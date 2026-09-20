import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './worker.mjs';
import { request } from './client.mjs';
import { grantWorkspace } from './workspace.mjs';

async function fixture(t, run) {
  if (process.platform !== 'win32') { t.skip('requires native Windows short names'); return; }
  const base = mkdtempSync(join(tmpdir(), 'webgpt-canonical-'));
  const root = join(base, 'LongProjectWorkspace'), alias = join(base, 'LONGPR~1');
  mkdirSync(root);
  try {
    if (!existsSync(alias)) { t.skip('the temporary volume does not generate this NTFS short name'); return; }
    assert.equal(realpathSync.native(alias), realpathSync.native(root));
    await run({ base, root, alias });
  } finally { rmSync(base, { recursive: true, force: true }); }
}

test('Windows native grant canonicalization preserves ordinary short-path project access and exact retries', t => fixture(t, async ({ base, root, alias }) => {
  const dir = join(base, 'runtime');
  const service = await start({ dir, port: 0, controlPort: 0 });
  const config = { dataDir: dir, controlPort: service.controlPort };
  try {
    const payload = { id: 'ordinary', instructions: 'Fixture only.', inputs: {}, workspace: { root: alias, mode: 'edit' } };
    const registered = await request('register', payload, config);
    const retried = await request('register', { ...payload, workspace: { root, mode: 'edit' } }, config);
    assert.equal(retried.token, registered.token);
    assert.equal(retried.duplicate, true);
    const stored = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))[0];
    assert.equal(stored.workspace.root, realpathSync.native(root));
    const folder = join(root, 'LongSourceFolder'); mkdirSync(folder);
    assert.equal(realpathSync.native(join(root, 'LONGSO~1')), realpathSync.native(folder));
    const response = await fetch(`http://127.0.0.1:${service.mcpPort}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_file', arguments: { token: registered.token, path: 'LONGSO~1/notes.txt', text: 'ordinary fixture file', expectedSha256: null } } }) });
    assert.equal((await response.json()).result.isError, false);
    assert.equal(readFileSync(join(folder, 'notes.txt'), 'utf8'), 'ordinary fixture file');
  } finally { await service.close(); }
}));

test('Windows project/runtime overlap is rejected regardless of which path uses a short alias', t => fixture(t, async ({ root, alias }) => {
  // Only a benign marker is created; the test never reads worker credentials.
  const runtime = join(root, 'runtime'); mkdirSync(runtime);
  writeFileSync(join(runtime, 'marker.txt'), 'fixture only');
  for (const [dir, workspaceRoot] of [[runtime, alias], [join(alias, 'runtime'), root]]) {
    const service = await start({ dir, port: 0, controlPort: 0 });
    const config = { dataDir: dir, controlPort: service.controlPort };
    try {
      await assert.rejects(request('register', { id: 'overlap', instructions: 'Fixture only.', inputs: {}, workspace: { root: workspaceRoot, mode: 'read' } }, config), /private worker data/);
      assert.equal((await request('tasks', undefined, config)).running, 0);
    } finally { await service.close(); }
  }
}));

test('Windows legacy grants with short names cannot access an overlapping runtime after restart', t => fixture(t, async ({ root, alias }) => {
  const dir = join(root, 'runtime'); mkdirSync(dir);
  writeFileSync(join(dir, 'marker.txt'), 'fixture only');
  const grant = { ...grantWorkspace({ root, mode: 'read' }), root: alias };
  writeFileSync(join(dir, 'state.json'), JSON.stringify([{ id: 'legacy', token: 'fixture-token', instructions: 'Fixture only.', inputs: {}, workspace: grant, changes: [], status: 'running', nextCheck: Date.now() + 60000, collected: false }]));
  const service = await start({ dir, port: 0, controlPort: 0 });
  const config = { dataDir: dir, controlPort: service.controlPort };
  try {
    const call = async (name, args) => {
      const response = await fetch(`http://127.0.0.1:${service.mcpPort}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { token: 'fixture-token', ...args } } }) });
      return (await response.json()).result;
    };
    assert.equal((await call('get_task')).isError, false);
    const read = await call('read_file', { path: 'runtime/marker.txt' });
    assert.equal(read.isError, true);
    assert.match(read.content[0].text, /private worker data/);
    await request('cancel', { id: 'legacy' }, config);
    assert.equal((await request('tasks', undefined, config)).running, 0);
  } finally { await service.close(); }
}));

test('Windows legacy non-overlapping short-path grants preserve registration retry identity', t => fixture(t, async ({ base, root, alias }) => {
  const dir = join(base, 'runtime'); mkdirSync(dir);
  const workspace = { ...grantWorkspace({ root, mode: 'read' }), root: alias };
  const instructions = 'Fixture only.';
  writeFileSync(join(dir, 'state.json'), JSON.stringify([{ id: 'legacy', token: 'fixture-token', instructions, inputs: {}, workspace, changes: [], status: 'running', nextCheck: Date.now() + 60000, collected: false }]));
  const service = await start({ dir, port: 0, controlPort: 0 });
  const config = { dataDir: dir, controlPort: service.controlPort };
  try {
    for (const suppliedRoot of [alias, root]) {
      const registered = await request('register', { id: 'legacy', instructions, inputs: {}, workspace: { root: suppliedRoot, mode: 'read' } }, config);
      assert.equal(registered.token, 'fixture-token');
      assert.equal(registered.duplicate, true);
    }
  } finally { await service.close(); }
}));
