// Real bounded POST reads; no production data, larger header limits or scope splitting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer, request as httpRequest, Server } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './worker.mjs';
import { request, waitForTasks } from './client.mjs';
import { observeFileRead } from './test-fixtures/file-read.mjs';
import { rejectsRequest } from './test-fixtures/request-error.mjs';

const MiB = 1024 * 1024;
const inventory = count => Array.from({ length: count }, (_, i) => ({
  id: `task_${String(i).padStart(5, '0')}_` + 'x'.repeat(69),
  status: 'cancelled', collected: true, instructions: '', inputs: {}, changes: [], nextCheck: null,
}));

async function fixture(t, tasks) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-large-scope-')));
  const state = join(dir, 'state.json'), pending = [], uploads = [], controllers = [];
  if (tasks) fs.writeFileSync(state, JSON.stringify(tasks));
  let worker;
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    for (const upload of uploads) upload.destroy();
    await worker?.close();
    await Promise.all(pending);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  worker = await start({ dir, port: 0, controlPort: 0, waitMs: 55000, closeGraceMs: 1000 });
  const config = { dataDir: dir, controlPort: worker.controlPort };
  const send = async (path, value, { method = 'POST', headers = {}, bytes } = {}) => {
    const response = await fetch(`http://127.0.0.1:${worker.controlPort}${path}`, {
      method, headers: { authorization: 'Bearer ' + worker.key, ...headers },
      body: method === 'GET' ? undefined : bytes ?? JSON.stringify(value),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, value: await response.json() };
  };
  const register = id => request('register', { id, instructions: 'fixture', inputs: {} }, config);
  const park = async ids => {
    let observed;
    const read = new Promise(resolve => { observed = resolve; });
    // The microtask runs after the synchronous post-body state check and parking.
    const trace = observeFileRead(t, state, { beforeRead: () => queueMicrotask(observed) });
    const controller = new AbortController(); controllers.push(controller);
    let settled = false;
    const outcome = waitForTasks(ids, config, { signal: controller.signal, retryDelays: [] })
      .then(value => ({ value }), error => ({ error })).then(value => { settled = true; return value; });
    pending.push(outcome);
    try {
      assert.equal(await Promise.race([read.then(() => 'read'), outcome.then(() => 'response')]), 'read');
      assert.equal(settled, false, 'fully parsed wait must remain parked');
    } finally { trace.restore(); }
    return { outcome, controller };
  };
  const upload = async (path, prefix = '{', headers = {}) => {
    let arrived;
    const arrival = new Promise(resolve => { arrived = resolve; });
    const emit = Server.prototype.emit;
    const observer = t.mock.method(Server.prototype, 'emit', function(event, ...args) {
      const result = Reflect.apply(emit, this, [event, ...args]);
      // A partial POST has entered its body reader before request emission returns.
      if (event === 'request' && this.address()?.port === worker.controlPort) arrived(args[0]);
      return result;
    });
    let req;
    const outcome = new Promise(resolve => {
      req = httpRequest({ hostname: '127.0.0.1', port: worker.controlPort, method: 'POST', path, agent: false,
        headers: { authorization: 'Bearer ' + worker.key, ...headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', error => resolve({ error }));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks)) }); }
          catch (error) { resolve({ error }); }
        });
      });
      req.on('error', error => resolve({ error }));
      req.setTimeout(10000, () => req.destroy(Error('fixture upload deadline')));
      req.write(prefix); // Deliberately no EOF or declared Content-Length.
    });
    pending.push(outcome); uploads.push(req);
    try {
      const incoming = await Promise.race([arrival, outcome.then(() => null)]);
      assert.ok(incoming, 'fixture request must reach the owned server');
      return { req, incoming, outcome };
    } finally { observer.mock.restore(); }
  };
  return { dir, state, worker, config, send, register, park, upload };
}

for (const action of ['wait', 'reconcile']) test(`${action} handles 1,024 long IDs without a large request target`, async t => {
  const tasks = inventory(1024), ids = tasks.map(task => task.id).reverse();
  assert.ok(ids.every(id => id.length === 80));
  assert.ok(Buffer.byteLength(new URLSearchParams(ids.map(id => ['id', id])).toString()) > 64 * 1024);
  const unrelated = { id: 'unrelated', token: 'unrelated-token', status: 'running', collected: false,
    instructions: 'not selected', inputs: {}, changes: [], nextCheck: 0 };
  const f = await fixture(t, [...tasks, unrelated]), before = fs.readFileSync(f.state);
  const fetch = globalThis.fetch, sent = [];
  const observer = t.mock.method(globalThis, 'fetch', (url, options) => {
    sent.push({ url, method: options.method, body: JSON.parse(options.body) });
    return fetch(url, options);
  });
  let result;
  try { result = await request(action, { ids: [...ids, ids[0]] }, f.config); }
  finally { observer.mock.restore(); }
  assert.deepEqual(sent, [{ url: `http://127.0.0.1:${f.worker.controlPort}/${action}`,
    method: 'POST', body: { ids } }]);
  if (action === 'wait') assert.deepEqual(result, { events: [], backupDue: [], settled: true });
  else {
    assert.deepEqual(result.scope, ids);
    assert.deepEqual(result.tasks.map(task => task.id), tasks.map(task => task.id));
    assert.equal(result.health.stateVerified, true);
  }
  assert.deepEqual(fs.readFileSync(f.state), before);
});

for (const action of ['wait', 'reconcile']) test(`${action} POST and legacy GET preserve ordering and reject unknown scopes`, async t => {
  const tasks = inventory(3), f = await fixture(t, tasks), ids = [tasks[2].id, tasks[0].id, tasks[2].id];
  const before = fs.readFileSync(f.state);
  const post = await f.send('/' + action, { ids });
  const get = await f.send(`/${action}?${new URLSearchParams(ids.map(id => ['id', id]))}`, undefined, { method: 'GET' });
  assert.equal(post.status, 200); assert.deepEqual(post, get);
  const all = await f.send('/' + action, undefined, { method: 'GET' });
  assert.equal(all.status, 200);
  assert.equal(Object.hasOwn(all.value, action === 'wait' ? 'settled' : 'scope'), false);
  for (const invalid of [['missing'], [tasks[0].id, 'missing'], [tasks[0].id.toUpperCase()]]) {
    const result = await f.send('/' + action, { ids: invalid });
    assert.equal(result.status, 400); assert.equal(result.value.error, 'unknown task');
    assert.equal(Object.hasOwn(result.value, 'events'), false);
    assert.equal(Object.hasOwn(result.value, 'tasks'), false);
  }
  assert.deepEqual(fs.readFileSync(f.state), before);
});

for (const action of ['wait', 'reconcile']) test(`${action} rejects malformed POST scopes before state inspection`, async t => {
  const f = await fixture(t, inventory(1)), before = fs.readFileSync(f.state);
  const trace = observeFileRead(t, f.state, { afterStat: () => { throw Object.assign(Error('denied fixture'), { code: 'EACCES' }); } });
  try {
    for (const value of [null, [], {}, { ids: [] }, { ids: 'x' }, { ids: ['x'], extra: true },
      { ids: [null] }, { ids: [123] }, { ids: [true] }, { ids: [{}] }, { ids: [''] },
      { ids: ['bad/id'] }, { ids: ['x'.repeat(81)] }, { ids: ['\ud800'] }]) {
      const result = await f.send('/' + action, value);
      assert.equal(result.status, 400, JSON.stringify(value));
      assert.equal(result.value.error, 'invalid task scope'); assert.equal(result.value.retryable, false);
    }
    for (const suffix of ['?', '?id=x', '?extra=1']) {
      // Some fetch versions remove a trailing empty query before transmission.
      // Test the exact wire target and its early refusal, not URL normalization.
      const rejected = await f.upload('/' + action + suffix, '{"ids":["x"]}');
      assert.equal(rejected.incoming.url, '/' + action + suffix);
      assert.equal((await rejected.outcome).status, 404);
      rejected.req.destroy();
    }
    assert.equal(trace.evidence.opens, 0);
  } finally { trace.restore(); }
  assert.deepEqual(fs.readFileSync(f.state), before);
});

test('POST wait keeps fresh-state failure ahead of unknown-task lookup; reconcile remains diagnostic', async t => {
  const tasks = inventory(1), f = await fixture(t, tasks), before = fs.readFileSync(f.state);
  const trace = observeFileRead(t, f.state, { afterStat: () => { throw Object.assign(Error('fixture I/O'), { code: 'EIO' }); } });
  try {
    const wait = await f.send('/wait', { ids: ['missing'] });
    assert.equal(wait.status, 503); assert.equal(wait.value.code, 'EIO');
    const reconcile = await f.send('/reconcile', { ids: [tasks[0].id] });
    assert.equal(reconcile.status, 200); assert.equal(reconcile.value.health.stateVerified, false);
    assert.deepEqual(reconcile.value.scope, [tasks[0].id]);
  } finally { trace.restore(); }
  assert.deepEqual(fs.readFileSync(f.state), before);
});

for (const action of ['wait', 'reconcile']) test(`${action} authenticates before uploads and retains controller body limits`, async t => {
  const f = await fixture(t, inventory(1)), trace = observeFileRead(t, f.state);
  try {
    for (const [headers, expected] of [[{ authorization: 'Bearer wrong' }, 401],
      [{ origin: 'https://example.invalid' }, 403],
      [{ 'content-length': String(2 * MiB + 1) }, 413]]) {
      const partial = await f.upload('/' + action, '{', headers);
      assert.equal((await partial.outcome).status, expected);
      partial.req.destroy();
    }
    for (const [bytes, expected] of [[Buffer.from([0xff]), 400], [Buffer.from('{'), 400],
      [Buffer.from('['.repeat(65)), 413],
      [Buffer.from('{"ids":[' + '"x",'.repeat(33000) + '"x"]}'), 413]]) {
      assert.equal((await f.send('/' + action, undefined, { bytes })).status, expected);
    }
    const overflow = await f.upload('/' + action, ' '.repeat(2 * MiB + 1));
    assert.equal((await overflow.outcome).status, 413); overflow.req.destroy();
    assert.equal(trace.evidence.opens, 0);
  } finally { trace.restore(); }
  assert.equal((await f.send('/' + action, { ids: [inventory(1)[0].id] })).status, 200);
});

test('four incomplete POST scopes occupy admission, disconnect releases it, and GET stays independent', async t => {
  const f = await fixture(t, inventory(1)), uploads = [];
  for (let i = 0; i < 4; i++) uploads.push(await f.upload(i % 2 ? '/reconcile' : '/wait', '{"ids":['));
  const busy = await f.send('/wait', { ids: [inventory(1)[0].id] });
  assert.equal(busy.status, 503); assert.equal(busy.value.code, 'HTTP_BODY_BUSY'); assert.equal(busy.value.retryable, true);
  assert.equal((await f.send('/status', undefined, { method: 'GET' })).status, 200);
  // An intentional aborted upload emits ECONNRESET before close. Await close,
  // not events.once's implicit rejection on that expected error.
  const closed = new Promise(resolve => uploads[0].incoming.once('close', resolve));
  uploads[0].req.destroy(); await closed;
  const released = await f.send('/reconcile', { ids: [inventory(1)[0].id] });
  assert.equal(released.status, 200); assert.equal(released.value.health.stateVerified, true);
});

test('fully parsed parked POST waits release admission and preserve scoped wakeups', async t => {
  const f = await fixture(t); await f.register('owned');
  const waits = [];
  for (let i = 0; i < 8; i++) waits.push(await f.park(['owned']));
  await f.register('unrelated');
  await request('cancel', { id: 'owned' }, f.config);
  for (const wait of waits) assert.deepEqual((await wait.outcome).value, { events: [], backupDue: [], settled: true });
  const other = await f.park(['unrelated']), reason = Object.freeze({ fixture: 'stop waiting only' });
  other.controller.abort(reason);
  assert.equal((await other.outcome).error, reason);
  assert.equal((await request('tasks', undefined, f.config)).running, 1);
});

for (const action of ['wait', 'reconcile']) test(`${action} completes an admitted upload before shutdown handling`, async t => {
  const f = await fixture(t); await f.register('owned');
  const upload = await f.upload('/' + action, '{"ids":[');
  assert.equal(upload.incoming.complete, false);
  const trace = observeFileRead(t, f.state);
  try {
    assert.equal((await f.send('/shutdown', {})).status, 202);
    upload.req.end('"owned"]}');
    const result = await upload.outcome;
    assert.equal(upload.incoming.complete, true);
    if (action === 'wait') {
      assert.equal(result.status, 503); assert.equal(result.value.code, 'SHUTTING_DOWN');
      assert.equal(trace.evidence.opens, 0);
    } else {
      assert.equal(result.status, 200); assert.ok(result.value.health.issues.includes('SHUTTING_DOWN'));
      assert.equal(result.value.health.stateVerified, true); assert.deepEqual(result.value.scope, ['owned']);
    }
  } finally { trace.restore(); }
});

for (const action of ['wait', 'reconcile']) test(`${action} serializes the captured IDs, not caller toJSON hooks`, async t => {
  const tasks = inventory(1), f = await fixture(t, tasks), id = tasks[0].id;
  const ids = [id, id]; ids.toJSON = () => { throw Error('caller array must not be serialized'); };
  let reads = 0;
  const payload = { get ids() { reads++; return ids; } };
  Object.defineProperty(payload, 'toJSON', { value: () => { throw Error('caller payload must not be serialized'); } });
  const result = await request(action, payload, f.config);
  assert.equal(reads, 1);
  if (action === 'wait') assert.equal(result.settled, true);
  else assert.deepEqual(result.scope, [id]);
});

for (const body of ['{"error":"not found"}', 'not JSON']) test(`GET-only worker refusal is nonretryable without fallback (${body})`, async t => {
  const f = await fixture(t, inventory(1)), received = [];
  const server = createServer((req, res) => {
    (async () => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      received.push({ method: req.method, path: req.url, body: JSON.parse(Buffer.concat(chunks)) });
      res.writeHead(404); res.end(body);
    })().catch(error => { received.push({ error }); res.destroy(); });
  });
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
  const config = { ...f.config, controlPort: server.address().port };
  await rejectsRequest(waitForTasks(['owned'], config), error => error.statusCode === 404
    && error.code === 'SCOPED_READ_UNSUPPORTED' && error.retryable === false
    && error.message.includes('update the idle worker and client together'));
  await rejectsRequest(request('reconcile', { ids: ['owned'] }, config), { statusCode: 404, code: 'SCOPED_READ_UNSUPPORTED' });
  assert.deepEqual(received, ['wait', 'reconcile'].map(action => ({
    method: 'POST', path: '/' + action, body: { ids: ['owned'] },
  })));
});
