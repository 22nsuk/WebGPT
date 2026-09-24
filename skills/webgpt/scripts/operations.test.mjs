import { test } from 'node:test';
import { withStateWriteFailure } from './test-fixtures/state-write-failure.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, Server } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { start, tools } from './worker.mjs';
import { request, waitForTasks, collectTask, reconcileTasks, retryableControllerError } from './client.mjs';
import { acquireRuntimeLock, parseState, startupExitCode } from './runtime.mjs';

const temporary = () => mkdtempSync(join(tmpdir(), 'webgpt-operations-'));
async function fixture(fn, options = {}) {
  const base = temporary(), dir = join(base, 'runtime'), root = join(base, 'project');
  mkdirSync(root);
  let service = await start({ dir, port: 0, controlPort: 0, waitMs: 30, closeGraceMs: 50, ...options });
  const config = { dataDir: dir, controlPort: service.controlPort };
  const admin = (action, payload, opts) => request(action, payload, config, opts);
  const call = async (name, args) => {
    const suffix = options.publicMcp ? '/' + readFileSync(join(dir, 'mcp-path.key'), 'utf8') : '';
    const result = await fetch(`http://127.0.0.1:${service.mcpPort}/mcp${suffix}`, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await result.json()).result;
  };
  const register = (id, mode) => admin('register', { id, instructions: 'fixture-only private instructions', inputs: { source: 'private input' },
    ...(mode ? { workspace: { root, mode } } : {}) });
  const complete = (token, status = 'completed') => call('submit_result', { token, status, summary: status, result: 'retained 한국어 result' });
  const restart = async () => {
    await service.close(); service = await start({ dir, port: 0, controlPort: 0, waitMs: 30, closeGraceMs: 50, ...options });
    config.controlPort = service.controlPort;
  };
  try { await fn({ base, dir, root, config, admin, call, register, complete, restart, get service() { return service; } }); }
  finally { await service.close(); rmSync(base, { recursive: true, force: true }); }
}

for (const [description, owner, probe, code] of [
  ['live owner', { pid: process.pid, host: hostname() }, () => 'alive', 'LOCK_HELD'],
  ['unknown/access-denied owner', { pid: 1, host: hostname() }, () => 'unknown', 'LOCK_UNCERTAIN'],
  ['foreign host', { pid: 1, host: 'different-fixture-host' }, () => 'dead', 'LOCK_UNCERTAIN'],
  ['malformed PID', { pid: -1, host: hostname() }, () => 'dead', 'LOCK_UNCERTAIN'],
]) test(`lock refuses ${description} without deleting ownership evidence`, () => {
  const dir = temporary(), lock = join(dir, 'worker.lock'); mkdirSync(lock);
  const bytes = JSON.stringify(owner); writeFileSync(join(lock, 'owner.json'), bytes);
  try {
    assert.throws(() => acquireRuntimeLock(dir, { probe }), { code });
    assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8'), bytes);
    assert.equal(existsSync(join(dir, 'worker.recovery.lock')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dead legacy owner is archived; a second owner cannot start or steal by age', () => {
  const dir = temporary(), lock = join(dir, 'worker.lock'); mkdirSync(lock);
  const bytes = JSON.stringify({ pid: 1234, host: hostname() }); writeFileSync(join(lock, 'owner.json'), bytes);
  let ownership;
  try {
    ownership = acquireRuntimeLock(dir, { probe: () => 'dead' });
    const archives = readdirSync(dir).filter(name => name.startsWith('worker.lock.stale-'));
    assert.equal(archives.length, 1);
    assert.equal(readFileSync(join(dir, archives[0], 'owner.json'), 'utf8'), bytes);
    assert.throws(() => acquireRuntimeLock(dir), { code: 'LOCK_HELD' });
  } finally { ownership?.release(); rmSync(dir, { recursive: true, force: true }); }
});

test('incomplete owner and recovery guard fail closed', () => {
  const dir = temporary(); mkdirSync(join(dir, 'worker.lock'));
  try {
    assert.throws(() => acquireRuntimeLock(dir), { code: 'LOCK_UNCERTAIN' });
    mkdirSync(join(dir, 'worker.recovery.lock'));
    assert.throws(() => acquireRuntimeLock(dir), { code: 'LOCK_UNCERTAIN' });
    assert.ok(existsSync(join(dir, 'worker.lock')));
    assert.ok(existsSync(join(dir, 'worker.recovery.lock')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('release refuses a replacement owner', () => {
  const dir = temporary(), ownership = acquireRuntimeLock(dir);
  const file = join(dir, 'worker.lock', 'owner.json'), old = readFileSync(file);
  const next = { ...JSON.parse(old), instanceId: randomUUID() }; writeFileSync(file, JSON.stringify(next));
  try {
    assert.throws(() => ownership.release(), { code: 'LOCK_UNCERTAIN' });
    assert.equal(JSON.parse(readFileSync(file)).instanceId, next.instanceId);
    writeFileSync(file, old); ownership.release(); ownership.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('actual killed lock owner can be recovered without PID signalling beyond existence checks', async () => {
  const dir = temporary(); let child, ownership;
  try {
    const module = new URL('./runtime.mjs', import.meta.url).href;
    child = spawn(process.execPath, ['--input-type=module', '-e',
      `import {acquireRuntimeLock} from ${JSON.stringify(module)}; acquireRuntimeLock(${JSON.stringify(dir)}); process.send('locked'); setInterval(()=>{},1000);`],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    await once(child, 'message');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    ownership = acquireRuntimeLock(dir);
    assert.equal(readdirSync(dir).filter(name => name.startsWith('worker.lock.stale-')).length, 1);
  } finally { if (child?.exitCode === null && child?.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
    ownership?.release(); rmSync(dir, { recursive: true, force: true }); }
});

for (const bytes of [Buffer.from('{'), Buffer.from('{}'), Buffer.from('[null]'), Buffer.from([0xff])])
  test(`invalid state bytes ${bytes.toString('hex')} stop startup and preserve bytes`, async () => {
    const dir = temporary(); writeFileSync(join(dir, 'state.json'), bytes);
    try {
      await assert.rejects(start({ dir, port: 0, controlPort: 0 }), { code: 'STATE_INVALID' });
      assert.deepEqual(readFileSync(join(dir, 'state.json')), bytes);
      assert.equal(existsSync(join(dir, 'worker.lock')), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

test('structural validation rejects duplicate IDs/tokens, path escapes and malformed workspace roots', () => {
  const dir = temporary(), valid = { id: 'a', token: 'test-only', instructions: '', inputs: {}, status: 'running', collected: false, nextCheck: 1 };
  try {
    for (const tasks of [[valid, { ...valid, id: 'A', token: 'another' }], [valid, { ...valid, id: 'b' }],
      [{ ...valid, id: '../outside' }], [{ ...valid, workspace: { root: 42, mode: 'read', device: 0, inode: 0 } }]])
      assert.throws(() => parseState(Buffer.from(JSON.stringify(tasks)), dir), { code: 'STATE_INVALID' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const evidence of ['state.json.tmp', 'a.result.txt', 'recovery']) test(`missing state beside ${evidence} does not silently become empty`, async () => {
  const dir = temporary(); if (evidence === 'recovery') mkdirSync(join(dir, evidence)); else writeFileSync(join(dir, evidence), 'evidence');
  try {
    await assert.rejects(start({ dir, port: 0, controlPort: 0 }), { code: 'STATE_INVALID' });
    assert.ok(existsSync(join(dir, evidence))); assert.equal(existsSync(join(dir, 'state.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an interrupted recovery guard also blocks startup when the old lock was already archived', () => {
  const dir = temporary(); mkdirSync(join(dir, 'worker.recovery.lock'));
  try {
    assert.throws(() => acquireRuntimeLock(dir), { code: 'LOCK_UNCERTAIN' });
    assert.equal(existsSync(join(dir, 'worker.lock')), false);
    assert.ok(existsSync(join(dir, 'worker.recovery.lock')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('release preserves owner evidence beside an unexpected lock entry', () => {
  const dir = temporary(), ownership = acquireRuntimeLock(dir);
  const file = join(dir, 'worker.lock', 'owner.json'), old = readFileSync(file);
  const extra = join(dir, 'worker.lock', 'unexpected'); writeFileSync(extra, 'evidence');
  try {
    assert.throws(() => ownership.release(), { code: 'LOCK_UNCERTAIN' });
    assert.deepEqual(readFileSync(file), old);
    unlinkSync(extra); ownership.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a previously registered read-only task cannot disappear into an empty runtime after state loss', () => fixture(async f => {
  await f.register('read-only', 'read');
  await f.service.close();
  assert.ok(existsSync(join(f.dir, 'state.initialized')));
  assert.equal(existsSync(join(f.dir, 'recovery')), false);
  unlinkSync(join(f.dir, 'state.json'));
  await assert.rejects(f.restart(), { code: 'STATE_INVALID' });
  assert.equal(existsSync(join(f.dir, 'state.json')), false);
}));

test('never-registered runtimes with keys remain valid, and legacy valid state gains a marker', () => fixture(async f => {
  await f.restart();
  assert.equal(existsSync(join(f.dir, 'state.initialized')), false);
  const task = await f.register('legacy');
  await f.service.close();
  unlinkSync(join(f.dir, 'state.initialized'));
  await f.restart();
  assert.ok(existsSync(join(f.dir, 'state.initialized')));
  assert.equal((await f.call('get_task', { token: task.token })).structuredContent.status, 'running');
}));

for (const tamper of ['delete', 'corrupt']) test(`initialization marker ${tamper} is detected before any further state transition`, () => fixture(async f => {
  await f.register('a');
  const before = readFileSync(join(f.dir, 'state.json'));
  const marker = join(f.dir, 'state.initialized');
  if (tamper === 'delete') unlinkSync(marker); else writeFileSync(marker, 'corrupt evidence');
  await assert.rejects(f.admin('ready'), e => e.details.issues.includes('STATE_INVALID'));
  await assert.rejects(f.register('b'), { code: 'STATE_INVALID' });
  assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
  if (tamper === 'corrupt') {
    await f.service.close();
    await assert.rejects(f.restart(), { code: 'STATE_INVALID' });
    assert.equal(readFileSync(marker, 'utf8'), 'corrupt evidence');
  }
}));

test('the first failed state commit leaves durable initialization evidence', () => fixture(async f => {
  mkdirSync(join(f.dir, 'state.json.tmp'));
  await assert.rejects(f.register('a'));
  assert.ok(existsSync(join(f.dir, 'state.initialized')));
  assert.equal(existsSync(join(f.dir, 'state.json')), false);
  // Remove only the injected fault; the initialization marker must suffice.
  rmSync(join(f.dir, 'state.json.tmp'), { recursive: true });
  await f.service.close();
  await assert.rejects(f.restart(), { code: 'STATE_INVALID' });
}));

test('public liveness is not private readiness and never exposes task or key data', () => fixture(async f => {
  const task = await f.register('a');
  const live = await fetch(`http://127.0.0.1:${f.service.mcpPort}/health`);
  assert.deepEqual(await live.json(), { ok: true, name: 'WebGPT Worker' });
  assert.equal((await fetch(`http://127.0.0.1:${f.service.mcpPort}/ready`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${f.service.controlPort}/ready`)).status, 401);
  const origin = await fetch(`http://127.0.0.1:${f.service.controlPort}/ready`, { headers: { authorization: 'Bearer ' + f.service.key, origin: 'https://example.invalid' } });
  assert.equal(origin.status, 403);
  const ready = await f.admin('ready'); assert.equal(ready.ok, true);
  for (const secret of [task.token, f.service.key, 'private instructions']) assert.equal(JSON.stringify(ready).includes(secret), false);
  assert.equal(readdirSync(f.dir).some(name => name.startsWith('.health-')), false);
}, { publicMcp: true }));

test('external state corruption leaves liveness up, readiness down, and blocks new mutations without replacing evidence', () => fixture(async f => {
  const a = await f.register('a', 'edit'); const bytes = '{corrupt evidence';
  writeFileSync(join(f.dir, 'state.json'), bytes);
  await assert.rejects(f.admin('ready'), e => e.statusCode === 503 && e.details.issues.includes('STATE_INVALID'));
  assert.equal((await fetch(`http://127.0.0.1:${f.service.mcpPort}/health`)).status, 200);
  assert.equal((await f.call('write_file', { token: a.token, path: 'no.txt', text: 'no', expectedSha256: null })).isError, true);
  await assert.rejects(f.register('b'), e => e.code === 'STATE_INVALID' && !e.retryable);
  assert.equal(existsSync(join(f.root, 'no.txt')), false);
  assert.equal(readFileSync(join(f.dir, 'state.json'), 'utf8'), bytes);
}));

test('storage failure interrupts waits, does not falsely accept completion, and clears only after a successful persist', () => fixture(async f => {
  const a = await f.register('a'); mkdirSync(join(f.dir, 'state.json.tmp'));
  assert.equal((await f.complete(a.token)).isError, true);
  assert.equal((await f.call('get_task', { token: a.token })).structuredContent.status, 'running');
  await assert.rejects(f.admin('ready'), e => e.statusCode === 503 && e.details.issues.includes('STORAGE_UNAVAILABLE'));
  const waiting = await waitForTasks(['a'], f.config); assert.equal(waiting.interrupted, true);
  rmSync(join(f.dir, 'state.json.tmp'), { recursive: true });
  await assert.rejects(f.admin('ready'), e => e.statusCode === 503); // A canary alone does not clear a failed real write.
  assert.equal((await f.complete(a.token)).isError, false);
  assert.equal((await f.admin('ready')).ok, true);
  assert.equal((await collectTask('a', f.config)).integrity, 'verified');
}));

test('corrupt journal blocks the affected task without replay or stopping unrelated tasks', () => fixture(async f => {
  const a = await f.register('a', 'edit'), b = await f.register('b', 'edit');
  const recovery = join(f.dir, 'recovery', 'a'); mkdirSync(recovery, { recursive: true });
  const path = join(recovery, randomUUID() + '.json'); writeFileSync(path, '{evidence');
  await assert.rejects(f.admin('ready'), e => e.details.recoveryRequired.includes('a'));
  assert.equal((await f.call('write_file', { token: a.token, path: 'no.txt', text: 'no', expectedSha256: null })).isError, true);
  assert.equal((await f.complete(a.token)).isError, true);
  assert.equal((await f.call('write_file', { token: b.token, path: 'yes.txt', text: 'yes', expectedSha256: null })).isError, false);
  assert.equal(readFileSync(path, 'utf8'), '{evidence');
  assert.equal((await f.complete(a.token, 'failed')).isError, false);
  const snapshot = await reconcileTasks(f.config);
  assert.equal(snapshot.tasks.find(t => t.id === 'a').attention, 'inspect_recovery');
}));

test('an applied but unrecorded mutation is restored from its receipt after restart without replaying project writes', t => fixture(async f => {
  const a = await f.register('a', 'edit');
  const changed = await withStateWriteFailure(t, f.dir, () => f.call('write_file', { token: a.token, path: 'a.txt', text: 'first', expectedSha256: null }));
  assert.equal(changed.isError, true);
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'first');
  writeFileSync(join(f.root, 'a.txt'), 'later parent edit');
  await f.restart();
  const task = (await f.call('get_task', { token: a.token })).structuredContent;
  assert.equal(task.changes.length, 1); assert.deepEqual(task.recoveryRequired, []);
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'later parent edit');
  assert.equal((await f.admin('ready')).ok, true);
}));

test('workspace unavailability is diagnosed independently of worker liveness', () => fixture(async f => {
  await f.register('a', 'read'); renameSync(f.root, f.root + '-moved');
  await assert.rejects(f.admin('ready'), e => e.details.unavailableWorkspaces.includes('a'));
  assert.equal((await fetch(`http://127.0.0.1:${f.service.mcpPort}/health`)).status, 200);
}));

test('shutdown is authenticated, drains an in-flight wait, is idempotent, and preserves running tasks', t => fixture(async f => {
  const a = await f.register('a');
  assert.equal((await fetch(`http://127.0.0.1:${f.service.controlPort}/shutdown`, { method: 'POST', body: '{}' })).status, 401);
  await assert.rejects(f.admin('shutdown', { extra: true }), /empty object/);
  // The GET handler installs its waiter synchronously. Observe its real request
  // after that handler returns, instead of guessing acceptance from elapsed time.
  let accepted;
  const waitAccepted = new Promise(resolve => { accepted = resolve; });
  const originalEmit = Server.prototype.emit;
  const observeRequest = t.mock.method(Server.prototype, 'emit', function (event, ...args) {
    const emitted = Reflect.apply(originalEmit, this, [event, ...args]);
    if (event === 'request' && this.address()?.port === f.service.controlPort
        && args[0].method === 'GET' && args[0].url === '/wait?id=a')
      accepted(!args[1].headersSent && !args[1].writableEnded);
    return emitted;
  });
  const waiting = f.admin('wait', { ids: ['a'] });
  assert.equal(await Promise.race([waitAccepted, waiting.then(() => false)]), true,
    'the scoped wait must be accepted and pending before shutdown');
  observeRequest.mock.restore();
  assert.equal((await f.admin('shutdown', {})).accepted, true);
  assert.equal((await waiting).interrupted, true);
  await Promise.all([f.service.close(), f.service.close()]);
  assert.equal(existsSync(join(f.dir, 'worker.lock')), false);
  await f.restart();
  assert.equal((await f.call('get_task', { token: a.token })).structuredContent.status, 'running');
// Use the production long-poll duration for this shutdown test; its completion
// must come from shutdown, not the fixture's 30 ms timeout expiring under CI load.
}, { waitMs: 55000 }));

test('bounded drain closes a partial request without accepting its late body', () => fixture(async f => {
  const socket = connect(f.service.controlPort, '127.0.0.1'); await once(socket, 'connect');
  socket.on('error', () => {});
  socket.write(`POST /register HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${f.service.key}\r\nContent-Length: 1000\r\n\r\n{`);
  await delay(5); const begun = Date.now(); await f.service.close(); socket.destroy();
  assert.ok(Date.now() - begun < 2000);
  assert.equal(existsSync(join(f.dir, 'state.json')), false);
  assert.equal(existsSync(join(f.dir, 'worker.lock')), false);
}));

test('reconciliation includes collected and cancelled tasks, checks retained hashes, and never acknowledges or cancels', () => fixture(async f => {
  const a = await f.register('a'), b = await f.register('b'), c = await f.register('c');
  await f.register('running'); await f.complete(a.token); await f.complete(b.token);
  await collectTask('a', f.config); await f.admin('cancel', { id: 'c' });
  const before = readFileSync(join(f.dir, 'state.json'));
  let result = await reconcileTasks(f.config);
  assert.equal(result.browserChecked, false);
  assert.equal(result.tasks.find(t => t.id === 'a').integrity, 'verified');
  assert.equal(result.tasks.find(t => t.id === 'a').attention, 'already_collected_or_cancelled');
  assert.equal(result.tasks.find(t => t.id === 'b').attention, 'collect_saved_result');
  assert.equal(result.tasks.find(t => t.id === 'c').integrity, 'not_expected');
  assert.equal(result.tasks.find(t => t.id === 'running').attention, 'inspect_retained_chat');
  assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
  assert.equal(JSON.stringify(result).includes(b.token), false);
  writeFileSync(join(f.dir, 'a.result.txt'), 'corrupted'); unlinkSync(join(f.dir, 'b.result.txt'));
  result = await reconcileTasks(f.config);
  assert.equal(result.tasks.find(t => t.id === 'a').integrity, 'mismatch_or_unreadable');
  assert.equal(result.tasks.find(t => t.id === 'b').integrity, 'missing');
  assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
}));

async function transportFixture(handler, fn) {
  const dir = temporary(); writeFileSync(join(dir, 'controller.key'), 'fixture-only');
  let count = 0;
  const server = createServer((req, res) => handler(req, res, ++count));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn({ config: { dataDir: dir, controlPort: server.address().port }, count: () => count }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
}

test('transport disconnects use a finite budget and never replay POST operations', async () => {
  await transportFixture((req, res) => req.socket.destroy(), async f => {
    await assert.rejects(waitForTasks(['a'], f.config, { retryDelays: [0, 0, 0] }));
    assert.equal(f.count(), 4);
    await assert.rejects(request('register', { id: 'a', instructions: '', inputs: {} }, f.config));
    assert.equal(f.count(), 5);
  });
});

test('temporary disconnect followed by a healthy result renews the same scoped read', async () => {
  await transportFixture((req, res, count) => {
    if (count === 1) return req.socket.destroy();
    assert.equal(req.url, '/wait?id=a'); res.end(JSON.stringify({ events: [], backupDue: ['a'], settled: false }));
  }, async f => {
    const result = await waitForTasks(['a'], f.config, { retryDelays: [0] });
    assert.deepEqual(result.backupDue, ['a']); assert.equal(f.count(), 2);
  });
});

test('healthy empty renewals do not reset a scoped wait transport retry budget', async () => {
  await transportFixture((req, res, count) => {
    if (count % 2) return req.socket.destroy();
    res.end(JSON.stringify({ events: [], backupDue: [], settled: false }));
  }, async f => {
    await assert.rejects(waitForTasks(['a'], f.config, { retryDelays: [0, 0, 0] }));
    assert.equal(f.count(), 7);
  });
});

for (const status of [400, 401, 403, 503]) test(`HTTP ${status} data/config errors are not retried`, async () => {
  await transportFixture((req, res) => { res.writeHead(status); res.end(JSON.stringify({ code: 'STATE_INVALID', error: 'inspect evidence' })); }, async f => {
    await assert.rejects(waitForTasks(['a'], f.config, { retryDelays: [0, 0, 0] }));
    assert.equal(f.count(), 1);
  });
});

test('classification does not retry local errors or invent new MCP capabilities', () => {
  assert.equal(retryableControllerError(Object.assign(Error(), { code: 'ENOENT' })), false);
  assert.equal(retryableControllerError(new SyntaxError('JSON')), false);
  assert.deepEqual(tools.map(t => t.name), ['list_files', 'read_file', 'write_file', 'delete_file', 'get_task', 'read_input', 'submit_result']);
  for (const [code, status] of [['STATE_INVALID', 65], ['LOCK_UNCERTAIN', 73], ['CONFIG_INVALID', 78], ['ENOSPC', 74]])
    assert.equal(startupExitCode({ code }), status);
});

// Restart is a local operational authority, not permission for delegated self-update.
test('grants cannot include the running scripts that an unattended restart would execute', () => fixture(async f => {
  for (const path of ['.', '..']) {
    const root = fileURLToPath(new URL(path + '/', import.meta.url));
    for (const mode of ['read', 'edit'])
      await assert.rejects(f.admin('register', { id: 'self-edit', instructions: '', inputs: {}, workspace: { root, mode } }), /workspace overlaps running worker code/);
  }
  assert.equal((await f.admin('tasks')).tasks.length, 0);
}));
