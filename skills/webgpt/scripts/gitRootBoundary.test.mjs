// Disposable metadata-shaped directories only. No real repository hooks or Git commands execute.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { grantWorkspace, listWorkspace, readWorkspace, changeWorkspace } from './workspace.mjs';
import { start } from './worker.mjs';
import { request, collectTask } from './client.mjs';

const denied = /Git metadata/;
const original = '# inert metadata fixture 한국어\n';
const revision = createHash('sha256').update(original).digest('hex');
function fixture(t, name = '.git', nested = false, beforeCleanup = () => {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt git-root 한글 ')));
  t.after(async () => { await beforeCleanup(); fs.rmSync(base, { recursive: true, force: true }); });
  const project = join(base, 'project'), metadata = join(project, name);
  const root = nested ? join(metadata, 'hooks') : metadata, dir = join(base, 'runtime');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(join(root, 'config'), original);
  const info = fs.lstatSync(root);
  const retained = mode => ({ root, mode, device: info.dev, inode: info.ino });
  return { base, project, metadata, root, dir, retained };
}
function alias(t, target, path) {
  try { fs.symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir'); return true; }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('directory aliases unavailable'); return false; }
    throw error;
  }
}
function rejectFileTools(f, grant) {
  assert.throws(() => listWorkspace(grant, '.'), denied);
  assert.throws(() => readWorkspace(grant, 'config'), denied);
  if (grant.mode === 'edit') {
    assert.throws(() => changeWorkspace(grant, f.dir, 'owned', {
      path: 'new/child.txt', text: 'not written', expectedSha256: null,
    }), denied);
    assert.throws(() => changeWorkspace(grant, f.dir, 'owned', {
      path: 'config', text: '# not applied', expectedSha256: revision,
    }), denied);
    assert.throws(() => changeWorkspace(grant, f.dir, 'owned', {
      path: 'config', expectedSha256: revision,
    }, true), denied);
  }
  assert.equal(fs.readFileSync(join(grant.root, 'config'), 'utf8'), original);
  assert.equal(fs.existsSync(join(grant.root, 'new')), false);
  assert.equal(fs.existsSync(f.dir), false);
}

for (const name of ['.git', '.GiT', 'GIT~1']) for (const nested of [false, true]) {
  test(`reject ${name} ${nested ? 'descendant' : 'root'} grants and retained access`, t => {
    const f = fixture(t, name, nested);
    for (const mode of ['read', 'edit']) {
      assert.throws(() => grantWorkspace({ root: f.root, mode }), denied);
      rejectFileTools(f, f.retained(mode));
    }
  });
}

for (const name of ['.git.', '.GIT ', 'Git~1. ', '.git::$DATA']) {
  test(`root policy rejects portable alias ${name} before filesystem resolution`, t => {
    const f = fixture(t);
    // Deliberately absent names also exercise platforms that cannot create this spelling.
    for (const mode of ['read', 'edit'])
      assert.throws(() => grantWorkspace({ root: join(f.base, name, 'hooks'), mode }), denied);
    assert.deepEqual(fs.readdirSync(f.base).sort(), ['project']);
  });
}

for (const nested of [false, true]) test(`canonical root rejects a directory alias into Git ${nested ? 'descendants' : 'metadata'}`, t => {
  const f = fixture(t, '.git', nested), link = join(f.base, 'apparently-ordinary');
  if (!alias(t, f.root, link)) return;
  for (const mode of ['read', 'edit']) assert.throws(() => grantWorkspace({ root: link, mode }), denied);
  assert.equal(fs.readFileSync(join(f.root, 'config'), 'utf8'), original);
});

test('a protected root spelling cannot be hidden by resolving a link out of metadata', t => {
  const f = fixture(t), ordinary = join(f.base, 'ordinary'), link = join(f.metadata, 'alias-out');
  fs.mkdirSync(ordinary); fs.writeFileSync(join(ordinary, 'config'), original);
  if (!alias(t, ordinary, link)) return;
  assert.throws(() => grantWorkspace({ root: link, mode: 'edit' }), denied);
  assert.equal(fs.readFileSync(join(ordinary, 'config'), 'utf8'), original);
});

test('every access rechecks canonical ancestors even when the retained root identity is unchanged', t => {
  const f = fixture(t), container = join(f.base, 'ordinary-parent'), root = join(container, 'child');
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(join(root, 'config'), original);
  const grant = grantWorkspace({ root, mode: 'edit' });
  const moved = join(f.metadata, 'moved'); fs.renameSync(container, moved);
  if (!alias(t, moved, container)) return;
  const current = fs.lstatSync(grant.root);
  assert.equal(current.dev, grant.device); assert.equal(current.ino, grant.inode);
  rejectFileTools(f, grant);
});

for (const name of ['.github', '.git-notes', 'git~10', 'ordinary']) test(`ordinary ${name} roots keep file editing and metadata filtering`, t => {
  const f = fixture(t, name), grant = grantWorkspace({ root: f.root, mode: 'edit' });
  fs.mkdirSync(join(f.root, '.git'));
  assert.deepEqual(listWorkspace(grant, '.').entries.map(e => e.name), ['config']);
  assert.throws(() => readWorkspace(grant, '.git/config'), denied);
  const file = readWorkspace(grant, 'config');
  const edited = changeWorkspace(grant, f.dir, 'owned', { path: 'config', text: original + '# changed\n', expectedSha256: file.sha256 });
  assert.equal(edited.action, 'edit');
  assert.equal(fs.readFileSync(edited.backup, 'utf8'), original);
  changeWorkspace(grant, f.dir, 'owned', { path: 'config', expectedSha256: edited.afterSha256 }, true);
  assert.equal(fs.existsSync(join(f.root, 'config')), false);
});

async function httpFixture(t, { retained = false, mode = 'edit', nested = false } = {}) {
  let worker;
  const f = fixture(t, '.git', nested, () => worker?.close()), config = { dataDir: f.dir };
  if (retained) {
    fs.mkdirSync(f.dir);
    fs.writeFileSync(join(f.dir, 'state.json'), JSON.stringify([{
      id: 'owned', token: 'fixture-retained-token', instructions: 'Fixture only', inputs: { example: 'supplied fixture' },
      status: 'running', collected: false, nextCheck: Date.now() + 900000, changes: [], workspace: f.retained(mode),
    }]), { mode: 0o600 });
  }
  worker = await start({ dir: f.dir, port: 0, controlPort: 0, waitMs: 20, configFile: join(f.base, 'config.json') });
  config.controlPort = worker.controlPort;
  const admin = (action, payload) => request(action, payload, config);
  const register = (id, root, grantMode = mode) => admin('register', {
    id, instructions: 'Fixture only', inputs: { example: 'supplied fixture' },
    ...(root ? { workspace: { root, mode: grantMode } } : {}),
  });
  const call = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${worker.mcpPort}/mcp`, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200); return (await response.json()).result;
  };
  return { ...f, worker, config, admin, register, call };
}

for (const mode of ['read', 'edit']) for (const nested of [false, true]) {
  test(`controller rejects ${mode} registration at Git ${nested ? 'descendant' : 'root'} without persistence`, async t => {
    const f = await httpFixture(t, { mode, nested });
    try {
      await assert.rejects(f.register('owned', f.root), error => error.statusCode === 400 && denied.test(error.message));
      assert.equal(fs.existsSync(join(f.dir, 'state.json')), false);
      assert.equal(fs.existsSync(join(f.dir, 'recovery')), false);
      assert.deepEqual(await f.admin('tasks'), { running: 0, uncollected: 0, tasks: [] });
      assert.equal(fs.readFileSync(join(f.root, 'config'), 'utf8'), original);
    } finally { await f.worker.close(); }
  });
  test(`retained ${mode} Git ${nested ? 'descendant' : 'root'} grant loses file access, not inspection or retirement`, async t => {
    const f = await httpFixture(t, { retained: true, mode, nested }), token = 'fixture-retained-token';
    try {
      for (const [name, args] of [
        ['list_files', { path: '.' }], ['read_file', { path: 'config' }],
        ['write_file', { path: 'new/child.txt', text: 'not written', expectedSha256: null }],
        ['delete_file', { path: 'config', expectedSha256: revision }],
      ]) {
        const result = await f.call(name, { token, ...args });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, mode === 'read' && ['write_file', 'delete_file'].includes(name) ? /read-only/ : denied);
      }
      assert.equal((await f.call('get_task', { token })).structuredContent.status, 'running');
      assert.equal((await f.call('read_input', { token, name: 'example' })).structuredContent.text, 'supplied fixture');
      await assert.rejects(f.admin('ready'), e => e.details.unavailableWorkspaces.includes('owned'));
      const other = await f.register('independent');
      assert.equal((await f.call('submit_result', { token: other.token, status: 'completed', summary: 'done', result: 'fixture result' })).isError, false);
      assert.equal((await collectTask('independent', f.config)).integrity, 'verified');
      assert.equal(fs.existsSync(join(f.dir, 'recovery')), false);
      assert.equal(fs.existsSync(join(f.root, 'new')), false);
      assert.equal(fs.readFileSync(join(f.root, 'config'), 'utf8'), original);
      await f.admin('cancel', { id: 'owned' });
      assert.equal((await f.call('get_task', { token })).isError, true);
      assert.equal((await f.admin('ready')).ok, true);
      const retired = JSON.parse(fs.readFileSync(join(f.dir, 'state.json'))).find(task => task.id === 'owned');
      assert.equal(retired.collected, true); assert.equal(retired.status, 'cancelled');
    } finally { await f.worker.close(); }
  });
}
