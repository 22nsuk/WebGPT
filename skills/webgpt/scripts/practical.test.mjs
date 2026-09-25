import { test } from 'node:test';
import { withStateWriteFailure } from './test-fixtures/state-write-failure.mjs';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, rmdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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

// A name advertised as text must round-trip to the same native directory entry.
// These checks do not grant access to raw byte paths or normalize valid Unicode.
test('Unicode directory pages retain exact names, cursor ordering and readable targets', () => fixture(async f => {
  for (const name of ['a.txt', '한글-🎾.txt', '\ufeffbom.txt', 'replacement-\ufffd.txt', 'e\u0301.txt'])
    writeFileSync(join(f.root, name), 'owned file: ' + name);
  mkdirSync(join(f.root, '.git'));
  const expected = fs.readdirSync(f.root).filter(name => name !== '.git').sort();
  const { token } = await f.register('unicode-pages', { workspace: { root: f.root, mode: 'read' } });
  const before = readFileSync(join(f.dir, 'state.json'));
  const names = []; let cursor;
  do {
    const result = await f.call('list_files', { token, path: '.', limit: 2, ...(cursor ? { cursor } : {}) });
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    for (const entry of result.structuredContent.entries) {
      names.push(entry.name); assert.equal(entry.type, 'file');
      const read = await f.call('read_file', { token, path: entry.name });
      assert.equal(read.isError, false);
      assert.equal(read.structuredContent.text, readFileSync(join(f.root, entry.name), 'utf8'));
    }
    cursor = result.structuredContent.nextCursor;
    assert.ok(names.length <= expected.length, 'pagination must not repeat names');
  } while (cursor);
  assert.deepEqual(names, expected); assert.ok(names.includes('\ufeffbom.txt')); assert.ok(names.includes('replacement-\ufffd.txt'));
  assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
}));

test('listing rejects lossy name bytes before returning any page, without silent filtering', t => fixture(async f => {
  for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(f.root, name), name);
  const { token } = await f.register('name-bytes', { workspace: { root: f.root, mode: 'read' } });
  const first = (await f.call('list_files', { token, path: '.', limit: 1 })).structuredContent;
  const before = readFileSync(join(f.dir, 'state.json')), readdir = fs.readdirSync;
  let malformed;
  // Windows cannot create arbitrary POSIX filename bytes. Exercise the same
  // decoder there with explicitly synthetic Dirents; native Linux is tested below.
  const mock = t.mock.method(fs, 'readdirSync', (path, options) => {
    const entries = readdir(path, options);
    if (path === fs.realpathSync.native(f.root) && malformed) entries.push({
      name: options?.encoding === 'buffer' ? malformed : malformed.toString('utf8'),
      isSymbolicLink: () => false, isDirectory: () => false,
    });
    return entries;
  });
  syncBuiltinESMExports();
  try {
    for (const bytes of [[0xff], [0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82]]) {
      malformed = Buffer.concat([Buffer.from('z-private-'), Buffer.from(bytes), Buffer.from('.txt')]);
      for (const options of [{ limit: 1 }, { limit: 1, cursor: first.nextCursor }]) {
        const result = await f.call('list_files', { token, path: '.', ...options });
        assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
        assert.equal(result.content[0].text, 'directory entry name must be UTF-8; inspect with native filesystem tools');
        assert.ok(!JSON.stringify(result).includes('z-private-'));
      }
    }
    malformed = null;
    const second = await f.call('list_files', { token, path: '.', limit: 1, cursor: first.nextCursor });
    assert.equal(second.isError, false); assert.equal(second.structuredContent.entries[0].name, 'b.txt');
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
  assert.equal(existsSync(join(f.dir, 'recovery')), false);
}));

test('native non-UTF-8 filename cannot be advertised as a different replacement-character file',
  { skip: process.platform !== 'linux' ? 'native arbitrary-byte filename fixture requires Linux' : false },
  () => fixture(async f => {
    const raw = Buffer.concat([Buffer.from(f.root + '/report-'), Buffer.from([0xff]), Buffer.from('.txt')]);
    const valid = join(f.root, 'report-\ufffd.txt');
    writeFileSync(raw, 'raw-name original'); writeFileSync(valid, 'different valid file');
    mkdirSync(join(f.root, 'safe')); writeFileSync(join(f.root, 'safe', 'ok.txt'), 'independent');
    const { token } = await f.register('native-names', { workspace: { root: f.root, mode: 'edit' } });
    const before = readFileSync(join(f.dir, 'state.json'));
    const result = await f.call('list_files', { token, path: '.' });
    assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
    assert.match(result.content[0].text, /name must be UTF-8/);
    assert.equal((await f.call('read_file', { token, path: 'report-\ufffd.txt' })).structuredContent.text, 'different valid file');
    assert.deepEqual((await f.call('list_files', { token, path: 'safe' })).structuredContent.entries, [{ name: 'ok.txt', type: 'file' }]);
    assert.deepEqual((await f.call('get_task', { token })).structuredContent.changes, []);
    assert.equal(readFileSync(raw, 'utf8'), 'raw-name original'); assert.equal(readFileSync(valid, 'utf8'), 'different valid file');
    assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
    assert.equal(existsSync(join(f.dir, 'recovery')), false);
  }));

// Registration follows legitimate root aliases. Their canonical native bytes
// must still name the requested project, not a replacement-character sibling.
test('normal Unicode root aliases retain grant identity, retries and scoped edits', t => fixture(async f => {
  const root = join(f.base, '한글-🎾-\ufffd-e\u0301'), alias = join(f.base, 'selected-project');
  mkdirSync(root); writeFileSync(join(root, 'value.txt'), 'selected project');
  try { fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('directory aliases unavailable'); throw error; }
  for (const mode of ['read', 'edit']) {
    const task = await f.register('alias-' + mode, { workspace: { root: alias, mode } });
    const direct = grantWorkspace({ root, mode }), before = readFileSync(join(f.dir, 'state.json'));
    assert.deepEqual((await f.call('get_task', { token: task.token })).structuredContent.workspace, direct);
    const retry = await f.register(task.id, { workspace: { root, mode } });
    assert.equal(retry.duplicate, true); assert.equal(retry.token, task.token);
    assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
    assert.equal((await f.call('list_files', { token: task.token, path: '.' })).structuredContent.entries[0].name, 'value.txt');
    const read = (await f.call('read_file', { token: task.token, path: 'value.txt' })).structuredContent;
    assert.equal(read.text, 'selected project');
    const changed = await f.call('write_file', { token: task.token, path: 'value.txt', text: 'updated', expectedSha256: read.sha256 });
    assert.equal(changed.isError, mode === 'read');
  }
  await f.restart();
  assert.equal(readFileSync(join(root, 'value.txt'), 'utf8'), 'updated');
  assert.equal((await f.admin('reconcile')).health.stateVerified, true);
}));

test('native canonical bytes are checked at grant and file resolution without changing ordinary paths', t => fixture(async f => {
  const replacement = join(f.base, 'root-\ufffd'); mkdirSync(replacement);
  const file = join(f.root, 'value.txt'), other = join(f.root, 'file-\ufffd.txt');
  writeFileSync(file, 'requested'); writeFileSync(other, 'different');
  const grant = grantWorkspace({ root: f.root, mode: 'edit' }), native = fs.realpathSync.native;
  const malformedRoot = Buffer.concat([Buffer.from(f.base + '/root-'), Buffer.from([0xff])]);
  const malformedFile = Buffer.concat([Buffer.from(f.root + '/file-'), Buffer.from([0xff]), Buffer.from('.txt')]);
  let selected = f.root, bytes = malformedRoot;
  // Synthetic native returns make the rejection test portable. The following
  // Linux fixtures exercise real arbitrary-byte aliases without this mock.
  const mock = t.mock.method(fs.realpathSync, 'native', (path, options) => path === selected
    ? options?.encoding === 'buffer' ? bytes : bytes.toString('utf8') : native(path, options));
  try {
    assert.throws(() => grantWorkspace({ root: f.root, mode: 'edit' }), /workspace path must be UTF-8/);
    selected = native(file); bytes = malformedFile; // Include native temp-path aliases on Windows/macOS.
    const task = await f.register('canonical-file', { workspace: { root: f.root, mode: 'edit' } });
    const before = readFileSync(join(f.dir, 'state.json'));
    const read = await f.call('read_file', { token: task.token, path: 'value.txt' });
    assert.equal(read.isError, true); assert.equal(read.structuredContent, undefined);
    assert.equal(read.content[0].text, 'workspace path must be UTF-8; inspect with native filesystem tools');
    assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
    assert.equal(grant.root, native(f.root));
  } finally { mock.mock.restore(); }
  assert.equal(readFileSync(file, 'utf8'), 'requested'); assert.equal(readFileSync(other, 'utf8'), 'different');
  assert.equal(existsSync(join(f.dir, 'recovery')), false);
}));

test('native root alias cannot register a replacement-character sibling as the selected project',
  { skip: process.platform !== 'linux' ? 'native arbitrary-byte directory fixture requires Linux' : false },
  () => fixture(async f => {
    const raw = Buffer.concat([Buffer.from(f.base + '/project-'), Buffer.from([0xff])]);
    const replacement = join(f.base, 'project-\ufffd'), alias = join(f.base, 'selected-project');
    fs.mkdirSync(raw); mkdirSync(replacement); fs.symlinkSync(raw, alias, 'dir');
    fs.writeFileSync(Buffer.concat([raw, Buffer.from('/value.txt')]), 'requested raw directory');
    writeFileSync(join(replacement, 'value.txt'), 'different directory');
    await f.register('independent'); const before = readFileSync(join(f.dir, 'state.json'));
    assert.equal(alias.isWellFormed(), true);
    assert.equal(Buffer.from(fs.realpathSync.native(alias)).equals(fs.realpathSync.native(alias, { encoding: 'buffer' })), false);
    for (const mode of ['read', 'edit']) {
      assert.throws(() => grantWorkspace({ root: alias, mode }), /workspace path must be UTF-8/);
      await assert.rejects(f.register('rejected-' + mode, { workspace: { root: alias, mode } }), error => {
        assert.equal(error.statusCode, 400); assert.match(error.message, /workspace path must be UTF-8/);
        assert.ok(!error.message.includes(f.base)); return true;
      });
    }
    assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
    assert.equal(existsSync(join(f.dir, 'state.json.tmp')), false); assert.equal(existsSync(join(f.dir, 'recovery')), false);
    assert.equal(readFileSync(Buffer.concat([raw, Buffer.from('/value.txt')]), 'utf8'), 'requested raw directory');
    assert.equal(readFileSync(join(replacement, 'value.txt'), 'utf8'), 'different directory');
  }));

test('retained grant rejects a newly lossy canonical ancestor before file reads or mutations',
  { skip: process.platform !== 'linux' ? 'native arbitrary-byte directory fixture requires Linux' : false },
  () => fixture(async f => {
    const parent = join(f.base, 'ordinary-parent'), root = join(parent, 'child');
    mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'value.txt'), 'original');
    const task = await f.register('retained', { workspace: { root, mode: 'edit' } }), other = await f.register('independent');
    const revision = (await f.call('read_file', { token: task.token, path: 'value.txt' })).structuredContent.sha256;
    const original = fs.lstatSync(root), raw = Buffer.concat([Buffer.from(f.base + '/moved-'), Buffer.from([0xff])]);
    fs.renameSync(parent, raw); fs.symlinkSync(raw, parent, 'dir');
    const current = fs.lstatSync(root); assert.equal(current.ino, original.ino); assert.equal(current.dev, original.dev);
    const before = readFileSync(join(f.dir, 'state.json'));
    for (const [name, args] of [['list_files', { path: '.' }], ['read_file', { path: 'value.txt' }],
      ['write_file', { path: 'value.txt', text: 'must not replace', expectedSha256: revision }],
      ['write_file', { path: 'new/child.txt', text: 'must not create', expectedSha256: null }],
      ['delete_file', { path: 'value.txt', expectedSha256: revision }]]) {
      const result = await f.call(name, { token: task.token, ...args });
      assert.equal(result.isError, true); assert.match(result.content[0].text, /workspace path must be UTF-8/);
    }
    const health = (await f.admin('reconcile', { ids: [task.id] })).health;
    assert.equal(health.stateVerified, true); assert.deepEqual(health.unavailableWorkspaces, [task.id]);
    assert.equal((await f.call('get_task', { token: other.token })).isError, false);
    assert.equal((await f.call('get_task', { token: task.token })).isError, false, 'parent/task evidence remains available');
    assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
    assert.equal(readFileSync(join(root, 'value.txt'), 'utf8'), 'original');
    assert.equal(existsSync(join(root, 'new')), false); assert.equal(existsSync(join(f.dir, 'recovery')), false);
  }));
