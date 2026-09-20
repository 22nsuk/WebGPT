import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { start } from './worker.mjs';
import { request, collectTask } from './client.mjs';

async function fixture(run) {
  const base = mkdtempSync(join(tmpdir(), 'webgpt-retirement-'));
  const dir = join(base, 'runtime'), root = join(base, 'project');
  mkdirSync(root);
  let service;
  const config = { dataDir: dir };
  const restart = async () => {
    await service?.close();
    service = await start({ dir, port: 0, controlPort: 0, waitMs: 20 });
    config.mcpPort = service.mcpPort; config.controlPort = service.controlPort;
  };
  const admin = (action, payload) => request(action, payload, config);
  const call = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${service.mcpPort}/mcp`, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await response.json()).result;
  };
  const register = id => admin('register', {
    id, instructions: 'Fixture instructions', inputs: { sample: 'Fixture input' }, workspace: { root, mode: 'edit' },
  });
  const state = id => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).find(task => task.id === id);
  try { await restart(); await run({ dir, root, config, admin, call, register, restart, state }); }
  finally {
    await service?.close();
    const rel = relative(resolve(tmpdir()), resolve(base));
    assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
    rmSync(base, { recursive: true, force: true });
  }
}

const evidence = task => Object.fromEntries(
  ['status', 'summary', 'artifact', 'sha256', 'changes', 'recoveryRequired'].map(key => [key, task[key]]),
);

for (const status of ['completed', 'failed', 'cancelled']) {
  test(`supervisor can abandon an uncollected ${status} result without changing its evidence`, () => fixture(async f => {
    const id = status;
    const { token } = await f.register(id);
    const change = await f.call('write_file', { token, path: 'work.txt', text: 'preserved project edit', expectedSha256: null });
    assert.equal(change.isError, false);
    const journal = join(f.dir, 'recovery', id, change.structuredContent.operation + '.json');
    if (status === 'failed') {
      // A failed terminal result may preserve an unresolved recovery incident.
      writeFileSync(journal, '{');
      await f.restart();
      assert.ok(f.state(id).recoveryRequired.length);
    }
    assert.equal((await f.call('submit_result', { token, status, summary: 'Original ' + status, result: 'Original result' })).isError, false);
    const before = evidence(f.state(id));
    const journalBefore = readFileSync(journal);
    if (status === 'completed') writeFileSync(before.artifact, 'Damaged result');
    if (status === 'failed') unlinkSync(before.artifact);
    const artifactBefore = existsSync(before.artifact) ? readFileSync(before.artifact) : null;
    if (status !== 'cancelled') {
      await assert.rejects(collectTask(id, f.config), status === 'completed' ? /integrity mismatch/ : /ENOENT/);
      assert.equal(f.state(id).collected, false);
    }
    assert.deepEqual(await f.admin('cancel', { id }), { ok: true });
    assert.equal(f.state(id).discarded, true);
    assert.equal(f.state(id).collected, true);
    for (const phase of ['immediate', 'retry', 'restart']) {
      if (phase === 'retry') await f.admin('cancel', { id });
      if (phase === 'restart') await f.restart();
      const retired = f.state(id);
      assert.deepEqual(evidence(retired), before, phase);
      assert.equal(retired.discarded, true, phase);
      assert.equal(retired.collected, true, phase);
      assert.equal(retired.token, undefined, phase);
      assert.equal(retired.instructions, '', phase);
      assert.deepEqual(retired.inputs, {}, phase);
      assert.equal((await f.call('get_task', { token })).isError, true, phase);
      assert.equal((await f.call('read_input', { token, name: 'sample' })).isError, true, phase);
      assert.deepEqual(await f.admin('tasks'), { running: 0, uncollected: 0, tasks: [] }, phase);
      assert.deepEqual(await f.admin('wait', { ids: [id] }), { events: [], backupDue: [], settled: true }, phase);
      await assert.rejects(collectTask(id, f.config), /no uncollected result/);
      assert.deepEqual(existsSync(before.artifact) ? readFileSync(before.artifact) : null, artifactBefore, phase);
      assert.deepEqual(readFileSync(journal), journalBefore, phase);
      assert.equal(readFileSync(join(f.root, 'work.txt'), 'utf8'), 'preserved project edit', phase);
    }
  }));
}

test('successful collection and later cancellation never mark verified results discarded', () => fixture(async f => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const { token } = await f.register(status);
    await f.call('submit_result', { token, status, summary: 'Original ' + status, result: 'Verified bytes' });
    const before = evidence(f.state(status));
    const collected = await collectTask(status, f.config);
    assert.equal(collected.integrity, 'verified');
    assert.equal(collected.status, status);
    assert.notEqual(f.state(status).discarded, true);
    await f.admin('cancel', { id: status });
    await f.restart();
    assert.notEqual(f.state(status).discarded, true);
    assert.equal(f.state(status).collected, true);
    assert.deepEqual(evidence(f.state(status)), before);
    assert.equal(readFileSync(before.artifact, 'utf8'), 'Verified bytes');
  }
}));

test('cancelling a running registration retains its existing cancellation behavior', () => fixture(async f => {
  const { token } = await f.register('running');
  await f.admin('cancel', { id: 'running' });
  const cancelled = f.state('running');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.summary, 'Cancelled by supervisor');
  assert.equal(cancelled.collected, true);
  assert.equal(cancelled.nextCheck, null);
  assert.notEqual(cancelled.discarded, true);
  assert.equal((await f.call('get_task', { token })).isError, true);
}));

test('failed terminal retirement preserves access and pending evidence until a durable retry', () => fixture(async f => {
  const id = 'storage-failure';
  const { token } = await f.register(id);
  await f.call('submit_result', { token, status: 'failed', summary: 'Original failure', result: 'Partial evidence' });
  const before = evidence(f.state(id));
  const savedState = readFileSync(join(f.dir, 'state.json'));
  const blocked = join(f.dir, 'state.json.tmp');
  mkdirSync(blocked);
  try {
    await assert.rejects(f.admin('cancel', { id }), /EISDIR|EPERM|EACCES/);
    assert.equal(readFileSync(join(f.dir, 'state.json')).equals(savedState), true);
    assert.equal(f.state(id).collected, false);
    assert.notEqual(f.state(id).discarded, true);
    assert.deepEqual(evidence(f.state(id)), before);
    assert.equal((await f.call('get_task', { token })).isError, false);
    assert.equal((await f.call('read_input', { token, name: 'sample' })).isError, false);
    assert.equal((await f.admin('tasks')).uncollected, 1);
    assert.deepEqual((await f.admin('wait', { ids: [id] })).events.map(event => event.id), [id]);
  } finally { rmdirSync(blocked); }
  await f.restart();
  assert.equal(f.state(id).collected, false);
  assert.equal((await f.call('get_task', { token })).isError, false);
  await f.admin('cancel', { id });
  await f.restart();
  assert.equal(f.state(id).discarded, true);
  assert.equal(f.state(id).collected, true);
  assert.deepEqual(evidence(f.state(id)), before);
  assert.equal((await f.call('get_task', { token })).isError, true);
  assert.equal(readFileSync(before.artifact, 'utf8'), 'Partial evidence');
  assert.deepEqual(await f.admin('tasks'), { running: 0, uncollected: 0, tasks: [] });
}));
