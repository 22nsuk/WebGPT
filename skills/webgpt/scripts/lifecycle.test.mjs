import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, linkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { start, tools } from './worker.mjs';
import { request, waitForTasks, collectTask } from './client.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('./client.mjs', import.meta.url));
const snapshot = { events: [], backupDue: [] };

async function fixture(run) {
  const base = mkdtempSync(join(tmpdir(), 'webgpt-lifecycle-'));
  const dir = join(base, 'runtime');
  let clock = 1000;
  let service = await start({ dir, port: 0, controlPort: 0, now: () => clock, waitMs: 20 });
  const config = { dataDir: dir, mcpPort: service.mcpPort, controlPort: service.controlPort };
  const admin = (action, payload, options) => request(action, payload, config, options);
  const call = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${service.mcpPort}/mcp`, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await response.json()).result;
  };
  const register = id => admin('register', { id, instructions: 'Review without changing files.', inputs: {} });
  const complete = (token, status = 'completed') => call('submit_result', { token, status, summary: status, result: 'saved 한국어 evidence' });
  const restart = async () => {
    await service.close();
    service = await start({ dir, port: 0, controlPort: 0, now: () => clock, waitMs: 20 });
    config.mcpPort = service.mcpPort; config.controlPort = service.controlPort;
  };
  try { await run({ base, dir, config, admin, call, register, complete, restart, advance: ms => { clock += ms; } }); }
  finally { await service.close(); rmSync(base, { recursive: true, force: true }); }
}

// A deterministic transport fixture verifies renewal and compatibility errors without 55s sleeps.
async function controllerFixture(replies, run) {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-controller-contract-'));
  writeFileSync(join(dir, 'controller.key'), 'fixture-only-key');
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    assert.equal(req.headers.authorization, 'Bearer fixture-only-key');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(replies[Math.min(requests.length - 1, replies.length - 1)]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run({ config: { dataDir: dir, controlPort: server.address().port }, requests }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
}

test('scoped waits exclude other results and deadlines while global calls stay compatible', () => fixture(async f => {
  const a = await f.register('a'); const b = await f.register('b');
  await f.register('unrelated-running');
  f.advance(900000);
  await f.complete(b.token); await f.complete(a.token);
  const result = await f.admin('wait', { ids: ['a', 'a'] });
  assert.deepEqual(result.events.map(e => e.id), ['a']);
  assert.deepEqual(result.backupDue, []);
  assert.equal(result.settled, true);
  const all = await f.admin('status');
  assert.deepEqual(all.events.map(e => e.id), ['a', 'b']);
  assert.deepEqual(all.backupDue, ['unrelated-running']);
  assert.equal(Object.hasOwn(all, 'settled'), false);
}));

test('quiet waits renew empty responses inside the client and return the first actionable state', () => {
  const done = { events: [{ id: 'a', status: 'completed' }], backupDue: [], settled: true };
  return controllerFixture([{ ...snapshot, settled: false }, { ...snapshot, settled: false }, done], async ({ config, requests }) => {
    assert.deepEqual(await waitForTasks(['a'], config), done);
    assert.deepEqual(requests, ['/wait?id=a', '/wait?id=a', '/wait?id=a']);
  });
});

test('quiet waits return due checks and recovery notices without retrying them', async () => {
  for (const result of [
    { events: [], backupDue: ['a'], settled: false },
    { ...snapshot, recoveryRequired: [{ id: 'a', journals: ['fixture.json'] }], settled: false },
  ]) await controllerFixture([result], async ({ config, requests }) => {
    assert.deepEqual(await waitForTasks(['a'], config), result);
    assert.equal(requests.length, 1);
  });
});

test('unknown IDs and malformed wait queries fail instead of silently widening scope', () => fixture(async f => {
  await f.register('a');
  for (const ids of [[], [''], ['../a'], ['a&other'], [null], 'a'])
    await assert.rejects(waitForTasks(ids, f.config), /task IDs/);
  await assert.rejects(f.admin('wait', { ids: ['missing'] }), /unknown task/);
  await assert.rejects(f.admin('wait', { ids: ['a'], extra: true }), /payload/);
  await assert.rejects(f.admin('status', { ids: ['a'] }), /payload/);
  for (const query of ['?id=', '?id=missing', '?other=a']) {
    const response = await fetch(`http://127.0.0.1:${f.config.controlPort}/wait${query}`, { headers: { authorization: 'Bearer ' + readFileSync(join(f.dir, 'controller.key'), 'utf8') } });
    assert.equal(response.status, 400);
  }
  assert.equal((await fetch(`http://127.0.0.1:${f.config.controlPort}/wait?id=a`)).status, 401);
}));

test('old or malformed worker responses fail promptly instead of causing an endless wait', async () => {
  for (const result of [null, snapshot, { ...snapshot, settled: 'no' }, { ...snapshot, settled: false, recoveryRequired: {} }])
    await controllerFixture([result], async ({ config, requests }) => {
      await assert.rejects(waitForTasks(['a'], config), /does not support task-scoped waits/);
      assert.equal(requests.length, 1);
    });
  for (const result of [
    { events: [{ id: 'other' }], backupDue: [], settled: true },
    { events: [], backupDue: ['other'], settled: false },
    { ...snapshot, recoveryRequired: [{ id: 'other' }], settled: false },
  ]) await controllerFixture([result], async ({ config, requests }) => {
    await assert.rejects(waitForTasks(['a'], config), /outside the requested task scope/);
    assert.equal(requests.length, 1);
  });
});

test('waiting can be aborted without cancelling a registered task', () => fixture(async f => {
  const a = await f.register('a');
  await assert.rejects(waitForTasks(['a'], f.config, { signal: AbortSignal.timeout(50) }), { name: 'TimeoutError' });
  assert.equal((await f.call('get_task', { token: a.token })).structuredContent.status, 'running');
  const stop = new AbortController(); stop.abort(new Error('stop this wait'));
  await assert.rejects(waitForTasks(['a'], f.config, { signal: stop.signal }), /stop this wait/);
  await f.admin('cancel', { id: 'a' });
  assert.deepEqual(await waitForTasks(['a'], f.config), { ...snapshot, settled: true });
}));

test('selected cancellation settles while unrelated work stays active', () => fixture(async f => {
  const a = await f.register('a'); const b = await f.register('b');
  const waiting = waitForTasks(['a'], f.config);
  await f.admin('cancel', { id: 'a' });
  assert.deepEqual(await waiting, { ...snapshot, settled: true });
  assert.equal((await f.call('get_task', { token: a.token })).isError, true);
  assert.equal((await f.call('get_task', { token: b.token })).structuredContent.status, 'running');
}));

test('collection verifies saved bytes, retires only the selected token, and preserves evidence', () => fixture(async f => {
  const a = await f.register('a'); const b = await f.register('b');
  await f.complete(a.token); await f.complete(b.token);
  const collected = await collectTask('a', f.config);
  assert.equal(collected.integrity, 'verified'); assert.equal(collected.collected, true);
  assert.equal(readFileSync(collected.artifact, 'utf8'), 'saved 한국어 evidence');
  assert.equal((await f.call('get_task', { token: a.token })).isError, true);
  assert.equal((await f.call('get_task', { token: b.token })).isError, false);
  assert.deepEqual((await f.admin('status')).events.map(e => e.id), ['b']);
  await assert.rejects(collectTask('a', f.config), /no uncollected result/);
  await collectTask('b', f.config);
  assert.deepEqual(await f.admin('wait'), snapshot);
}));

test('tampered, missing or multiply linked artifacts are not acknowledged', () => fixture(async f => {
  const a = await f.register('a'); await f.complete(a.token);
  const path = join(f.dir, 'a.result.txt');
  const original = readFileSync(path);
  writeFileSync(path, 'tampered');
  await assert.rejects(collectTask('a', f.config), /integrity mismatch/);
  assert.equal((await f.call('get_task', { token: a.token })).isError, false);
  unlinkSync(path);
  await assert.rejects(collectTask('a', f.config), /ENOENT/);
  writeFileSync(path, original);
  linkSync(path, join(f.dir, 'alias.txt'));
  await assert.rejects(collectTask('a', f.config), /single-link/);
  unlinkSync(join(f.dir, 'alias.txt'));
  assert.equal((await f.admin('status')).events.length, 1);
  await collectTask('a', f.config);
}));

test('collection refuses state that points outside the task artifact path', () => fixture(async f => {
  const a = await f.register('a'); await f.complete(a.token);
  const statePath = join(f.dir, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state[0].artifact = join(f.dir, 'other.result.txt');
  writeFileSync(statePath, JSON.stringify(state)); await f.restart();
  await assert.rejects(collectTask('a', f.config), /unexpected saved result path/);
  assert.equal((await f.admin('status')).events.length, 1);
}));

test('failed and cancelled results keep their status after integrity-checked collection', () => fixture(async f => {
  for (const status of ['failed', 'cancelled']) {
    const task = await f.register(status); await f.complete(task.token, status);
    const result = await collectTask(status, f.config);
    assert.equal(result.status, status); assert.equal(result.integrity, 'verified');
    assert.ok(existsSync(result.artifact));
  }
}));

test('collecting running work does not invent a result or revoke access', () => fixture(async f => {
  const a = await f.register('a');
  await assert.rejects(collectTask('a', f.config), /no uncollected result/);
  assert.equal((await f.call('get_task', { token: a.token })).structuredContent.status, 'running');
}));

test('new commands work with task IDs and JSON files; legacy no-argument wait stays bounded', () => fixture(async f => {
  const file = join(f.dir, 'config.json'); writeFileSync(file, JSON.stringify(f.config));
  const env = { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: f.dir };
  const run = async (...args) => JSON.parse((await execute(process.execPath, [cli, ...args], { env })).stdout);
  const a = await f.register('a'); await f.complete(a.token);
  assert.equal((await run('wait', 'a')).events[0].id, 'a');
  const ids = join(f.dir, 'ids.json'); writeFileSync(ids, JSON.stringify({ ids: ['a'] }));
  assert.equal((await run('wait', ids)).events[0].id, 'a');
  assert.equal((await run('collect', 'a')).collected, true);
  await f.register('b');
  assert.deepEqual(await run('wait'), snapshot);
  assert.deepEqual(await run('checked', 'b'), { ok: true });
  const cancel = join(f.dir, 'cancel.json'); writeFileSync(cancel, JSON.stringify({ id: 'b' }));
  assert.deepEqual(await run('cancel', cancel), { ok: true });
  assert.deepEqual(await run('wait', 'b'), { ...snapshot, settled: true });
  await assert.rejects(execute(process.execPath, [cli, 'collect'], { env }), /usage/);
}));

test('stdin module imports do not treat the dash as a filename or launch either CLI', async () => {
  for (const file of ['client.mjs', 'worker.mjs']) {
    const source = `await import(${JSON.stringify(new URL(file, import.meta.url).href)}); console.log('imported');`;
    const stdout = await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, ['--input-type=module', '-'], { timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin.end(source);
    });
    assert.equal(stdout.trim(), 'imported');
  }
});

test('upstream terminal and open registration cannot silently change the fork authority model', () => fixture(async f => {
  assert.deepEqual(tools.map(t => t.name), ['list_files', 'read_file', 'write_file', 'delete_file', 'get_task', 'read_input', 'submit_result']);
  for (const extra of [{ terminal: { cwd: f.dir } }, { terminal: null }, { mode: 'open' }, { mode: null }]) {
    await assert.rejects(f.admin('register', { id: 'bad', instructions: '', inputs: {}, ...extra }), /not supported/);
  }
  assert.deepEqual(await f.admin('status'), snapshot);
  const root = join(f.base, 'project'); mkdirSync(root);
  for (const mode of ['read', 'edit', 'text']) {
    const task = await f.admin('register', { id: mode, instructions: 'Check authority', inputs: {},
      ...(mode === 'text' ? {} : { workspace: { root, mode } }) });
    if (mode !== 'edit')
      assert.equal((await f.call('write_file', { token: task.token, path: 'no.txt', text: 'no', expectedSha256: null })).isError, true);
    const marker = join(root, mode + '.txt');
    const script = join(root, mode + '.cjs');
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected execution')`);
    const command = `"${process.execPath}" "${script}"`;
    for (const name of ['exec_command', 'write_stdin']) {
      const result = await f.call(name, { token: task.token, command, session_id: 'ungranted', input: command });
      assert.equal(result.isError, true, mode + ': ' + name);
      assert.match(result.content[0].text, /unknown tool/);
    }
    assert.equal(existsSync(marker), false);
  }
}));

test('live upstream state is rejected without rewriting grants or leaving a startup lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-incompatible-state-'));
  try {
    const contents = JSON.stringify([{ id: 'upstream', status: 'running', collected: false, mode: 'open', terminal: { cwd: dir }, token: 'fixture-only' }]);
    writeFileSync(join(dir, 'state.json'), contents);
    await assert.rejects(start({ dir, port: 0, controlPort: 0 }), /incompatible terminal\/open state/);
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), contents);
    assert.equal(existsSync(join(dir, 'worker.lock')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid test wait bounds fail before creating runtime files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-wait-bounds-'));
  try {
    for (const waitMs of [0, -1, 55001, Infinity, 1.5])
      await assert.rejects(start({ dir, port: 0, controlPort: 0, waitMs }), /waitMs/);
    assert.equal(existsSync(join(dir, 'worker.lock')), false);
    assert.equal(existsSync(join(dir, 'controller.key')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
