import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { request } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './worker.mjs';
import { callTool } from './test-fixtures/worker-http.mjs';

async function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-controller-preflight-')));
  const dir = join(base, 'runtime');
  let worker;
  t.after(async () => { try { await worker?.close(); } finally { fs.rmSync(base, { recursive: true, force: true }); } });
  worker = await start({ dir, port: 0, controlPort: 0, waitMs: 20, configFile: join(base, 'config.json') });
  const send = async (method, path, value, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${worker.controlPort}${path}`, {
      method, headers: { authorization: 'Bearer ' + worker.key, ...headers },
      body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, value: await response.json() };
  };
  const registration = { id: 'active', instructions: 'fixture', inputs: {} };
  assert.equal((await send('POST', '/register', registration)).status, 200);
  return { base, dir, worker, send, registration, state: join(dir, 'state.json') };
}

// Count attempted native opens, including injected failures; leave all other I/O real.
function observeState(t, file) {
  const open = fs.openSync, access = { opens: 0, denied: false };
  const mock = t.mock.method(fs, 'openSync', (path, ...args) => {
    if (path === file) {
      access.opens++;
      if (access.denied) throw Object.assign(Error('fixture state access denied'), { code: 'EACCES' });
    }
    return open(path, ...args);
  });
  syncBuiltinESMExports();
  return { access, restore() { mock.mock.restore(); syncBuiltinESMExports(); } };
}

for (const denied of [false, true]) test(`invalid controller requests avoid state inspection with ${denied ? 'denied' : 'readable'} state`, async t => {
  const f = await fixture(t), before = fs.readFileSync(f.state);
  const registration = { ...f.registration, id: 'new' };
  const collection = { id: 'active', expectedStatus: 'completed', expectedSha256: 'a'.repeat(64) };
  const cases = [
    ['GET', '/wait?unexpected=1', undefined, 400, 'invalid wait query'],
    ['GET', '/wait?id=', undefined, 400, 'invalid wait query'],
    ['GET', '/wait?id=bad%2Fid', undefined, 400, 'invalid wait query'],
    ['GET', '/wait?id=' + 'x'.repeat(81), undefined, 400, 'invalid wait query'],
    ['GET', '/reconcile?unexpected=1', undefined, 400, 'invalid reconciliation query'],
    ['POST', '/register', {}, 400, 'invalid task'],
    ['POST', '/register', null, 400, 'invalid task'],
    ['POST', '/register', [], 400, 'invalid task'],
    ['POST', '/register', { ...registration, inputs: [] }, 400, 'invalid task'],
    ['POST', '/register', { ...registration, inputs: { value: 1 } }, 400, 'invalid task'],
    ['POST', '/register', { ...registration, instructions: '\ud800' }, 400, 'task instructions and inputs must be well-formed Unicode'],
    ['POST', '/register', { ...registration, inputs: { '\ud800': 'text' } }, 400, 'task instructions and inputs must be well-formed Unicode'],
    ['POST', '/register', { ...registration, id: 'CON' }, 400, 'invalid task ID: reserved Windows filename'],
    ['POST', '/register', { ...registration, terminal: false }, 400, 'terminal/open modes are not supported by this file-scoped fork'],
    ...[false, 0, '', [], {}, { root: 'relative', mode: 'read' }, { root: f.base, mode: 'invalid' },
      { root: f.base, mode: 'read', write: [] }].map(workspace =>
      ['POST', '/register', { ...registration, workspace }, 400, 'use workspace root and mode only']),
    ['POST', '/register', { ...registration, workspace: { root: join(f.base, '\ud800'), mode: 'read' } }, 400, 'workspace root must be well-formed Unicode'],
    ['POST', '/register', { ...registration, workspace: { root: join(f.base, 'project\0invalid'), mode: 'read' } }, 400, 'workspace root must not contain NUL'],
    ...(process.platform === 'win32' ? ['\\project', '/project', '\\\\server', '//server', '\\', '/']
      .map(root => ['POST', '/register', { ...registration, workspace: { root, mode: 'edit' } },
        400, 'workspace root must be fully qualified']) : []),
    ...[{}, null, [], { ...collection, extra: true }, { ...collection, id: 'bad/id' },
      { ...collection, expectedStatus: 'running' }, { ...collection, expectedSha256: 'bad' }]
      .map(value => ['POST', '/collect', value, 400, 'invalid conditional collection']),
    ...['/ack', '/checked', '/cancel'].flatMap(path => [{}, null, [], { id: 'bad/id' }]
      .map(value => ['POST', path, value, 400, 'invalid task ID'])),
    ['POST', '/shutdown', { extra: true }, 400, 'shutdown requires an empty object'],
    ...[['POST', '/unknown'], ['POST', '/register?unexpected=1'], ['POST', '/ready'],
      ['GET', '/register'], ['PUT', '/cancel'], ['GET', '/status?unexpected=1'],
      ['GET', '/tasks?unexpected=1'], ['GET', '/ready?unexpected=1']]
      .map(([method, path]) => [method, path, method === 'GET' ? undefined : {}, 404, undefined]),
  ];
  const trace = observeState(t, f.state); trace.access.denied = denied;
  try {
    for (const [method, path, value, status, error] of cases) await t.test(`${method} ${path} ${JSON.stringify(value)}`, async () => {
      const opens = trace.access.opens, result = await f.send(method, path, value);
      assert.equal(result.status, status); assert.equal(result.value.error, error);
      assert.equal(trace.access.opens, opens, 'request-only rejection must not open state.json');
    });
  } finally { trace.restore(); }
  assert.deepEqual(fs.readFileSync(f.state), before);
  assert.equal((await f.send('GET', '/ready')).status, 200, 'invalid requests must not latch a storage failure');
});

test('valid requests still verify fresh state and retain the storage failure until a real persist', async t => {
  const f = await fixture(t);
  const task = (await f.send('POST', '/register', { id: 'done', instructions: '', inputs: {} })).value;
  assert.equal((await callTool(f.worker, 'submit_result', {
    token: task.token, status: 'completed', summary: 'done', result: 'retained evidence',
  })).isError, false);
  const before = fs.readFileSync(f.state), saved = JSON.parse(before).find(task => task.id === 'done');
  const cases = [
    ['GET', '/status'], ['GET', '/tasks'], ['GET', '/wait?id=done&id=done'], ['GET', '/wait?id=missing'],
    ['POST', '/register', f.registration],
    ['POST', '/register', { id: 'new', instructions: '', inputs: {}, workspace: { root: join(f.base, 'missing'), mode: 'read' } }],
    ['POST', '/collect', { id: 'done', expectedStatus: 'completed', expectedSha256: saved.sha256 }],
    ['POST', '/collect', { id: 'missing', expectedStatus: 'completed', expectedSha256: saved.sha256 }],
    ...['/ack', '/checked', '/cancel'].map(path => ['POST', path, { id: 'active' }]),
  ];
  const trace = observeState(t, f.state); trace.access.denied = true;
  try {
    for (const [method, path, value] of cases) {
      const opens = trace.access.opens, result = await f.send(method, path, value);
      assert.equal(result.status, 503, path); assert.equal(result.value.code, 'EACCES', path);
      assert.ok(trace.access.opens > opens, path + ' must verify current state before task or workspace inspection');
    }
  } finally { trace.restore(); }
  assert.deepEqual(fs.readFileSync(f.state), before);
  assert.equal((await f.send('GET', '/status')).status, 200);
  const unhealthy = await f.send('GET', '/ready');
  assert.equal(unhealthy.status, 503); assert.equal(unhealthy.value.stateVerified, true);
  assert.ok(unhealthy.value.issues.includes('STORAGE_UNAVAILABLE'));
  assert.equal((await f.send('POST', '/checked', { id: 'active', compatibleExtra: true })).status, 200);
  assert.equal((await f.send('GET', '/ready')).status, 200);
  assert.equal((await f.send('POST', '/register', { ...f.registration, workspace: null, compatibleExtra: true })).value.duplicate, true);
  const wait = await f.send('GET', '/wait?id=done&id=done');
  assert.equal(wait.status, 200); assert.equal(wait.value.settled, true);
  assert.deepEqual(wait.value.events.map(task => task.id), ['done']);
});

test('ready and reconcile still diagnose failed storage while shutdown avoids state inspection', async t => {
  const f = await fixture(t), before = fs.readFileSync(f.state);
  const trace = observeState(t, f.state); trace.access.denied = true;
  try {
    const ready = await f.send('GET', '/ready');
    assert.equal(ready.status, 503); assert.ok(ready.value.issues.includes('STORAGE_UNAVAILABLE'));
    const reconcile = await f.send('GET', '/reconcile?id=active&id=active');
    assert.equal(reconcile.status, 200); assert.equal(reconcile.value.health.stateVerified, false);
    assert.deepEqual(reconcile.value.scope, ['active']);
    assert.deepEqual(reconcile.value.tasks.map(task => task.id), ['active']);
    const opens = trace.access.opens;
    assert.deepEqual(await f.send('POST', '/shutdown', {}), { status: 202, value: { accepted: true } });
    assert.equal(trace.access.opens, opens);
  } finally { trace.restore(); }
  await f.worker.close();
  assert.deepEqual(fs.readFileSync(f.state), before);
});

// Do not send EOF: route/auth/body-limit refusals must not wait for a complete upload.
function prefixRequest(worker, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: worker.controlPort, path, method: 'POST', agent: false,
      headers: { authorization: 'Bearer ' + worker.key, connection: 'keep-alive', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer); req.destroy();
        resolve({ status: res.statusCode, connection: res.headers.connection, value: JSON.parse(Buffer.concat(chunks)) });
      });
    });
    const timer = setTimeout(() => req.destroy(Error('early refusal did not finish')), 10000);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.write('{');
  });
}

test('authentication stays first and unsupported routes and oversized bodies refuse incomplete uploads', async t => {
  const f = await fixture(t), trace = observeState(t, f.state); trace.access.denied = true;
  try {
    const origin = await prefixRequest(f.worker, '/unknown', { origin: 'https://example.invalid', authorization: 'Bearer wrong' });
    assert.equal(origin.status, 403);
    const unauthorized = await prefixRequest(f.worker, '/unknown', { authorization: 'Bearer wrong' });
    assert.equal(unauthorized.status, 401);
    const unknown = await prefixRequest(f.worker, '/unknown');
    assert.equal(unknown.status, 404); assert.equal(unknown.connection, 'close');
    const oversized = await prefixRequest(f.worker, '/register', { 'content-length': String(2 * 1024 * 1024 + 1) });
    assert.equal(oversized.status, 413); assert.equal(oversized.connection, 'close');
    assert.equal(trace.access.opens, 0);
  } finally { trace.restore(); }
  assert.equal((await f.send('GET', '/ready')).status, 200);
});
