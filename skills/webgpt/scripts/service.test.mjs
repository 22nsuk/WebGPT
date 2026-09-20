import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { runService, requestServiceStop, restartDelay } from './service.mjs';
import { request } from './client.mjs';

async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function fixture(fn) {
  const base = mkdtempSync(join(tmpdir(), 'webgpt-service-')), dataDir = join(base, 'runtime'), file = join(base, 'config.json');
  let controlPort = await freePort(), mcpPort = await freePort();
  while (mcpPort === controlPort) mcpPort = await freePort();
  const config = { dataDir, controlPort, mcpPort };
  writeFileSync(file, JSON.stringify(config));
  const env = { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: dataDir };
  try { await fn({ base, env, config, file }); }
  finally { rmSync(base, { recursive: true, force: true }); }
}
async function until(fn) {
  const deadline = Date.now() + 5000;
  let last;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch (error) { last = error; }
    await delay(20);
  }
  throw last ?? Error('fixture deadline exceeded');
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
});

test('supervisor launches only the fixed worker without a shell and exhausts its one lifetime retry budget', () => fixture(async f => {
  const waits = []; let attempts = 0;
  const code = await runService(f.env, { spawnWorker(executable, args, options) {
    attempts++; assert.equal(executable, process.execPath);
    assert.deepEqual(args, [fileURLToPath(new URL('./worker.mjs', import.meta.url))]);
    assert.equal(options.shell, false); assert.equal(options.cwd, f.config.dataDir);
    assert.deepEqual(options.stdio, ['ignore', 'inherit', 'inherit', 'ipc']);
    return exited(1);
  }, pause: async value => { waits.push(value); } });
  assert.equal(code, 1); assert.equal(attempts, 4); assert.deepEqual(waits, [1000, 5000, 15000]);
  assert.equal(existsSync(join(f.config.dataDir, 'service.lock')), false);
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

test('explicit stop during backoff prevents any next worker launch', () => fixture(async f => {
  let attempts = 0;
  const code = await runService(f.env, { spawnWorker: () => { attempts++; return exited(1); }, pause: async (_ms, _value, { signal }) => {
    assert.equal(requestServiceStop(f.env).accepted, true);
    await delay(5000, undefined, { signal });
  } });
  assert.equal(code, 0); assert.equal(attempts, 1);
  assert.equal(existsSync(join(f.config.dataDir, 'service.lock')), false);
}));

test('real worker is restarted after force kill; explicit service stop drains IPC and releases both locks', () => fixture(async f => {
  const waits = [];
  const service = runService(f.env, { pause: async ms => { waits.push(ms); } });
  let finished = false; service.then(() => { finished = true; }, () => { finished = true; });
  try {
    await until(async () => (await request('ready', undefined, f.config)).ok);
    const task = await request('register', { id: 'survives', instructions: 'fixture', inputs: {} }, f.config);
    const old = JSON.parse(readFileSync(join(f.config.dataDir, 'worker.lock', 'owner.json'), 'utf8'));
    process.kill(old.pid, 'SIGKILL'); // Only this fixture's owned child, never a configured arbitrary PID.
    await until(async () => {
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
    if (!finished) { requestServiceStop(f.env); await service; }
  }
}));

test('a delayed stop request for a different service instance cannot stop the current worker', () => fixture(async f => {
  const service = runService(f.env);
  let finished = false; service.then(() => { finished = true; }, () => { finished = true; });
  const marker = join(f.config.dataDir, 'service.lock', 'stop-request');
  try {
    await until(async () => (await request('ready', undefined, f.config)).ok);
    writeFileSync(marker, '00000000-0000-0000-0000-000000000000');
    await delay(600); // Allow at least two supervisor polls to inspect the marker.
    assert.equal(finished, false);
    assert.equal((await request('ready', undefined, f.config)).ok, true);
    assert.throws(() => requestServiceStop(f.env), { code: 'EEXIST' });
    unlinkSync(marker);
    assert.equal(requestServiceStop(f.env).accepted, true);
    assert.equal(await service, 0);
  } finally {
    if (!finished) {
      if (existsSync(marker)) unlinkSync(marker);
      requestServiceStop(f.env); await service;
    }
  }
}));
