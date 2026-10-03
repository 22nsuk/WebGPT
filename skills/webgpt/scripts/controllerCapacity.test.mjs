import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { request, retryableControllerError, collectTask } from './client.mjs';
import { createJsonBodyReader } from './json-body.mjs';

const busy = { error: 'request body capacity exhausted', code: 'HTTP_BODY_BUSY', retryable: true };
const send = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
async function drain(req) { for await (const chunk of req) { /* Finish the fixture's small upload. */ } }
async function fixture(t, handler) {
  const dataDir = mkdtempSync(join(tmpdir(), 'webgpt-controller-capacity-'));
  const key = 'controller-capacity-test-key';
  writeFileSync(join(dataDir, 'controller.key'), key, { mode: 0o600 });
  const failures = [];
  const server = createServer((req, res) => {
    Promise.resolve().then(() => {
      assert.equal(req.headers.authorization, 'Bearer ' + key);
      return handler(req, res);
    }).catch(error => { failures.push(error); res.destroy(); });
  });
  t.after(async () => {
    try {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      assert.deepEqual(failures, [], 'fixture handler must not hide failures');
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { dataDir, controlPort: server.address().port };
}
function rejection(status, code, retryable) {
  return error => {
    assert.equal(error.statusCode, status);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    assert.equal(retryableControllerError(error), retryable);
    return true;
  };
}

test('controller preserves only explicit known transient HTTP 503 refusals', async t => {
  const cases = [
    ['body capacity', 503, busy, true],
    ['shutdown remains retryable', 503, { ...busy, code: 'SHUTTING_DOWN' }, true],
    ['false flag', 503, { ...busy, retryable: false }, false],
    ['missing flag', 503, { error: busy.error, code: busy.code }, false],
    ['string flag', 503, { ...busy, retryable: 'true' }, false],
    ['numeric flag', 503, { ...busy, retryable: 1 }, false],
    ['null flag', 503, { ...busy, retryable: null }, false],
    ['storage failure', 503, { ...busy, code: 'STORAGE_UNAVAILABLE' }, false],
    ['invalid state', 503, { ...busy, code: 'STATE_INVALID' }, false],
    ['unknown code', 503, { ...busy, code: 'OTHER_BUSY' }, false],
    ['missing code', 503, { error: busy.error, retryable: true }, false],
    ['bad request', 400, busy, false],
    ['oversized body', 413, busy, false],
    ['rate limit is not capacity proof', 429, busy, false],
    ['internal failure', 500, busy, false],
  ];
  for (const [name, status, body, retryable] of cases) await t.test(name, async t => {
    let calls = 0;
    const config = await fixture(t, async (req, res) => {
      calls++; await drain(req); send(res, status, body);
    });
    await assert.rejects(request('register', { id: 'capacity' }, config), error => {
      rejection(status, body.code, retryable)(error);
      assert.deepEqual(error.details, body);
      assert.equal(error.message, body.error);
      return true;
    });
    assert.equal(calls, 1, 'request must never replay a mutation');
  });
});

test('malformed or uninformative HTTP 503 bodies cannot authorize a retry', async t => {
  for (const raw of ['', '<html>busy</html>', '{"code":"HTTP_BODY_BUSY","retryable":true,', 'null', '[]']) {
    await t.test(JSON.stringify(raw), async t => {
      let calls = 0;
      const config = await fixture(t, async (req, res) => {
        calls++; await drain(req); res.writeHead(503); res.end(raw);
      });
      await assert.rejects(request('register', { id: 'capacity' }, config), rejection(503, undefined, false));
      assert.equal(calls, 1);
    });
  }
});

test('successful controller JSON is not reclassified as a capacity refusal', async t => {
  const config = await fixture(t, async (req, res) => { await drain(req); send(res, 200, busy); });
  assert.deepEqual(await request('register', { id: 'capacity' }, config), busy);
});

test('real body-reader admission refusal survives the client and permits an explicit later request', async t => {
  const read = createJsonBodyReader();
  // Hold four real readers deterministically without socket-arrival races. The
  // HTTP fixture uses the production reader and the controller's error envelope,
  // not a full worker. Draining here ensures the client receives that envelope.
  const held = Array.from({ length: 4 }, () => Object.assign(new PassThrough(), { headers: {} }));
  const pending = held.map(stream => read(stream));
  const settled = Promise.allSettled(pending);
  t.after(async () => { for (const stream of held) stream.end(); await settled; });
  let calls = 0, dispatched = 0;
  const config = await fixture(t, async (req, res) => {
    calls++;
    let value;
    try { value = await read(req); }
    catch (error) {
      await drain(req);
      send(res, error.statusCode ?? 400, { error: error.message, code: error.code, retryable: error.code === 'HTTP_BODY_BUSY' });
      return;
    }
    dispatched++; send(res, 200, { accepted: value.id });
  });
  await assert.rejects(request('register', { id: 'capacity' }, config), rejection(503, 'HTTP_BODY_BUSY', true));
  assert.equal(calls, 1);
  assert.equal(dispatched, 0, 'a capacity refusal must precede dispatch');
  for (const stream of held) stream.end('{}');
  assert.deepEqual(await settled, Array.from({ length: 4 }, () => ({ status: 'fulfilled', value: {} })));
  assert.deepEqual(await request('register', { id: 'capacity' }, config), { accepted: 'capacity' });
  assert.equal(calls, 2, 'only the explicit second request may be sent');
  assert.equal(dispatched, 1);
});

for (const resume of [false, true]) test(`collection${resume ? ' resume' : ''} propagates capacity refusal without replay, probe or ack fallback`, async t => {
  const calls = [];
  let event, task;
  const config = await fixture(t, async (req, res) => {
    calls.push(req.url); await drain(req);
    if (req.url === '/wait?id=capacity') return send(res, 200, { events: [event], backupDue: [], settled: true });
    if (req.url === '/reconcile?id=capacity') return send(res, 200, { health: { stateVerified: true, issues: [] }, scope: ['capacity'], tasks: [task] });
    if (req.url === '/collect') return send(res, 503, busy);
    assert.fail('unexpected controller action: ' + req.url);
  });
  const bytes = Buffer.from('retained result evidence\n'), artifact = join(config.dataDir, 'capacity.result.txt');
  writeFileSync(artifact, bytes, { mode: 0o600 });
  event = { id: 'capacity', status: 'completed', summary: 'done', artifact,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  task = { ...event, collected: false, discarded: false, recoveryRequired: [], journalIssues: [], pendingResults: [] };
  const before = readdirSync(config.dataDir).sort();
  await assert.rejects(collectTask('capacity', config, { resume }), rejection(503, 'HTTP_BODY_BUSY', true));
  assert.deepEqual(calls, [resume ? '/reconcile?id=capacity' : '/wait?id=capacity', '/collect']);
  assert.deepEqual(readFileSync(artifact), bytes);
  assert.deepEqual(readdirSync(config.dataDir).sort(), before);
  assert.equal(task.collected, false);
});
