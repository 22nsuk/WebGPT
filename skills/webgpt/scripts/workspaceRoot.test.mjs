import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateWorkspaceInput, grantWorkspace } from './workspace.mjs';
import { start } from './worker.mjs';
import { request } from './client.mjs';
import { callTool } from './test-fixtures/worker-http.mjs';

const execute = promisify(execFile);
const invalidRoot = { message: 'workspace root must be fully qualified' };

test('workspace root syntax preserves qualified native paths without resolving them', () => {
  // UNC coverage is lexical: no live share or network access is required.
  const roots = process.platform === 'win32'
    ? ['C:\\project', 'C:/project', '\\\\server\\share\\project', '//server/share/project',
      '\\\\?\\C:\\project', '\\\\?\\UNC\\server\\share\\project']
    : ['/absolute/project', '/absolute/한국어 😀', '//absolute/project'];
  for (const root of roots) for (const mode of ['read', 'edit']) {
    const input = { root, mode };
    assert.doesNotThrow(() => validateWorkspaceInput(input));
    assert.deepEqual(input, { root, mode });
  }
});

test('Windows drive-less roots fail before native grant resolution', { skip: process.platform !== 'win32' }, () => {
  for (const root of ['\\project', '/project', '\\\\server', '//server', '\\', '/']) {
    assert.throws(() => validateWorkspaceInput({ root, mode: 'edit' }), invalidRoot);
    assert.throws(() => grantWorkspace({ root, mode: 'edit' }), invalidRoot);
  }
});

async function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-workspace-root-')));
  const root = join(base, 'project'), dir = join(base, 'runtime'), configFile = join(base, 'config.json');
  fs.mkdirSync(root); fs.writeFileSync(join(root, 'owned.txt'), 'original fixture');
  const f = { base, root, dir, configFile, config: { dataDir: dir } };
  t.after(async () => { await f.worker?.close(); fs.rmSync(base, { recursive: true, force: true }); });
  f.boot = async () => {
    f.worker = await start({ dir, port: 0, controlPort: 0, configFile, waitMs: 20, closeGraceMs: 100 });
    Object.assign(f.config, { controlPort: f.worker.controlPort, mcpPort: f.worker.mcpPort });
    fs.writeFileSync(configFile, JSON.stringify(f.config));
  };
  f.admin = (action, payload) => request(action, payload, f.config);
  f.spec = { id: 'owned', instructions: 'Disposable root fixture', inputs: {}, workspace: { root, mode: 'edit' } };
  await f.boot();
  return f;
}

test('qualified workspace spellings keep native grants, duplicate registration and restart usable', async t => {
  const f = await fixture(t), { token } = await f.admin('register', f.spec);
  const stored = () => JSON.parse(fs.readFileSync(join(f.dir, 'state.json'), 'utf8'))[0];
  const grant = stored().workspace;
  assert.equal(grant.root, f.root);
  const roots = process.platform === 'win32'
    ? [f.root, f.root.replaceAll('\\', '/'), toNamespacedPath(f.root)] : [f.root];
  for (const root of roots) {
    const duplicate = await f.admin('register', { ...f.spec, workspace: { root, mode: 'edit' } });
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.token, token);
    assert.deepEqual(stored().workspace, grant);
  }
  assert.equal((await callTool(f.worker, 'read_file', { token, path: 'owned.txt' })).structuredContent.text, 'original fixture');
  assert.equal((await callTool(f.worker, 'write_file', { token, path: 'created.txt', text: 'created fixture', expectedSha256: null })).isError, false);
  await f.worker.close(); await f.boot();
  assert.deepEqual(stored().workspace, grant);
  assert.equal((await f.admin('register', f.spec)).token, token);
  assert.equal((await callTool(f.worker, 'read_file', { token, path: 'created.txt' })).structuredContent.text, 'created fixture');
  assert.equal((await f.admin('ready')).ok, true);
});

test('Windows CLI on another drive cannot register the worker-drive project through a drive-less root',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    const workerDrive = parse(f.base).root;
    if (!/^[A-Za-z]:\\$/.test(workerDrive)) return t.skip('drive-backed temporary fixture required');
    const clientCwd = ['C:\\', 'D:\\'].find(root => root.toLowerCase() !== workerDrive.toLowerCase() && fs.existsSync(root));
    if (!clientCwd) return t.skip('a second Windows drive is required for cross-drive CLI coverage');
    await f.admin('register', f.spec);
    const before = fs.readFileSync(join(f.dir, 'state.json')), cwd = process.cwd();
    const env = { ...process.env, WEBGPT_CONFIG: f.configFile, WEBGPT_DATA_DIR: f.dir };
    // Ensure the old implementation would find this real project on the worker
    // drive, even when the checkout and temporary fixtures use different drives.
    process.chdir(f.base);
    try {
      for (const separator of ['\\', '/']) await t.test(`root separator ${separator}`, async () => {
        const root = f.root.slice(2).replaceAll('\\', separator);
        assert.equal(fs.existsSync(resolve(clientCwd, root)), false);
        const payload = join(f.base, 'registration.json');
        fs.writeFileSync(payload, JSON.stringify({ ...f.spec, id: 'ambiguous', workspace: { root, mode: 'edit' } }));
        const reply = await execute(process.execPath, [fileURLToPath(new URL('./client.mjs', import.meta.url)), 'register', payload],
          { cwd: clientCwd, env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
          .then(result => ({ ...result, code: 0 }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
        assert.equal(reply.code, 1); assert.equal(reply.stdout, '');
        assert.equal(reply.stderr.trim(), 'WebGPT: workspace root must be fully qualified');
        assert.deepEqual(fs.readFileSync(join(f.dir, 'state.json')), before);
        assert.deepEqual(fs.readdirSync(f.root), ['owned.txt']);
        assert.equal(fs.readFileSync(join(f.root, 'owned.txt'), 'utf8'), 'original fixture');
        assert.equal(fs.existsSync(join(f.dir, 'recovery')), false);
      });
    } finally { process.chdir(cwd); }
    assert.equal((await f.admin('ready')).ok, true);
  });
