// Disposable loopback workers only. Never repair, restart or mutate an installed runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { start } from './worker.mjs';
import { request, waitForTasks, collectTask } from './client.mjs';

const original = 'Original 한국어 🧪\r\n';
const revision = createHash('sha256').update(original).digest('hex');
const pendingText = 'PRIVATE_PENDING_STATE_FIXTURE';
const denied = /state\.json\.tmp requires inspection/;
async function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-mutation-preflight-')));
  const root = join(base, 'project'), dir = join(base, 'runtime');
  fs.mkdirSync(root); fs.writeFileSync(join(root, 'original.txt'), original);
  let worker, clock = 1000;
  t.after(async () => { await worker?.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const config = { dataDir: dir };
  const boot = async () => {
    worker = await start({ dir, port: 0, controlPort: 0, waitMs: 20, now: () => clock++, configFile: join(base, 'config.json') });
    config.controlPort = worker.controlPort;
  };
  await boot();
  const admin = (action, payload) => request(action, payload, config);
  const register = id => admin('register', { id, instructions: 'Fixture', inputs: { sample: 'supplied' }, workspace: { root, mode: 'edit' } });
  const call = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${worker.mcpPort}/mcp`, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200); return (await response.json()).result;
  };
  const { token } = await register('owned');
  const complete = (taskToken = token) => call('submit_result', { token: taskToken, status: 'completed', summary: 'done', result: 'fixture evidence' });
  const mutate = operation => call(operation === 'delete' ? 'delete_file' : 'write_file', {
    token, path: operation === 'create' ? 'new/child.txt' : 'original.txt',
    expectedSha256: operation === 'create' ? null : revision,
    ...(operation !== 'delete' ? { text: 'replacement' } : {}),
  });
  return { base, root, dir, config, admin, register, call, token, complete, mutate,
    state: join(dir, 'state.json'), stage: join(dir, 'state.json.tmp'), boot, close: () => worker.close() };
}
async function patched(t, name, replacement, run) {
  t.mock.method(fs, name, replacement); syncBuiltinESMExports();
  try { return await run(); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}
function unchanged(f, state) {
  assert.equal(fs.readFileSync(join(f.root, 'original.txt'), 'utf8'), original);
  assert.equal(fs.existsSync(join(f.root, 'new')), false);
  assert.equal(fs.existsSync(join(f.dir, 'recovery')), false);
  assert.deepEqual(fs.readFileSync(f.state), state);
}
function rejected(reply, f) {
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, denied);
  for (const secret of [f.base, f.token, pendingText]) assert.ok(!JSON.stringify(reply).includes(secret));
}

for (const previous of ['checked-owned', 'checked-other', 'ack-other']) for (const operation of ['create', 'edit', 'delete']) {
  test(`${operation} stops after failed ${previous}; ${previous.startsWith('checked') ? 'advancing-clock retry requires offline recovery' : 'identical ack retry still works'}`, async t => {
    const f = await fixture(t);
    const other = await f.register('other');
    if (previous === 'ack-other') assert.equal((await f.complete(other.token)).isError, false);
    const action = previous.startsWith('checked') ? 'checked' : 'ack';
    const payload = { id: previous.endsWith('owned') ? 'owned' : 'other' };
    const committed = fs.readFileSync(f.state), rename = fs.renameSync;
    await patched(t, 'renameSync', (from, to) => {
      if (from === f.stage) throw Object.assign(Error('fixture publication failure'), { code: 'EIO' });
      return rename(from, to);
    }, () => assert.rejects(f.admin(action, payload), { statusCode: 503, code: 'EIO' }));
    const candidate = fs.readFileSync(f.stage);
    assert.notDeepEqual(candidate, committed, 'real uncommitted state was produced');
    rejected(await f.mutate(operation), f);
    unchanged(f, committed);
    assert.deepEqual(fs.readFileSync(f.stage), candidate);
    const task = (await f.call('get_task', { token: f.token })).structuredContent;
    assert.deepEqual(task.changes, []); assert.deepEqual(task.recoveryRequired ?? [], []);
    assert.equal((await waitForTasks(['owned'], f.config)).interrupted, true);
    await assert.rejects(f.admin('ready'), e => e.details.storage.code === 'STATE_STAGING_CONFLICT'
      && e.details.automaticRestartRecommended === false);
    if (action === 'checked') {
      // Each now() advances: repeating the same payload proposes a later deadline,
      // not the bytes retained by the failed publication. No online recovery claim.
      const deadline = bytes => JSON.parse(bytes).find(task => task.id === payload.id).nextCheck;
      assert.ok(deadline(candidate) > deadline(committed));
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(f.admin(action, payload), { statusCode: 503, code: 'STATE_STAGING_CONFLICT' });
        rejected(await f.mutate(operation), f);
        unchanged(f, committed);
        assert.deepEqual(fs.readFileSync(f.stage), candidate);
        assert.equal((await f.call('get_task', { token: f.token })).structuredContent.status, 'running');
        await assert.rejects(f.admin('ready'), e => e.details.storage.code === 'STATE_STAGING_CONFLICT');
      }
      // Restart cannot resolve the failed transition either. Preserve both files
      // for the documented, deliberate offline disposition by the supervisor.
      await f.close();
      await assert.rejects(f.boot(), { code: 'STATE_STAGING_CONFLICT' });
      unchanged(f, committed);
      assert.deepEqual(fs.readFileSync(f.stage), candidate);
      assert.equal(fs.existsSync(join(f.dir, 'worker.lock')), false);
      return;
    }
    // Ack has no fresh deadline; with unchanged task inventory its explicit retry
    // remains byte-identical even while the clock advances.
    assert.equal((await f.admin(action, payload)).ok, true);
    assert.equal(fs.existsSync(f.stage), false);
    assert.equal((await f.admin('ready')).ok, true);
    assert.equal((await f.mutate(operation)).isError, false);
    assert.equal((await f.complete()).isError, false);
    assert.equal((await collectTask('owned', f.config)).integrity, 'verified');
  });
}

for (const kind of ['regular', 'empty', 'directory', 'symlink', 'dangling', 'hardlink']) {
  test(`an existing ${kind} state stage blocks all new file mutations without reading or removing it`, async t => {
    const f = await fixture(t), committed = fs.readFileSync(f.state), other = join(f.base, 'candidate.txt');
    fs.writeFileSync(other, pendingText);
    if (kind === 'directory') fs.mkdirSync(f.stage);
    else if (kind === 'hardlink') fs.linkSync(other, f.stage);
    else if (kind === 'symlink' || kind === 'dangling') {
      try { fs.symlinkSync(kind === 'symlink' ? other : join(f.base, 'missing'), f.stage, 'file'); }
      catch (e) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) return t.skip('file symlinks are unavailable');
        throw e;
      }
    } else fs.writeFileSync(f.stage, kind === 'empty' ? '' : pendingText, { mode: 0o600 });
    const before = fs.lstatSync(f.stage);
    for (const operation of ['create', 'edit', 'delete']) {
      rejected(await f.mutate(operation), f); unchanged(f, committed);
    }
    const after = fs.lstatSync(f.stage);
    assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino); assert.equal(after.size, before.size);
    assert.equal(fs.readFileSync(other, 'utf8'), pendingText);
    assert.equal(fs.existsSync(join(f.base, 'missing')), false);
    const task = (await f.call('get_task', { token: f.token })).structuredContent;
    assert.equal(task.status, 'running'); assert.deepEqual(task.changes, []);
    assert.deepEqual(task.recoveryRequired ?? [], []);
    assert.equal((await f.call('read_input', { token: f.token, name: 'sample' })).structuredContent.text, 'supplied');
    assert.equal((await f.call('read_file', { token: f.token, path: 'original.txt' })).structuredContent.sha256, revision);
    assert.deepEqual((await f.call('list_files', { token: f.token, path: '.' })).structuredContent.entries.map(e => e.name), ['original.txt']);
    assert.equal((await waitForTasks(['owned'], f.config)).interrupted, true);
  });
}

for (const code of ['EACCES', 'EIO']) test(`an unreadable stage check (${code}) fails before editing and wakes the wait path`, async t => {
  const f = await fixture(t), committed = fs.readFileSync(f.state), stat = fs.lstatSync;
  await patched(t, 'lstatSync', (path, ...args) => {
    if (path === f.stage) throw Object.assign(Error('fixture metadata failure'), { code });
    return stat(path, ...args);
  }, async () => {
    assert.equal((await f.mutate('edit')).isError, true);
    unchanged(f, committed);
  });
  assert.equal(fs.existsSync(f.stage), false);
  assert.equal((await waitForTasks(['owned'], f.config)).interrupted, true);
  await assert.rejects(f.admin('ready'), e => e.details.storage.code === code);
  await f.admin('checked', { id: 'owned' });
  assert.equal((await f.admin('ready')).ok, true);
  assert.equal((await f.mutate('edit')).isError, false);
});

test('a newly arising persistence failure after editing still preserves the original and recovery evidence', async t => {
  const f = await fixture(t), committed = fs.readFileSync(f.state), rename = fs.renameSync;
  await patched(t, 'renameSync', (from, to) => {
    if (from === f.stage) throw Object.assign(Error('fixture late publication failure'), { code: 'EIO' });
    return rename(from, to);
  }, async () => assert.equal((await f.mutate('edit')).isError, true));
  assert.equal(fs.readFileSync(join(f.root, 'original.txt'), 'utf8'), 'replacement');
  assert.deepEqual(fs.readFileSync(f.state), committed);
  assert.ok(fs.existsSync(f.stage));
  const task = (await f.call('get_task', { token: f.token })).structuredContent;
  assert.equal(task.recoveryRequired.length, 1);
  const journal = JSON.parse(fs.readFileSync(task.recoveryRequired[0], 'utf8'));
  assert.equal(fs.readFileSync(journal.backup, 'utf8'), original);
  assert.equal((await f.mutate('create')).isError, true);
  assert.equal(fs.existsSync(join(f.root, 'new')), false);
});

test('result preservation and explicit identical completion retry are not replaced by the file preflight', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.stage, pendingText, { mode: 0o600 });
  assert.equal((await f.complete()).isError, true);
  assert.equal(fs.readFileSync(join(f.dir, 'owned.result.txt'), 'utf8'), 'fixture evidence');
  assert.equal((await f.call('get_task', { token: f.token })).structuredContent.status, 'running');
  // Dispose only this injected fixture obstruction; production requires offline inspection.
  fs.unlinkSync(f.stage);
  assert.equal((await f.complete()).isError, false);
  assert.equal((await collectTask('owned', f.config)).integrity, 'verified');
});
