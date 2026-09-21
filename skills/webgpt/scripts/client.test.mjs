import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { configuration, request, collectTask, reconcileTasks } from './client.mjs';
import { start } from './worker.mjs';

const execute = promisify(execFile);
const invoke = async (s, name, args) => {
  const response = await fetch(`http://127.0.0.1:${s.mcpPort}/mcp`, {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await response.json()).result;
};
async function fixture(run) {
  const base = mkdtempSync(join(tmpdir(), 'webgpt-portable-test-'));
  const dir = join(base, 'runtime');
  let clock = 1000;
  let service = await start({ dir, port: 0, controlPort: 0, now: () => clock });
  const config = { dataDir: dir, mcpPort: service.mcpPort, controlPort: service.controlPort };
  const admin = (action, payload) => request(action, payload, config);
  const restart = async () => {
    await service.close();
    service = await start({ dir, port: 0, controlPort: 0, now: () => clock });
    config.mcpPort = service.mcpPort; config.controlPort = service.controlPort;
  };
  try { await run({ base, dir, get service() { return service; }, config, admin, restart, advance: ms => { clock += ms; } }); }
  finally { await service.close(); rmSync(base, { recursive: true }); }
}

test('portable config uses absolute paths and independent ports, with explicit overrides', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-config-test-'));
  try {
    const file = join(dir, 'config.json');
    const saved = { dataDir: join(dir, 'private data'), mcpPort: 12340, controlPort: 12341 };
    writeFileSync(file, JSON.stringify(saved));
    assert.deepEqual(configuration({ WEBGPT_CONFIG: file }), {...saved, publicMcp:false});
    writeFileSync(file, JSON.stringify({...saved, publicMcp:true}));
    assert.equal(configuration({ WEBGPT_CONFIG: file }).publicMcp, true);
    assert.equal(configuration({ WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: dir }).dataDir, dir);
    for (const invalid of [[], null, { publicMcp:'true' }, { dataDir: 'relative' }, { mcpPort: 0 }, { controlPort: '12341' }, { mcpPort: 43139 }]) {
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
  symlinkSync(dirname(fileURLToPath(import.meta.url)), scripts, process.platform === 'win32' ? 'junction' : 'dir');
  const file = join(dir, 'config.json'); writeFileSync(file, JSON.stringify(config));
  const env = { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: dir };
  const { stdout } = await execute(process.execPath, [join(scripts, 'client.mjs'), 'status'], { env });
  assert.deepEqual(JSON.parse(stdout), { events: [], backupDue: [] });
  // Startup must actually execute and reject the live owner's lock, not exit silently with code 0.
  await assert.rejects(execute(process.execPath, [join(scripts, 'worker.mjs')], { env }), error => {
    assert.equal(error.code, 73);
    assert.deepEqual(JSON.parse(error.stderr), { event: 'startup_failed', code: 'LOCK_HELD', exitCode: 73 });
    return true;
  });
}));

test('controller authenticates, rejects invalid calls, and returns errors without keys', () => fixture(async ({ service, admin }) => {
  assert.equal((await fetch(`http://127.0.0.1:${service.controlPort}/status`)).status, 401);
  await assert.rejects(admin('unknown'), /unknown/);
  await assert.rejects(admin('status', {}), /payload/);
  await assert.rejects(admin('register'), /payload/);
  await assert.rejects(admin('ack', { id: 'missing' }), /unknown task/);
  await admin('register', { id: 'a', instructions: 'Review', inputs: {} });
  assert.equal((await admin('register', { id: 'a', instructions: 'Review', inputs: {} })).duplicate, true);
  await assert.rejects(admin('register', { id: 'a', instructions: 'Different review', inputs: {} }), /task ID already exists/);
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

test('a single text-only task survives backup intervals and restart, then completes without file access', () => fixture(async f => {
  const transcript = 'Speaker: Please analyze this complete transcript.\nReviewer: Include the context.';
  const task = await f.admin('register', {
    id: 'transcript-analysis', instructions: 'Analyze the supplied transcript.', inputs: { transcript },
  });
  assert.equal((await invoke(f.service, 'get_task', { token: task.token })).structuredContent.workspace, null);
  assert.equal((await invoke(f.service, 'read_input', { token: task.token, name: 'transcript' })).structuredContent.text, transcript);
  for (const name of ['list_files', 'read_file', 'write_file', 'delete_file']) {
    assert.equal((await invoke(f.service, name, {
      token: task.token, path: name === 'list_files' ? '.' : 'ungranted.txt',
      text: 'not authorized', expectedSha256: null,
    })).isError, true);
  }
  // Advance only the fixture clock: backup checks are not execution deadlines.
  for (const elapsed of [900000, 24 * 60 * 60 * 1000]) {
    f.advance(elapsed);
    assert.deepEqual(await f.admin('status'), { events: [], backupDue: [task.id] });
    assert.equal((await invoke(f.service, 'get_task', { token: task.token })).structuredContent.status, 'running');
    await f.admin('checked', { id: task.id });
    assert.deepEqual(await f.admin('status'), { events: [], backupDue: [] });
  }
  await f.restart();
  assert.equal((await invoke(f.service, 'read_input', { token: task.token, name: 'transcript' })).structuredContent.text, transcript);
  const result = 'Analysis of the supplied transcript; no project changes were requested.';
  assert.equal((await invoke(f.service, 'submit_result', {
    token: task.token, status: 'completed', summary: 'Analysis complete', result,
  })).isError, false);
  f.advance(900000);
  const notice = await f.admin('wait');
  assert.deepEqual(notice.backupDue, []);
  assert.equal(notice.events.length, 1);
  assert.equal(notice.events[0].id, task.id);
  assert.equal(readFileSync(notice.events[0].artifact, 'utf8'), result);
  assert.equal(notice.events[0].sha256, createHash('sha256').update(result).digest('hex'));
  const saved = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'))[0];
  assert.equal(saved.nextCheck, null);
  assert.deepEqual(saved.changes, []);
  await f.admin('ack', { id: task.id });
  f.advance(900000);
  assert.deepEqual(await f.admin('wait'), { events: [], backupDue: [] });
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
  const root = join(f.base, 'project'); mkdirSync(root);
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

// Forward only to the disposable fixture worker; observe/lose responses without
// replacing controller state or weakening its authentication and persistence rules.
async function controllerProxy(f, run, intercept = async () => false) {
  const actions = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    actions.push(req.url);
    const response = await fetch(`http://127.0.0.1:${f.config.controlPort}${req.url}`, {
      method: req.method, headers: { authorization: req.headers.authorization, 'content-type': 'application/json' },
      ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
    });
    const body = await response.text();
    if (await intercept({ req, res, body, actions })) return;
    res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run({ config: { ...f.config, controlPort: server.address().port }, actions }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const retainedEvidence = dir => Object.fromEntries(readdirSync(dir).filter(name => name === 'state.json' || name.endsWith('.result.txt')).map(name => {
  const path = join(dir, name);
  return [name, { bytes: readFileSync(path).toString('base64'), modified: statSync(path, { bigint: true }).mtimeNs }];
}));
async function completedTask(f, id, status = 'completed') {
  const task = await f.admin('register', { id, instructions: 'Review', inputs: {} });
  assert.equal((await invoke(f.service, 'submit_result', { token: task.token, status, summary: 'Done', result: 'saved evidence' })).isError, false);
  return task;
}

test('explicit collection resume verifies retired results without repeating acknowledgment or modifying evidence', () => fixture(async f => {
  for (const status of ['completed', 'failed', 'cancelled']) await completedTask(f, status, status);
  await controllerProxy(f, async ({ config, actions }) => {
    for (const status of ['completed', 'failed', 'cancelled']) {
      const first = await collectTask(status, config, { resume: true });
      assert.equal(first.disposition, 'collected'); assert.equal(first.status, status);
      assert.equal(first.integrity, 'verified'); assert.equal(first.browserChecked, false);
    }
    assert.equal(actions.filter(action => action === '/ack').length, 3);
    await f.restart();
    const before = retainedEvidence(f.dir);
    for (const status of ['completed', 'failed', 'cancelled']) {
      const resumed = await collectTask(status, config, { resume: true });
      assert.equal(resumed.disposition, 'already_collected'); assert.equal(resumed.status, status);
      assert.equal(resumed.integrity, 'verified');
    }
    assert.equal(actions.filter(action => action === '/ack').length, 3);
    assert.deepEqual(retainedEvidence(f.dir), before);
  });
}));

test('resume CLI distinguishes discarded results, cancelled tasks without a result, and active tasks', () => fixture(async f => {
  await completedTask(f, 'discarded'); await f.admin('cancel', { id: 'discarded' });
  await f.admin('register', { id: 'cancelled', instructions: 'Review', inputs: {} });
  await f.admin('cancel', { id: 'cancelled' });
  const active = await f.admin('register', { id: 'active', instructions: 'Review', inputs: {} });
  writeFileSync(join(f.dir, 'active.result.txt'), 'uncommitted candidate');
  await controllerProxy(f, async ({ config, actions }) => {
    const file = join(f.dir, 'resume-config.json'); writeFileSync(file, JSON.stringify(config));
    const env = { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: f.dir };
    const run = id => execute(process.execPath, [fileURLToPath(new URL('./client.mjs', import.meta.url)), 'collect', '--resume', id], { env });
    const before = retainedEvidence(f.dir);
    for (let i = 0; i < 2; i++) {
      const discarded = JSON.parse((await run('discarded')).stdout);
      assert.equal(discarded.disposition, 'discarded'); assert.equal(discarded.discarded, true);
      assert.equal(discarded.integrity, 'verified'); assert.equal(discarded.status, 'completed');
      const cancelled = JSON.parse((await run('cancelled')).stdout);
      assert.equal(cancelled.disposition, 'cancelled_without_result'); assert.equal(cancelled.integrity, 'not_expected');
      await assert.rejects(run('active'), error => { assert.match(error.stderr, /still running/); return true; });
    }
    assert.equal(actions.filter(action => action === '/ack').length, 0);
    assert.deepEqual(retainedEvidence(f.dir), before);
    assert.equal((await invoke(f.service, 'get_task', { token: active.token })).structuredContent.status, 'running');
  });
}));

test('resume rechecks retained hashes and preserves integrity/recovery warnings without acknowledgment', () => fixture(async f => {
  await completedTask(f, 'retired'); await collectTask('retired', f.config);
  await completedTask(f, 'pending');
  const retired = join(f.dir, 'retired.result.txt'); writeFileSync(retired, 'tampered');
  writeFileSync(join(f.dir, 'pending.result.txt.tmp'), 'candidate');
  const journalDir = join(f.dir, 'recovery', 'pending'); mkdirSync(journalDir, { recursive: true });
  writeFileSync(join(journalDir, 'bad.json'), '{');
  await controllerProxy(f, async ({ config, actions }) => {
    const before = retainedEvidence(f.dir);
    await assert.rejects(collectTask('retired', config, { resume: true }), /integrity mismatch/);
    assert.equal(actions.filter(action => action === '/ack').length, 0);
    const raw = await request('reconcile', undefined, config);
    assert.equal(raw.tasks.find(task => task.id === 'retired').integrity, undefined);
    const verified = await reconcileTasks(config);
    assert.equal(verified.tasks.find(task => task.id === 'retired').integrity, 'mismatch_or_unreadable');
    assert.deepEqual(retainedEvidence(f.dir), before);
    await assert.rejects(collectTask('pending', config, { resume: true }), error => {
      assert.equal(error.code, 'COLLECTION_RECOVERY_REQUIRED'); assert.equal(error.attention, 'inspect_recovery');
      assert.equal(error.reconciliation.integrity, 'verified');
      assert.equal(error.reconciliation.journalIssues.length, 1); assert.equal(error.reconciliation.pendingResults.length, 1);
      return true;
    });
    assert.equal(actions.filter(action => action === '/ack').length, 0);
    assert.deepEqual(retainedEvidence(f.dir), before);
    await f.admin('cancel', { id: 'pending' });
    const result = await collectTask('pending', config, { resume: true });
    assert.equal(result.disposition, 'discarded'); assert.equal(result.attention, 'inspect_recovery');
    assert.equal(result.journalIssues.length, 1); assert.equal(result.pendingResults.length, 1);
    assert.equal(actions.filter(action => action === '/ack').length, 0);
  });
}));

test('resume recovers a lost acknowledgment response by observing once without retrying the write', () => fixture(async f => {
  await completedTask(f, 'lost');
  await controllerProxy(f, async ({ config, actions }) => {
    const collected = await collectTask('lost', config, { resume: true });
    assert.equal(collected.collected, true); assert.equal(collected.integrity, 'verified');
    assert.equal((await collectTask('lost', config, { resume: true })).disposition, 'already_collected');
    assert.equal(actions.filter(action => action === '/ack').length, 1);
  }, async ({ req, res }) => { if (req.url !== '/ack') return false; res.destroy(); return true; });
}));

test('resume preserves a concurrent discard and reports unverifiable post-ack results as unconfirmed', () => fixture(async f => {
  await completedTask(f, 'discard'); await completedTask(f, 'changed');
  await controllerProxy(f, async ({ config, actions }) => {
    const discarded = await collectTask('discard', config, { resume: true });
    assert.equal(discarded.disposition, 'discarded'); assert.equal(discarded.discarded, true);
    await assert.rejects(collectTask('changed', config, { resume: true }), error => {
      assert.equal(error.code, 'COLLECTION_UNCONFIRMED'); assert.equal(error.acknowledgment, 'accepted');
      assert.match(error.cause.message, /integrity mismatch/); return true;
    });
    assert.equal(actions.filter(action => action === '/ack').length, 2);
  }, async ({ req, actions }) => {
    if (req.url === '/reconcile' && actions.length === 1) await f.admin('cancel', { id: 'discard' });
    if (req.url === '/ack' && actions.filter(action => action === '/ack').length === 2)
      writeFileSync(join(f.dir, 'changed.result.txt'), 'tampered after acknowledgment');
    return false;
  });
}));


test('resume does not trust diagnostic task snapshots after controller state corruption', () => fixture(async f => {
  await completedTask(f, 'retired'); await collectTask('retired', f.config);
  writeFileSync(join(f.dir, 'state.json'), '[]');
  await controllerProxy(f, async ({ config, actions }) => {
    await assert.rejects(collectTask('retired', config, { resume: true }), { code: 'STATE_INVALID' });
    assert.equal(actions.filter(action => action === '/ack').length, 0);
    assert.equal(readFileSync(join(f.dir, 'state.json'), 'utf8'), '[]');
  });
}));

test('resume keeps known acknowledgment storage errors and leaves work uncollected for an explicit later retry', () => fixture(async f => {
  const task = await completedTask(f, 'blocked');
  mkdirSync(join(f.dir, 'state.json.tmp'));
  await controllerProxy(f, async ({ config, actions }) => {
    await assert.rejects(collectTask('blocked', config, { resume: true }), error => {
      assert.equal(error.statusCode, 503); assert.notEqual(error.code, 'COLLECTION_UNCONFIRMED'); return true;
    });
    assert.equal(actions.filter(action => action === '/ack').length, 1);
    assert.equal((await invoke(f.service, 'get_task', { token: task.token })).isError, false);
    assert.equal((await f.admin('status')).events[0].id, 'blocked');
    rmSync(join(f.dir, 'state.json.tmp'), { recursive: true });
    assert.equal((await collectTask('blocked', config, { resume: true })).disposition, 'collected');
    assert.equal(actions.filter(action => action === '/ack').length, 2);
  });
}));


test('resume CLI reports pending recovery and uncertain acknowledgment with safe structured fields', () => fixture(async f => {
  await completedTask(f, 'pending'); await completedTask(f, 'uncertain');
  writeFileSync(join(f.dir, 'pending.result.txt.tmp'), 'uncommitted candidate');
  await controllerProxy(f, async ({ config, actions }) => {
    const file = join(f.dir, 'resume-config.json'); writeFileSync(file, JSON.stringify(config));
    const env = { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: f.dir };
    const run = id => execute(process.execPath, [fileURLToPath(new URL('./client.mjs', import.meta.url)), 'collect', '--resume', id], { env });
    await assert.rejects(run('pending'), error => {
      assert.equal(error.stdout, '');
      const diagnostic = JSON.parse(error.stderr.slice('WebGPT: '.length));
      assert.equal(diagnostic.code, 'COLLECTION_RECOVERY_REQUIRED'); assert.equal(diagnostic.attention, 'inspect_uncommitted_result');
      assert.equal(error.stderr.includes(f.dir), false); return true;
    });
    assert.equal(actions.filter(action => action === '/ack').length, 0);
    await assert.rejects(run('uncertain'), error => {
      assert.equal(error.stdout, '');
      const diagnostic = JSON.parse(error.stderr.slice('WebGPT: '.length));
      assert.equal(diagnostic.code, 'COLLECTION_UNCONFIRMED'); assert.equal(diagnostic.acknowledgment, 'unknown');
      assert.equal(error.stderr.includes(f.dir), false); assert.equal(error.stderr.includes('cause'), false); return true;
    });
    assert.equal(actions.filter(action => action === '/ack').length, 1);
  }, async ({ req, res }) => {
    if (req.url !== '/ack') return false;
    writeFileSync(join(f.dir, 'uncertain.result.txt'), 'tampered after commit');
    res.destroy(); return true;
  });
}));
