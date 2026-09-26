import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runService, requestServiceStop, restartDelay } from './service.mjs';
import { request } from './client.mjs';
import { acquireRuntimeLock } from './runtime.mjs';
import { spawnFixtureWorker, untilFixture } from './test-fixtures/worker-process.mjs';

async function fixture(fn) {
  const base = mkdtempSync(join(tmpdir(), 'webgpt-service-')), dataDir = join(base, 'runtime'), file = join(base, 'config.json');
  // Valid configuration placeholders; the real child binds its own ephemeral ports.
  const config = { dataDir, controlPort: 12341, mcpPort: 12340 };
  writeFileSync(file, JSON.stringify(config));
  const env = { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: dataDir };
  try { await fn({ base, env, config, file }); }
  finally { rmSync(base, { recursive: true, force: true }); }
}
function realService(f, options = {}) {
  const launches = [];
  let finished = false;
  const service = runService(f.env, { ...options, spawnWorker: (executable, args, settings) => {
    const observed = spawnFixtureWorker(executable, args, settings, ports => {
      f.config.mcpPort = ports.mcpPort; f.config.controlPort = ports.controlPort;
    });
    launches.push(observed); return observed.child;
  } });
  service.then(() => { finished = true; }, () => { finished = true; });
  return { service, get finished() { return finished; },
    until: predicate => untilFixture(async () => launches.at(-1)?.listening && await predicate(), {
      timeoutMs: 5000, label: 'service readiness', stopped: () => finished,
      diagnostic: () => launches.map(item => item.diagnostic()).join('\n'),
    }),
  };
}
function exited(code, signal = null) {
  const child = new EventEmitter();
  child.pid = undefined; child.exitCode = null; child.signalCode = null;
  setImmediate(() => { child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal); });
  return child;
}

test('restart policy is bounded and never retries clean/data/config/storage/ownership errors', () => {
  assert.deepEqual([0, 1, 2, 3].map(n => restartDelay(1, null, n)), [1000, 5000, 15000, null]);
  assert.equal(restartDelay(null, 'SIGKILL', 0), 1000);
  for (const code of [0, 65, 73, 74, 78, 2, 9]) assert.equal(restartDelay(code, null, 0), null);
  assert.equal(restartDelay(null, 'SIGTERM', 0), null);
  assert.equal(restartDelay(1, null, -1), null);
  assert.equal(restartDelay(0xffffffff, null, 0, 'win32'), 1000);
  assert.equal(restartDelay(0xffffffff, null, 3, 'win32'), null);
  assert.equal(restartDelay(0xffffffff, null, 0, 'linux'), null);
  assert.equal(restartDelay(0xc0000005, null, 0, 'win32'), null);
});

test('supervisor launches only the fixed worker without a shell and exhausts its one lifetime retry budget', () => fixture(async f => {
  const waits = [], records = []; let attempts = 0;
  const code = await runService(f.env, { record: entry => records.push(entry), spawnWorker(executable, args, options) {
    attempts++; assert.equal(executable, process.execPath);
    assert.deepEqual(args, [fileURLToPath(new URL('./worker.mjs', import.meta.url))]);
    assert.equal(options.shell, false); assert.equal(options.cwd, f.config.dataDir);
    assert.deepEqual(options.stdio, ['ignore', 'inherit', 'inherit', 'ipc']);
    return exited(1);
  }, pause: async value => { waits.push(value); } });
  assert.equal(code, 1); assert.equal(attempts, 4); assert.deepEqual(waits, [1000, 5000, 15000]);
  assert.equal(existsSync(join(f.config.dataDir, 'service.lock')), false);
  assert.equal(records[0].event, 'service_started');
  assert.equal(records.filter(entry => entry.event === 'worker_started').length, 4);
  assert.equal(records.filter(entry => entry.event === 'worker_exited').length, 4);
  assert.equal(records.find(entry => entry.event === 'worker_restart_refused').reason, 'budget_exhausted');
  assert.equal(records.at(-1).event, 'service_exited');
  assert.equal(records.at(-1).exitCode, 1);
  for (const entry of records) {
    assert.ok(Number.isFinite(Date.parse(entry.time)));
    assert.equal(entry.supervisorPid, process.pid); assert.equal(entry.parentPid, process.ppid);
    assert.equal(entry.instanceId, records[0].instanceId);
    assert.equal(JSON.stringify(entry).includes(f.base), false);
  }
}));

for (const code of [0, 65, 73, 74, 78]) test(`supervisor does not restart worker exit ${code}`, () => fixture(async f => {
  let attempts = 0;
  assert.equal(await runService(f.env, { spawnWorker: () => { attempts++; return exited(code); }, pause: () => { throw Error('must not retry'); } }), code);
  assert.equal(attempts, 1);
}));

test('spawn failure is not converted into a retry loop', () => fixture(async f => {
  let attempts = 0;
  await assert.rejects(runService(f.env, { spawnWorker: () => {
    attempts++; const child = new EventEmitter();
    setImmediate(() => child.emit('error', Object.assign(Error('spawn failed'), { code: 'EACCES' }))); return child;
  } }), { code: 'CONFIG_INVALID' });
  assert.equal(attempts, 1); assert.equal(existsSync(join(f.config.dataDir, 'service.lock')), false);
}));

test('service cannot use a relative configuration or implicit account-profile runtime', () => fixture(async f => {
  await assert.rejects(runService({ WEBGPT_CONFIG: 'relative.json' }), { code: 'CONFIG_INVALID' });
  writeFileSync(f.file, '{}'); const env = { ...f.env }; delete env.WEBGPT_DATA_DIR;
  await assert.rejects(runService(env), { code: 'CONFIG_INVALID' });
  assert.equal(existsSync(f.config.dataDir), false);
}));

test('invalid service entry paths fail before runtime creation or child launch', () => fixture(async f => {
  for (const entryPath of [null, 12, 'service.mjs', join(f.base, 'missing.mjs'), f.file])
    await assert.rejects(runService(f.env, { entryPath, spawnWorker: () => assert.fail('must not launch') }), { code: 'CONFIG_INVALID' });
  assert.equal(existsSync(f.config.dataDir), false);
}));

test('service preserves its entry alias and validates the fixed worker again on restart', () => fixture(async f => {
  const scripts = join(f.base, 'scripts-alias');
  symlinkSync(fileURLToPath(new URL('.', import.meta.url)), scripts, process.platform === 'win32' ? 'junction' : 'dir');
  let attempts = 0;
  await assert.rejects(runService(f.env, {
    entryPath: join(scripts, 'service.mjs'), record: () => {},
    spawnWorker(executable, args) {
      attempts++;
      assert.equal(executable, process.execPath);
      assert.deepEqual(args, [join(scripts, 'worker.mjs')]);
      return exited(1);
    },
    pause: async () => {
      // Replace only this fixture's alias, never the real scripts directory.
      unlinkSync(scripts); mkdirSync(scripts);
      writeFileSync(join(scripts, 'worker.mjs'), 'throw Error("must never execute");');
    },
  }), { code: 'CONFIG_INVALID' });
  assert.equal(attempts, 1);
  assert.equal(existsSync(join(f.config.dataDir, 'service.lock')), false);
}));

test('explicit stop during backoff prevents any next worker launch', () => fixture(async f => {
  let attempts = 0; const records = [];
  const code = await runService(f.env, { record: entry => records.push(entry), spawnWorker: () => { attempts++; return exited(1); }, pause: async (_ms, _value, { signal }) => {
    assert.equal(requestServiceStop(f.env).accepted, true);
    await delay(5000, undefined, { signal });
  } });
  assert.equal(code, 0); assert.equal(attempts, 1);
  assert.equal(existsSync(join(f.config.dataDir, 'service.lock')), false);
  assert.equal(records.at(-1).stopReason, 'stop_request');
  assert.equal(records.at(-1).exitCode, 0);
}));

test('real worker is restarted after force kill; explicit service stop drains IPC and releases both locks', () => fixture(async f => {
  const waits = [];
  const running = realService(f, { pause: async ms => { waits.push(ms); } });
  const { service } = running;
  try {
    await running.until(async () => (await request('ready', undefined, f.config)).ok);
    const task = await request('register', { id: 'survives', instructions: 'fixture', inputs: {} }, f.config);
    const old = JSON.parse(readFileSync(join(f.config.dataDir, 'worker.lock', 'owner.json'), 'utf8'));
    process.kill(old.pid, 'SIGKILL'); // Only this fixture's owned child, never a configured arbitrary PID.
    await running.until(async () => {
      const owner = JSON.parse(readFileSync(join(f.config.dataDir, 'worker.lock', 'owner.json'), 'utf8'));
      return owner.instanceId !== old.instanceId && (await request('ready', undefined, f.config)).ok;
    });
    assert.deepEqual(waits, [1000]);
    assert.equal((await request('tasks', undefined, f.config)).tasks[0].id, task.id);
    assert.equal(readdirSync(f.config.dataDir).filter(name => name.startsWith('worker.lock.stale-')).length, 1);
    await assert.rejects(runService(f.env), { code: 'LOCK_HELD' });
    assert.equal(requestServiceStop(f.env).accepted, true);
    assert.equal(requestServiceStop(f.env).accepted, true);
    assert.equal(await service, 0);
    assert.equal(existsSync(join(f.config.dataDir, 'worker.lock')), false);
    assert.equal(existsSync(join(f.config.dataDir, 'service.lock')), false);
    assert.equal(JSON.parse(readFileSync(join(f.config.dataDir, 'state.json')))[0].status, 'running');
  } finally {
    if (!running.finished) { requestServiceStop(f.env); await service; }
  }
}));

test('a delayed stop request for a different service instance cannot stop the current worker', () => fixture(async f => {
  const running = realService(f);
  const { service } = running;
  const marker = join(f.config.dataDir, 'service.lock', 'stop-request');
  try {
    await running.until(async () => (await request('ready', undefined, f.config)).ok);
    writeFileSync(marker, '00000000-0000-0000-0000-000000000000');
    await delay(600); // Allow at least two supervisor polls to inspect the marker.
    assert.equal(running.finished, false);
    assert.equal((await request('ready', undefined, f.config)).ok, true);
    assert.throws(() => requestServiceStop(f.env), { code: 'EEXIST' });
    unlinkSync(marker);
    assert.equal(requestServiceStop(f.env).accepted, true);
    assert.equal(await service, 0);
  } finally {
    if (!running.finished) {
      if (existsSync(marker)) unlinkSync(marker);
      requestServiceStop(f.env); await service;
    }
  }
}));

test('Windows Stop-Process DWORD exit is retried and recorded by the owned supervisor', { skip: process.platform !== 'win32' }, () => fixture(async f => {
  const records = [], waits = [];
  const running = realService(f, { record: entry => records.push(entry), pause: async ms => waits.push(ms) });
  try {
    await running.until(async () => (await request('ready', undefined, f.config)).ok);
    const old = JSON.parse(readFileSync(join(f.config.dataDir, 'worker.lock', 'owner.json')));
    // PID comes only from this disposable worker's private lock.
    const terminator = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${old.pid} -ErrorAction Stop`],
      { windowsHide: true, stdio: 'ignore' });
    assert.deepEqual(await once(terminator, 'exit'), [0, null]);
    await running.until(async () => JSON.parse(readFileSync(join(f.config.dataDir, 'worker.lock', 'owner.json'))).instanceId !== old.instanceId
      && (await request('ready', undefined, f.config)).ok);
    assert.equal(records.find(entry => entry.event === 'worker_exited').exitCode, 0xffffffff);
    assert.deepEqual(waits, [1000]);
    requestServiceStop(f.env);
    assert.equal(await running.service, 0);
    assert.equal(records.at(-1).stopReason, 'stop_request');
  } finally {
    if (!running.finished) { requestServiceStop(f.env); await running.service; }
  }
}));


test('worker fixture reports real startup stderr and exit code before any readiness timeout', () => fixture(async f => {
  writeFileSync(f.file, JSON.stringify({ ...f.config, publicMcp: 'invalid' }));
  const observed = spawnFixtureWorker(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], { env: f.env });
  try {
    await assert.rejects(untilFixture(() => observed.listening, {
      timeoutMs: 5000, label: 'intentional invalid config', diagnostic: observed.diagnostic,
      stopped: () => observed.child.exitCode !== null || observed.child.signalCode !== null,
    }), error => {
      assert.match(error.message, /child exited before readiness/);
      assert.match(error.message, /startup_failed/); assert.match(error.message, /CONFIG_INVALID/);
      assert.match(error.message, /"exitCode":78/); return true;
    });
    assert.deepEqual(await observed.exit, [78, null]);
    assert.equal(existsSync(join(f.config.dataDir, 'worker.lock')), false);
  } finally {
    if (observed.child.exitCode === null && observed.child.signalCode === null) {
      observed.child.kill('SIGKILL'); await observed.exit;
    }
  }
}));

// A requested stop suppresses restarts, not the child's failure status. These
// controlled exits cover the same numeric/signal distinction on every platform.
for (const [code, signal] of [[0, null], [74, null], [null, 'SIGKILL']])
  test(`requested stop preserves worker outcome ${code ?? signal} without restarting`, () => fixture(async f => {
    const records = []; let launches = 0, sends = 0;
    const service = runService(f.env, {
      record: entry => records.push(entry), pause: () => assert.fail('must not restart after stop'),
      spawnWorker() {
        launches++;
        const child = new EventEmitter();
        Object.assign(child, { exitCode: null, signalCode: null, connected: true,
          send(message, callback) {
            sends++; assert.deepEqual(message, { type: 'shutdown' }); callback();
            setImmediate(() => { child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal); });
          },
          kill() { assert.fail('responsive child must not be force-killed'); },
        });
        return child;
      },
    });
    assert.deepEqual(requestServiceStop(f.env), { accepted: true });
    assert.equal(await service, code ?? 1);
    assert.equal(launches, 1); assert.equal(sends, 1);
    assert.equal(records.find(entry => entry.event === 'worker_exited').exitCode, code);
    assert.equal(records.find(entry => entry.event === 'worker_exited').signal, signal);
    assert.equal(records.at(-1).exitCode, code ?? 1);
    assert.equal(records.at(-1).stopReason, 'stop_request');
    assert.equal(records.some(entry => entry.event === 'worker_restart_scheduled'), false);
    assert.equal(existsSync(join(f.config.dataDir, 'service.lock')), false);
  }));

test('worker ownership-release failure is preserved by requested service stop', () => fixture(async f => {
  const records = [];
  const running = realService(f, { record: entry => records.push(entry) });
  try {
    await running.until(async () => (await request('ready', undefined, f.config)).ok);
    const task = await request('register', { id: 'retained', instructions: 'private task', inputs: { source: 'private input' } }, f.config);
    const state = readFileSync(join(f.config.dataDir, 'state.json'));
    const lock = join(f.config.dataDir, 'worker.lock');
    const owner = readFileSync(join(lock, 'owner.json'));
    // Real filesystem evidence makes the real worker's existing release refuse.
    // Never substitute an exit code or remove the entry to make shutdown succeed.
    writeFileSync(join(lock, 'preserve.txt'), 'unexpected owned-fixture evidence');
    assert.equal(requestServiceStop(f.env).accepted, true);
    const result = await running.service;
    assert.equal(records.find(entry => entry.event === 'worker_exited').exitCode, 74);
    assert.equal(result, 74);
    assert.equal(records.at(-1).exitCode, 74);
    assert.equal(records.at(-1).stopReason, 'stop_request');
    assert.equal(records.filter(entry => entry.event === 'worker_started').length, 1);
    assert.equal(records.some(entry => entry.event === 'worker_restart_scheduled'), false);
    assert.deepEqual(readFileSync(join(lock, 'owner.json')), owner);
    assert.equal(readFileSync(join(lock, 'preserve.txt'), 'utf8'), 'unexpected owned-fixture evidence');
    assert.deepEqual(readFileSync(join(f.config.dataDir, 'state.json')), state);
    assert.equal(JSON.parse(state)[0].token, task.token);
    assert.equal(existsSync(join(f.config.dataDir, 'service.lock')), false);
    for (const port of [f.config.mcpPort, f.config.controlPort])
      await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }));
  } finally {
    if (!running.finished) { requestServiceStop(f.env); await running.service; }
  }
}));

// Only disposable owner directories; no supervisor or child is stopped here.
function stopFixture(fn) {
  return fixture(async f => {
    mkdirSync(f.config.dataDir);
    const owner = acquireRuntimeLock(f.config.dataDir, { name: 'service' });
    const marker = join(f.config.dataDir, 'service.lock', 'stop-request');
    try { await fn({ ...f, marker, instanceId: owner.instanceId }); }
    finally { rmSync(marker, { recursive: true, force: true }); owner.release(); }
  });
}
async function observeStopWrites(t, marker, run, overrides = {}) {
  const write = fs.writeFileSync; let attempts = 0;
  t.mock.method(fs, 'writeFileSync', (path, ...args) => {
    if (path === marker) attempts++;
    return write(path, ...args);
  });
  for (const [name, replacement] of Object.entries(overrides)) t.mock.method(fs, name, replacement);
  syncBuiltinESMExports();
  try { await run(() => attempts); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}

for (const kind of ['foreign', 'partial', 'directory', 'symlink', 'dangling', 'hardlink'])
  test(`service stop preserves an existing ${kind} marker without attempting creation`, t => stopFixture(async f => {
    const target = join(f.base, 'target.txt');
    if (kind !== 'dangling') writeFileSync(target, f.instanceId);
    if (kind === 'directory') mkdirSync(f.marker);
    else if (kind === 'hardlink') fs.linkSync(target, f.marker);
    else if (['symlink', 'dangling'].includes(kind)) {
      try { symlinkSync(target, f.marker, 'file'); }
      catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('file symlink creation unavailable'); return; }
        throw error;
      }
    } else writeFileSync(f.marker, kind === 'partial' ? '' : '00000000-0000-0000-0000-000000000000');
    const info = fs.lstatSync(f.marker), owner = readFileSync(join(f.config.dataDir, 'service.lock', 'owner.json'));
    await observeStopWrites(t, f.marker, attempts => {
      assert.throws(() => requestServiceStop(f.env), { code: 'EEXIST' });
      assert.equal(attempts(), 0, 'known entries must be handled before a creation-capable operation');
    });
    const after = fs.lstatSync(f.marker);
    assert.equal(after.ino, info.ino); assert.equal(after.isSymbolicLink(), info.isSymbolicLink());
    assert.deepEqual(readFileSync(join(f.config.dataDir, 'service.lock', 'owner.json')), owner);
    if (kind === 'dangling') assert.equal(existsSync(target), false);
    else assert.equal(readFileSync(target, 'utf8'), f.instanceId);
    if (kind === 'foreign' || kind === 'partial')
      assert.equal(readFileSync(f.marker, 'utf8'), kind === 'partial' ? '' : '00000000-0000-0000-0000-000000000000');
  }));

test('service stop creates one private marker and accepts its identical retry without another write', t => stopFixture(async f => {
  await observeStopWrites(t, f.marker, attempts => {
    assert.deepEqual(requestServiceStop(f.env), { accepted: true });
    assert.equal(attempts(), 1);
    const before = readFileSync(f.marker);
    assert.equal(before.toString(), f.instanceId);
    if (process.platform !== 'win32') assert.equal(fs.lstatSync(f.marker).mode & 0o077, 0);
    assert.deepEqual(requestServiceStop(f.env), { accepted: true });
    assert.equal(attempts(), 1);
    assert.deepEqual(readFileSync(f.marker), before);
  });
}));

test('unavailable stop marker metadata cannot be interpreted as absence', t => stopFixture(async f => {
  const stat = fs.lstatSync;
  for (const code of ['EACCES', 'EIO']) await observeStopWrites(t, f.marker, attempts => {
    assert.throws(() => requestServiceStop(f.env), { code });
    assert.equal(attempts(), 0);
    assert.equal(existsSync(f.marker), false);
  }, { lstatSync(path, ...args) {
    if (path === f.marker) throw Object.assign(Error('fixture metadata failure'), { code });
    return stat(path, ...args);
  } });
}));

test('exclusive marker creation still resolves a racing writer by instance identity', t => stopFixture(async f => {
  const write = fs.writeFileSync;
  for (const same of [false, true]) {
    let collided = false;
    t.mock.method(fs, 'writeFileSync', (path, ...args) => {
      if (path === f.marker) {
        collided = true;
        assert.equal(args[1].flag, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
          | (fs.constants.O_NOFOLLOW ?? 0)); assert.equal(args[1].flush, true);
        write(f.marker, same ? f.instanceId : '00000000-0000-0000-0000-000000000000', { flag: 'wx', mode: 0o600 });
      }
      return write(path, ...args);
    });
    syncBuiltinESMExports();
    try {
      if (same) assert.deepEqual(requestServiceStop(f.env), { accepted: true });
      else assert.throws(() => requestServiceStop(f.env), { code: 'EEXIST' });
      assert.equal(collided, true);
      assert.equal(readFileSync(f.marker, 'utf8'), same ? f.instanceId : '00000000-0000-0000-0000-000000000000');
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); unlinkSync(f.marker); }
  }
}));


// Creation and verification have separate races. Controlled replacements retain
// the original inode so an equal payload cannot stand in for the inspected file.
for (const kind of ['regular', 'symlink', 'original-link'])
  test(`service stop refuses a ${kind} replacement between marker metadata and open`, t => stopFixture(async f => {
    const retained = join(f.base, 'retained'), target = join(f.base, 'target');
    writeFileSync(f.marker, f.instanceId); writeFileSync(target, f.instanceId);
    if (kind !== 'regular') {
      const probe = join(f.base, 'link-probe');
      try { symlinkSync(target, probe, 'file'); unlinkSync(probe); }
      catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('file symlink creation unavailable'); return; }
        throw error;
      }
    }
    const stat = fs.lstatSync, write = fs.writeFileSync; let observed = 0, replaced = false;
    await observeStopWrites(t, f.marker, attempts => {
      assert.throws(() => requestServiceStop(f.env));
      assert.equal(replaced, true); assert.equal(attempts(), 0);
    }, { lstatSync(path, ...args) {
      const info = stat(path, ...args);
      if (path === f.marker && ++observed === 2) {
        fs.renameSync(f.marker, retained);
        if (kind !== 'regular') symlinkSync(kind === 'original-link' ? retained : target, f.marker, 'file');
        else write(f.marker, f.instanceId);
        replaced = true;
      }
      return info;
    } });
    assert.equal(readFileSync(retained, 'utf8'), f.instanceId);
    assert.equal(readFileSync(target, 'utf8'), f.instanceId);
    assert.equal(fs.lstatSync(f.marker).isSymbolicLink(), kind !== 'regular');
  }));

test('stop collision preserves metadata errors from the ownership recheck', t => stopFixture(async f => {
  writeFileSync(f.marker, f.instanceId);
  const stat = fs.lstatSync;
  for (const code of ['EACCES', 'EIO']) {
    let observed = 0;
    await observeStopWrites(t, f.marker, attempts => {
      assert.throws(() => requestServiceStop(f.env), { code });
      assert.equal(attempts(), 0); assert.equal(observed, 2);
    }, { lstatSync(path, ...args) {
      if (path === f.marker && ++observed === 2)
        throw Object.assign(Error('private fixture metadata'), { code });
      return stat(path, ...args);
    } });
    assert.equal(readFileSync(f.marker, 'utf8'), f.instanceId);
  }
}));

test('stop verification propagates descriptor errors and closes every opened handle', t => stopFixture(async f => {
  writeFileSync(f.marker, f.instanceId);
  for (const stage of ['openSync', 'fstatSync', 'readSync', 'closeSync']) {
    const open = fs.openSync, close = fs.closeSync, stat = fs.fstatSync, operation = fs[stage];
    let fd, closed = 0;
    const overrides = {
      openSync(path, ...args) {
        const opened = open(path, ...args); if (path === f.marker) fd = opened; return opened;
      },
      closeSync(opened) { if (opened === fd) closed++; return close(opened); },
    };
    const forward = overrides[stage] ?? operation;
    overrides[stage] = (first, ...args) => {
      if (stage === 'openSync' ? first === f.marker : fd !== undefined && first === fd) {
        if (stage === 'closeSync') { closed++; close(first); }
        throw Object.assign(Error('private fixture descriptor failure'), { code: 'EIO' });
      }
      return forward(first, ...args);
    };
    await observeStopWrites(t, f.marker, attempts => {
      assert.throws(() => requestServiceStop(f.env), { code: 'EIO' });
      assert.equal(attempts(), 0); assert.equal(closed, stage === 'openSync' ? 0 : 1);
      if (fd !== undefined) assert.throws(() => stat(fd), { code: 'EBADF' });
    }, overrides);
  }
}));

test('stop verification caps actual growth and never reads the marker through its path', t => stopFixture(async f => {
  writeFileSync(f.marker, f.instanceId);
  const open = fs.openSync, read = fs.readSync, readFile = fs.readFileSync, close = fs.closeSync, write = fs.writeFileSync;
  let fd, consumed = 0, closed = 0, legacyReads = 0, grown = false;
  const grow = () => {
    if (grown) return;
    grown = true; const appender = open(f.marker, 'a');
    try { write(appender, 'x'.repeat(8192)); } finally { close(appender); }
  };
  await observeStopWrites(t, f.marker, attempts => {
    assert.throws(() => requestServiceStop(f.env), { code: 'EEXIST' });
    assert.equal(attempts(), 0); assert.equal(grown, true);
    assert.equal(legacyReads, 0); assert.equal(consumed, 37); assert.equal(closed, 1);
  }, {
    openSync(path, ...args) { const opened = open(path, ...args); if (path === f.marker) fd = opened; return opened; },
    readFileSync(path, ...args) { if (path === f.marker) { legacyReads++; grow(); } return readFile(path, ...args); },
    readSync(opened, ...args) { if (opened === fd) grow(); const count = read(opened, ...args); if (opened === fd) consumed += count; return count; },
    closeSync(opened) { if (opened === fd) closed++; return close(opened); },
  });
  assert.equal(fs.statSync(f.marker).size, 36 + 8192, 'growth evidence is not truncated or removed');
}));

test('native exclusive creation refuses a late dangling marker where no-follow is supported', t => stopFixture(async f => {
  if (!fs.constants.O_NOFOLLOW) { t.skip('native O_NOFOLLOW unavailable; no Windows race guarantee'); return; }
  const target = join(f.base, 'absent-target'), write = fs.writeFileSync; let raced = false;
  await observeStopWrites(t, f.marker, () => {
    assert.throws(() => requestServiceStop(f.env));
    assert.equal(raced, true); assert.equal(fs.lstatSync(f.marker).isSymbolicLink(), true);
    assert.equal(existsSync(target), false);
  }, { writeFileSync(path, ...args) {
    if (path === f.marker) {
      assert.equal(args[1].flag, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW);
      symlinkSync(target, f.marker, 'file'); raced = true;
    }
    return write(path, ...args);
  } });
}));

test('an unreadable marker neither crashes the supervisor poll nor authorizes shutdown', t => fixture(async f => {
  const records = [], running = realService(f, { record: entry => records.push(entry) });
  let restored = false;
  const restore = () => { t.mock.restoreAll(); syncBuiltinESMExports(); restored = true; };
  try {
    await running.until(async () => (await request('ready', undefined, f.config)).ok === true);
    const marker = join(f.config.dataDir, 'service.lock', 'stop-request');
    const owner = JSON.parse(readFileSync(join(f.config.dataDir, 'service.lock', 'owner.json'), 'utf8'));
    const stat = fs.lstatSync; let polls = 0;
    writeFileSync(marker, owner.instanceId);
    t.mock.method(fs, 'lstatSync', (path, ...args) => {
      if (path === marker) { polls++; throw Object.assign(Error('private poll failure'), { code: 'EIO' }); }
      return stat(path, ...args);
    });
    syncBuiltinESMExports();
    await untilFixture(() => polls > 0, { timeoutMs: 2000, label: 'marker poll', stopped: () => running.finished });
    assert.equal(running.finished, false);
    assert.equal((await request('ready', undefined, f.config)).ok, true);
    assert.equal(records.some(entry => entry.event === 'worker_exited'), false);
    restore();
    assert.deepEqual(requestServiceStop(f.env), { accepted: true });
    assert.equal(await running.service, 0);
  } finally {
    if (!restored) restore();
    if (!running.finished) { requestServiceStop(f.env); await running.service; }
  }
}));
