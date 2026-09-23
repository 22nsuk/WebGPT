import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { assertNoStateStage, writeStateBytes, startupExitCode } from './runtime.mjs';

const prior = Buffer.from('["committed"]');
const next = Buffer.from('["next 한국어 🧪"]');
function files(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'webgpt-state-storage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json'), stage = path + '.tmp', other = join(dir, 'evidence.txt');
  fs.writeFileSync(path, prior);
  fs.writeFileSync(other, 'unrelated private evidence');
  return { dir, path, stage, other };
}
function makeStage(t, f, kind, bytes = next) {
  if (kind === 'symlink' || kind === 'dangling') {
    try { fs.symlinkSync(kind === 'symlink' ? f.other : join(f.dir, 'missing'), f.stage, 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('symlink creation is not permitted'); return false; }
      throw error;
    }
  } else if (kind === 'hardlink') fs.linkSync(f.other, f.stage);
  else if (kind === 'directory') fs.mkdirSync(f.stage);
  else fs.writeFileSync(f.stage, bytes, { mode: 0o600 });
  return true;
}
function patched(t, method, replacement, run) {
  t.mock.method(fs, method, replacement);
  syncBuiltinESMExports();
  try { return run(); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}

test('state writer publishes bytes with a private new stage', t => {
  const f = files(t);
  assertNoStateStage(f.path);
  writeStateBytes(f.path, next);
  assert.deepEqual(fs.readFileSync(f.path), next);
  assert.equal(fs.existsSync(f.stage), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.path).mode & 0o077, 0);
});

test('state writer permits a flushed byte-identical explicit retry', t => {
  const f = files(t);
  fs.writeFileSync(f.stage, next, { mode: 0o600 });
  const original = fs.fsyncSync;
  let flushed = 0;
  patched(t, 'fsyncSync', fd => { flushed++; return original(fd); }, () => writeStateBytes(f.path, next));
  assert.equal(flushed, 1);
  assert.deepEqual(fs.readFileSync(f.path), next);
  assert.equal(fs.existsSync(f.stage), false);
});

for (const candidate of [Buffer.alloc(0), Buffer.from('["partial'), Buffer.alloc(next.length, 120), Buffer.alloc(next.length + 1, 121)]) {
  test(`state writer preserves conflicting stage (${candidate.length} bytes)`, t => {
    const f = files(t);
    fs.writeFileSync(f.stage, candidate, { mode: 0o600 });
    assert.throws(() => writeStateBytes(f.path, next), { code: 'STATE_STAGING_CONFLICT' });
    assert.deepEqual(fs.readFileSync(f.path), prior);
    assert.deepEqual(fs.readFileSync(f.stage), candidate);
  });
}

for (const kind of ['symlink', 'dangling', 'hardlink', 'directory']) {
  test(`state writer refuses ${kind} stages without changing their targets`, t => {
    const f = files(t);
    if (!makeStage(t, f, kind)) return;
    const original = fs.readFileSync(f.other);
    assert.throws(() => writeStateBytes(f.path, next));
    assert.deepEqual(fs.readFileSync(f.path), prior);
    assert.deepEqual(fs.readFileSync(f.other), original);
    assert.ok(fs.lstatSync(f.stage));
    if (kind === 'dangling') assert.equal(fs.existsSync(join(f.dir, 'missing')), false);
  });
}

test('state writer refuses a same-byte hardlink, not just mismatched bytes', t => {
  const f = files(t);
  fs.writeFileSync(f.other, next, { mode: 0o600 });
  fs.linkSync(f.other, f.stage);
  assert.throws(() => writeStateBytes(f.path, next), { code: 'STATE_STAGING_CONFLICT' });
  assert.deepEqual(fs.readFileSync(f.path), prior);
  assert.deepEqual(fs.readFileSync(f.other), next);
  assert.equal(fs.statSync(f.stage).nlink, 2);
});

test('state writer refuses to publish an overly accessible existing stage', { skip: process.platform === 'win32' }, t => {
  const f = files(t);
  fs.writeFileSync(f.stage, next);
  fs.chmodSync(f.stage, 0o644);
  assert.throws(() => writeStateBytes(f.path, next), { code: 'STATE_STAGING_CONFLICT' });
  assert.deepEqual(fs.readFileSync(f.path), prior);
  assert.deepEqual(fs.readFileSync(f.stage), next);
});

for (const kind of ['regular', 'symlink', 'dangling', 'hardlink', 'directory']) {
  test(`startup state check preserves and refuses a ${kind} stage`, t => {
    const f = files(t);
    if (!makeStage(t, f, kind)) return;
    assert.throws(() => assertNoStateStage(f.path), { code: 'STATE_STAGING_CONFLICT' });
    assert.deepEqual(fs.readFileSync(f.path), prior);
    assert.ok(fs.lstatSync(f.stage));
  });
}

test('state writer preserves a complete candidate after flush failure and flushes it again', t => {
  const f = files(t);
  patched(t, 'fsyncSync', () => { throw Object.assign(Error('fixture flush'), { code: 'EIO' }); }, () => {
    assert.throws(() => writeStateBytes(f.path, next), { code: 'EIO' });
  });
  assert.deepEqual(fs.readFileSync(f.path), prior);
  assert.deepEqual(fs.readFileSync(f.stage), next);
  writeStateBytes(f.path, next);
  assert.deepEqual(fs.readFileSync(f.path), next);
});

test('state writer preserves partial write evidence and refuses to overwrite it on retry', t => {
  const f = files(t), original = fs.writeFileSync;
  patched(t, 'writeFileSync', (fd, bytes, ...args) => {
    original(fd, bytes.subarray(0, 3), ...args);
    throw Object.assign(Error('fixture disk full'), { code: 'ENOSPC' });
  }, () => assert.throws(() => writeStateBytes(f.path, next), { code: 'ENOSPC' }));
  assert.deepEqual(fs.readFileSync(f.path), prior);
  assert.deepEqual(fs.readFileSync(f.stage), next.subarray(0, 3));
  assert.throws(() => writeStateBytes(f.path, next), { code: 'STATE_STAGING_CONFLICT' });
});

test('state writer preserves a complete stage after rename failure and only retries identical bytes', t => {
  const f = files(t);
  patched(t, 'renameSync', () => { throw Object.assign(Error('fixture rename'), { code: 'EPERM' }); }, () => {
    assert.throws(() => writeStateBytes(f.path, next), { code: 'EPERM' });
  });
  assert.deepEqual(fs.readFileSync(f.path), prior);
  assert.deepEqual(fs.readFileSync(f.stage), next);
  assert.throws(() => writeStateBytes(f.path, Buffer.from('["different"]')), { code: 'STATE_STAGING_CONFLICT' });
  writeStateBytes(f.path, next);
  assert.deepEqual(fs.readFileSync(f.path), next);
});

test('state stage conflicts have a non-restartable storage exit and contain no file bytes', t => {
  const f = files(t);
  fs.writeFileSync(f.stage, 'fixture-private-candidate', { mode: 0o600 });
  assert.throws(() => writeStateBytes(f.path, next), error => {
    assert.equal(error.code, 'STATE_STAGING_CONFLICT');
    assert.equal(error.retryable, false);
    assert.equal(startupExitCode(error), 74);
    assert.equal(error.message.includes('fixture-private-candidate'), false);
    assert.equal(error.message.includes(f.dir), false);
    return true;
  });
});

// Exercise the real controller/MCP paths, not a second implementation of persist().
async function workerFixture(t) {
  const { start } = await import('./worker.mjs');
  const dir = fs.mkdtempSync(join(tmpdir(), 'webgpt-state-http-'));
  let worker;
  t.after(async () => { await worker?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  worker = await start({ dir, port: 0, controlPort: 0, waitMs: 20, closeGraceMs: 50, now: () => 1000 });
  const request = async (action, payload) => {
    const response = await fetch(`http://127.0.0.1:${worker.controlPort}/${action}`, {
      method: payload === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + worker.key },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: response.status, data: await response.json() };
  };
  const call = async (name, args) => (await (await fetch(`http://127.0.0.1:${worker.mcpPort}/mcp`, {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })).json()).result;
  const register = async id => (await request('register', { id, instructions: 'fixture', inputs: {} })).data;
  return { dir, path: join(dir, 'state.json'), stage: join(dir, 'state.json.tmp'), request, call, register, close: () => worker.close(), start };
}

for (const action of ['register', 'cancel', 'checked']) {
  test(`controller ${action} preserves conflicting stage, state and task access`, async t => {
    const f = await workerFixture(t), task = await f.register('task');
    const original = fs.readFileSync(f.path);
    fs.writeFileSync(f.stage, 'uncommitted evidence', { mode: 0o600 });
    const payload = action === 'register' ? { id: 'new', instructions: 'fixture', inputs: {} } : { id: 'task' };
    const result = await f.request(action, payload);
    assert.equal(result.status, 503);
    assert.equal(result.data.code, 'STATE_STAGING_CONFLICT');
    assert.equal(result.data.retryable, false);
    assert.deepEqual(fs.readFileSync(f.path), original);
    assert.equal(fs.readFileSync(f.stage, 'utf8'), 'uncommitted evidence');
    assert.equal((await f.call('get_task', { token: task.token })).structuredContent.status, 'running');
    assert.equal((await f.request('tasks')).data.tasks.length, 1);
    const ready = await f.request('ready');
    assert.equal(ready.status, 503);
    assert.equal(ready.data.storage.code, 'STATE_STAGING_CONFLICT');
    // Fixture-only repair models offline inspection; production never auto-removes it.
    fs.unlinkSync(f.stage);
    assert.equal((await f.request(action, payload)).status, 200);
  });
}

test('controller completion and ack do not publish or retire tokens on a stage conflict', async t => {
  const f = await workerFixture(t), task = await f.register('task');
  const args = { token: task.token, status: 'completed', summary: 'done', result: 'saved 한국어 evidence' };
  fs.writeFileSync(f.stage, 'blocked', { mode: 0o600 });
  assert.equal((await f.call('submit_result', args)).isError, true);
  assert.equal((await f.call('get_task', { token: task.token })).structuredContent.status, 'running');
  assert.equal((await f.request('status')).data.events.length, 0);
  assert.equal(fs.readFileSync(join(f.dir, 'task.result.txt'), 'utf8'), args.result);
  fs.unlinkSync(f.stage);
  assert.equal((await f.call('submit_result', args)).structuredContent.accepted, true);
  const committed = fs.readFileSync(f.path);
  fs.writeFileSync(f.stage, 'blocked ack', { mode: 0o600 });
  assert.equal((await f.request('ack', { id: 'task' })).status, 503);
  assert.deepEqual(fs.readFileSync(f.path), committed);
  assert.equal((await f.request('status')).data.events.length, 1);
  assert.equal((await f.call('get_task', { token: task.token })).isError, false);
  fs.unlinkSync(f.stage);
  assert.equal((await f.request('ack', { id: 'task' })).status, 200);
  assert.equal((await f.call('get_task', { token: task.token })).isError, true);
});

test('controller can finish an identical ack after a failed rename, not silently cancel instead', async t => {
  const f = await workerFixture(t), task = await f.register('task');
  await f.call('submit_result', { token: task.token, status: 'completed', summary: 'done', result: 'evidence' });
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === f.stage) throw Object.assign(Error('fixture state rename'), { code: 'EPERM' });
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try { assert.equal((await f.request('ack', { id: 'task' })).status, 503); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  const pending = fs.readFileSync(f.stage);
  assert.equal((await f.request('cancel', { id: 'task' })).data.code, 'STATE_STAGING_CONFLICT');
  assert.deepEqual(fs.readFileSync(f.stage), pending);
  assert.equal((await f.request('ack', { id: 'task' })).status, 200);
  assert.equal((await f.call('get_task', { token: task.token })).isError, true);
});

for (const empty of [true, false]) {
  test(`worker restart refuses staged evidence beside ${empty ? 'empty' : 'active'} committed state`, async t => {
    const f = await workerFixture(t);
    if (empty) fs.writeFileSync(f.path, '[]');
    else await f.register('task');
    await f.close();
    const committed = fs.readFileSync(f.path);
    fs.writeFileSync(f.stage, '["interrupted transition"]', { mode: 0o600 });
    await assert.rejects(f.start({ dir: f.dir, port: 0, controlPort: 0 }), { code: 'STATE_STAGING_CONFLICT' });
    assert.deepEqual(fs.readFileSync(f.path), committed);
    assert.equal(fs.readFileSync(f.stage, 'utf8'), '["interrupted transition"]');
    assert.equal(fs.existsSync(join(f.dir, 'worker.lock')), false);
  });
}


test('readiness detects a pending stage before any mutation without erasing it', async t => {
  const f = await workerFixture(t);
  await f.register('task');
  const committed = fs.readFileSync(f.path);
  fs.writeFileSync(f.stage, 'pending evidence', { mode: 0o600 });
  const ready = await f.request('ready');
  assert.equal(ready.status, 503);
  assert.equal(ready.data.storage.code, 'STATE_STAGING_CONFLICT');
  assert.equal(ready.data.automaticRestartRecommended, false);
  const reconciliation = await f.request('reconcile');
  assert.equal(reconciliation.status, 200);
  assert.equal(reconciliation.data.health.ok, false);
  assert.equal(reconciliation.data.tasks[0].status, 'running');
  assert.deepEqual(fs.readFileSync(f.path), committed);
  assert.equal(fs.readFileSync(f.stage, 'utf8'), 'pending evidence');
});
