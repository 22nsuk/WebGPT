import { test } from 'node:test';
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
