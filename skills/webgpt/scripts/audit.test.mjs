import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, existsSync, statSync, symlinkSync, linkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Server } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { start, tools } from './worker.mjs';
import { request, collectTask } from './client.mjs';
import { AUDIT_LIMIT, auditFromEnvironment, auditRecord, createAuditWriter, readDiagnosticBytes } from './audit.mjs';
import { diagnoseTask } from './diagnose.mjs';

const temporary = () => mkdtempSync(join(tmpdir(), 'webgpt-audit-'));
const logName = 'mcp-audit.jsonl';
const logs = dir => readFileSync(join(dir, logName), 'utf8').trim().split('\n').map(JSON.parse);
async function fixture(run, { audit = true, prepare = () => {} } = {}) {
  const base = temporary(), dir = join(base, 'runtime'), root = join(base, 'project');
  mkdirSync(dir); mkdirSync(root); prepare(dir);
  const service = await start({ dir, port: 0, controlPort: 0, publicMcp: true, waitMs: 10, closeGraceMs: 50, audit });
  const config = { dataDir: dir, controlPort: service.controlPort };
  const capability = readFileSync(join(dir, 'mcp-path.key'), 'utf8');
  const origin = `http://127.0.0.1:${service.mcpPort}`;
  const admin = (action, payload) => request(action, payload, config);
  const register = (id, mode) => admin('register', { id, instructions: 'FIXTURE_PRIVATE_PROMPT', inputs: { source: 'FIXTURE_PRIVATE_INPUT' },
    ...(mode ? { workspace: { root, mode } } : {}) });
  const call = async (name, args, rpcId = 'FIXTURE_PRIVATE_RPC_ID') => {
    const res = await fetch(origin + '/mcp/' + capability, { method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } }) });
    assert.equal(res.status, 200);
    return (await res.json()).result;
  };
  try { await run({ base, dir, root, service, config, origin, capability, admin, register, call }); }
  finally { await service.close(); rmSync(base, { recursive: true, force: true }); }
}
const event = (extra = {}) => ({ version: 1, runId: randomUUID(), timestamp: '2026-09-23T00:00:00.000Z', phase: 'started', ...extra });
function makeLink(t, kind, source, destination) {
  try { if (kind === 'symlink') symlinkSync(source, destination); else linkSync(source, destination); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('link creation unavailable'); return false; } throw error; }
  return true;
}

test('health supports exact GET/HEAD, rejects other methods, preserves origin/auth and liveness boundaries', () => fixture(async f => {
  const get = await fetch(f.origin + '/health');
  assert.equal(get.status, 200); assert.deepEqual(await get.json(), { ok: true, name: 'WebGPT Worker' });
  const head = await fetch(f.origin + '/health', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
  assert.equal(head.headers.get('cache-control'), 'no-store');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const res = await fetch(f.origin + '/health', { method });
    assert.equal(res.status, 405); assert.equal(res.headers.get('allow'), 'GET, HEAD');
  }
  for (const method of ['GET', 'HEAD']) assert.equal((await fetch(f.origin + '/health', {
    method, headers: { origin: 'https://example.invalid' },
  })).status, 403);
  for (const path of ['/health/', '/health?check=1', '/ready', '/mcp']) assert.equal((await fetch(f.origin + path)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${f.service.controlPort}/ready`)).status, 401);
  await f.register('task');
  writeFileSync(join(f.dir, 'state.json'), '{fixture-corruption');
  await assert.rejects(f.admin('ready'), e => e.details.issues.includes('STATE_INVALID'));
  assert.equal((await fetch(f.origin + '/health', { method: 'HEAD' })).status, 200);
  assert.equal(tools.length, 7);
}));

test('audit stays off by default with no log files or changed completion semantics', () => fixture(async f => {
  const { token } = await f.register('task');
  assert.equal((await f.call('submit_result', { token, status: 'completed', summary: 'done', result: 'saved' })).isError, false);
  assert.equal((await collectTask('task', f.config)).integrity, 'verified');
  assert.equal(existsSync(join(f.dir, logName)), false);
  assert.equal(existsSync(join(f.dir, logName + '.1')), false);
  const report = diagnoseTask('task', f.config);
  assert.equal(report.audit.availability, 'not_observed'); assert.equal(report.task.integrity, 'verified');
}, { audit: false }));

test('audit enablement is explicit and invalid settings fail without creating runtime data', async () => {
  for (const env of [{}, { WEBGPT_MCP_AUDIT: '0' }]) assert.equal(auditFromEnvironment(env), false);
  assert.equal(auditFromEnvironment({ WEBGPT_MCP_AUDIT: '1' }), true);
  for (const value of ['', 'true', 'yes', 1]) assert.throws(() => auditFromEnvironment({ WEBGPT_MCP_AUDIT: value }), { code: 'CONFIG_INVALID' });
  const dir = join(temporary(), 'not-created');
  try {
    for (const audit of ['true', 1, null]) await assert.rejects(start({ dir, port: 0, controlPort: 0, audit }), { code: 'CONFIG_INVALID' });
    assert.equal(existsSync(dir), false);
  } finally { rmSync(join(dir, '..'), { recursive: true, force: true }); }
});

test('real MCP calls are scoped, metadata-only and independent of result acknowledgment', () => fixture(async f => {
  const owned = await f.register('owned', 'edit'), other = await f.register('other', 'read');
  await f.call('get_task', { token: owned.token });
  await f.call('read_input', { token: owned.token, name: 'source' });
  await f.call('list_files', { token: owned.token, path: '.' });
  await f.call('write_file', { token: owned.token, path: 'FIXTURE_PRIVATE_PATH.txt', text: 'FIXTURE_PRIVATE_BODY', expectedSha256: null });
  const read = await f.call('read_file', { token: owned.token, path: 'FIXTURE_PRIVATE_PATH.txt' });
  await f.call('delete_file', { token: owned.token, path: 'FIXTURE_PRIVATE_PATH.txt', expectedSha256: read.structuredContent.sha256 });
  const bad = await f.call('delete_file', { token: other.token, path: 'no', expectedSha256: null });
  assert.equal(bad.isError, true);
  await f.call('get_task', { token: 'FIXTURE_INVALID_TOKEN' });
  await f.call('FIXTURE_UNKNOWN_TOOL', { token: owned.token });
  const result = 'FIXTURE_PRIVATE_RESULT';
  assert.equal((await f.call('submit_result', { token: owned.token, status: 'completed', summary: 'FIXTURE_PRIVATE_SUMMARY', result })).isError, false);
  const before = readFileSync(join(f.dir, 'state.json')), auditBefore = readFileSync(join(f.dir, logName));
  const report = diagnoseTask('owned', f.config);
  assert.equal(report.task.collected, false); assert.equal(report.task.integrity, 'verified');
  assert.equal(report.audit.failed, 1); assert.equal(report.audit.received, 8); assert.equal(report.audit.completed, 8);
  assert.equal(report.audit.unscoped.unassignedToolCalls, 1);
  assert.equal(report.audit.receivedWithoutCompletionInWindow, 0);
  assert.ok(report.audit.recent.every(e => e.taskId === 'owned'));
  assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
  assert.deepEqual(readFileSync(join(f.dir, logName)), auditBefore);
  const all = auditBefore.toString(); const output = JSON.stringify(report);
  for (const secret of [owned.token, other.token, f.capability, f.service.key, f.root, result,
    'FIXTURE_PRIVATE_PROMPT', 'FIXTURE_PRIVATE_INPUT', 'FIXTURE_PRIVATE_PATH', 'FIXTURE_PRIVATE_BODY', 'FIXTURE_PRIVATE_RPC_ID',
    'FIXTURE_PRIVATE_SUMMARY', 'FIXTURE_INVALID_TOKEN', 'FIXTURE_UNKNOWN_TOOL']) {
    assert.equal(all.includes(secret), false, secret); assert.equal(output.includes(secret), false, secret);
  }
  assert.equal(output.includes('"other"'), false);
  assert.equal(logs(f.dir).filter(e => e.phase === 'tool_completed').length, 10);
  await collectTask('owned', f.config);
  assert.equal(diagnoseTask('owned', f.config).task.collected, true);
  await f.call('get_task', { token: owned.token });
  assert.equal(diagnoseTask('owned', f.config).audit.unscoped.unassignedToolCalls, 2);
}));

test('transport rejection is observable but cannot be attributed to a chosen task', () => fixture(async f => {
  await f.register('owned');
  assert.equal((await fetch(f.origin + '/mcp/' + f.capability, { method: 'POST', body: '{' })).status, 400);
  assert.equal((await fetch(f.origin + '/PRIVATE_WRONG_CAPABILITY', { method: 'POST' })).status, 404);
  const report = diagnoseTask('owned', f.config);
  assert.equal(report.audit.unscoped.httpErrors, 2); assert.equal(report.audit.received, 0);
  assert.equal(readFileSync(join(f.dir, logName), 'utf8').includes('PRIVATE_WRONG_CAPABILITY'), false);
}));

test('a disconnected partial request records exactly one aborted response without a tool execution', t => fixture(async f => {
  await f.register('owned');
  let accepted;
  const seen = new Promise(resolve => { accepted = resolve; });
  const emit = Server.prototype.emit;
  const mock = t.mock.method(Server.prototype, 'emit', function (name, ...args) {
    const result = Reflect.apply(emit, this, [name, ...args]);
    if (name === 'request' && this.address()?.port === f.service.mcpPort) accepted();
    return result;
  });
  const socket = connect(f.service.mcpPort, '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(`POST /mcp/${f.capability} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\n{`);
  await seen; mock.mock.restore(); socket.destroy();
  await f.service.close();
  const records = logs(f.dir);
  assert.equal(records.filter(e => e.phase === 'http_completed').length, 1);
  assert.equal(records.find(e => e.phase === 'http_completed').aborted, true);
  assert.equal(records.some(e => e.phase === 'tool_received'), false);
}));

test('audit path failure does not fail startup, tools, completion or collection', t => {
  const warnings = t.mock.method(console, 'error', () => {});
  return fixture(async f => {
    const task = await f.register('owned');
    await f.call('get_task', { token: task.token });
    assert.equal((await f.call('submit_result', { token: task.token, status: 'completed', summary: '', result: 'done' })).isError, false);
    assert.equal((await collectTask('owned', f.config)).collected, true);
    assert.equal(warnings.mock.calls.length, 1);
    assert.deepEqual(warnings.mock.calls[0].arguments, ['WebGPT MCP audit unavailable; capture disabled for this run.']);
  }, { prepare: dir => mkdirSync(join(dir, logName)) });
});

for (const kind of ['symlink', 'hardlink']) for (const suffix of ['', '.1']) {
  test(`audit preserves ${kind} at ${suffix || 'active log'} and its target`, t => {
    const dir = temporary(), source = join(dir, 'evidence'), file = join(dir, logName);
    try {
      writeFileSync(source, 'preserve', { mode: 0o600 });
      if (suffix) writeFileSync(file, Buffer.alloc(AUDIT_LIMIT, 32), { mode: 0o600 });
      if (!makeLink(t, kind, source, file + suffix)) return;
      let warnings = 0; const write = createAuditWriter(dir, true, { warn: () => warnings++ });
      write({ phase: 'started' }); write({ phase: 'started' });
      assert.equal(warnings, 1); assert.equal(readFileSync(source, 'utf8'), 'preserve');
      assert.ok(existsSync(file + suffix));
      if (suffix) assert.equal(statSync(file).size, AUDIT_LIMIT);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
test('audit refuses a dangling link without creating its missing target', t => {
  const dir = temporary(), target = join(dir, 'missing');
  try {
    if (!makeLink(t, 'symlink', target, join(dir, logName))) return;
    let warning = 0; createAuditWriter(dir, true, { warn: () => warning++ })({ phase: 'started' });
    assert.equal(warning, 1); assert.equal(existsSync(target), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rotation is bounded and does not chmod a preexisting permissive log', t => {
  const dir = temporary(), file = join(dir, logName);
  try {
    writeFileSync(file, Buffer.alloc(AUDIT_LIMIT, 32), { mode: 0o600 });
    writeFileSync(file + '.1', 'old segment', { mode: 0o600 });
    const write = createAuditWriter(dir, true, { warn: () => assert.fail('unexpected warning') });
    write({ phase: 'started', token: 'OMIT_ME' });
    assert.equal(statSync(file + '.1').size, AUDIT_LIMIT); assert.ok(statSync(file).size < 4096);
    assert.equal(readFileSync(file, 'utf8').includes('OMIT_ME'), false);
    if (process.platform === 'win32') return;
    fs.chmodSync(file, 0o644); const before = readFileSync(file); let warnings = 0;
    createAuditWriter(dir, true, { warn: () => warnings++ })({ phase: 'started' });
    assert.equal(warnings, 1); assert.equal(statSync(file).mode & 0o777, 0o644); assert.deepEqual(readFileSync(file), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('write errors and a broken warning sink cannot escape the audit writer', t => {
  const dir = temporary();
  const mock = t.mock.method(fs, 'writeFileSync', () => { throw Object.assign(Error('PRIVATE_ERROR'), { code: 'ENOSPC' }); });
  syncBuiltinESMExports();
  try { assert.doesNotThrow(() => createAuditWriter(dir, true, { warn: () => { throw Error('PRIVATE_SINK'); } })({ phase: 'started' })); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true }); }
});

test('diagnostic records whitelist fields and reject unsafe values', () => {
  assert.deepEqual(auditRecord(event({ token: 'secret', phase: 'started' })).phase, 'started');
  for (const change of [{ phase: 'SECRET_PHASE' }, { runId: 'SECRET_RUN' }, { timestamp: 'not-time' }, { timestamp: '2026-02-31T00:00:00.000Z' }, { version: 2 }])
    assert.throws(() => auditRecord(event(change)), /diagnostic data unavailable/);
  const valid = event({ phase: 'tool_completed', requestId: randomUUID(), transportId: randomUUID(), taskId: 'owned', tool: 'read_file', isError: true, durationMs: 2 });
  assert.equal(auditRecord({ ...valid, token: 'secret' }).token, undefined);
  for (const change of [{ tool: 'SECRET_TOOL' }, { taskId: '../task' }, { requestId: 'PRIVATE_CLIENT_ID' }, { durationMs: Infinity }, { isError: 'true' }])
    assert.throws(() => auditRecord({ ...valid, ...change }));
});

test('diagnosis reports malformed/rotated windows, caps returned events and never infers a hung call', () => fixture(async f => {
  const { token } = await f.register('owned');
  for (let i = 0; i < 30; i++) await f.call('get_task', { token });
  appendFileSync(join(f.dir, logName), '{PRIVATE_BAD_LINE\n' + JSON.stringify(event({ phase: 'tool_received', requestId: randomUUID(), transportId: randomUUID(), taskId: 'owned', tool: 'read_file', path: 'PRIVATE_PATH' })) + '\n');
  const report = diagnoseTask('owned', f.config);
  assert.equal(report.audit.malformedLines, 1); assert.equal(report.audit.recent.length, 50);
  assert.equal(report.audit.recentTruncated, true); assert.equal(report.audit.receivedWithoutCompletionInWindow, 1);
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  assert.match(report.interpretation, /not proof of a hung call/);
}));

for (const name of ['state.json', logName]) for (const kind of ['symlink', 'hardlink']) {
  test(`diagnosis rejects linked ${name} (${kind})`, t => fixture(async f => {
    await f.register('owned');
    const file = join(f.dir, name), original = readFileSync(file), target = join(f.base, 'copy');
    writeFileSync(target, original); unlinkSync(file);
    if (!makeLink(t, kind, target, file)) { writeFileSync(file, original, { mode: 0o600 }); return; }
    assert.throws(() => diagnoseTask('owned', f.config), /unavailable/);
    assert.deepEqual(readFileSync(target), original);
  }));
}

test('bounded reads reject file growth as well as initially oversized files', t => {
  const dir = temporary(), file = join(dir, 'data');
  writeFileSync(file, '1234');
  const read = fs.readSync; let changed = false;
  const mock = t.mock.method(fs, 'readSync', (...args) => {
    if (!changed) { changed = true; appendFileSync(file, '56789'); }
    return read(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => readDiagnosticBytes(file, 5), /unavailable/);
    assert.throws(() => readDiagnosticBytes(file, 5), /unavailable/);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true }); }
});

test('diagnosis reports pending state and rechecks retained result bytes without repair', () => fixture(async f => {
  const { token } = await f.register('owned');
  await f.call('submit_result', { token, status: 'failed', summary: '', result: 'retained' });
  await collectTask('owned', f.config);
  writeFileSync(join(f.dir, 'state.json.tmp'), 'candidate', { mode: 0o600 });
  writeFileSync(join(f.dir, 'owned.result.txt'), 'changed');
  const report = diagnoseTask('owned', f.config);
  assert.equal(report.stateStage, 'present'); assert.equal(report.task.status, 'failed');
  assert.equal(report.task.integrity, 'mismatch_or_unreadable');
  assert.equal(readFileSync(join(f.dir, 'state.json.tmp'), 'utf8'), 'candidate');
  unlinkSync(join(f.dir, 'owned.result.txt'));
  assert.equal(diagnoseTask('owned', f.config).task.integrity, 'missing');
}));

test('diagnostic CLI is usable and configuration/errors do not expose private paths', () => fixture(async f => {
  await f.register('owned');
  const cli = fileURLToPath(new URL('./diagnose.mjs', import.meta.url)), execute = promisify(execFile);
  const config = join(f.base, 'private-config.json'); writeFileSync(config, JSON.stringify(f.config));
  const env = { ...process.env, WEBGPT_CONFIG: config, WEBGPT_DATA_DIR: f.dir };
  const result = await execute(process.execPath, [cli, 'owned'], { env, timeout: 5000 });
  assert.equal(JSON.parse(result.stdout).task.id, 'owned'); assert.equal(result.stderr, '');
  for (const args of [[], ['../PRIVATE_TASK'], ['missing']]) {
    await assert.rejects(execute(process.execPath, [cli, ...args], { env, timeout: 5000 }), error => {
      assert.equal(error.stdout, ''); assert.equal(error.stderr.includes(f.base), false); assert.equal(error.stderr.includes('PRIVATE_TASK'), false); return true;
    });
  }
  await assert.rejects(execute(process.execPath, [cli, 'owned'], { env: { ...env, WEBGPT_CONFIG: join(f.base, 'MISSING_PRIVATE_CONFIG') }, timeout: 5000 }), error => {
    assert.equal(error.stderr.trim(), 'WebGPT diagnose: diagnosis unavailable'); return true;
  });
}));

test('success produces one response completion and audit remains quiet after close', () => fixture(async f => {
  await f.register('owned');
  await f.call('get_task', { token: (await f.admin('register', { id: 'owned', instructions: 'FIXTURE_PRIVATE_PROMPT', inputs: { source: 'FIXTURE_PRIVATE_INPUT' } })).token });
  await f.service.close();
  const before = readFileSync(join(f.dir, logName));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(readFileSync(join(f.dir, logName)), before);
  const records = logs(f.dir), responses = records.filter(e => e.phase === 'http_completed');
  assert.equal(responses.length, 1); assert.equal(responses[0].aborted, false);
  assert.equal(records.filter(e => e.phase === 'http_received').length, 1);
  assert.equal(new Set(records.map(e => e.runId)).size, 1);
}));

test('a new worker run appends a distinct run ID without changing retained task tokens', () => fixture(async f => {
  const { token } = await f.register('owned');
  await f.call('get_task', { token });
  await f.service.close();
  const restarted = await start({ dir: f.dir, port: 0, controlPort: 0, audit: true });
  try {
    const response = await fetch(`http://127.0.0.1:${restarted.mcpPort}/mcp`, { method: 'POST', body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_task', arguments: { token } },
    }) });
    assert.equal((await response.json()).result.structuredContent.status, 'running');
    const report = diagnoseTask('owned', f.config);
    assert.equal(report.audit.observedRunStarts, 2); assert.equal(report.audit.received, 2);
    assert.equal(report.audit.completed, 2);
  } finally { await restarted.close(); }
}));

test('diagnosis fails safely on invalid UTF-8, oversized logs and corrupt state', () => fixture(async f => {
  await f.register('owned');
  await f.service.close();
  const log = join(f.dir, logName);
  writeFileSync(log, Buffer.from([0xff]));
  assert.throws(() => diagnoseTask('owned', f.config), /diagnostic data unavailable/);
  writeFileSync(log, Buffer.alloc(AUDIT_LIMIT + 1));
  assert.throws(() => diagnoseTask('owned', f.config), /diagnostic data unavailable/);
  const state = join(f.dir, 'state.json'); writeFileSync(state, '{PRIVATE_CORRUPT_STATE');
  assert.throws(() => diagnoseTask('owned', f.config), { message: 'task state unavailable' });
  assert.equal(readFileSync(state, 'utf8'), '{PRIVATE_CORRUPT_STATE');
}));

test('worker CLI audit opt-in records real traffic and invalid options fail before runtime creation', async () => {
  const base = temporary(), dir = join(base, 'runtime'), config = join(base, 'config.json');
  const { createServer } = await import('node:net');
  const ports = [];
  // Reserve distinct ephemeral ports together, then release immediately before launch.
  const reservations = [createServer(), createServer()];
  try {
    for (const server of reservations) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); ports.push(server.address().port); }
    for (const server of reservations) await new Promise(resolve => server.close(resolve));
    writeFileSync(config, JSON.stringify({ dataDir: dir, mcpPort: ports[0], controlPort: ports[1] }));
    const cli = fileURLToPath(new URL('./worker.mjs', import.meta.url));
    const env = { ...process.env, WEBGPT_CONFIG: config, WEBGPT_DATA_DIR: dir, WEBGPT_MCP_AUDIT: '1' };
    const child = execFile(process.execPath, [cli], { env, timeout: 10000 });
    const exited = once(child, 'exit');
    let output = '';
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => reject(Error('worker exited before listening: ' + code)));
        child.stdout.on('data', chunk => { output += chunk; if (output.includes('"event":"listening"')) resolve(); });
      });
      const response = await fetch(`http://127.0.0.1:${ports[0]}/health`, { method: 'HEAD' });
      assert.equal(response.status, 200);
      await request('shutdown', {}, { dataDir: dir, controlPort: ports[1] }); await exited;
      assert.equal(logs(dir).filter(e => e.phase === 'http_completed').length, 1);
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
    const invalidDir = join(base, 'not-created');
    await assert.rejects(promisify(execFile)(process.execPath, [cli], { env: { ...env, WEBGPT_DATA_DIR: invalidDir, WEBGPT_MCP_AUDIT: 'PRIVATE_INVALID' } }), error => {
      assert.equal(error.code, 78); assert.equal(error.stderr.includes('PRIVATE_INVALID'), false); return true;
    });
    assert.equal(existsSync(invalidDir), false);
  } finally { for (const server of reservations) server.close(); rmSync(base, { recursive: true, force: true }); }
});
