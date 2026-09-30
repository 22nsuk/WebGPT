// Real parked HTTP requests; filesystem faults affect only disposable state files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'node:http';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { start } from './worker.mjs';
import { request, collectTask } from './client.mjs';
import { callTool } from './test-fixtures/worker-http.mjs';
import { observeFileRead } from './test-fixtures/file-read.mjs';

async function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-wait-wake-')));
  const worker = await start({ dir, port: 0, controlPort: 0, waitMs: 55000, closeGraceMs: 50 });
  const config = { dataDir: dir, controlPort: worker.controlPort }, pending = [];
  t.after(async () => {
    await worker.close(); await Promise.allSettled(pending);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const admin = (action, payload) => request(action, payload, config);
  const register = id => admin('register', { id, instructions: 'Retain instructions', inputs: { sample: 'Retain input 한국어' } });
  const emit = Server.prototype.emit;
  let accepted;
  const observer = t.mock.method(Server.prototype, 'emit', function(event, ...args) {
    const result = Reflect.apply(emit, this, [event, ...args]);
    // A GET handler installs the waiter synchronously; do not sleep to guess it.
    if (event === 'request' && this.address()?.port === worker.controlPort && args[0].url.startsWith('/wait'))
      accepted?.(args[1]);
    return result;
  });
  t.after(() => observer.mock.restore());
  const park = async (ids, signal) => {
    const arrived = new Promise(resolve => { accepted = resolve; });
    const outcome = request('wait', ids === undefined ? undefined : { ids }, config, { signal, timeoutMs: 5000 })
      .then(value => ({ value }), error => ({ error }));
    pending.push(outcome);
    const response = await Promise.race([arrived, outcome.then(() => null)]);
    accepted = undefined;
    assert.ok(response && !response.headersSent && !response.writableEnded, 'request must be parked before the trigger');
    return { response, outcome };
  };
  const submit = token => callTool(worker, 'submit_result', { token, status: 'completed', summary: 'done', result: 'Result 한국어' });
  return { dir, worker, config, admin, register, park, submit, stateFile: join(dir, 'state.json') };
}
// Observe each actual opened state descriptor, not readFileSync(path): state
// materialization deliberately uses readFileSync(fd). Keep faults file-scoped.
async function withStateReads(t, file, afterStat, run) {
  const trace = observeFileRead(t, file, { afterStat });
  try { return await run(); }
  finally {
    trace.restore();
    assert.equal(trace.evidence.opens, trace.evidence.closes, 'state descriptors close even on failed observations');
  }
}
const ioError = () => Object.assign(Error('fixture state read failed'), { code: 'EIO' });

for (const count of [1, 8, 32]) test(`persistent storage error visits each of ${count} parked waits only once`, async t => {
  const f = await fixture(t), task = await f.register('owned'), waits = [];
  for (let i = 0; i < count; i++) waits.push(await f.park(i % 2 ? undefined : ['owned']));
  const before = fs.readFileSync(f.stateFile);
  let reads = 0;
  await withStateReads(t, f.stateFile, () => { reads++; throw ioError(); }, async () => {
    await assert.rejects(f.admin('status'), { code: 'EIO', statusCode: 503 });
    assert.ok(waits.every(wait => wait.response.writableEnded), 'all responses end during notification, not at their timers');
    for (const { outcome } of waits) {
      const { error } = await outcome;
      assert.equal(error?.code, 'EIO'); assert.equal(error.statusCode, 503); assert.equal(error.retryable, false);
    }
    assert.equal(reads, count + 1, 'one trigger check plus one fresh check for every waiter');
  });
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
  assert.equal((await callTool(f.worker, 'read_input', { token: task.token, name: 'sample' })).isError, false);
  // A successful canary does not erase a failed real read/write observation.
  await assert.rejects(f.admin('ready'), error => error.details.issues.includes('STORAGE_UNAVAILABLE'));
  await f.admin('checked', { id: 'owned' });
  assert.equal((await f.admin('ready')).ok, true);
  const fresh = await f.park(['owned']);
  assert.equal((await f.submit(task.token)).isError, false);
  assert.deepEqual((await fresh.outcome).value.events.map(event => event.id), ['owned']);
  assert.equal((await collectTask('owned', f.config)).collected, true);
});

test('a nested storage notification also revisits an earlier unrelated waiter that re-parked', async t => {
  const f = await fixture(t); await f.register('owned');
  const waits = [];
  for (let i = 0; i < 3; i++) waits.push(await f.park(['owned']));
  const rename = fs.renameSync;
  let published = false, reads = 0;
  const publication = t.mock.method(fs, 'renameSync', (from, to) => {
    const result = rename(from, to);
    if (to === f.stateFile) published = true;
    return result;
  });
  syncBuiltinESMExports();
  try {
    await withStateReads(t, f.stateFile, () => {
      // Begin after real registration publication, then fail only the second
      // waiter's fresh state check. The first has already re-parked quietly.
      if (published && ++reads === 2) throw ioError();
    }, async () => {
      await f.register('unrelated');
      assert.ok(waits.every(wait => wait.response.writableEnded), 'nested notification must not be dropped');
      const outcomes = await Promise.all(waits.map(wait => wait.outcome));
      assert.equal(outcomes[1].error?.code, 'EIO');
      for (const index of [0, 2]) {
        assert.equal(outcomes[index].value?.interrupted, true);
        assert.deepEqual(outcomes[index].value.events, []);
      }
      assert.equal(reads, 4, 'three initial observations, then the one re-parked waiter');
    });
  } finally { publication.mock.restore(); syncBuiltinESMExports(); }
  const stored = JSON.parse(fs.readFileSync(f.stateFile));
  assert.deepEqual(stored.map(task => task.id), ['owned', 'unrelated']);
  assert.ok(stored.every(task => !task.collected && task.token && task.inputs.sample));
});

test('healthy notifications keep scopes quiet and later completion remains observable', async t => {
  const f = await fixture(t), a = await f.register('a'), b = await f.register('b');
  const first = await f.park(['a']), second = await f.park(['b']);
  await f.admin('checked', { id: 'a' });
  assert.equal(first.response.writableEnded, false); assert.equal(second.response.writableEnded, false);
  assert.equal((await f.submit(a.token)).isError, false);
  assert.deepEqual((await first.outcome).value.events.map(event => event.id), ['a']);
  assert.equal(second.response.writableEnded, false, 'unrelated completion must not finish this wait');
  assert.equal((await collectTask('a', f.config)).collected, true);
  assert.equal(second.response.writableEnded, false);
  assert.equal((await f.submit(b.token)).isError, false);
  assert.deepEqual((await second.outcome).value.events.map(event => event.id), ['b']);
});

test('a disconnected wait is removed before a later storage notification', async t => {
  const f = await fixture(t); await f.register('owned');
  const abort = new AbortController(), cancelled = await f.park(['owned'], abort.signal), remaining = await f.park(['owned']);
  const closed = once(cancelled.response, 'close'); abort.abort();
  assert.ok((await cancelled.outcome).error); await closed;
  let reads = 0;
  await withStateReads(t, f.stateFile, () => { reads++; throw ioError(); }, async () => {
    await assert.rejects(f.admin('status'), { code: 'EIO' });
    assert.equal((await remaining.outcome).error?.code, 'EIO');
    assert.equal(reads, 2, 'no fresh observation for the disconnected waiter');
  });
});

test('shutdown drains failed waits without recursive reads and retains restartable task state', async t => {
  const f = await fixture(t), task = await f.register('owned'), waits = [];
  for (let i = 0; i < 8; i++) waits.push(await f.park(['owned']));
  const before = fs.readFileSync(f.stateFile); let reads = 0;
  await withStateReads(t, f.stateFile, () => { reads++; throw ioError(); }, async () => {
    await f.worker.close();
    for (const wait of waits) assert.equal((await wait.outcome).error?.code, 'EIO');
    assert.equal(reads, waits.length);
  });
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
  assert.equal(fs.existsSync(join(f.dir, 'worker.lock')), false);
  const restarted = await start({ dir: f.dir, port: 0, controlPort: 0 });
  try {
    assert.equal((await callTool(restarted, 'get_task', { token: task.token })).structuredContent.status, 'running');
  } finally { await restarted.close(); }
});
