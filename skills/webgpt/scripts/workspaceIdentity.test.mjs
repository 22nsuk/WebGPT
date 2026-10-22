import test from 'node:test';
import assert from 'node:assert/strict';
import { rejectsRequest } from './test-fixtures/request-error.mjs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { grantWorkspace, readWorkspace, listWorkspace, probeWorkspace, changeWorkspace } from './workspace.mjs';
import { parseState } from './runtime.mjs';
import { start } from './worker.mjs';
import { request, collectTask } from './client.mjs';
import { callTool } from './test-fixtures/worker-http.mjs';

const original = 'retained source 한국어\n';
function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-workspace-identity-')));
  const root = join(base, 'project'), dir = join(base, 'runtime');
  fs.mkdirSync(root); fs.writeFileSync(join(root, 'note.txt'), original);
  const f = { base, root, dir, config: { dataDir: dir } };
  t.after(async () => {
    await f.worker?.close();
    t.mock.restoreAll(); syncBuiltinESMExports();
    fs.rmSync(base, { recursive: true, force: true });
  });
  f.open = async () => {
    f.worker = await start({ dir, port: 0, controlPort: 0, waitMs: 20, closeGraceMs: 100,
      configFile: join(base, 'config.json') });
    f.config.controlPort = f.worker.controlPort;
  };
  f.admin = (action, payload) => request(action, payload, f.config);
  f.spec = { id: 'owned', instructions: 'Identity fixture only', inputs: { sample: 'supplied input' },
    workspace: { root, mode: 'edit' } };
  return f;
}

// Inject only native identity fields. Directories, file bytes, descriptors,
// controller traffic and recovery journals remain real and independently checked.
function nativeIdentity(t, f, current = { device: 17n, inode: 42n }) {
  const native = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (path, options) => {
    const info = native(path, options);
    if (path === f.root) {
      info.dev = options?.bigint ? current.device : Number(current.device);
      info.ino = options?.bigint ? current.inode : Number(current.inode);
    }
    return info;
  });
  syncBuiltinESMExports();
  return current;
}
function retained(f, workspace, changes = []) {
  return { id: f.spec.id, token: 'retained-fixture-token', instructions: f.spec.instructions,
    inputs: f.spec.inputs, workspace, changes, status: 'running', collected: false,
    nextCheck: Date.now() + 900000 };
}
function saveTask(f, task) {
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(join(f.dir, 'state.json'), JSON.stringify([task]), { mode: 0o600 });
}
const state = f => JSON.parse(fs.readFileSync(join(f.dir, 'state.json'), 'utf8'));
const tool = (f, token, name, args = {}) => callTool(f.worker, name, { token, ...args });

for (const field of ['device', 'inode']) test(`full-width ${field} collisions cannot reuse a workspace grant`, t => {
  const f = fixture(t), current = nativeIdentity(t, f);
  current[field] = 2n ** 60n;
  const grant = grantWorkspace(f.spec.workspace), before = readWorkspace(grant, 'note.txt');
  assert.equal(grant[field], current[field].toString());
  const bytes = Buffer.from(JSON.stringify([retained(f, grant)]));
  assert.deepEqual(parseState(bytes, f.dir)[0].workspace, grant);
  const first = current[field]; current[field]++;
  assert.notEqual(first, current[field]);
  assert.equal(Number(first), Number(current[field]));
  for (const access of [
    () => readWorkspace(grant, 'note.txt'),
    () => listWorkspace(grant, '.'),
    () => probeWorkspace(grant),
    () => changeWorkspace(grant, f.dir, 'owned', { path: 'new/child.txt', text: 'not written', expectedSha256: null }),
    () => changeWorkspace(grant, f.dir, 'owned', { path: 'note.txt', text: 'not written', expectedSha256: before.sha256 }),
    () => changeWorkspace(grant, f.dir, 'owned', { path: 'note.txt', expectedSha256: before.sha256 }, true),
  ]) assert.throws(access, /workspace root changed/);
  assert.equal(fs.readFileSync(join(f.root, 'note.txt'), 'utf8'), original);
  assert.deepEqual(fs.readdirSync(f.root), ['note.txt']);
  assert.equal(fs.existsSync(f.dir), false);
});

test('new exact identities survive registration, reconciliation and worker restart', async t => {
  const f = fixture(t), current = nativeIdentity(t, f, { device: 2n ** 60n + 1n, inode: 2n ** 61n + 3n });
  await f.open();
  const registered = await f.admin('register', f.spec);
  const expected = { root: f.root, mode: 'edit', device: current.device.toString(), inode: current.inode.toString() };
  assert.deepEqual(state(f)[0].workspace, expected);
  await f.worker.close(); await f.open();
  const snapshot = await f.admin('reconcile', { ids: ['owned'] });
  assert.equal(snapshot.health.ok, true);
  assert.deepEqual(snapshot.tasks[0].workspace, expected);
  assert.deepEqual(await f.admin('register', f.spec), { id: 'owned', token: registered.token, duplicate: true });
  const read = await tool(f, registered.token, 'read_file', { path: 'note.txt' });
  assert.equal(read.isError, false); assert.equal(read.structuredContent.text, original);
  assert.deepEqual(state(f)[0].workspace, expected);
});

for (const values of [[0n, BigInt(Number.MAX_SAFE_INTEGER)], [BigInt(Number.MAX_SAFE_INTEGER), 0n], [17n, 42n]]) {
  test(`safe legacy identity ${values.join('/')} remains usable without a state migration`, async t => {
    const f = fixture(t), current = nativeIdentity(t, f, { device: values[0], inode: values[1] });
    const workspace = { ...grantWorkspace(f.spec.workspace), device: Number(current.device), inode: Number(current.inode) };
    const saved = retained(f, workspace); saveTask(f, saved); await f.open();
    const before = fs.readFileSync(join(f.dir, 'state.json'));
    assert.deepEqual(await f.admin('register', f.spec), { id: 'owned', token: saved.token, duplicate: true });
    assert.deepEqual(fs.readFileSync(join(f.dir, 'state.json')), before);
    const snapshot = await f.admin('reconcile', { ids: ['owned'] });
    assert.equal(snapshot.health.ok, true); assert.deepEqual(snapshot.tasks[0].workspace, workspace);
    const read = await tool(f, saved.token, 'read_file', { path: 'note.txt' });
    assert.equal(read.isError, false); assert.equal(read.structuredContent.text, original);
    const created = await tool(f, saved.token, 'write_file', { path: 'new.txt', text: 'new', expectedSha256: null });
    assert.equal(created.isError, false);
    assert.equal((await tool(f, saved.token, 'delete_file', {
      path: 'new.txt', expectedSha256: created.structuredContent.afterSha256,
    })).isError, false);
    assert.deepEqual(state(f)[0].workspace, workspace);
    current.inode++;
    assert.throws(() => readWorkspace(workspace, 'note.txt'), /workspace root changed/);
    await rejectsRequest(f.admin('register', f.spec), /task ID already exists/);
    assert.deepEqual(state(f)[0].workspace, workspace);
  });
}

for (const field of ['device', 'inode']) test(`imprecise retained ${field} blocks files, not inspection or retirement`, async t => {
  const f = fixture(t), current = nativeIdentity(t, f);
  current[field] = 2n ** 60n;
  const exact = grantWorkspace(f.spec.workspace), revision = readWorkspace(exact, 'note.txt').sha256;
  const receipt = changeWorkspace(exact, f.dir, 'owned', { path: 'retained.txt', text: 'retained evidence', expectedSha256: null });
  const journal = join(f.dir, 'recovery', 'owned', receipt.operation + '.json'), evidence = fs.readFileSync(journal);
  const workspace = { ...exact, [field]: Number(current[field]) }, saved = retained(f, workspace, [receipt]);
  saveTask(f, saved); await f.open();
  const before = fs.readFileSync(join(f.dir, 'state.json'));
  const snapshot = await f.admin('reconcile', { ids: ['owned'] });
  assert.equal(snapshot.health.stateVerified, true);
  assert.deepEqual(snapshot.health.unavailableWorkspaces, ['owned']);
  assert.deepEqual(snapshot.tasks[0].workspace, workspace);
  await rejectsRequest(f.admin('ready'), error => error.statusCode === 503 && error.details.issues.includes('WORKSPACE_UNAVAILABLE'));
  const assigned = await tool(f, saved.token, 'get_task');
  assert.equal(assigned.isError, false); assert.deepEqual(assigned.structuredContent.workspace, workspace);
  const input = await tool(f, saved.token, 'read_input', { name: 'sample' });
  assert.equal(input.isError, false); assert.equal(input.structuredContent.text, f.spec.inputs.sample);
  for (const [name, args] of [
    ['list_files', { path: '.' }],
    ['read_file', { path: 'note.txt' }],
    ['write_file', { path: 'new/child.txt', text: 'not written', expectedSha256: null }],
    ['write_file', { path: 'note.txt', text: 'not written', expectedSha256: revision }],
    ['delete_file', { path: 'note.txt', expectedSha256: revision }],
  ]) {
    const response = await tool(f, saved.token, name, args);
    assert.equal(response.isError, true); assert.match(response.content[0].text, /workspace identity is imprecise/);
  }
  await rejectsRequest(f.admin('register', f.spec), /workspace identity is imprecise/);
  assert.deepEqual(fs.readFileSync(join(f.dir, 'state.json')), before);
  assert.deepEqual(fs.readFileSync(journal), evidence);
  assert.deepEqual(fs.readdirSync(join(f.dir, 'recovery', 'owned')), [receipt.operation + '.json']);
  assert.equal(fs.readFileSync(join(f.root, 'note.txt'), 'utf8'), original);
  assert.equal(fs.existsSync(join(f.root, 'new')), false);
  const other = await f.admin('register', { id: 'unrelated', instructions: '', inputs: {} });
  assert.equal((await tool(f, other.token, 'submit_result', { status: 'completed', summary: '', result: 'independent' })).isError, false);
  assert.equal((await collectTask('unrelated', f.config)).collected, true);
  await f.admin('cancel', { id: 'owned' });
  const retired = state(f).find(task => task.id === 'owned');
  assert.equal(retired.collected, true); assert.equal(retired.token, undefined);
  assert.deepEqual(retired.workspace, workspace); assert.deepEqual(fs.readFileSync(journal), evidence);
  assert.equal((await f.admin('ready')).ok, true);
});

test('state accepts exact strings and retained finite numbers without accepting malformed identities', t => {
  const f = fixture(t), workspace = grantWorkspace(f.spec.workspace);
  for (const field of ['device', 'inode']) {
    for (const value of ['0', (2n ** 64n - 1n).toString(), 0, Number.MAX_SAFE_INTEGER, 2 ** 60, 1.5, -1]) {
      const task = retained(f, { ...workspace, [field]: value }), bytes = Buffer.from(JSON.stringify([task]));
      assert.deepEqual(parseState(bytes, f.dir), [task]);
      if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0))
        assert.throws(() => readWorkspace(task.workspace, 'note.txt'), /workspace identity is imprecise/);
    }
    for (const value of ['', '01', '-1', '+1', '1.0', '1e3', ' 1', '0x10', null, true, {}, []]) {
      const bytes = Buffer.from(JSON.stringify([retained(f, { ...workspace, [field]: value })]));
      assert.throws(() => parseState(bytes, f.dir), { code: 'STATE_INVALID' });
    }
  }
});
