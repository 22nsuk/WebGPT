// Actual loopback workers and disposable recovery evidence; no operational runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { start } from './worker.mjs';
import { withStateWriteFailure } from './test-fixtures/state-write-failure.mjs';
import { request, collectTask, reconcileTasks } from './client.mjs';

const execute = promisify(execFile);
const text = 'Retained 한국어 🧪\r\nPRIVATE_RECOVERY_FIXTURE';
const reply = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
};
async function fixture(t, { status = 'completed', intercept = async () => false, interrupted = false } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-collection-recovery-')));
  const dir = join(base, 'runtime'), root = join(base, 'project'); fs.mkdirSync(root);
  let worker, proxy;
  const actions = [], failures = [];
  t.after(async () => {
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
    await worker?.close(); fs.rmSync(base, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  });
  worker = await start({ dir, port: 0, controlPort: 0, waitMs: 20, configFile: join(base, 'config.json') });
  const direct = { dataDir: dir, controlPort: worker.controlPort };
  const admin = (action, payload) => request(action, payload, direct);
  const call = async (name, args) => (await (await fetch(`http://127.0.0.1:${worker.mcpPort}/mcp`, {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })).json()).result;
  const register = id => admin('register', { id, instructions: 'Retain instructions', inputs: { sample: text }, workspace: { root, mode: 'edit' } });
  const complete = async (task, terminal = status) => {
    assert.equal((await call('submit_result', { token: task.token, status: terminal, summary: 'done', result: text })).isError, false);
  };
  const task = await register('owned');
  // A real edit creates its original backup and journal before normal completion.
  fs.writeFileSync(join(root, 'notes.txt'), 'original bytes');
  const before = await call('read_file', { token: task.token, path: 'notes.txt' });
  const edit = () => call('write_file', { token: task.token, path: 'notes.txt', text: 'reviewed edit', expectedSha256: before.structuredContent.sha256 });
  const changed = interrupted ? await withStateWriteFailure(t, dir, edit) : await edit();
  assert.equal(changed.isError, interrupted);
  await complete(task);
  const artifact = join(dir, 'owned.result.txt'), state = join(dir, 'state.json');
  const evidence = (kind, id = 'owned') => {
    if (kind === 'pending-result') {
      const file = join(dir, id + '.result.txt.tmp'); fs.writeFileSync(file, text); return file;
    }
    if (kind === 'missing-backup') { fs.unlinkSync(changed.structuredContent.backup); return null; }
    const directory = join(dir, 'recovery', id); fs.mkdirSync(directory, { recursive: true });
    const file = join(directory, 'unresolved.json'); fs.writeFileSync(file, '{}'); return file;
  };
  const f = { base, dir, root, task, artifact, state, admin, call, register, complete, evidence, direct, actions };
  proxy = createServer((req, res) => {
    Promise.resolve().then(async () => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      actions.push(req.url);
      if (await intercept({ ...f, req, res, phase: 'before' })) return;
      const response = await fetch(`http://127.0.0.1:${worker.controlPort}${req.url}`, {
        method: req.method, headers: { authorization: req.headers.authorization, 'content-type': 'application/json' },
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}), redirect: 'error',
      });
      const data = await response.json();
      if (!await intercept({ ...f, req, res, phase: 'after', data })) reply(res, data, response.status);
    }).catch(error => { failures.push(error.message); res.destroy(); });
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return { ...f, config: { ...direct, controlPort: proxy.address().port } };
}
const initial = resume => resume ? ['/reconcile?id=owned'] : ['/wait?id=owned'];
const refused = resume => resume ? initial(true) : [...initial(false), '/collect'];
function recoveryError(kind) {
  return error => {
    assert.equal(error.code, 'COLLECTION_RECOVERY_REQUIRED');
    assert.equal(error.attention, kind === 'pending-result' ? 'inspect_uncommitted_result' : 'inspect_recovery');
    assert.equal(error.reconciliation.collected, false);
    return true;
  };
}
function unchanged(f, before, candidate) {
  assert.deepEqual(fs.readFileSync(f.state), before);
  assert.equal(fs.readFileSync(f.artifact, 'utf8'), text);
  assert.equal(fs.readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'reviewed edit');
  assert.equal(JSON.parse(before)[0].token, f.task.token);
  if (candidate) assert.equal(fs.existsSync(candidate), true);
  assert.equal(f.actions.includes('/ack'), false, 'no unchecked acknowledgment');
}

for (const kind of ['pending-result', 'unresolved-journal', 'missing-backup']) {
  for (const status of ['completed', 'failed', 'cancelled']) for (const resume of [false, true]) {
    test(`${resume ? 'resume' : 'ordinary'} ${status} collection preserves ${kind} evidence before ack`, async t => {
      const f = await fixture(t, { status }), candidate = f.evidence(kind), before = fs.readFileSync(f.state);
      const bytes = candidate ? fs.readFileSync(candidate) : null;
      await assert.rejects(collectTask('owned', f.config, { resume }), recoveryError(kind));
      unchanged(f, before, candidate);
      assert.deepEqual(f.actions, refused(resume));
      if (candidate) assert.deepEqual(fs.readFileSync(candidate), bytes);
      assert.equal((await f.call('get_task', { token: f.task.token })).isError, false);
      assert.equal((await f.call('read_input', { token: f.task.token, name: 'sample' })).structuredContent.text, text);
    });
  }
  for (const resume of [false, true]) test(`${resume ? 'resume' : 'ordinary'} collection cannot confirm ${kind} appearing after ack`, async t => {
    let candidate;
    const f = await fixture(t, { intercept: async ({ req, phase, evidence }) => {
      if (req.url === '/collect' && phase === 'after') candidate = evidence(kind);
    } });
    await assert.rejects(collectTask('owned', f.config, { resume }), error => {
      assert.equal(error.code, 'COLLECTION_UNCONFIRMED');
      assert.equal(error.acknowledgment, 'accepted');
      assert.equal(error.cause.code, 'COLLECTION_RECOVERY_REQUIRED');
      return true;
    });
    assert.deepEqual(f.actions, [...initial(resume), '/collect', '/reconcile?id=owned']);
    const stored = JSON.parse(fs.readFileSync(f.state))[0];
    assert.equal(stored.collected, true); assert.equal(stored.token, undefined);
    assert.equal(fs.readFileSync(f.artifact, 'utf8'), text);
    if (candidate) assert.equal(fs.existsSync(candidate), true);
    // Retired-result resume remains an explicit diagnostic, not a new ack or repair.
    const result = await collectTask('owned', f.config, { resume: true });
    assert.equal(result.disposition, 'already_collected');
    assert.equal(result.attention, kind === 'pending-result' ? 'inspect_uncommitted_result' : 'inspect_recovery');
    assert.equal(f.actions.filter(path => path === '/collect').length, 1);
  });
}

for (const kind of ['pending-result', 'unresolved-journal']) test(`unrelated ${kind} does not block a healthy target or weaken full diagnostics`, async t => {
  const f = await fixture(t), other = await f.register('other'); await f.complete(other);
  const candidate = f.evidence(kind, 'other'), bytes = fs.readFileSync(candidate);
  assert.equal((await collectTask('owned', f.config)).collected, true);
  assert.deepEqual(f.actions, [...initial(false), '/collect', '/reconcile?id=owned']);
  assert.deepEqual(fs.readFileSync(candidate), bytes);
  const snapshot = await reconcileTasks(f.direct);
  assert.equal(snapshot.tasks.find(task => task.id === 'other').attention,
    kind === 'pending-result' ? 'inspect_uncommitted_result' : 'inspect_recovery');
});

for (const issue of ['unavailable', 'changed-identity', 'aborted']) test(`ordinary collection rejects ${issue} before guarded retirement`, async t => {
  const controller = new AbortController(), reason = Error('explicit fixture abort');
  const f = await fixture(t, { intercept: async ({ req, res, phase, data }) => {
    if (issue === 'changed-identity' && req.url.startsWith('/wait?') && phase === 'after') {
      data.events[0].status = 'failed'; reply(res, data); return true;
    }
    if (req.url !== '/collect' || phase !== 'before') return;
    if (issue === 'aborted') { controller.abort(reason); res.destroy(); return true; }
    if (issue === 'unavailable') { reply(res, { error: 'fixture unavailable' }, 503); return true; }
  } });
  const before = fs.readFileSync(f.state);
  await assert.rejects(collectTask('owned', f.config, { signal: controller.signal }), error => {
    if (issue === 'aborted') assert.equal(error, reason);
    else if (issue === 'unavailable') assert.equal(error.statusCode, 503);
    else { assert.equal(error.code, 'COLLECTION_UNCONFIRMED'); assert.equal(error.acknowledgment, undefined); }
    return true;
  });
  unchanged(f, before); assert.deepEqual(f.actions, refused(false));
});

test('ordinary CLI recovery error exposes only existing safe fields and preserves private inputs', async t => {
  const f = await fixture(t), candidate = f.evidence('pending-result'), before = fs.readFileSync(f.state);
  const file = join(f.base, 'cli.json'); fs.writeFileSync(file, JSON.stringify(f.config));
  await assert.rejects(execute(process.execPath, [fileURLToPath(new URL('./client.mjs', import.meta.url)), 'collect', 'owned'], {
    env: { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: f.dir }, windowsHide: true, timeout: 10000,
  }), error => {
    assert.equal(error.code, 1); assert.equal(error.stdout, '');
    const diagnostic = JSON.parse(error.stderr.trim().replace(/^WebGPT: /, ''));
    assert.deepEqual(Object.keys(diagnostic).sort(), ['attention', 'code', 'message']);
    assert.equal(diagnostic.code, 'COLLECTION_RECOVERY_REQUIRED'); assert.equal(diagnostic.attention, 'inspect_uncommitted_result');
    for (const secret of [f.base, f.task.token, text, 'PRIVATE_RECOVERY_FIXTURE']) assert.ok(!error.stderr.includes(secret));
    return true;
  });
  unchanged(f, before, candidate); assert.deepEqual(f.actions, refused(false));
});

for (const resume of [false, true]) test(`${resume ? 'resume' : 'ordinary'} collection retains failed partial work after an actual receipt-write failure`, async t => {
  const f = await fixture(t, { status: 'failed', interrupted: true }), before = fs.readFileSync(f.state);
  const stored = JSON.parse(before)[0];
  assert.equal(stored.changes.length, 0); assert.equal(stored.recoveryRequired.length, 1);
  const journal = stored.recoveryRequired[0], journalBytes = fs.readFileSync(journal);
  const backup = JSON.parse(journalBytes).backup, backupBytes = fs.readFileSync(backup);
  await assert.rejects(collectTask('owned', f.config, { resume }), recoveryError('unresolved-journal'));
  unchanged(f, before, journal);
  assert.deepEqual(fs.readFileSync(journal), journalBytes); assert.deepEqual(fs.readFileSync(backup), backupBytes);
  assert.deepEqual(f.actions, refused(resume));
});
