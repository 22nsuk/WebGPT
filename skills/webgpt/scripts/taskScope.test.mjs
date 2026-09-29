// Real loopback requests and disposable state. Work counters are not latency benchmarks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, Server } from 'node:http';
import { once } from 'node:events';
import { start } from './worker.mjs';
import { request } from './client.mjs';
import { callTool, controllerProxy, replyJson } from './test-fixtures/worker-http.mjs';

async function fixture(t, { tasks, countIds = false, now = Date.now } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-scope-')));
  const stateFile = join(dir, 'state.json');
  if (tasks) fs.writeFileSync(stateFile, JSON.stringify(tasks));
  const counter = { ids: 0 };
  let worker, observer;
  t.after(async () => { observer?.mock.restore(); await worker?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  // Count accesses to the actual parsed inventory, without replacing any task values.
  const parse = JSON.parse;
  const watched = countIds ? t.mock.method(JSON, 'parse', function(...args) {
    const value = Reflect.apply(parse, this, args);
    if (Array.isArray(value) && value.length === tasks.length && value[0]?.id === tasks[0].id) {
      for (const task of value) {
        const id = task.id;
        Object.defineProperty(task, 'id', { enumerable: true, configurable: true, get() { counter.ids++; return id; } });
      }
    }
    return value;
  }) : null;
  try { worker = await start({ dir, port: 0, controlPort: 0, waitMs: 55000, closeGraceMs: 50, now }); }
  finally { watched?.mock.restore(); }
  counter.ids = 0;
  const config = { dataDir: dir, controlPort: worker.controlPort };
  const admin = (action, payload) => request(action, payload, config);
  const register = id => admin('register', { id, instructions: 'Scoped fixture only', inputs: { note: 'private fixture' } });
  const submit = async token => {
    const response = await callTool(worker, 'submit_result', { token, status: 'completed', summary: 'done', result: 'result' });
    assert.equal(response.isError, false, response.content[0].text);
  };
  const raw = async (path, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${worker.controlPort}${path}`, {
      headers: { authorization: 'Bearer ' + worker.key, ...headers }, signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, value: await response.json() };
  };
  let accepted;
  const emit = Server.prototype.emit;
  observer = t.mock.method(Server.prototype, 'emit', function(event, ...args) {
    const result = Reflect.apply(emit, this, [event, ...args]);
    if (event === 'request' && this.address()?.port === worker.controlPort && args[0].url.startsWith('/wait'))
      accepted?.(args[1]);
    return result;
  });
  const park = async (ids, signal) => {
    const arrival = new Promise(resolve => { accepted = resolve; });
    const outcome = request('wait', ids ? { ids } : undefined, config, { signal, timeoutMs: 5000 })
      .then(value => ({ value }), error => ({ error }));
    const response = await Promise.race([arrival, outcome.then(() => null)]);
    accepted = undefined;
    assert.ok(response && !response.writableEnded && !response.headersSent, 'wait must actually be parked');
    return { response, outcome };
  };
  return { dir, stateFile, worker, config, admin, register, submit, raw, park, counter };
}
// Node 22's mock.method rejects Array.prototype because it is itself an array.
// Restore the exact descriptor in finally; observe only fixture scope arrays.
function observeMembership(prefix) {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'includes');
  const setDescriptor = Object.getOwnPropertyDescriptor(Set.prototype, 'has');
  let probes = 0, checks = 0;
  Object.defineProperty(Set.prototype, 'has', { ...setDescriptor, value: function(value) {
    if (typeof value === 'string' && value.startsWith(prefix)) checks++;
    return Reflect.apply(setDescriptor.value, this, [value]);
  } });
  Object.defineProperty(Array.prototype, 'includes', { ...descriptor, value: function(...args) {
    if (typeof this[0] !== 'string' || !this[0].startsWith(prefix)) return Reflect.apply(descriptor.value, this, args);
    const counted = new Proxy(this, { get(target, key, receiver) {
      if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) probes++;
      return Reflect.get(target, key, receiver);
    } });
    return Reflect.apply(descriptor.value, counted, args);
  } });
  return { count: () => probes, checks: () => checks, restore() {
    Object.defineProperty(Array.prototype, 'includes', descriptor);
    Object.defineProperty(Set.prototype, 'has', setDescriptor);
  } };
}
const query = ids => new URLSearchParams(ids.map(id => ['id', id]));
const inventory = n => Array.from({ length: n }, (_, i) => ({
  id: 'scope-cost-' + i, status: 'cancelled', collected: true, instructions: '', inputs: {}, changes: [], nextCheck: null,
}));

for (const endpoint of ['wait', 'reconcile']) test(`${endpoint} selects a large scope without nested inventory searches`, async t => {
  const tasks = inventory(1024), ids = tasks.filter((_, i) => i % 4 === 0).map(task => task.id).reverse();
  const f = await fixture(t, { tasks, countIds: true }), before = fs.readFileSync(f.stateFile);
  const membership = observeMembership('scope-cost-');
  let status, value;
  try { ({ status, value } = await f.raw(`/${endpoint}?${query(ids)}`)); }
  finally { membership.restore(); }
  assert.equal(status, 200);
  if (endpoint === 'wait') assert.deepEqual(value, { events: [], backupDue: [], settled: true });
  else {
    assert.deepEqual(value.scope, ids, 'scope echoes request order');
    assert.deepEqual(value.tasks.map(task => task.id), [...ids].reverse(), 'task detail order stays in inventory order');
    assert.equal(value.health.stateVerified, true);
  }
  const observed = f.counter.ids;
  t.diagnostic(JSON.stringify({ endpoint, inventory: tasks.length, requested: ids.length, inventoryIdReads: observed, linearMembershipProbes: membership.count(), setMembershipChecks: membership.checks() }));
  assert.ok(observed <= tasks.length + 4 * ids.length, `unexpected repeated inventory search: ${observed}`);
  assert.ok(membership.count() <= tasks.length, 'scope membership must not multiply inventory and requested-ID scans');
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
});

for (const action of ['wait', 'reconcile']) test(`client ${action} validates a large returned scope without repeated linear membership scans`, async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'webgpt-client-scope-'));
  fs.writeFileSync(join(dir, 'controller.key'), 'fixture-key');
  const ids = Array.from({ length: 256 }, (_, i) => 'client-scope-' + i);
  const value = action === 'wait' ? { settled: false, events: ids.map(id => ({ id })), backupDue: ids,
    recoveryRequired: ids.map(id => ({ id })), resultRecoveryRequired: ids.map(id => ({ id })) }
    : { scope: ids, tasks: [...ids].reverse().map(id => ({ id })) };
  const server = createServer((_req, res) => replyJson(res, value));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const observer = observeMembership('client-scope-');
  let result;
  try { result = await request(action, { ids }, { dataDir: dir, controlPort: server.address().port }); }
  finally { observer.restore(); }
  const probes = observer.count();
  assert.deepEqual(result, value);
  t.diagnostic(JSON.stringify({ action, requested: ids.length, linearMembershipProbes: probes, setMembershipChecks: observer.checks() }));
  assert.ok(probes <= ids.length * 4, 'scope validation must not repeatedly scan the requested array');
});

test('scope order, duplicate IDs and unscoped shape remain compatible across terminal states', async t => {
  const f = await fixture(t), a = await f.register('alpha'), b = await f.register('beta');
  await f.register('gamma');
  await f.submit(a.token); await f.submit(b.token); await f.admin('cancel', { id: 'gamma' });
  const before = fs.readFileSync(f.stateFile);
  for (const ids of [['beta', 'alpha'], ['beta', 'alpha', 'beta']]) {
    const wait = await f.raw(`/wait?${query(ids)}`), reconcile = await f.raw(`/reconcile?${query(ids)}`);
    assert.equal(wait.status, 200); assert.equal(reconcile.status, 200);
    assert.deepEqual(wait.value.events.map(event => event.id), ['alpha', 'beta']);
    assert.equal(wait.value.settled, true); assert.deepEqual(reconcile.value.scope, ['beta', 'alpha']);
    assert.deepEqual(reconcile.value.tasks.map(task => task.id), ['alpha', 'beta']);
  }
  const all = await f.raw('/wait'), status = await f.admin('status'), reconcile = await f.raw('/reconcile');
  assert.deepEqual(all.value, status); assert.equal(Object.hasOwn(all.value, 'settled'), false);
  assert.equal(Object.hasOwn(reconcile.value, 'scope'), false);
  assert.deepEqual(reconcile.value.tasks.map(task => task.id), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
});

test('unknown, case-mismatched and malformed scopes never broaden to all tasks', async t => {
  const f = await fixture(t); await f.register('alpha');
  const before = fs.readFileSync(f.stateFile);
  for (const endpoint of ['wait', 'reconcile']) {
    for (const ids of [['missing'], ['alpha', 'missing'], ['ALPHA'], ['']]) {
      const response = await f.raw(`/${endpoint}?${query(ids)}`);
      assert.equal(response.status, 400); assert.equal(response.value.retryable, false);
      assert.equal(Object.hasOwn(response.value, 'tasks'), false);
      assert.equal(Object.hasOwn(response.value, 'events'), false);
    }
    assert.equal((await f.raw(`/${endpoint}?id=alpha&other=value`)).status, 400);
    assert.equal((await f.raw(`/${endpoint}?id=alpha`, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await f.raw(`/${endpoint}?id=alpha`, { origin: 'https://example.invalid' })).status, 403);
  }
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
});

for (const field of ['events', 'backupDue', 'recoveryRequired', 'resultRecoveryRequired'])
  test(`client still rejects an out-of-scope ${field} entry`, async t => {
    const f = await fixture(t), { token } = await f.register('alpha'); await f.submit(token);
    const proxy = await controllerProxy(f.config, ({ phase, res, data }) => {
      if (phase !== 'after') return false;
      data[field] = field === 'backupDue' ? ['outside'] : [{ id: 'outside' }]; replyJson(res, data); return true;
    });
    try {
      await assert.rejects(request('wait', { ids: ['alpha'] }, { ...f.config, controlPort: proxy.port }), /outside the requested task scope/);
      assert.equal(proxy.actions.length, 1); assert.deepEqual(proxy.failures, []);
    } finally { await proxy.close(); }
  });

for (const problem of ['wrong-scope-order', 'duplicate', 'missing', 'outside'])
  test(`client reconciliation still rejects ${problem} evidence`, async t => {
    const f = await fixture(t); await f.register('alpha'); await f.register('beta');
    const proxy = await controllerProxy(f.config, ({ phase, res, data }) => {
      if (phase !== 'after') return false;
      if (problem === 'wrong-scope-order') data.scope.reverse();
      else if (problem === 'duplicate') data.tasks[1] = data.tasks[0];
      else if (problem === 'missing') data.tasks.pop();
      else data.tasks[1].id = 'outside';
      replyJson(res, data); return true;
    });
    try {
      await assert.rejects(request('reconcile', { ids: ['beta', 'alpha'] }, { ...f.config, controlPort: proxy.port }), /did not confirm task-scoped reconciliation/);
      assert.equal(proxy.actions.length, 1); assert.deepEqual(proxy.failures, []);
    } finally { await proxy.close(); }
  });

test('parked scopes observe current objects after unrelated commits and cancellation', async t => {
  const f = await fixture(t), a = await f.register('alpha'), b = await f.register('beta');
  const selected = await f.park(['alpha', 'alpha']), global = await f.park();
  await f.admin('checked', { id: 'alpha' });
  await f.register('gamma');
  assert.equal(selected.response.writableEnded, false); assert.equal(global.response.writableEnded, false);
  await f.submit(b.token);
  assert.deepEqual((await global.outcome).value.events.map(event => event.id), ['beta']);
  assert.equal(selected.response.writableEnded, false, 'unrelated completion does not finish the scoped wait');
  await f.admin('cancel', { id: 'alpha' });
  assert.deepEqual((await selected.outcome).value, { events: [], backupDue: [], settled: true });
  assert.equal((await callTool(f.worker, 'get_task', { token: a.token })).isError, true);
});

test('unscoped parked waits include tasks registered after parking', async t => {
  const f = await fixture(t); await f.register('alpha');
  const pending = await f.park(); await f.register('beta');
  await f.admin('cancel', { id: 'alpha' });
  assert.equal(pending.response.writableEnded, false);
  await f.admin('cancel', { id: 'beta' });
  assert.deepEqual((await pending.outcome).value, { events: [], backupDue: [] });
});

test('scoped recovery stays fresh while reconciliation health remains global', async t => {
  const f = await fixture(t); await f.register('alpha'); await f.register('beta');
  const pending = join(f.dir, 'beta.result.txt.tmp'); fs.writeFileSync(pending, 'retained candidate');
  const result = await f.admin('reconcile', { ids: ['alpha'] });
  assert.deepEqual(result.tasks.map(task => task.id), ['alpha']);
  assert.deepEqual(result.tasks[0].pendingResults, []);
  assert.deepEqual(result.health.pendingResultTasks, ['beta']);
  assert.ok(result.health.issues.includes('RESULT_RECOVERY_REQUIRED'));
  const wait = await f.admin('wait', { ids: ['beta'] });
  assert.deepEqual(wait.resultRecoveryRequired, [{ id: 'beta' }]);
  assert.equal(wait.settled, false); assert.equal(fs.readFileSync(pending, 'utf8'), 'retained candidate');
});

test('parked scope checks current state before completion instead of reusing a verdict', async t => {
  const f = await fixture(t); await f.register('alpha');
  const wait = await f.park(['alpha']);
  fs.writeFileSync(f.stateFile, 'corrupt evidence');
  await assert.rejects(f.admin('status'), { code: 'STATE_INVALID', retryable: false });
  const { error } = await wait.outcome;
  assert.ok(error, 'unverified parked state must reject, not return a healthy snapshot');
  assert.equal(error.code, 'STATE_INVALID'); assert.equal(error.retryable, false);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), 'corrupt evidence');
});

test('scope selection does not retain disconnected waits or prevent orderly shutdown', async t => {
  const f = await fixture(t); await f.register('alpha');
  const abort = new AbortController(), cancelled = await f.park(['alpha'], abort.signal);
  const closed = once(cancelled.response, 'close'); abort.abort(Error('fixture stop'));
  assert.ok((await cancelled.outcome).error); await closed;
  const pending = await f.park(['alpha']); await f.worker.close();
  const { value } = await pending.outcome;
  assert.equal(value.interrupted, true); assert.deepEqual(value.events, []); assert.equal(value.settled, false);
  const stored = JSON.parse(fs.readFileSync(f.stateFile));
  assert.equal(stored[0].status, 'running'); assert.equal(stored[0].collected, false);
});

test('a parked multi-task scope returns the actual due task after a deadline update', async t => {
  let clock = 1000;
  const f = await fixture(t, { now: () => clock });
  await f.register('alpha'); clock = 2000; await f.register('beta');
  const wait = await f.park(['beta', 'alpha']);
  clock = 901001; await f.admin('checked', { id: 'beta' });
  const { value } = await wait.outcome;
  assert.deepEqual(value.events, []); assert.deepEqual(value.backupDue, ['alpha']);
  assert.equal(value.settled, false);
});
