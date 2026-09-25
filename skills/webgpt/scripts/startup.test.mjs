import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './worker.mjs';
import { request } from './client.mjs';
import { createServer, Server, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { acquireRuntimeLock, startupExitCode } from './runtime.mjs';
import { callTool } from './test-fixtures/worker-http.mjs';

for (const [name, key] of [
  ['empty', ''],
  ['trailing space', 'fixture-only '],
  ['trailing tab', 'fixture-only\t'],
  ['newline', 'fixture-only\n'],
  ['control character', 'fixture-\0-only'],
  ['DEL character', 'fixture-\x7f-only'],
  ['wide Unicode', 'fixture-한글'],
]) {
  test(`startup rejects a ${name} controller key without changing evidence and allows corrected retry`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webgpt-startup-invalid-key-'));
    const keyPath = join(dir, 'controller.key');
    const statePath = join(dir, 'state.json');
    const state = '[\n]\n';
    let service;
    try {
      writeFileSync(keyPath, key);
      writeFileSync(statePath, state);
      await assert.rejects(async () => {
        service = await start({ dir, port: 0, controlPort: 0 });
      }, { message: 'invalid controller.key' });
      assert.equal(readFileSync(keyPath, 'utf8'), key);
      assert.equal(readFileSync(statePath, 'utf8'), state);
      assert.equal(existsSync(join(dir, 'worker.lock')), false);

      // The owner can repair its preserved key and retry without recovering a stale lock.
      writeFileSync(keyPath, 'corrected-fixture-only-key');
      service = await start({ dir, port: 0, controlPort: 0 });
      assert.deepEqual(await request('status', undefined, {
        dataDir: dir, controlPort: service.controlPort,
      }), { events: [], backupDue: [] });
      assert.equal(readFileSync(statePath, 'utf8'), state);
    } finally {
      // Also close an unexpectedly successful pre-fix startup after assert.rejects fails.
      await service?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const [name, key] of [
  ['custom ASCII', 'fixture-only-custom-key'],
  ['leading space', ' fixture-only'],
  ['internal space', 'fixture only'],
  ['Latin-1', 'fixture-é'],
]) {
  test(`startup preserves a header-compatible ${name} controller key`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webgpt-startup-valid-key-'));
    const keyPath = join(dir, 'controller.key');
    let service;
    try {
      writeFileSync(keyPath, key);
      service = await start({ dir, port: 0, controlPort: 0 });
      assert.deepEqual(await request('status', undefined, {
        dataDir: dir, controlPort: service.controlPort,
      }), { events: [], backupDue: [] });
      assert.equal(readFileSync(keyPath, 'utf8'), key);
    } finally {
      await service?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}


// Delay only the second listen attempt to expose an in-flight request reliably.
// Both listeners, the occupied port, the partial upload and EADDRINUSE are real.
async function partialStartup(t, { publicMcp = false, name = 'submit_result', stalled = false } = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'webgpt-partial-startup-')));
  const dir = join(base, 'runtime'), root = join(base, 'project'); mkdirSync(root);
  let seed, retry, blocker, mcp, control, client, starting, releaseBind;
  t.after(async () => {
    client?.destroy(); releaseBind?.();
    mcp?.closeAllConnections(); control?.closeAllConnections();
    await starting; await seed?.close(); await retry?.close();
    for (const server of [mcp, control, blocker].filter(Boolean)) {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    rmSync(base, { recursive: true, force: true });
  });
  seed = await start({ dir, port: 0, controlPort: 0 });
  const task = await request('register', { id: 'owned', instructions: 'Retain instructions',
    inputs: { sample: 'Retain input 한국어' }, workspace: { root, mode: 'edit' } },
  { dataDir: dir, controlPort: seed.controlPort });
  await seed.close();
  blocker = createServer((req, res) => res.end('unrelated listener'));
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const occupied = blocker.address().port, listen = Server.prototype.listen;
  let bindReached, closeCalled, closed = false, lockedAtClose = false, forced = 0;
  const binding = new Promise(resolve => { bindReached = resolve; });
  const closing = new Promise(resolve => { closeCalled = resolve; });
  const listenMock = t.mock.method(Server.prototype, 'listen', function (...args) {
    if (args[0] === occupied) {
      control = this;
      releaseBind = () => { releaseBind = undefined; Reflect.apply(listen, this, args); };
      bindReached(); return this;
    }
    mcp = this;
    mcp.once('close', () => { closed = true; lockedAtClose = existsSync(join(dir, 'worker.lock')); });
    const close = this.close, force = this.closeAllConnections;
    t.mock.method(this, 'close', function (...args) {
      const result = Reflect.apply(close, this, args); closeCalled(); return result;
    });
    t.mock.method(this, 'closeAllConnections', function () { forced++; return Reflect.apply(force, this, []); });
    return Reflect.apply(listen, this, args);
  });
  starting = start({ dir, port: 0, controlPort: occupied, publicMcp, audit: true,
    closeGraceMs: stalled ? 80 : 1000 }).then(value => ({ value }), error => ({ error }));
  await binding; listenMock.mock.restore();
  // Startup may normalize legacy recovery state. Compare after that, not before it.
  const statePath = join(dir, 'state.json'), before = readFileSync(statePath);
  const key = readFileSync(join(dir, 'controller.key'));
  const args = name === 'write_file' ? { token: task.token, path: 'late.txt', expectedSha256: null, text: 'late edit' }
    : { token: task.token, status: 'completed', summary: 'late', result: 'late result 한국어' };
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const received = once(mcp, 'request');
  const response = new Promise(resolve => {
    const path = '/mcp' + (publicMcp ? '/' + readFileSync(join(dir, 'mcp-path.key'), 'utf8') : '');
    client = httpRequest({ host: '127.0.0.1', port: mcp.address().port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), connection: 'close' } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    client.on('error', error => resolve({ error })); client.write(payload.slice(0, 1));
  });
  await received; releaseBind(); await closing;
  const heldDuringDrain = existsSync(join(dir, 'worker.lock'));
  let contender, lockError;
  try { contender = acquireRuntimeLock(dir); } catch (error) { lockError = error; }
  finally { contender?.release(); }
  if (!stalled) client.end(payload.slice(1));
  const outcome = await starting;
  assert.equal(outcome.error?.code, 'EADDRINUSE', 'keep the original bind failure');
  assert.equal(startupExitCode(outcome.error), 73);
  assert.equal(closed, true, 'startup rejection must wait for the first listener to close');
  assert.equal(heldDuringDrain, true); assert.equal(lockedAtClose, true);
  assert.equal(lockError?.code, 'LOCK_HELD', 'a second runtime owner cannot start during rollback');
  assert.equal(existsSync(join(dir, 'worker.lock')), false);
  const reply = await response;
  if (stalled) { assert.ok(reply.error); assert.equal(forced, 1, 'bounded drain must close unfinished uploads'); }
  else { assert.equal(reply.status, 503); assert.equal(reply.body.code, 'SHUTTING_DOWN'); assert.equal(forced, 0); }
  assert.deepEqual(readFileSync(statePath), before); assert.deepEqual(readFileSync(join(dir, 'controller.key')), key);
  assert.equal(existsSync(join(dir, 'owned.result.txt')), false);
  assert.equal(existsSync(join(dir, 'recovery', 'owned')), false); assert.equal(existsSync(join(root, 'late.txt')), false);
  const audit = readFileSync(join(dir, 'mcp-audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(audit.map(entry => entry.phase), ['http_received', 'http_completed']);
  assert.equal(audit[1].aborted, stalled); // No tool execution and no false started event.
  assert.equal(await (await fetch(`http://127.0.0.1:${occupied}`)).text(), 'unrelated listener');
  retry = await start({ dir, port: 0, controlPort: 0 });
  const retained = await callTool(retry, 'get_task', { token: task.token });
  assert.equal(retained.structuredContent.status, 'running');
  assert.equal((await callTool(retry, 'read_input', { token: task.token, name: 'sample' })).structuredContent.text, 'Retain input 한국어');
  await retry.close();
  assert.equal(readFileSync(join(dir, 'mcp-audit.jsonl'), 'utf8').trim().split('\n').length, 2, 'no audit writes after ownership release');
}

for (const [name, publicMcp] of [['submit_result', false], ['write_file', true]])
  test(`failed controller bind drains the ${publicMcp ? 'private-URL' : 'local'} MCP listener before a late ${name}`, { timeout: 20000 },
    t => partialStartup(t, { name, publicMcp }));

test('failed startup force-closes an unfinished upload before releasing its lock', { timeout: 20000 },
  t => partialStartup(t, { stalled: true }));

for (const endpoint of ['MCP', 'controller']) test(`ordinary ${endpoint} bind failure leaves no owned listener and allows explicit retry`, async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'webgpt-startup-port-')));
  const blocker = createServer((req, res) => res.end('untouched'));
  let retry;
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  try {
    const occupied = blocker.address().port;
    await assert.rejects(start({ dir, port: endpoint === 'MCP' ? occupied : 0,
      controlPort: endpoint === 'controller' ? occupied : 0 }), { code: 'EADDRINUSE' });
    assert.equal(existsSync(join(dir, 'worker.lock')), false);
    assert.equal(await (await fetch(`http://127.0.0.1:${occupied}`)).text(), 'untouched');
    retry = await start({ dir, port: 0, controlPort: 0 });
    assert.equal((await request('ready', undefined, { dataDir: dir, controlPort: retry.controlPort })).ok, true);
  } finally {
    await retry?.close(); blocker.closeAllConnections(); await new Promise(resolve => blocker.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
