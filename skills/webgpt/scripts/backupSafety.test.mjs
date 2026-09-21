import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, unlinkSync, symlinkSync, linkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { start } from './worker.mjs';
import { request, reconcileTasks, collectTask } from './client.mjs';
import { inspectRecovery } from './workspace.mjs';
import { spawnFixtureWorker, untilFixture } from './test-fixtures/worker-process.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
// The grant uses the canonical path; Windows temp directories may use 8.3
// aliases, so fault injection must address that same physical project path.
const temporary = () => fs.realpathSync.native(mkdtempSync(join(tmpdir(), 'webgpt-backup-safety-')));
function linkOrSkip(t, target, file, type) {
  try { symlinkSync(target, file, type); return true; }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Windows symlink creation unavailable under this test account'); return false;
    }
    throw error;
  }
}
async function fixture(run, configure = () => ({})) {
  const base = temporary(), dir = join(base, 'runtime'), root = join(base, 'project');
  mkdirSync(root);
  let options = { dir, port: 0, controlPort: 0, waitMs: 20, closeGraceMs: 50, ...configure({ base, dir, root }) };
  let service = await start(options);
  const config = { dataDir: dir, controlPort: service.controlPort };
  const admin = (action, payload) => request(action, payload, config);
  const call = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${service.mcpPort}/mcp`, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await response.json()).result;
  };
  const register = (id = 'a', mode = 'edit', project = root) => admin('register', { id, instructions: '', inputs: {}, workspace: { root: project, mode } });
  const submit = token => call('submit_result', { token, status: 'completed', summary: 'fixture', result: 'fixture report' });
  const restart = async changes => {
    await service.close(); options = { ...options, ...changes }; service = await start(options); config.controlPort = service.controlPort;
  };
  try { await run({ base, dir, root, config, admin, call, register, submit, restart }); }
  finally { await service.close(); rmSync(base, { recursive: true, force: true }); }
}

for (const damage of ['missing', 'changed', 'symlink', 'hardlink']) {
  for (const restarted of [false, true]) test(`${damage} original backup blocks only the affected task${restarted ? ' after restart' : ''}`, t => fixture(async f => {
    writeFileSync(join(f.root, 'source.txt'), 'original 한국어');
    const { token } = await f.register();
    const receipt = (await f.call('write_file', { token, path: 'source.txt', text: 'edited', expectedSha256: hash('original 한국어') })).structuredContent;
    const journal = join(f.dir, 'recovery', 'a', receipt.operation + '.json');
    const journalBytes = readFileSync(journal);
    if (damage === 'changed') writeFileSync(receipt.backup, 'wrong');
    else if (damage === 'hardlink') linkSync(receipt.backup, join(f.base, 'linked-backup'));
    else {
      unlinkSync(receipt.backup);
      if (damage === 'symlink') { writeFileSync(join(f.base, 'outside.txt'), 'original 한국어'); if (!linkOrSkip(t, join(f.base, 'outside.txt'), receipt.backup)) return; }
    }
    if (restarted) await f.restart();
    await assert.rejects(f.admin('ready'), error => error.details.issues.includes('RECOVERY_REQUIRED'));
    const result = await reconcileTasks(f.config);
    assert.equal(result.tasks[0].attention, 'inspect_recovery');
    assert.ok(result.tasks[0].journalIssues.includes(journal));
    assert.equal((await f.call('write_file', { token, path: 'source.txt', text: 'again', expectedSha256: hash('edited') })).isError, true);
    assert.equal((await f.submit(token)).isError, true);
    assert.equal((await f.call('read_file', { token, path: 'source.txt' })).structuredContent.text, 'edited');
    assert.deepEqual(readFileSync(journal), journalBytes);
    const other = await f.register('other'); assert.equal((await f.submit(other.token)).isError, false);
  }));
}

test('a lost delete backup is detected by mutation admission even without a readiness poll', () => fixture(async f => {
  writeFileSync(join(f.root, 'old.txt'), 'original');
  const { token } = await f.register();
  const receipt = (await f.call('delete_file', { token, path: 'old.txt', expectedSha256: hash('original') })).structuredContent;
  unlinkSync(receipt.backup);
  assert.equal((await f.call('write_file', { token, path: 'new.txt', text: 'no', expectedSha256: null })).isError, true);
  assert.equal(existsSync(join(f.root, 'new.txt')), false);
  assert.equal(existsSync(join(f.root, 'old.txt')), false); // Never invent a rollback.
}));

test('collected tasks still disclose missing backups on reconciliation without revoking unrelated work', () => fixture(async f => {
  writeFileSync(join(f.root, 'source.txt'), 'old');
  const { token } = await f.register();
  const receipt = (await f.call('write_file', { token, path: 'source.txt', text: 'new', expectedSha256: hash('old') })).structuredContent;
  assert.equal((await f.submit(token)).isError, false); await collectTask('a', f.config);
  unlinkSync(receipt.backup);
  const before = readFileSync(join(f.dir, 'state.json'));
  const snapshot = await reconcileTasks(f.config);
  assert.equal(snapshot.tasks[0].integrity, 'verified');
  assert.equal(snapshot.tasks[0].attention, 'inspect_recovery');
  assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
  assert.equal((await f.admin('ready')).ok, true); // Completed recovery is not active admission.
}));

test('valid empty backups and earlier receipts remain valid after later edits', () => fixture(async f => {
  writeFileSync(join(f.root, 'source.txt'), '');
  const { token } = await f.register();
  let current = '';
  for (const next of ['one', 'two', 'three']) {
    const reply = await f.call('write_file', { token, path: 'source.txt', text: next, expectedSha256: hash(current) });
    assert.equal(reply.isError, false); current = next;
  }
  await f.restart(); assert.equal((await f.admin('ready')).ok, true);
  assert.equal(inspectRecovery(f.dir, 'a').receipts.length, 3);
  assert.equal((await f.submit(token)).isError, false);
}));

for (const stage of ['backup', 'prepared', 'project']) test(`a ${stage} flush failure is not acknowledged as a successful file change`, () => fixture(async f => {
  writeFileSync(join(f.root, 'source.txt'), 'old');
  const { token } = await f.register();
  const originalWrite = fs.writeFileSync;
  let reached = false;
  fs.writeFileSync = (path, bytes, options) => {
    const name = String(path);
    const match = stage === 'backup' ? name.endsWith('.before.txt') : stage === 'prepared' ? name.endsWith('.json') && name.includes(join('recovery', 'a'))
      : name.includes(join('project', '.webgpt-'));
    // Model an I/O failure at the flush barrier, not merely at the write syscall.
    if (match && options?.flush === true) { reached = true; originalWrite(path, bytes, { ...options, flush: false }); throw Object.assign(Error('fixture flush failure'), { code: 'EIO' }); }
    return originalWrite(path, bytes, options);
  };
  syncBuiltinESMExports();
  try {
    const reply = await f.call('write_file', { token, path: 'source.txt', text: 'new', expectedSha256: hash('old') });
    assert.equal(reached, true);
    assert.equal(reply.isError, true);
    assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'old');
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'state.json')))[0].changes, []);
  } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
}));

test('a partial applied-record write preserves the complete prepared journal and original backup', () => fixture(async f => {
  writeFileSync(join(f.root, 'source.txt'), 'old'); const { token } = await f.register();
  const originalWrite = fs.writeFileSync;
  let reached = false;
  fs.writeFileSync = (path, bytes, options) => {
    if (String(path).includes(join('recovery', 'a')) && String(bytes).includes('"state":"applied"')) {
      reached = true; originalWrite(path, '{partial applied record'); throw Object.assign(Error('fixture interrupted journal'), { code: 'EIO' });
    }
    return originalWrite(path, bytes, options);
  };
  syncBuiltinESMExports();
  try { assert.equal((await f.call('write_file', { token, path: 'source.txt', text: 'new', expectedSha256: hash('old') })).isError, true); }
  finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
  assert.equal(reached, true);
  const folder = join(f.dir, 'recovery', 'a'), files = readdirSync(folder);
  const journal = files.find(name => name.endsWith('.json'));
  const prepared = JSON.parse(readFileSync(join(folder, journal)));
  assert.equal(prepared.state, 'prepared');
  assert.equal(readFileSync(prepared.backup, 'utf8'), 'old');
  assert.equal(readFileSync(join(folder, journal + '.tmp'), 'utf8'), '{partial applied record');
  assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'new');
  await f.restart(); await assert.rejects(f.admin('ready'), e => e.details.issues.includes('RECOVERY_REQUIRED'));
}));

for (const mode of ['read', 'edit']) test(`a project containing the active config cannot receive a ${mode} grant`, () => fixture(async f => {
  await assert.rejects(f.register('config-access', mode), /workspace overlaps worker configuration/);
  assert.equal(readFileSync(join(f.root, 'config.json'), 'utf8'), '{"fixture":true}');
}, ({ root }) => { const configFile = join(root, 'config.json'); writeFileSync(configFile, '{"fixture":true}'); return { configFile }; }));

test('an absent future config path is protected before a task can create it', () => fixture(async f => {
  await assert.rejects(f.register(), /workspace overlaps worker configuration/);
  assert.equal(existsSync(join(f.root, '.config')), false);
}, ({ root }) => ({ configFile: join(root, '.config', 'webgpt', 'config.json') })));

test('a config symlink outside the project does not expose its in-project target', t => fixture(async f => {
  const target = join(f.root, 'config.json'); writeFileSync(target, '{}');
  if (!linkOrSkip(t, target, join(f.base, 'active-config.json'))) return;
  await assert.rejects(f.register(), /workspace overlaps worker configuration/);
}, ({ base }) => ({ configFile: join(base, 'active-config.json') })));

test('an absent config beneath a directory alias is protected by its canonical ancestor', t => fixture(async f => {
  if (!linkOrSkip(t, f.root, join(f.base, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')) return;
  await assert.rejects(f.register(), /workspace overlaps worker configuration/);
}, ({ base }) => ({ configFile: join(base, 'alias', 'missing', 'config.json') })));

test('restored grants are rechecked against the active config while task evidence stays readable', () => fixture(async f => {
  const { token } = await f.register(); const configFile = join(f.root, 'config.json'); writeFileSync(configFile, '{}');
  await f.restart({ configFile });
  assert.equal((await f.call('read_file', { token, path: 'config.json' })).isError, true);
  assert.equal((await f.call('get_task', { token })).structuredContent.status, 'running');
  await assert.rejects(f.admin('ready'), e => e.details.unavailableWorkspaces.includes('a'));
}));

test('an unrelated project config.json remains editable with no new MCP capability', () => fixture(async f => {
  writeFileSync(join(f.root, 'config.json'), '{}'); const { token } = await f.register();
  assert.equal((await f.call('write_file', { token, path: 'config.json', text: '{"project":true}', expectedSha256: hash('{}') })).isError, false);
  assert.equal((await f.submit(token)).isError, false);
}, ({ base }) => ({ configFile: join(base, 'project-other', 'config.json') })));


test('failed create synchronization preserves its prepared evidence and prevents blind replay', () => fixture(async f => {
  const { token } = await f.register();
  const target = join(f.root, 'created.txt'), originalWrite = fs.writeFileSync;
  let reached = false;
  fs.writeFileSync = (file, bytes, options) => {
    if (file === target && options?.flush) {
      reached = true; originalWrite(file, bytes, { ...options, flush: false });
      throw Object.assign(Error('fixture create sync failure'), { code: 'EIO' });
    }
    return originalWrite(file, bytes, options);
  };
  syncBuiltinESMExports();
  try {
    assert.equal((await f.call('write_file', { token, path: 'created.txt', text: 'preserved', expectedSha256: null })).isError, true);
    assert.equal(reached, true);
  } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
  assert.equal(readFileSync(target, 'utf8'), 'preserved');
  const recovery = inspectRecovery(f.dir, 'a'); assert.equal(recovery.unresolved.length, 1);
  assert.equal(JSON.parse(readFileSync(recovery.unresolved[0])).state, 'prepared');
  await f.restart();
  assert.equal((await f.call('write_file', { token, path: 'created.txt', text: 'replayed', expectedSha256: hash('preserved') })).isError, true);
  assert.equal(readFileSync(target, 'utf8'), 'preserved');
}));

test('failed applied-record rename preserves both prepared and applied candidates without claiming success', () => fixture(async f => {
  writeFileSync(join(f.root, 'source.txt'), 'old'); const { token } = await f.register();
  const originalRename = fs.renameSync;
  let reached = false;
  fs.renameSync = (source, target) => {
    if (String(source).includes(join('recovery', 'a')) && String(source).endsWith('.json.tmp')) {
      reached = true; throw Object.assign(Error('fixture journal rename failure'), { code: 'EIO' });
    }
    return originalRename(source, target);
  };
  syncBuiltinESMExports();
  try {
    assert.equal((await f.call('write_file', { token, path: 'source.txt', text: 'new', expectedSha256: hash('old') })).isError, true);
    assert.equal(reached, true);
  } finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  const [journal] = inspectRecovery(f.dir, 'a').unresolved;
  assert.deepEqual(inspectRecovery(f.dir, 'a').unresolved, [journal]); // The prepared record diagnoses both candidates.
  assert.equal(JSON.parse(readFileSync(journal)).state, 'prepared');
  assert.equal(JSON.parse(readFileSync(journal + '.tmp')).state, 'applied');
  assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'new');
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'state.json')))[0].changes, []);
  await f.restart(); await assert.rejects(f.admin('ready'), e => e.details.issues.includes('RECOVERY_REQUIRED'));
  // A second loss must not make the surviving applied candidate invisible.
  const candidate = journal + '.tmp', candidateBytes = readFileSync(candidate);
  unlinkSync(journal); await f.restart();
  assert.deepEqual(inspectRecovery(f.dir, 'a').unresolved, [candidate]);
  await assert.rejects(f.admin('ready'), e => e.details.issues.includes('RECOVERY_REQUIRED'));
  assert.equal((await f.call('write_file', { token, path: 'source.txt', text: 'again', expectedSha256: hash('new') })).isError, true);
  assert.deepEqual(readFileSync(candidate), candidateBytes);
  assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'new');
}));

test('an applied journal with an additional staged candidate requires inspection without erasing either', () => fixture(async f => {
  const { token } = await f.register();
  const receipt = (await f.call('write_file', { token, path: 'created.txt', text: 'saved', expectedSha256: null })).structuredContent;
  const journal = join(f.dir, 'recovery', 'a', receipt.operation + '.json'), candidate = journal + '.tmp';
  const committed = readFileSync(journal); writeFileSync(candidate, '{conflicting candidate');
  assert.deepEqual(inspectRecovery(f.dir, 'a').unresolved, [candidate]);
  await f.restart();
  await assert.rejects(f.admin('ready'), e => e.details.issues.includes('RECOVERY_REQUIRED'));
  assert.equal((await f.submit(token)).isError, true);
  assert.deepEqual(readFileSync(journal), committed);
  assert.equal(readFileSync(candidate, 'utf8'), '{conflicting candidate');
}));

test('the actual worker CLI protects WEBGPT_CONFIG, not only an injected start option', async () => {
  const base = temporary(), root = join(base, 'project'), dir = join(base, 'runtime'); mkdirSync(root);
  const file = join(root, 'config.json');
  let child, exited;
  try {
    const savedConfig = { dataDir: dir, mcpPort: 12340, controlPort: 12341 };
    const config = { ...savedConfig };
    writeFileSync(file, JSON.stringify(savedConfig));
    const observed = spawnFixtureWorker(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], {
      env: { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: dir },
    }, ports => { config.mcpPort = ports.mcpPort; config.controlPort = ports.controlPort; });
    child = observed.child; exited = observed.exit;
    await untilFixture(() => observed.listening, {
      timeoutMs: 5000, label: 'config boundary worker', diagnostic: observed.diagnostic,
      stopped: () => child.exitCode !== null || child.signalCode !== null,
    });
    await assert.rejects(request('register', { id: 'unsafe-config', instructions: '', inputs: {}, workspace: { root, mode: 'edit' } }, config), /workspace overlaps worker configuration/);
    assert.deepEqual(JSON.parse(readFileSync(file)), savedConfig);
    const safeRoot = join(base, 'other-project'); mkdirSync(safeRoot);
    assert.ok((await request('register', { id: 'safe', instructions: '', inputs: {}, workspace: { root: safeRoot, mode: 'read' } }, config)).token);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { if (child.connected) child.send({ type: 'shutdown' }, () => {}); } catch {}
      const deadline = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
      try { await exited; } finally { clearTimeout(deadline); }
    }
    rmSync(base, { recursive: true, force: true });
  }
});
