// Exercise a disposable installation, never the active checkout or a real service.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { request, collectTask } from './client.mjs';
import { grantWorkspace } from './workspace.mjs';

const denied = /workspace overlaps worker deployment files/;
async function fixture(t, { deploy = true } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt deployment 한글 ')));
  const installed = join(base, 'installed'), scripts = join(installed, 'scripts');
  const deployment = join(installed, 'deploy'), windows = join(deployment, 'windows');
  const dir = join(base, 'runtime'), configFile = join(base, 'config.json');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(dir);
  // Include every production module/helper, but no tests or executable service launch.
  const source = fileURLToPath(new URL('.', import.meta.url));
  for (const name of fs.readdirSync(source)) {
    if ((name.endsWith('.mjs') && !name.endsWith('.test.mjs')) || name.endsWith('.ps1'))
      fs.copyFileSync(join(source, name), join(scripts, name));
  }
  const original = '# inert fixture launcher; never executed\n';
  if (deploy) {
    fs.mkdirSync(join(windows, 'nested'), { recursive: true });
    fs.writeFileSync(join(windows, 'run-worker-task.ps1'), original);
  }
  const { start } = await import(pathToFileURL(join(scripts, 'worker.mjs')).href);
  let worker;
  const config = { dataDir: dir };
  const boot = async () => {
    await worker?.close();
    worker = await start({ dir, port: 0, controlPort: 0, configFile, waitMs: 20 });
    config.controlPort = worker.controlPort;
  };
  const admin = (action, payload) => request(action, payload, config);
  const register = (id, root, mode = 'edit') => admin('register', {
    id, instructions: 'Fixture boundary review', inputs: { example: 'fixture input' },
    ...(root ? { workspace: { root, mode } } : {}),
  });
  const call = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${worker.mcpPort}/mcp`, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const legacy = (id, root, mode) => {
    const tasks = [{ id, token: 'fixture-only-' + id, status: 'running', collected: false,
      instructions: 'Retained fixture', inputs: { example: 'fixture input' }, changes: [],
      workspace: grantWorkspace({ root, mode }), nextCheck: Date.now() + 900000 }];
    fs.writeFileSync(join(dir, 'state.json'), JSON.stringify(tasks), { mode: 0o600 });
    return tasks[0].token;
  };
  t.after(async () => { await worker?.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, installed, deployment, windows, dir, configFile, config, original, boot, admin, register, call, legacy };
}
function alias(t, destination, name) {
  try { fs.symlinkSync(destination, name, process.platform === 'win32' ? 'junction' : 'dir'); return true; }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('directory aliases are unavailable'); return false; }
    throw error;
  }
}

for (const mode of ['read', 'edit']) for (const location of ['deployment', 'windows', 'nested']) {
  test(`registration rejects ${mode} access to the installed ${location} directory`, async t => {
    const f = await fixture(t); await f.boot();
    const root = location === 'nested' ? join(f.windows, 'nested') : f[location];
    await assert.rejects(f.register('self', root, mode), denied);
    assert.equal(fs.existsSync(join(f.dir, 'state.json')), false);
    assert.equal(fs.existsSync(join(f.dir, 'recovery')), false);
    assert.equal(fs.readFileSync(join(f.windows, 'run-worker-task.ps1'), 'utf8'), f.original);
    assert.deepEqual(await f.admin('tasks'), { running: 0, uncollected: 0, tasks: [] });
  });
}

for (const mode of ['read', 'edit']) {
  test(`legacy ${mode} deployment grants lose file access but keep recovery and cancellation`, async t => {
    const f = await fixture(t), token = f.legacy('legacy', f.windows, mode);
    await f.boot();
    const stored = JSON.parse(fs.readFileSync(join(f.dir, 'state.json')))[0];
    assert.equal(stored.token, token);
    assert.equal(stored.workspace.mode, mode);
    const task = await f.call('get_task', { token });
    assert.equal(task.isError, false); assert.equal(task.structuredContent.status, 'running');
    assert.equal((await f.call('read_input', { token, name: 'example' })).structuredContent.text, 'fixture input');
    for (const [name, extra] of [
      ['list_files', { path: '.' }], ['read_file', { path: 'run-worker-task.ps1' }],
      ['write_file', { path: 'new.txt', text: 'must not be written', expectedSha256: null }],
      ['delete_file', { path: 'run-worker-task.ps1', expectedSha256: '0'.repeat(64) }],
    ]) {
      const result = await f.call(name, { token, ...extra });
      assert.equal(result.isError, true); assert.match(result.content[0].text, denied);
    }
    await assert.rejects(f.register('legacy', f.windows, mode), denied);
    await assert.rejects(f.admin('ready'), error => error.details.unavailableWorkspaces.includes('legacy'));
    assert.equal((await f.admin('reconcile')).tasks[0].collected, false);
    assert.equal(fs.readFileSync(join(f.windows, 'run-worker-task.ps1'), 'utf8'), f.original);
    assert.equal(fs.existsSync(join(f.windows, 'new.txt')), false);
    assert.equal(fs.existsSync(join(f.dir, 'recovery')), false);
    // An independent task remains usable; a bad grant cannot halt the shared worker.
    const other = await f.register('other');
    assert.equal((await f.call('submit_result', { token: other.token, status: 'completed', summary: 'done', result: 'fixture evidence' })).isError, false);
    assert.equal((await collectTask('other', f.config)).integrity, 'verified');
    await f.admin('cancel', { id: 'legacy' });
    assert.equal((await f.call('get_task', { token })).isError, true);
    await f.boot();
    assert.equal((await f.admin('ready')).ok, true);
    const retired = JSON.parse(fs.readFileSync(join(f.dir, 'state.json'))).find(task => task.id === 'legacy');
    assert.equal(retired.status, 'cancelled'); assert.equal(retired.collected, true);
  });

  test(`an alternate path to deployment cannot restore ${mode} access`, async t => {
    const f = await fixture(t), link = join(f.base, 'deployment-alias');
    if (!alias(t, f.deployment, link)) return;
    await f.boot();
    await assert.rejects(f.register('alias', join(link, 'windows'), mode), denied);
    assert.equal(fs.existsSync(join(f.dir, 'state.json')), false);
  });

  test(`linked deployment protects its actual ${mode} target and enclosing project`, async t => {
    const f = await fixture(t, { deploy: false });
    const project = join(f.base, 'deployment-storage'), root = join(project, 'actual');
    fs.mkdirSync(join(root, 'windows'), { recursive: true });
    if (!alias(t, root, f.deployment)) return;
    await f.boot();
    for (const grant of [project, root, join(root, 'windows')])
      await assert.rejects(f.register('alias-target', grant, mode), denied);
    assert.equal(fs.existsSync(join(f.dir, 'state.json')), false);
  });
}

for (const mode of ['read', 'edit']) test(`a linked Windows launcher directory protects its external ${mode} target`, async t => {
  const f = await fixture(t, { deploy: false }), root = join(f.base, 'external-windows-launchers');
  fs.mkdirSync(root); fs.mkdirSync(f.deployment);
  fs.writeFileSync(join(root, 'run-worker-task.ps1'), f.original);
  if (!alias(t, root, f.windows)) return;
  await f.boot();
  await assert.rejects(f.register('windows-alias', root, mode), denied);
  assert.equal(fs.readFileSync(join(root, 'run-worker-task.ps1'), 'utf8'), f.original);
  assert.equal(fs.existsSync(join(f.dir, 'state.json')), false);
});

test('a deployment target added after startup is checked again before existing-grant access', async t => {
  const f = await fixture(t, { deploy: false }), root = join(f.base, 'later-deployment');
  fs.mkdirSync(root); fs.writeFileSync(join(root, 'marker.txt'), 'retained bytes');
  await f.boot();
  const { token } = await f.register('earlier', root);
  assert.equal((await f.call('read_file', { token, path: 'marker.txt' })).isError, false);
  if (!alias(t, root, f.deployment)) return;
  const result = await f.call('write_file', { token, path: 'new.txt', text: 'no', expectedSha256: null });
  assert.equal(result.isError, true); assert.match(result.content[0].text, denied);
  assert.equal(fs.existsSync(join(root, 'new.txt')), false);
  assert.equal(fs.readFileSync(join(root, 'marker.txt'), 'utf8'), 'retained bytes');
  await f.admin('cancel', { id: 'earlier' });
});

test('scripts-only installations stay usable without creating deployment directories', async t => {
  const f = await fixture(t, { deploy: false }); await f.boot();
  assert.equal((await f.admin('ready')).ok, true);
  const task = await f.register('text-only');
  assert.equal((await f.call('get_task', { token: task.token })).isError, false);
  assert.equal(fs.existsSync(f.deployment), false);
  await f.admin('cancel', { id: 'text-only' });
});

for (const location of ['source-copy', 'deploy-copy', 'references']) {
  test(`independent ${location} work remains editable with exact registration retry`, async t => {
    const f = await fixture(t); await f.boot();
    const root = location === 'source-copy' ? join(f.base, 'separate-source', 'deploy', 'windows')
      : join(f.installed, location);
    fs.mkdirSync(root, { recursive: true });
    const task = await f.register('independent', root);
    const retry = await f.register('independent', root);
    assert.equal(retry.token, task.token); assert.equal(retry.duplicate, true);
    const created = await f.call('write_file', { token: task.token, path: 'notes.txt', text: '허용된 복사본', expectedSha256: null });
    assert.equal(created.isError, false);
    const read = await f.call('read_file', { token: task.token, path: 'notes.txt' });
    assert.equal(read.structuredContent.text, '허용된 복사본');
    assert.equal((await f.call('delete_file', { token: task.token, path: 'notes.txt', expectedSha256: read.structuredContent.sha256 })).isError, false);
    assert.equal((await f.admin('ready')).ok, true);
  });
}
