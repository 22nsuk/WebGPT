// Bound work by observed directory reads, not a machine-dependent time threshold.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { grantWorkspace, listWorkspace, probeWorkspace } from './workspace.mjs';

function project(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-workspace-probe-')));
  const root = join(base, 'project'); fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, grant: grantWorkspace({ root, mode: 'read' }) };
}
async function withFs(t, replacements, run) {
  const mocks = Object.entries(replacements).map(([name, fn]) => t.mock.method(fs, name, fn));
  syncBuiltinESMExports();
  try { return await run(); }
  finally { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); }
}

test('workspace probe reads at most one entry, returns no names and leaves full listings unchanged', async t => {
  const f = project(t), open = fs.opendirSync, read = fs.readdirSync;
  const counts = { opened: 0, read: 0, closed: 0, listed: 0 }, handles = [];
  await withFs(t, {
    readdirSync: (...args) => { counts.listed++; return read(...args); },
    opendirSync: (path, options) => {
      assert.deepEqual(options, { bufferSize: 1 }); counts.opened++;
      const dir = open(path, options); handles.push(dir);
      return { readSync: () => { counts.read++; return dir.readSync(); },
        closeSync: () => { counts.closed++; dir.closeSync(); } };
    },
  }, () => {
    assert.equal(probeWorkspace(f.grant), undefined); // Empty is accessible.
    for (let i = 0; i < 512; i++) fs.writeFileSync(join(f.root, 'file-' + i), '');
    fs.mkdirSync(join(f.root, '.git'));
    assert.equal(probeWorkspace({ ...f.grant, mode: 'edit' }), undefined);
    assert.deepEqual(counts, { opened: 2, read: 2, closed: 2, listed: 0 });
    const page = listWorkspace(f.grant, '.', { limit: 1 });
    assert.equal(counts.listed, 1); assert.equal(page.truncated, true);
    assert.deepEqual(page.entries, [{ name: 'file-0', type: 'file' }]);
    fs.writeFileSync(join(f.root, 'new'), '');
    assert.throws(() => listWorkspace(f.grant, '.', { cursor: page.nextCursor }), /directory changed/);
  });
  for (const handle of handles) assert.throws(() => handle.readSync(), { code: 'ERR_DIR_CLOSED' });
});

test('workspace probe rejects invalid or stale grants before opening a directory', async t => {
  const f = project(t); let opens = 0;
  await withFs(t, { opendirSync: () => { opens++; throw Error('unexpected open'); } }, () => {
    for (const grant of [null, { ...f.grant, mode: 'invalid' }, { ...f.grant, read: [] },
      { ...f.grant, device: -1 }, { ...f.grant, inode: -1 }]) assert.throws(() => probeWorkspace(grant));
    fs.renameSync(f.root, f.root + '-old');
    assert.throws(() => probeWorkspace(f.grant), { code: 'ENOENT' });
    fs.mkdirSync(f.root);
    assert.throws(() => probeWorkspace(f.grant), /workspace root changed/);
  });
  assert.equal(opens, 0);
});

test('workspace probe retains named and native Git-root boundaries', async t => {
  const f = project(t), git = join(f.base, '.git'); fs.mkdirSync(git);
  const stat = fs.lstatSync(git);
  assert.throws(() => probeWorkspace({ root: git, device: stat.dev, inode: stat.ino, mode: 'read' }), /Git metadata/);
  // Keep the same underlying project inode but redirect an ancestor into .git.
  fs.renameSync(f.root, join(git, 'project'));
  const alias = join(f.base, 'alias');
  try { fs.symlinkSync(git, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.diagnostic('Native alias assertion unavailable: ' + error.code); return;
  }
  assert.throws(() => probeWorkspace({ ...f.grant, root: join(alias, 'project') }), /Git metadata/);
  fs.symlinkSync(join(git, 'project'), f.root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => probeWorkspace(f.grant), /workspace root changed/);
});

for (const phase of ['open', 'read', 'close']) test(`workspace probe propagates ${phase} failure and closes any opened handle`, async t => {
  const f = project(t), open = fs.opendirSync;
  const failure = Object.assign(Error('fixture ' + phase), { code: phase === 'open' ? 'EACCES' : 'EIO' });
  let handle, closed = 0;
  await withFs(t, { opendirSync: (path, options) => {
    if (phase === 'open') throw failure;
    handle = open(path, options);
    return { readSync: () => { if (phase === 'read') throw failure; return handle.readSync(); },
      closeSync: () => { handle.closeSync(); closed++; if (phase === 'close') throw failure; } };
  } }, () => assert.throws(() => probeWorkspace(f.grant), error => error === failure));
  assert.equal(closed, phase === 'open' ? 0 : 1);
  if (handle) assert.throws(() => handle.readSync(), { code: 'ERR_DIR_CLOSED' });
});

test('readiness uses bounded probes, preserves global diagnostics and never caches accessibility', async t => {
  const { start } = await import('./worker.mjs');
  const { request } = await import('./client.mjs');
  const f = project(t), dir = join(f.base, 'runtime');
  const worker = await start({ dir, port: 0, controlPort: 0, configFile: join(f.base, 'config.json') });
  // Register this cleanup separately and finish it before the project directory.
  try {
    const config = { dataDir: dir, controlPort: worker.controlPort };
    for (const mode of ['read', 'edit']) await request('register', {
      id: mode, instructions: '', inputs: {}, workspace: { root: f.root, mode },
    }, config);
    await request('register', { id: 'text', instructions: '', inputs: {} }, config);
    for (let i = 0; i < 512; i++) fs.writeFileSync(join(f.root, 'file-' + i), '');
    const before = fs.readFileSync(join(dir, 'state.json'));
    const open = fs.opendirSync, read = fs.readdirSync;
    let opened = 0, listed = 0, denied = false;
    await withFs(t, {
      readdirSync: (path, ...args) => { if (path === f.root) listed++; return read(path, ...args); },
      opendirSync: (path, options) => {
        if (path === f.root) {
          opened++; assert.deepEqual(options, { bufferSize: 1 });
          if (denied) throw Object.assign(Error('fixture denied'), { code: 'EACCES' });
        }
        return open(path, options);
      },
    }, async () => {
      assert.equal((await request('ready', undefined, config)).ok, true);
      assert.equal(opened, 2); assert.equal(listed, 0);
      denied = true;
      await assert.rejects(request('ready', undefined, config), error => {
        assert.equal(error.statusCode, 503);
        assert.deepEqual(error.details.unavailableWorkspaces, ['read', 'edit']); return true;
      });
      const afterDenied = opened;
      assert.equal((await fetch(`http://127.0.0.1:${worker.mcpPort}/health`)).status, 200);
      assert.equal(opened, afterDenied, 'public liveness does not inspect projects');
      denied = false;
      assert.equal((await request('ready', undefined, config)).ok, true);
      fs.writeFileSync(join(dir, 'edit.result.txt.tmp'), 'uncommitted evidence');
      const snapshot = await request('reconcile', { ids: ['read'] }, config);
      assert.deepEqual(snapshot.scope, ['read']); assert.equal(snapshot.tasks.length, 1);
      assert.ok(snapshot.health.issues.includes('RESULT_RECOVERY_REQUIRED'));
      assert.deepEqual(snapshot.health.pendingResultTasks, ['edit']);
      assert.equal(listed, 0);
    });
    assert.deepEqual(fs.readFileSync(join(dir, 'state.json')), before);
    fs.writeFileSync(join(dir, 'state.json'), '[]');
    await assert.rejects(request('ready', undefined, config), error => {
      assert.ok(error.details.issues.includes('STATE_INVALID')); return true;
    });
  } finally { await worker.close(); }
});
