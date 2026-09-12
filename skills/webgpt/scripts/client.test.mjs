import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { configuration, request } from './client.mjs';
import { start } from './worker.mjs';

const execute = promisify(execFile);
const invoke = async (s, name, args) => {
  const response = await fetch(`http://127.0.0.1:${s.mcpPort}/mcp`, {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await response.json()).result;
};
async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-portable-test-'));
  let clock = 1000;
  let service = await start({ dir, port: 0, controlPort: 0, now: () => clock });
  const config = { dataDir: dir, mcpPort: service.mcpPort, controlPort: service.controlPort };
  const admin = (action, payload) => request(action, payload, config);
  const restart = async () => {
    await service.close();
    service = await start({ dir, port: 0, controlPort: 0, now: () => clock });
    config.mcpPort = service.mcpPort; config.controlPort = service.controlPort;
  };
  try { await run({ dir, get service() { return service; }, config, admin, restart, advance: ms => { clock += ms; } }); }
  finally { await service.close(); rmSync(dir, { recursive: true }); }
}

test('portable config uses absolute paths and independent ports, with explicit overrides', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-config-test-'));
  try {
    const file = join(dir, 'config.json');
    const saved = { dataDir: join(dir, 'private data'), mcpPort: 12340, controlPort: 12341 };
    writeFileSync(file, JSON.stringify(saved));
    assert.deepEqual(configuration({ WEBGPT_CONFIG: file }), saved);
    assert.equal(configuration({ WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: dir }).dataDir, dir);
    for (const invalid of [[], null, { dataDir: 'relative' }, { mcpPort: 0 }, { controlPort: '12341' }, { mcpPort: 43139 }]) {
      writeFileSync(file, JSON.stringify(invalid));
      assert.throws(() => configuration({ WEBGPT_CONFIG: file }));
    }
    assert.throws(() => configuration({ WEBGPT_CONFIG: join(dir, 'missing.json') }), /does not exist/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('client CLI works from an unrelated directory with configured private data', () => fixture(async ({ dir, config }) => {
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(config));
  const cli = new URL('./client.mjs', import.meta.url);
  const { stdout } = await execute(process.execPath, [fileURLToPath(cli), 'status'], {
    cwd: tmpdir(), env: { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: dir },
  });
  assert.deepEqual(JSON.parse(stdout), { events: [], backupDue: [] });
  assert.ok(!stdout.includes(readFileSync(join(dir, 'controller.key'), 'utf8')));
}));

test('client and worker CLIs execute through a symlinked installation path', () => fixture(async ({ dir, config }) => {
  const scripts = join(dir, 'installed scripts');
  symlinkSync(dirname(fileURLToPath(import.meta.url)), scripts, 'dir');
  const file = join(dir, 'config.json'); writeFileSync(file, JSON.stringify(config));
  const env = { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: dir };
  const { stdout } = await execute(process.execPath, [join(scripts, 'client.mjs'), 'status'], { env });
  assert.deepEqual(JSON.parse(stdout), { events: [], backupDue: [] });
  // Startup must actually execute and reject the live owner's lock, not exit silently with code 0.
  await assert.rejects(execute(process.execPath, [join(scripts, 'worker.mjs')], { env }), /data directory locked/);
}));

test('controller authenticates, rejects invalid calls, and returns errors without keys', () => fixture(async ({ service, admin }) => {
  assert.equal((await fetch(`http://127.0.0.1:${service.controlPort}/status`)).status, 401);
  await assert.rejects(admin('unknown'), /unknown/);
  await assert.rejects(admin('status', {}), /payload/);
  await assert.rejects(admin('register'), /payload/);
  await assert.rejects(admin('ack', { id: 'missing' }), /unknown task/);
  await admin('register', { id: 'a', instructions: 'Review', inputs: {} });
  await assert.rejects(admin('register', { id: 'a', instructions: 'Review', inputs: {} }), /invalid task/);
  await assert.rejects(admin('ack', { id: 'a' }), /not complete/);
  await admin('cancel', { id: 'a' });
}));

test('parallel early completions persist, verify their hashes and retry idempotently', () => fixture(async ({ service, admin }) => {
  const a = await admin('register', { id: 'a', instructions: 'Review A', inputs: {} });
  const b = await admin('register', { id: 'b', instructions: 'Review B', inputs: {} });
  const payload = { token: a.token, status: 'completed', summary: 'done', result: 'verified output' };
  await Promise.all([
    invoke(service, 'submit_result', payload),
    invoke(service, 'submit_result', { ...payload, token: b.token, status: 'failed', result: 'partial output' }),
  ]);
  assert.equal((await invoke(service, 'submit_result', payload)).structuredContent.duplicate, true);
  const view = await admin('wait');
  assert.deepEqual(view.events.map(e => e.id).sort(), ['a', 'b']);
  for (const event of view.events) {
    assert.equal(createHash('sha256').update(readFileSync(event.artifact)).digest('hex'), event.sha256);
  }
  await admin('ack', { id: 'a' }); await admin('ack', { id: 'b' });
  assert.deepEqual(await admin('wait'), { events: [], backupDue: [] });
}));

test('15-minute backup checks reset only running tasks and never revive terminal tasks', () => fixture(async ({ service, admin, advance }) => {
  const a = await admin('register', { id: 'a', instructions: 'Review', inputs: {} });
  await admin('register', { id: 'b', instructions: 'Review', inputs: {} });
  advance(899999); assert.deepEqual((await admin('status')).backupDue, []);
  advance(1); assert.deepEqual((await admin('wait')).backupDue, ['a', 'b']);
  await invoke(service, 'submit_result', { token: a.token, status: 'completed', summary: 'done', result: 'done' });
  await admin('checked', { id: 'b' });
  assert.deepEqual((await admin('status')).backupDue, []);
  advance(900000); assert.deepEqual((await admin('status')).backupDue, ['b']);
  await admin('checked', { id: 'a' }); await admin('ack', { id: 'a' });
  await admin('cancel', { id: 'b' });
  advance(900000); assert.deepEqual(await admin('wait'), { events: [], backupDue: [] });
}));

test('malformed, invalid and oversized results do not complete a task', () => fixture(async ({ service, admin }) => {
  const a = await admin('register', { id: 'a', instructions: 'Review', inputs: {} });
  const payload = { token: a.token, status: 'completed', summary: 'done', result: 'done' };
  for (const extra of [{ token: 'wrong' }, { status: 'running' }, { summary: 'x'.repeat(2049) }, { result: 'x'.repeat(1048577) }]) {
    assert.equal((await invoke(service, 'submit_result', { ...payload, ...extra })).isError, true);
  }
  const malformed = await fetch(`http://127.0.0.1:${service.mcpPort}/mcp`, { method: 'POST', body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await admin('status')).events.length, 0);
}));

test('worker CLI honors the same config without changing existing data', () => fixture(async ({ dir, config, admin }) => {
  // Occupied ports must fail safely, not displace the existing service.
  const file = join(dir, 'config.json');
  const other = { ...config, dataDir: join(dir, 'port-conflict') };
  writeFileSync(file, JSON.stringify(other));
  await assert.rejects(execute(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], {
    env: { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: other.dataDir },
  }), /EADDRINUSE/);
  assert.equal(existsSync(join(other.dataDir, 'worker.lock')), false);
  assert.deepEqual(await admin('status'), { events: [], backupDue: [] });
}));

test('acknowledgment and cancellation retire task access across restarts', () => fixture(async f => {
  const a = await f.admin('register', { id: 'a', instructions: 'private instruction', inputs: { code: 'private input' } });
  const b = await f.admin('register', { id: 'b', instructions: 'cancel me', inputs: { code: 'private' } });
  const payload = { token: a.token, status: 'completed', summary: 'done', result: 'saved evidence' };
  await invoke(f.service, 'submit_result', payload);
  assert.equal((await invoke(f.service, 'submit_result', payload)).structuredContent.duplicate, true);
  await f.admin('ack', { id: 'a' }); await f.admin('cancel', { id: 'b' });
  await f.restart();
  for (const token of [a.token, b.token, undefined]) {
    assert.equal((await invoke(f.service, 'get_task', { token })).isError, true);
    assert.equal((await invoke(f.service, 'read_input', { token, name: 'code' })).isError, true);
  }
  assert.equal((await invoke(f.service, 'submit_result', payload)).isError, true);
  const state = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'));
  for (const task of state) { assert.equal(task.token, undefined); assert.deepEqual(task.inputs, {}); assert.equal(task.instructions, ''); }
}));

test('one data directory cannot be opened by two workers even on different ports', () => fixture(async f => {
  await assert.rejects(start({ dir: f.dir, port: 0, controlPort: 0 }), /data directory locked/);
  assert.deepEqual(await f.admin('status'), { events: [], backupDue: [] });
  await f.restart();
  assert.deepEqual(await f.admin('status'), { events: [], backupDue: [] });
}));

test('restart restores missing applied receipts and surfaces ambiguous crash journals without replaying writes', () => fixture(async f => {
  const root = join(f.dir, 'project'); mkdirSync(root);
  const a = await f.admin('register', { id: 'a', instructions: 'edit', inputs: {}, workspace: { root, mode: 'edit' } });
  const changed = await invoke(f.service, 'write_file', { token: a.token, path: 'a.txt', text: 'applied', expectedSha256: null });
  assert.equal(changed.isError, false);
  // Simulate the crash window after mutation/journal persistence but before task-state persistence.
  const statePath = join(f.dir, 'state.json');
  let state = JSON.parse(readFileSync(statePath, 'utf8')); state[0].changes = [];
  writeFileSync(statePath, JSON.stringify(state)); await f.restart();
  let task = (await invoke(f.service, 'get_task', { token: a.token })).structuredContent;
  assert.equal(task.changes[0].operation, changed.structuredContent.operation);
  assert.deepEqual(task.recoveryRequired, []);
  const journal = join(f.dir, 'recovery', 'a', changed.structuredContent.operation + '.json');
  writeFileSync(journal, JSON.stringify({ ...changed.structuredContent, state: 'prepared' }));
  state = JSON.parse(readFileSync(statePath, 'utf8')); state[0].changes = [];
  writeFileSync(statePath, JSON.stringify(state)); await f.restart();
  task = (await invoke(f.service, 'get_task', { token: a.token })).structuredContent;
  assert.equal(task.recoveryRequired.length, 1);
  assert.equal((await f.admin('wait')).recoveryRequired[0].id, 'a');
  assert.equal((await invoke(f.service, 'read_file', { token: a.token, path: 'a.txt' })).structuredContent.text, 'applied');
  assert.equal((await invoke(f.service, 'write_file', { token: a.token, path: 'b.txt', text: 'retry', expectedSha256: null })).isError, true);
  assert.equal((await invoke(f.service, 'submit_result', { token: a.token, status: 'completed', summary: 'done', result: 'done' })).isError, true);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'applied');
  await f.admin('cancel', { id: 'a' });
  assert.deepEqual(await f.admin('wait'), { events: [], backupDue: [] });
}));
