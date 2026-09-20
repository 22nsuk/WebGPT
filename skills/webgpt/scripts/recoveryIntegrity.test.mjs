import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { start } from './worker.mjs';
import { request, reconcileTasks, collectTask } from './client.mjs';
import { processState } from './runtime.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
async function fixture(run) {
  const base = mkdtempSync(join(tmpdir(), 'webgpt-integrity-'));
  const dir = join(base, 'runtime'), root = join(base, 'project'); mkdirSync(root);
  let service = await start({ dir, port: 0, controlPort: 0, waitMs: 20, closeGraceMs: 50 });
  const config = { dataDir: dir, controlPort: service.controlPort };
  const admin = (action, payload) => request(action, payload, config);
  const call = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${service.mcpPort}/mcp`, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await response.json()).result;
  };
  const register = (id = 'a', mode = 'edit') => admin('register', {
    id, instructions: 'fixture only', inputs: {}, workspace: { root, mode },
  });
  const submit = (token, result = 'saved 한국어 evidence', status = 'completed') => call('submit_result', { token, result, status, summary: 'fixture result' });
  const restart = async () => {
    await service.close();
    service = await start({ dir, port: 0, controlPort: 0, waitMs: 20, closeGraceMs: 50 }); config.controlPort = service.controlPort;
  };
  try { await run({ base, dir, root, config, admin, call, register, submit, restart }); }
  finally { await service.close(); rmSync(base, { recursive: true, force: true }); }
}

async function leaveUncommittedResult(f, token) {
  const fault = join(f.dir, 'state.json.tmp'); mkdirSync(fault);
  assert.equal((await f.submit(token)).isError, true);
  rmSync(fault, { recursive: true });
  assert.equal(readFileSync(join(f.dir, 'a.result.txt'), 'utf8'), 'saved 한국어 evidence');
}

test('a result saved before a failed state commit is visible on read-only reconciliation after restart', () => fixture(async f => {
  const { token } = await f.register(); await leaveUncommittedResult(f, token); await f.restart();
  const state = readFileSync(join(f.dir, 'state.json'));
  const result = await reconcileTasks(f.config), task = result.tasks.find(t => t.id === 'a');
  assert.equal(task.status, 'running'); assert.equal(task.artifact, null);
  assert.equal(task.attention, 'inspect_uncommitted_result');
  assert.equal(task.pendingResults[0].sha256, hash('saved 한국어 evidence'));
  assert.equal(task.pendingResults[0].artifact, join(f.dir, 'a.result.txt'));
  assert.equal(task.pendingResults[0].integrity, 'uncommitted');
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.deepEqual(readFileSync(join(f.dir, 'state.json')), state);
}));

test('a changed submission cannot overwrite an uncommitted result', () => fixture(async f => {
  const { token } = await f.register(); await leaveUncommittedResult(f, token); await f.restart();
  const reply = await f.submit(token, 'replacement that would erase the first result');
  assert.equal(reply.isError, true);
  assert.equal(readFileSync(join(f.dir, 'a.result.txt'), 'utf8'), 'saved 한국어 evidence');
  assert.equal((await f.call('get_task', { token })).structuredContent.status, 'running');
}));

test('an identical retry can commit preserved bytes, then collection still verifies and revokes the token', () => fixture(async f => {
  const { token } = await f.register(); await leaveUncommittedResult(f, token); await f.restart();
  assert.equal((await f.submit(token)).isError, false);
  assert.equal((await collectTask('a', f.config)).integrity, 'verified');
  assert.equal((await f.call('get_task', { token })).isError, true);
}));

for (const suffix of ['.tmp', '']) test(`a different result cannot erase existing ${suffix || 'final'} candidate evidence`, () => fixture(async f => {
  const { token } = await f.register();
  const file = join(f.dir, 'a.result.txt' + suffix); writeFileSync(file, 'first candidate');
  assert.equal((await f.submit(token, 'different candidate')).isError, true);
  assert.equal(readFileSync(file, 'utf8'), 'first candidate');
}));

for (const tamper of ['missing', 'changed']) test(`a duplicate terminal submission does not claim success for ${tamper} artifact bytes`, () => fixture(async f => {
  const { token } = await f.register(); assert.equal((await f.submit(token)).isError, false);
  const file = join(f.dir, 'a.result.txt');
  if (tamper === 'missing') unlinkSync(file); else writeFileSync(file, 'changed evidence');
  const state = readFileSync(join(f.dir, 'state.json'));
  assert.equal((await f.submit(token)).isError, true);
  assert.deepEqual(readFileSync(join(f.dir, 'state.json')), state);
  if (tamper === 'missing') assert.equal(existsSync(file), false); else assert.equal(readFileSync(file, 'utf8'), 'changed evidence');
}));

for (const restart of [false, true]) test(`a missing committed journal blocks only its task${restart ? ' after restart' : ''}`, () => fixture(async f => {
  const { token } = await f.register();
  const receipt = (await f.call('write_file', { token, path: 'evidence.txt', text: 'v1', expectedSha256: null })).structuredContent;
  unlinkSync(join(f.dir, 'recovery', 'a', receipt.operation + '.json'));
  if (restart) await f.restart();
  await assert.rejects(f.admin('ready'), error => error.details.issues.includes('RECOVERY_REQUIRED'));
  assert.equal((await f.call('write_file', { token, path: 'evidence.txt', text: 'v2', expectedSha256: receipt.afterSha256 })).isError, true);
  assert.equal(readFileSync(join(f.root, 'evidence.txt'), 'utf8'), 'v1');
  assert.equal((await f.submit(token)).isError, true);
  const other = await f.register('unrelated'); assert.equal((await f.submit(other.token)).isError, false);
  assert.equal((await f.call('read_file', { token, path: 'evidence.txt' })).isError, false);
}));

for (const action of ['wait', 'tasks', 'status']) test(`${action} does not return a healthy stale snapshot after state loss`, () => fixture(async f => {
  await f.register(); writeFileSync(join(f.dir, 'state.json'), '{corrupt evidence');
  await assert.rejects(f.admin(action, action === 'wait' ? { ids: ['a'] } : undefined), { code: 'STATE_INVALID' });
  assert.equal(readFileSync(join(f.dir, 'state.json'), 'utf8'), '{corrupt evidence');
  assert.equal((await reconcileTasks(f.config)).health.ok, false);
}));

test('an already parked wait verifies state again before sending its timeout response', () => fixture(async f => {
  await f.register();
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const originalRead = fs.readFileSync, statePath = join(f.dir, 'state.json');
  let checked = false;
  // Inject the change just after the request's first successful state read.
  // This avoids a timing assumption about when the long poll was accepted.
  fs.readFileSync = (path, ...args) => {
    const bytes = originalRead(path, ...args);
    if (path === statePath && !checked) {
      checked = true; writeFileSync(statePath, '{corrupt while waiting');
    }
    return bytes;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.admin('wait', { ids: ['a'] }), { code: 'STATE_INVALID' });
    assert.equal(checked, true);
    assert.equal(originalRead(statePath, 'utf8'), '{corrupt while waiting');
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
}));

async function ownedWorker(run) {
  const base = mkdtempSync(join(tmpdir(), 'webgpt-ipc-')), dir = join(base, 'runtime');
  const configPath = join(base, 'config.json');
  // start() accepts test ports, configuration() does not; reserve distinct ephemeral ports first.
  const { createServer } = await import('node:net');
  const servers = [createServer(), createServer()];
  await Promise.all(servers.map(s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve))));
  const config = { dataDir: dir, mcpPort: servers[0].address().port, controlPort: servers[1].address().port };
  await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
  writeFileSync(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], {
    env: { ...process.env, WEBGPT_CONFIG: configPath, WEBGPT_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const exit = once(child, 'exit');
  const until = async predicate => {
    const controller = new AbortController();
    try {
      await Promise.race([
        (async () => { while (!await predicate()) await delay(10, undefined, { signal: controller.signal }); })(),
        delay(2500, undefined, { signal: controller.signal }).then(() => { throw Error('fixture deadline: ' + stderr); }),
      ]);
    } finally { controller.abort(); }
  };
  try { await run({ child, dir, config, exit, until, listening: () => stdout.includes('"event":"listening"') }); }
  finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    rmSync(base, { recursive: true, force: true });
  }
}

for (const early of [false, true]) test(`owned Worker drains when IPC is lost ${early ? 'during startup' : 'after listening'}`, () => ownedWorker(async f => {
  if (!early) { await f.until(f.listening); await request('register', { id: 'survives', instructions: '', inputs: {} }, f.config); }
  f.child.disconnect();
  await f.until(() => f.child.exitCode !== null || f.child.signalCode !== null);
  assert.deepEqual(await f.exit, [0, null]);
  assert.equal(existsSync(join(f.dir, 'worker.lock')), false);
  if (!early) assert.equal(JSON.parse(readFileSync(join(f.dir, 'state.json')))[0].status, 'running');
}));

test('an identical staged result resumes without rewriting its bytes', () => fixture(async f => {
  const { token } = await f.register();
  const temporary = join(f.dir, 'a.result.txt.tmp'); writeFileSync(temporary, 'saved 한국어 evidence');
  assert.equal((await f.submit(token)).isError, false);
  assert.equal(existsSync(temporary), false);
  assert.equal((await collectTask('a', f.config)).integrity, 'verified');
}));

test('conflicting final and temporary results are both preserved', () => fixture(async f => {
  const { token } = await f.register();
  const file = join(f.dir, 'a.result.txt'), temporary = file + '.tmp';
  writeFileSync(file, 'saved 한국어 evidence'); writeFileSync(temporary, 'partial competing evidence');
  assert.equal((await f.submit(token)).isError, true);
  assert.equal(readFileSync(file, 'utf8'), 'saved 한국어 evidence');
  assert.equal(readFileSync(temporary, 'utf8'), 'partial competing evidence');
  assert.equal((await reconcileTasks(f.config)).tasks[0].pendingResults.length, 2);
}));

test('an unreadable staged result is reported without reading a directory or deleting evidence', () => fixture(async f => {
  const { token } = await f.register(); const temporary = join(f.dir, 'a.result.txt.tmp'); mkdirSync(temporary);
  writeFileSync(join(temporary, 'evidence'), 'keep');
  assert.equal((await f.submit(token)).isError, true);
  const pending = (await reconcileTasks(f.config)).tasks[0].pendingResults;
  assert.equal(pending[0].integrity, 'unreadable'); assert.equal(pending[0].code, 'RESULT_INVALID');
  assert.equal(readFileSync(join(temporary, 'evidence'), 'utf8'), 'keep');
}));

test('cancellation preserves an uncommitted result and includes it on reconciliation', () => fixture(async f => {
  const { token } = await f.register(); await leaveUncommittedResult(f, token); await f.restart();
  await f.admin('cancel', { id: 'a' });
  const task = (await reconcileTasks(f.config)).tasks[0];
  assert.equal(task.status, 'cancelled'); assert.equal(task.collected, true);
  assert.equal(task.attention, 'inspect_uncommitted_result');
  assert.equal(task.pendingResults[0].sha256, hash('saved 한국어 evidence'));
  assert.equal((await f.call('get_task', { token })).isError, true);
}));

test('pending result readiness and scoped wait require inspection, not automatic restart or unrelated wakeups', () => fixture(async f => {
  const { token } = await f.register(); await f.register('other');
  await leaveUncommittedResult(f, token); await f.restart();
  await assert.rejects(f.admin('ready'), error => error.details.issues.includes('RESULT_RECOVERY_REQUIRED')
    && error.details.pendingResultTasks.join() === 'a' && error.details.automaticRestartRecommended === false);
  const { waitForTasks } = await import('./client.mjs');
  const notice = await waitForTasks(['a'], f.config, { signal: AbortSignal.timeout(1000) });
  assert.deepEqual(notice.resultRecoveryRequired, [{ id: 'a' }]);
  assert.equal((await f.admin('wait', { ids: ['other'] })).resultRecoveryRequired, undefined);
  assert.equal((await f.submit(token)).isError, false);
  assert.equal((await f.admin('ready')).ok, true);
}));

test('pending result blocks further file edits only for its task without blocking reads', () => fixture(async f => {
  const { token } = await f.register(); const other = await f.register('other');
  writeFileSync(join(f.dir, 'a.result.txt'), 'saved 한국어 evidence');
  const edit = { path: 'after-result.txt', text: 'new', expectedSha256: null };
  assert.equal((await f.call('write_file', { token, ...edit })).isError, true);
  assert.equal(existsSync(join(f.root, edit.path)), false);
  assert.equal((await f.call('read_file', { token, path: edit.path })).isError, false);
  assert.equal((await f.call('write_file', { token: other.token, ...edit })).isError, false);
}));

test('a legacy result temporary file alone is enough to prevent silently creating an empty runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-lost-state-')); let service;
  const candidate = join(dir, 'legacy.result.txt.tmp'); writeFileSync(candidate, 'orphaned evidence');
  try {
    await assert.rejects(async () => { service = await start({ dir, port: 0, controlPort: 0 }); }, { code: 'STATE_INVALID' });
    assert.equal(readFileSync(candidate, 'utf8'), 'orphaned evidence');
    assert.equal(existsSync(join(dir, 'state.json')), false);
  } finally { await service?.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const value of ['invalid', [{ id: 'outside-scope' }]]) test(`new result recovery notices reject ${typeof value === 'string' ? 'malformed' : 'out-of-scope'} scoped responses`, async () => {
  const { createServer } = await import('node:http');
  const { waitForTasks } = await import('./client.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-result-scope-')); writeFileSync(join(dir, 'controller.key'), 'fixture-key');
  let calls = 0;
  const server = createServer((req, res) => { calls++; res.end(JSON.stringify({ events: [], backupDue: [], settled: false, resultRecoveryRequired: value })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(waitForTasks(['a'], { dataDir: dir, controlPort: server.address().port }, { signal: AbortSignal.timeout(1000) }),
      /does not support task-scoped waits|outside the requested task scope/);
    assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});

test('actual supervisor death permits verified drain or dead-owner recovery and resumes saved tasks', async () => {
  const { createServer } = await import('node:net');
  const { requestServiceStop } = await import('./service.mjs');
  const base = mkdtempSync(join(tmpdir(), 'webgpt-owner-death-')), dir = join(base, 'runtime'), configPath = join(base, 'config.json');
  const servers = [createServer(), createServer()];
  await Promise.all(servers.map(s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve))));
  const config = { dataDir: dir, mcpPort: servers[0].address().port, controlPort: servers[1].address().port };
  await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve)))); writeFileSync(configPath, JSON.stringify(config));
  const env = { ...process.env, WEBGPT_CONFIG: configPath, WEBGPT_DATA_DIR: dir };
  const source = `import {spawn} from 'node:child_process';
    import {runService} from ${JSON.stringify(new URL('./service.mjs', import.meta.url).href)};
    process.exitCode = await runService(process.env, {spawnWorker: (...args) => {
      const child=spawn(...args); process.send({workerPid: child.pid}); return child;
    }}); process.disconnect();`;
  const launches = [];
  const launch = () => {
    const parent = spawn(process.execPath, ['--input-type=module', '-e', source], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const item = { parent, exit: once(parent, 'exit'), workerPid: null };
    parent.on('message', value => { item.workerPid = value.workerPid; }); launches.push(item); return item;
  };
  const until = async predicate => {
    const end = Date.now() + 4000;
    while (Date.now() < end) { if (await predicate()) return; await delay(10); }
    throw Error('supervisor fixture deadline');
  };
  const ready = async () => { try { return (await request('ready', undefined, config, { timeoutMs: 250 })).ok; } catch { return false; } };
  try {
    const first = launch(); await until(ready);
    const task = await request('register', { id: 'retained', instructions: '', inputs: {} }, config);
    assert.ok(Number.isSafeInteger(first.workerPid));
    first.parent.kill('SIGKILL'); await first.exit;
    // Windows may terminate the descendant tree together with the supervisor.
    // A surviving child must drain through IPC; a killed child leaves ownership
    // evidence that the replacement must verify and archive before starting.
    const workerLock = join(dir, 'worker.lock');
    await until(() => !existsSync(workerLock) || processState(first.workerPid) === 'dead');
    const needsRecovery = existsSync(workerLock);
    if (needsRecovery) {
      assert.equal(processState(first.workerPid), 'dead');
      assert.equal(JSON.parse(readFileSync(join(workerLock, 'owner.json'))).pid, first.workerPid);
    }
    const second = launch(); await until(ready);
    assert.notEqual(second.workerPid, first.workerPid);
    if (needsRecovery) {
      const archives = readdirSync(dir).filter(name => name.startsWith('worker.lock.stale-'));
      assert.equal(archives.length, 1);
      assert.equal(JSON.parse(readFileSync(join(dir, archives[0], 'owner.json'))).pid, first.workerPid);
    }
    const reply = await fetch(`http://127.0.0.1:${config.mcpPort}/mcp`, { method: 'POST', body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_task', arguments: { token: task.token } },
    }) });
    assert.equal((await reply.json()).result.structuredContent.status, 'running');
    requestServiceStop(env); await second.exit;
    assert.equal(existsSync(join(dir, 'worker.lock')), false);
    assert.equal(existsSync(join(dir, 'service.lock')), false);
  } finally {
    // Only descendants created by this fixture may be killed; never a service
    // discovered by a port or a PID taken from unrelated runtime data.
    for (const item of launches) {
      if (item.parent.exitCode === null && item.parent.signalCode === null) { item.parent.kill('SIGKILL'); await item.exit; }
      if (item.workerPid && existsSync(join(dir, 'worker.lock', 'owner.json'))) {
        const owner = JSON.parse(readFileSync(join(dir, 'worker.lock', 'owner.json'), 'utf8'));
        if (owner.pid === item.workerPid) { try { process.kill(item.workerPid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
      }
    }
    rmSync(base, { recursive: true, force: true });
  }
});

for (const suffix of ['', '.tmp']) test(`a surviving ${suffix || 'final'} candidate is flushed before state can commit`, () => fixture(async f => {
  const { token } = await f.register();
  const file = join(f.dir, 'a.result.txt' + suffix); writeFileSync(file, 'saved 한국어 evidence');
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  // Keep the original inode allocated even if a defective implementation replaces
  // the path; a new state tempfile must not be mistaken for this candidate.
  const held = fs.openSync(file, 'r');
  const candidate = fs.fstatSync(held), originalFlush = fs.fsyncSync;
  let checked = 0;
  // Inject failure only for this fixture's candidate inode; state and other files
  // retain their real filesystem implementation. Restore even when the test fails.
  fs.fsyncSync = fd => {
    const info = fs.fstatSync(fd);
    if (info.dev === candidate.dev && info.ino === candidate.ino) {
      checked++; throw Object.assign(Error('fixture result flush failure'), { code: 'EIO' });
    }
    return originalFlush(fd);
  };
  syncBuiltinESMExports();
  try {
    assert.equal((await f.submit(token)).isError, true);
    assert.ok(checked > 0);
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'state.json')))[0].status, 'running');
    assert.equal(readFileSync(file, 'utf8'), 'saved 한국어 evidence');
  } finally { fs.fsyncSync = originalFlush; syncBuiltinESMExports(); fs.closeSync(held); }
  assert.equal((await f.submit(token)).isError, false);
  assert.equal((await collectTask('a', f.config)).integrity, 'verified');
}));
