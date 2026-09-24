import { test } from 'node:test';
import { withStateWriteFailure } from './test-fixtures/state-write-failure.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { start, tools } from './worker.mjs';
import { request, collectTask } from './client.mjs';
import { grantWorkspace, listWorkspace } from './workspace.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('./client.mjs', import.meta.url));
async function fixture(run) {
  const base = mkdtempSync(join(tmpdir(), 'webgpt-practical-'));
  const dir = join(base, 'runtime'), root = join(base, 'project');
  mkdirSync(root);
  let service = await start({ dir, port: 0, controlPort: 0, waitMs: 20 });
  const config = { dataDir: dir, controlPort: service.controlPort, mcpPort: service.mcpPort };
  const admin = (action, payload) => request(action, payload, config);
  const registration = (id, extra = {}) => ({ id, instructions: 'Review fixture files.', inputs: { sample: 'input' }, ...extra });
  const register = (id, extra) => admin('register', registration(id, extra));
  const call = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${config.mcpPort}/mcp`, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const complete = token => call('submit_result', { token, status: 'completed', summary: 'done', result: 'Saved evidence 한국어' });
  const restart = async () => {
    await service.close();
    service = await start({ dir, port: 0, controlPort: 0, waitMs: 20 });
    config.mcpPort = service.mcpPort; config.controlPort = service.controlPort;
  };
  const blockState = () => mkdirSync(join(dir, 'state.json.tmp'));
  const unblockState = () => rmdirSync(join(dir, 'state.json.tmp'));
  const runCli = async (...args) => {
    const file = join(base, 'config.json'); writeFileSync(file, JSON.stringify(config));
    const { stdout } = await execute(process.execPath, [cli, ...args], {
      cwd: root, env: { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: dir }, timeout: 5000,
    });
    return JSON.parse(stdout);
  };
  try { await run({ base, dir, root, config, admin, register, registration, call, complete, restart, blockState, unblockState, runCli }); }
  finally { await service.close(); rmSync(base, { recursive: true, force: true }); }
}

test('directory pages enumerate more than 500 entries without omissions or duplicates', () => fixture(({ root }) => {
  for (let i = 0; i < 1105; i++) writeFileSync(join(root, `file-${String(i).padStart(4, '0')}.txt`), 'x');
  mkdirSync(join(root, '.git'));
  const grant = grantWorkspace({ root, mode: 'read' });
  let cursor, names = [], pages = 0;
  do {
    const page = listWorkspace(grant, '.', { cursor });
    assert.ok(page.entries.length <= 500);
    assert.equal(page.truncated, Boolean(page.nextCursor));
    names.push(...page.entries.map(e => e.name)); cursor = page.nextCursor;
    assert.ok(++pages <= 3, 'pagination must terminate');
  } while (cursor);
  assert.equal(pages, 3); assert.equal(names.length, 1105); assert.equal(new Set(names).size, 1105);
  assert.ok(!names.includes('.git'));
}));

test('directory cursors fail clearly on changed listings and cannot select a different directory', () => fixture(({ root }) => {
  mkdirSync(join(root, 'nested'));
  for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(root, name), 'x');
  const grant = grantWorkspace({ root, mode: 'read' });
  const page = listWorkspace(grant, '.', { limit: 2 });
  assert.ok(page.nextCursor);
  assert.throws(() => listWorkspace(grant, 'nested', { cursor: page.nextCursor }), /directory changed|cursor/);
  writeFileSync(join(root, 'added.txt'), 'x');
  assert.throws(() => listWorkspace(grant, '.', { cursor: page.nextCursor }), /directory changed/);
  assert.equal(listWorkspace(grant, '.', { limit: 2 }).entries.length, 2);
}));

test('pagination validates bounds and cursors while keeping ordinary listing compatibility', () => fixture(({ root }) => {
  const grant = grantWorkspace({ root, mode: 'read' });
  assert.deepEqual(listWorkspace(grant, '.'), { path: '.', entries: [], truncated: false });
  for (const limit of [0, 501, -1, 1.5, '10', null]) assert.throws(() => listWorkspace(grant, '.', { limit }), /limit/);
  for (const cursor of ['', 'not-json', {}, 'x'.repeat(1000)]) assert.throws(() => listWorkspace(grant, '.', { cursor }), /cursor/);
  assert.throws(() => listWorkspace(grant, '.GIT', { limit: 2 }), /Git metadata/);
}));

test('MCP advertises and serves optional pagination without adding privileged tools', () => fixture(async f => {
  for (let i = 0; i < 5; i++) writeFileSync(join(f.root, `file${i}.txt`), 'x');
  const { token } = await f.register('pages', { workspace: { root: f.root, mode: 'read' } });
  const schema = tools.find(t => t.name === 'list_files').inputSchema;
  assert.ok(schema.properties.cursor); assert.ok(schema.properties.limit);
  assert.deepEqual(schema.required, ['token', 'path']); assert.equal(tools.length, 7);
  const first = await f.call('list_files', { token, path: '.', limit: 2 });
  assert.equal(first.isError, false); assert.equal(first.structuredContent.entries.length, 2);
  const second = await f.call('list_files', { token, path: '.', limit: 2, cursor: first.structuredContent.nextCursor });
  assert.equal(second.structuredContent.entries[0].name, 'file2.txt');
  assert.equal((await f.call('list_files', { token: 'wrong', path: '.', cursor: first.structuredContent.nextCursor })).isError, true);
}));

test('a failed registration save does not leave an in-memory phantom task', () => fixture(async f => {
  f.blockState();
  await assert.rejects(f.register('retry'));
  f.unblockState();
  const registered = await f.register('retry');
  assert.ok(registered.token);
  await f.restart();
  assert.equal((await f.call('get_task', { token: registered.token })).isError, false);
}));

test('failed completion persistence is not reported as success on a repeated submission', () => fixture(async f => {
  const { token } = await f.register('result');
  f.blockState();
  assert.equal((await f.complete(token)).isError, true);
  assert.equal((await f.call('get_task', { token })).structuredContent.status, 'running');
  assert.equal((await f.complete(token)).isError, true, 'an identical retry must not bypass failed persistence');
  f.unblockState();
  assert.equal((await f.complete(token)).isError, false);
  await f.restart();
  assert.equal((await f.admin('status')).events[0].status, 'completed');
  const collected = await collectTask('result', f.config);
  assert.equal(readFileSync(collected.artifact, 'utf8'), 'Saved evidence 한국어');
}));

test('failed acknowledgment preserves task access until the state save succeeds', () => fixture(async f => {
  const { token } = await f.register('ack'); await f.complete(token);
  f.blockState(); await assert.rejects(f.admin('ack', { id: 'ack' }));
  assert.equal((await f.call('get_task', { token })).isError, false);
  assert.equal((await f.admin('status')).events.length, 1);
  f.unblockState(); await collectTask('ack', f.config);
  await f.restart();
  assert.equal((await f.call('get_task', { token })).isError, true);
}));

test('failed cancellation preserves registration and can be retried durably', () => fixture(async f => {
  const { token } = await f.register('cancel');
  f.blockState(); await assert.rejects(f.admin('cancel', { id: 'cancel' }));
  assert.equal((await f.call('get_task', { token })).structuredContent.status, 'running');
  f.unblockState(); await f.admin('cancel', { id: 'cancel' });
  await f.restart();
  assert.equal((await f.call('get_task', { token })).isError, true);
}));

test('an applied file change with unsaved task state blocks later edits until recovery', t => fixture(async f => {
  const { token } = await f.register('edit', { workspace: { root: f.root, mode: 'edit' } });
  const changed = await withStateWriteFailure(t, f.dir, () => f.call('write_file', { token, path: 'first.txt', text: 'preserve this', expectedSha256: null }));
  assert.equal(changed.isError, true); assert.equal(readFileSync(join(f.root, 'first.txt'), 'utf8'), 'preserve this');
  const second = await f.call('write_file', { token, path: 'second.txt', text: 'must not apply', expectedSha256: null });
  assert.equal(second.isError, true); assert.equal(existsSync(join(f.root, 'second.txt')), false);
  assert.equal((await f.complete(token)).isError, true);
  assert.equal((await f.admin('status')).recoveryRequired[0].id, 'edit');
  await f.restart();
  const task = (await f.call('get_task', { token })).structuredContent;
  assert.equal(task.changes.length, 1); assert.deepEqual(task.recoveryRequired, []);
  assert.equal((await f.complete(token)).isError, false);
}));

test('private runtime data cannot be granted through an enclosing project root', () => fixture(async f => {
  for (const root of [f.dir, f.base]) for (const mode of ['read', 'edit']) {
    await assert.rejects(f.register('unsafe', { workspace: { root, mode } }), /private worker data/);
  }
  const safe = await f.register('safe', { workspace: { root: f.root, mode: 'read' } });
  assert.equal((await f.call('list_files', { token: safe.token, path: '.' })).isError, false);
}));

test('private runtime descendants cannot be registered as read or edit workspaces', () => fixture(async f => {
  const recovery = join(f.dir, 'recovery'), backupRoot = join(recovery, 'prior-task');
  mkdirSync(backupRoot, { recursive: true });
  const backup = join(backupRoot, 'private.before.txt');
  writeFileSync(backup, 'private recovery fixture');
  for (const root of [recovery, backupRoot]) for (const mode of ['read', 'edit'])
    await assert.rejects(f.register('unsafe-child', { workspace: { root, mode } }), /private worker data/);
  assert.equal(readFileSync(backup, 'utf8'), 'private recovery fixture');
  assert.deepEqual(await f.admin('tasks'), { running: 0, uncollected: 0, tasks: [] });
  const sibling = join(f.base, 'runtime-copy'); mkdirSync(sibling);
  const safe = await f.register('safe-sibling', { workspace: { root: sibling, mode: 'edit' } });
  assert.equal((await f.call('write_file', { token: safe.token, path: 'ok.txt', text: 'allowed', expectedSha256: null })).isError, false);
}));

test('legacy grants inside private recovery data lose all file access but remain cancellable', () => fixture(async f => {
  const root = join(f.dir, 'recovery', 'prior-task'); mkdirSync(root, { recursive: true });
  const backup = join(root, 'private.before.txt'); writeFileSync(backup, 'private recovery fixture');
  for (const mode of ['read', 'edit']) {
    const id = 'legacy-' + mode;
    const { token } = await f.register(id, { workspace: { root: f.root, mode } });
    const statePath = join(f.dir, 'state.json'), state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.find(t => t.id === id).workspace = grantWorkspace({ root, mode });
    writeFileSync(statePath, JSON.stringify(state)); await f.restart();
    for (const name of ['list_files', 'read_file', 'write_file', 'delete_file']) {
      const result = await f.call(name, { token, path: name === 'list_files' ? '.' : 'private.before.txt', text: 'forbidden', expectedSha256: null });
      assert.equal(result.isError, true, mode + ': ' + name);
      assert.match(result.content[0].text, /private worker data/);
    }
    assert.equal((await f.call('get_task', { token })).isError, false);
    assert.equal(readFileSync(backup, 'utf8'), 'private recovery fixture');
    await f.admin('cancel', { id });
  }
}));

test('older overlapping grants are preserved for cancellation but lose file access', () => fixture(async f => {
  const { token } = await f.register('legacy', { workspace: { root: f.root, mode: 'read' } });
  const statePath = join(f.dir, 'state.json'), state = JSON.parse(readFileSync(statePath, 'utf8'));
  state[0].workspace = grantWorkspace({ root: f.base, mode: 'read' });
  writeFileSync(statePath, JSON.stringify(state)); await f.restart();
  assert.equal((await f.call('get_task', { token })).isError, false);
  const result = await f.call('read_file', { token, path: 'runtime/controller.key' });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /private worker data/);
  await f.admin('cancel', { id: 'legacy' });
}));

test('identical running registrations retry safely without widening scope or resetting the deadline', () => fixture(async f => {
  const payload = f.registration('same', { workspace: { root: f.root, mode: 'read' }, inputs: { a: 'one', b: 'two' } });
  const first = await f.admin('register', payload);
  const statePath = join(f.dir, 'state.json');
  const before = JSON.parse(readFileSync(statePath, 'utf8'))[0].nextCheck;
  const second = await f.admin('register', { ...payload, inputs: { b: 'two', a: 'one' } });
  assert.equal(second.token, first.token); assert.equal(second.duplicate, true);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8'))[0].nextCheck, before);
  await assert.rejects(f.admin('register', { ...payload, instructions: 'Different task' }), /task ID already exists/);
  await assert.rejects(f.admin('register', { ...payload, workspace: { root: f.root, mode: 'edit' } }), /task ID already exists/);
  await f.restart();
  assert.equal((await f.admin('register', payload)).token, first.token);
  await f.complete(first.token);
  await assert.rejects(f.admin('register', payload), /task ID already exists/);
}));

test('task inventory distinguishes running work from an idle event queue without leaking credentials', () => fixture(async f => {
  const a = await f.register('running', { workspace: { root: f.root, mode: 'read' } });
  assert.deepEqual(await f.admin('status'), { events: [], backupDue: [] });
  const inventory = await f.admin('tasks');
  assert.equal(inventory.running, 1); assert.equal(inventory.uncollected, 0);
  assert.equal(inventory.tasks[0].id, 'running'); assert.equal(inventory.tasks[0].workspace.mode, 'read');
  const serialized = JSON.stringify(inventory);
  assert.ok(!serialized.includes(a.token)); assert.ok(!serialized.includes('Review fixture files.'));
  assert.ok(!serialized.includes('controller.key'));
  await f.complete(a.token);
  assert.equal((await f.admin('tasks')).uncollected, 1);
  await collectTask('running', f.config);
  assert.deepEqual(await f.admin('tasks'), { running: 0, uncollected: 0, tasks: [] });
  assert.deepEqual(await f.runCli('tasks'), { running: 0, uncollected: 0, tasks: [] });
  const response = await fetch(`http://127.0.0.1:${f.config.controlPort}/tasks`);
  assert.equal(response.status, 401);
}));

test('task IDs take precedence over same-named files; explicit --file retains JSON support', () => fixture(async f => {
  const a = await f.register('task'); const b = await f.register('other');
  writeFileSync(join(f.root, 'task'), JSON.stringify({ id: 'other' }));
  await f.runCli('cancel', 'task');
  assert.equal((await f.call('get_task', { token: a.token })).isError, true);
  assert.equal((await f.call('get_task', { token: b.token })).isError, false);
  await f.runCli('cancel', '--file', 'task');
  assert.equal((await f.call('get_task', { token: b.token })).isError, true);
  const c = await f.register('waitjob'); await f.complete(c.token);
  writeFileSync(join(f.root, 'waitjob'), 'not JSON');
  assert.equal((await f.runCli('wait', 'waitjob')).events[0].id, 'waitjob');
  writeFileSync(join(f.root, 'ids'), JSON.stringify({ ids: ['waitjob'] }));
  assert.equal((await f.runCli('wait', '--file', 'ids')).events[0].id, 'waitjob');
}));

test('non-string task IDs are rejected before creating state or results', () => fixture(async f => {
  for (const id of [123, true, ['task']]) await assert.rejects(f.register(id), /invalid task/);
  assert.equal(existsSync(join(f.dir, 'state.json')), false);
}));

test('portable registration prevents case-alias collisions and Windows device-name artifacts', () => fixture(async f => {
  for (const id of ['CON', 'prn', 'Aux', 'NUL', 'COM1', 'com9', 'Lpt1', 'LPT9'])
    await assert.rejects(f.register(id), /reserved Windows filename/);
  const { token } = await f.register('Review');
  await assert.rejects(f.register('review'), /case-insensitive/);
  await f.complete(token); await collectTask('Review', f.config);
  await assert.rejects(f.register('REVIEW'), /case-insensitive/);
  assert.equal(readFileSync(join(f.dir, 'Review.result.txt'), 'utf8'), 'Saved evidence 한국어');
  assert.ok((await f.register('review-2')).token);
}));

test('revision conflicts and rejected paths do not block an otherwise healthy editor', () => fixture(async f => {
  const { token } = await f.register('healthy', { workspace: { root: f.root, mode: 'edit' } });
  const first = await f.call('write_file', { token, path: 'file.txt', text: 'one', expectedSha256: null });
  assert.equal(first.isError, false);
  assert.equal((await f.call('write_file', { token, path: 'file.txt', text: 'stale', expectedSha256: null })).isError, true);
  assert.equal((await f.call('write_file', { token, path: '.GIT/config', text: 'blocked', expectedSha256: null })).isError, true);
  assert.deepEqual((await f.call('get_task', { token })).structuredContent.recoveryRequired, []);
  const edited = await f.call('write_file', { token, path: 'file.txt', text: 'two', expectedSha256: first.structuredContent.afterSha256 });
  assert.equal(edited.isError, false);
  assert.equal((await f.complete(token)).isError, false);
}));

test('result file write failure leaves work running and does not discard a saved result on retry', () => fixture(async f => {
  const { token } = await f.register('artifact');
  const blocked = join(f.dir, 'artifact.result.txt.tmp'); mkdirSync(blocked);
  assert.equal((await f.complete(token)).isError, true);
  assert.equal((await f.call('get_task', { token })).structuredContent.status, 'running');
  assert.equal(existsSync(join(f.dir, 'artifact.result.txt')), false);
  rmdirSync(blocked);
  assert.equal((await f.complete(token)).isError, false);
  assert.equal((await f.complete(token)).structuredContent.duplicate, true);
  await collectTask('artifact', f.config);
}));

test('failed backup-check persistence does not move a live deadline', () => fixture(async f => {
  const { token } = await f.register('deadline');
  const statePath = join(f.dir, 'state.json');
  const before = JSON.parse(readFileSync(statePath, 'utf8'))[0].nextCheck;
  f.blockState(); await assert.rejects(f.admin('checked', { id: 'deadline' }));
  assert.equal((await f.admin('tasks')).tasks[0].nextCheck, before);
  f.unblockState(); await f.admin('checked', { id: 'deadline' });
  assert.equal((await f.call('get_task', { token })).structuredContent.status, 'running');
}));

test('only the failing file task is blocked; unrelated tasks can still complete after storage recovers', t => fixture(async f => {
  const editor = await f.register('editor', { workspace: { root: f.root, mode: 'edit' } });
  const other = await f.register('other');
  const changed = await withStateWriteFailure(t, f.dir, () => f.call('write_file', { token: editor.token, path: 'saved.txt', text: 'keep', expectedSha256: null }));
  assert.equal(changed.isError, true);
  assert.equal(readFileSync(join(f.root, 'saved.txt'), 'utf8'), 'keep');
  assert.equal((await f.complete(other.token)).isError, false);
  await collectTask('other', f.config);
  const state = await f.admin('status');
  assert.deepEqual(state.recoveryRequired.map(t => t.id), ['editor']);
  assert.equal((await f.complete(editor.token)).isError, true);
}));
