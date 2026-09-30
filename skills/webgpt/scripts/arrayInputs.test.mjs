// Public parent APIs: validate the same captured values that select tasks/bytes.
// HTTP and file observations use disposable loopback fixtures, not live workers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { request, waitForTasks, reconcileTasks } from './client.mjs';
import { buildArtifactInput, MAX_WINDOW_BYTES } from './artifact-input.mjs';
import { readFixture, observeFileRead } from './test-fixtures/file-read.mjs';

async function controller(t) {
  const dir = readFixture(t), key = join(dir, 'controller.key'), calls = [];
  fs.writeFileSync(key, 'array-input-fixture-key');
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost'), ids = url.searchParams.getAll('id');
    calls.push({ method: req.method, url: req.url, ids, authorization: req.headers.authorization });
    const value = url.pathname === '/wait' ? { events: [], backupDue: [], settled: true }
      : { health: { stateVerified: true, issues: [] },
        ...(ids.length ? { scope: ids } : {}),
        tasks: ids.map(id => ({ id, status: 'cancelled', collected: true, discarded: false,
          artifact: null, sha256: null, recoveryRequired: [], journalIssues: [], pendingResults: [] })) };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { key, calls, config: { dataDir: dir, controlPort: server.address().port } };
}

const invalidIds = [
  ['one empty slot', () => Array(1)],
  ['a missing middle ID', () => ['owned', , 'last']],
  ['explicit undefined', () => ['owned', undefined]],
  ['empty list', () => []],
  ['invalid iterator value', () => Object.assign(['owned'], {
    [Symbol.iterator]: function* () { yield '../invalid'; },
  })],
  ['empty iterator', () => Object.assign(['owned'], { [Symbol.iterator]: function* () {} })],
];
for (const action of ['wait', 'reconcile']) for (const [name, make] of invalidIds) {
  test(`${action} rejects ${name} before credential reads or HTTP`, async t => {
    const f = await controller(t), observed = observeFileRead(t, f.key);
    let error;
    try { await request(action, { ids: make() }, f.config); }
    catch (caught) { error = caught; }
    finally { observed.restore(); }
    assert.equal(observed.evidence.reads, 0, 'invalid scope must not read controller credentials');
    assert.deepEqual(f.calls, [], 'invalid scope must not reach the controller');
    assert.equal(error?.message, 'nonempty task IDs required');
  });
}

const clients = [
  ['request wait', (ids, config) => request('wait', { ids }, config)],
  ['request reconcile', (ids, config) => request('reconcile', { ids }, config)],
  ['waitForTasks', (ids, config) => waitForTasks(ids, config, { retryDelays: [] })],
  ['reconcileTasks', (ids, config) => reconcileTasks(config, { ids })],
];
for (const [name, invoke] of clients) test(`${name} validates and sends one captured ID value`, async t => {
  const f = await controller(t);
  let reads = 0;
  const ids = [null];
  Object.defineProperty(ids, 0, { get() { return ++reads === 1 ? 'owned' : 'other'; } });
  await invoke(ids, f.config);
  assert.equal(reads, 1, 'validation and normalization must not reread caller elements');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].ids, ['owned']);
});

for (const action of ['wait', 'reconcile']) test(`${action} preserves ordered deduplication of ordinary IDs`, async t => {
  const f = await controller(t), ids = Object.freeze(['B-2', 'a_1', 'B-2', 'last']);
  const observed = observeFileRead(t, f.key);
  let result;
  try { result = await request(action, { ids }, f.config); }
  finally { observed.restore(); }
  assert.equal(observed.evidence.reads, 1, 'valid scope still uses the real credential reader');
  assert.deepEqual(f.calls, [{ method: 'GET', url: `/${action}?id=B-2&id=a_1&id=last`,
    ids: ['B-2', 'a_1', 'last'], authorization: 'Bearer array-input-fixture-key' }]);
  if (action === 'reconcile') assert.deepEqual(result.scope, ['B-2', 'a_1', 'last']);
  else assert.equal(result.settled, true);
  assert.deepEqual(ids, ['B-2', 'a_1', 'B-2', 'last']);
});

test('an explicit full reconciliation remains unscoped', async t => {
  const f = await controller(t);
  const result = await reconcileTasks(f.config);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/reconcile');
  assert.equal(Object.hasOwn(result, 'scope'), false);
});

for (const view of ['text', 'hex']) for (const content of ['', 'abcdef']) {
  test(`${view} rejects sparse ranges before inspecting a ${content ? 'nonempty' : 'zero-byte'} source`, t => {
    const source = join(readFixture(t), 'source.bin'); fs.writeFileSync(source, content);
    const originalStat = fs.lstatSync;
    let stats = 0, error;
    const stat = t.mock.method(fs, 'lstatSync', (path, ...args) => {
      if (path === source) stats++;
      return originalStat(path, ...args);
    });
    const observed = observeFileRead(t, source);
    try { buildArtifactInput({ source, label: 'fixture', view, ranges: Array(1) }); }
    catch (caught) { error = caught; }
    finally { observed.restore(); stat.mock.restore(); }
    assert.equal(error?.code, 'INVALID_ARGUMENT', 'never emit a null window or a late native TypeError');
    assert.equal(stats, 0);
    assert.equal(observed.evidence.opens, 0);
    assert.equal(observed.evidence.reads, 0);
    assert.equal(fs.readFileSync(source, 'utf8'), content);
  });
}

test('artifact ranges capture each numeric bound once before validation and budgeting', t => {
  const source = join(readFixture(t), 'source.bin');
  fs.writeFileSync(source, 'a' + 'b'.repeat(MAX_WINDOW_BYTES + 1));
  let offsets = 0, lengths = 0;
  const range = {
    get offset() { return ++offsets <= 3 ? 0 : 1; },
    get length() { return ++lengths <= 4 ? 1 : MAX_WINDOW_BYTES + 1; },
  };
  const result = buildArtifactInput({ source, label: 'fixture', view: 'text', ranges: [range] });
  assert.equal(result.windows[0].offsetBytes, 0);
  assert.equal(result.windows[0].requestedBytes, 1);
  assert.equal(result.windows[0].content, 'a');
  assert.equal(result.omittedBytes, MAX_WINDOW_BYTES + 1);
  assert.equal(offsets, 1); assert.equal(lengths, 1);
});
