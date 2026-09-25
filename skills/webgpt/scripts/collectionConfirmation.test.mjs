// Actual loopback controller responses and disposable result files; no live account.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, realpathSync, readFileSync, writeFileSync, unlinkSync, rmSync, mkdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request, collectTask, retryableControllerError } from './client.mjs';
import { start } from './worker.mjs';
import { callTool, controllerProxy, replyJson as reply } from './test-fixtures/worker-http.mjs';

const execute = promisify(execFile);
const resultText = 'Retained result 한국어 🧪\r\nPRIVATE_COLLECTION_FIXTURE';
async function fixture(t, intercept = async () => false, status = 'completed') {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'webgpt-collection-confirm-')));
  let worker, proxy;
  t.after(async () => {
    await proxy?.close();
    await worker?.close(); rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(proxy?.failures ?? [], []);
  });
  worker = await start({ dir, port: 0, controlPort: 0, waitMs: 20 });
  const direct = { dataDir: dir, controlPort: worker.controlPort };
  const admin = (action, payload) => request(action, payload, direct);
  const task = await admin('register', { id: 'owned', instructions: 'fixture', inputs: {} });
  const call = (name, args) => callTool(worker, name, args);
  assert.equal((await call('submit_result', { token: task.token, status, summary: 'done', result: resultText })).isError, false);
  const stateFile = join(dir, 'state.json'), artifact = join(dir, 'owned.result.txt');
  const state = () => JSON.parse(readFileSync(stateFile)).find(t => t.id === 'owned');
  const f = { dir, direct, admin, task, call, stateFile, artifact, state };
  proxy = await controllerProxy(direct, event => intercept({ ...f, ...event }));
  return { ...f, actions: proxy.actions, config: { ...direct, controlPort: proxy.port } };
}
const collectionStart = resume => resume ? ['/reconcile?id=owned'] : ['/wait?id=owned'];
const expectedCalls = [...collectionStart(false), '/collect', '/reconcile?id=owned'];
function unconfirmed(error) {
  assert.equal(error.code, 'COLLECTION_UNCONFIRMED');
  assert.equal(retryableControllerError(error), false);
  assert.ok(!error.message.includes(resultText));
  return true;
}

for (const status of ['completed', 'failed', 'cancelled']) {
  test(`ordinary ${status} collection confirms the outcome and preserves its compact result shape`, async t => {
    const f = await fixture(t, undefined, status);
    const result = await collectTask('owned', f.config);
    assert.deepEqual(result, { id: 'owned', status, summary: 'done', artifact: f.artifact,
      sha256: f.state().sha256, integrity: 'verified', collected: true });
    assert.deepEqual(f.actions, expectedCalls);
    assert.equal(f.state().collected, true); assert.equal(f.state().token, undefined);
    assert.equal(readFileSync(f.artifact, 'utf8'), resultText);
  });
  test(`ordinary ${status} collection does not report success when another parent discards before ack`, async t => {
    const f = await fixture(t, async ({ req, phase, admin }) => {
      if (phase === 'before' && req.url === '/collect') await admin('cancel', { id: 'owned' });
    }, status);
    await assert.rejects(collectTask('owned', f.config), { code: 'COLLECTION_DISCARDED', statusCode: 409 });
    assert.deepEqual(f.actions, expectedCalls.slice(0, -1));
    assert.equal(f.state().collected, true); assert.equal(f.state().discarded, true);
    const resumed = await collectTask('owned', f.direct, { resume: true });
    assert.equal(resumed.disposition, 'discarded'); assert.equal(resumed.integrity, 'verified');
    assert.equal(readFileSync(f.artifact, 'utf8'), resultText);
  });
}

for (const data of [{ ok: false }, {}, { ok: true }]) test(`an uncommitted ack reply ${JSON.stringify(data)} is not collection proof`, async t => {
  const f = await fixture(t, async ({ req, res, phase }) => {
    if (phase === 'before' && req.url === '/collect') { reply(res, data); return true; }
  });
  const before = readFileSync(f.stateFile);
  await assert.rejects(collectTask('owned', f.config), unconfirmed);
  assert.deepEqual(f.actions, expectedCalls);
  assert.deepEqual(readFileSync(f.stateFile), before);
  assert.equal(f.state().collected, false); assert.equal(f.state().token, f.task.token);
  assert.equal((await f.call('get_task', { token: f.task.token })).isError, false);
});

for (const committed of [false, true]) test(`lost ${committed ? 'committed' : 'uncommitted'} ack is observed once without repeating the write`, async t => {
  const f = await fixture(t, async ({ req, res, phase }) => {
    if (req.url === '/collect' && phase === (committed ? 'after' : 'before')) { res.destroy(); return true; }
  });
  if (committed) assert.equal((await collectTask('owned', f.config)).collected, true);
  else await assert.rejects(collectTask('owned', f.config), error => {
    unconfirmed(error); assert.equal(error.acknowledgment, 'unknown'); return true;
  });
  assert.deepEqual(f.actions, expectedCalls);
  assert.equal(f.state().collected, committed);
  assert.equal(readFileSync(f.artifact, 'utf8'), resultText);
});

for (const change of ['missing', 'corrupt']) test(`result bytes ${change} after ack prevent a verified collection report`, async t => {
  const f = await fixture(t, async ({ req, phase, artifact }) => {
    if (phase === 'after' && req.url === '/collect') {
      if (change === 'missing') unlinkSync(artifact); else writeFileSync(artifact, 'different fixture bytes');
    }
  });
  await assert.rejects(collectTask('owned', f.config), unconfirmed);
  assert.deepEqual(f.actions, expectedCalls);
  assert.equal(f.state().collected, true); // Observation does not roll back the real ack.
});

for (const issue of ['unavailable', 'missing-task', 'wrong-status', 'wrong-hash', 'nonboolean-collected', 'invalid-state']) {
  test(`post-ack ${issue} leaves collection unconfirmed without a second ack`, async t => {
    let acknowledged = false;
    const f = await fixture(t, async ({ req, res, phase, data, stateFile }) => {
      if (req.url === '/collect' && phase === 'after') acknowledged = true;
      if (issue === 'invalid-state' && phase === 'after' && req.url === '/collect') writeFileSync(stateFile, '[]');
      // Exercise the post-ack observation, not the new pre-ack recovery check.
      if (req.url !== '/reconcile?id=owned' || !acknowledged) return;
      if (issue === 'unavailable' && phase === 'before') { reply(res, { error: 'fixture unavailable' }, 503); return true; }
      if (phase !== 'after') return;
      if (issue === 'missing-task') data.tasks = [];
      if (issue === 'wrong-status') data.tasks[0].status = 'failed';
      if (issue === 'wrong-hash') data.tasks[0].sha256 = '0'.repeat(64);
      if (issue === 'nonboolean-collected') data.tasks[0].collected = 'false';
      reply(res, data); return true;
    });
    await assert.rejects(collectTask('owned', f.config), unconfirmed);
    assert.deepEqual(f.actions, expectedCalls);
    assert.equal(readFileSync(f.artifact, 'utf8'), resultText);
  });
}

test('known ack storage failures remain direct errors and do not trigger outcome probes or retries', async t => {
  const f = await fixture(t); mkdirSync(join(f.dir, 'state.json.tmp'));
  const before = readFileSync(f.stateFile);
  await assert.rejects(collectTask('owned', f.config), { statusCode: 503, code: 'STATE_STAGING_CONFLICT' });
  assert.deepEqual(f.actions, [...collectionStart(false), '/collect']);
  assert.deepEqual(readFileSync(f.stateFile), before); assert.equal(f.state().token, f.task.token);
});

for (const resume of [false, true]) test(`${resume ? 'resumed' : 'ordinary'} collection preserves an explicit SHUTTING_DOWN ack rejection`, async t => {
  const rejection = { error: 'worker is stopping', code: 'SHUTTING_DOWN', retryable: true };
  const f = await fixture(t, async ({ req, res, phase }) => {
    if (phase === 'before' && req.url === '/collect') { reply(res, rejection, 503); return true; }
  });
  const before = readFileSync(f.stateFile);
  await assert.rejects(collectTask('owned', f.config, { resume }), error => {
    assert.equal(error.statusCode, 503); assert.equal(error.code, 'SHUTTING_DOWN');
    assert.equal(error.message, rejection.error); assert.deepEqual(error.details, rejection);
    assert.equal(error.retryable, true); assert.equal(retryableControllerError(error), true);
    return true;
  });
  assert.deepEqual(f.actions, [...collectionStart(resume), '/collect']);
  assert.deepEqual(readFileSync(f.stateFile), before);
  assert.equal(f.state().collected, false); assert.equal(f.state().token, f.task.token);
  assert.equal(readFileSync(f.artifact, 'utf8'), resultText);
});

test('an explicit abort during ack stops collection without another HTTP request', async t => {
  const controller = new AbortController();
  const f = await fixture(t, async ({ req, res, phase }) => {
    if (phase === 'before' && req.url === '/collect') { controller.abort(); res.destroy(); return true; }
  });
  await assert.rejects(collectTask('owned', f.config, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(f.actions, [...collectionStart(false), '/collect']); assert.equal(f.state().collected, false);
});

for (const resume of [false, true]) for (const custom of [false, true]) {
  test(`${resume ? 'resumed' : 'ordinary'} collection preserves ${custom ? 'custom' : 'default'} aborts during post-ack reconciliation`, async t => {
    const controller = new AbortController();
    const reason = custom ? Error('explicit fixture cancellation') : undefined;
    let committedState;
    const f = await fixture(t, async ({ req, res, phase, stateFile }) => {
      if (phase === 'after' && req.url === '/collect') committedState = readFileSync(stateFile);
      if (phase === 'before' && req.url === '/reconcile?id=owned' && committedState && !controller.signal.aborted) {
        controller.abort(reason); res.destroy(); return true;
      }
    });
    await assert.rejects(collectTask('owned', f.config, { resume, signal: controller.signal }),
      error => error === controller.signal.reason);
    assert.deepEqual(f.actions, [...collectionStart(resume), '/collect', '/reconcile?id=owned']);
    assert.deepEqual(readFileSync(f.stateFile), committedState);
    assert.equal(f.state().collected, true); assert.equal(f.state().token, undefined);
    assert.equal(readFileSync(f.artifact, 'utf8'), resultText);
    // Aborting observation does not undo acknowledgment; a later explicit resume
    // verifies the retained result without another write.
    const recovered = await collectTask('owned', f.config, { resume: true });
    assert.equal(recovered.disposition, 'already_collected'); assert.equal(recovered.integrity, 'verified');
    assert.deepEqual(f.actions, [...collectionStart(resume), '/collect', '/reconcile?id=owned', '/reconcile?id=owned']);
    assert.deepEqual(readFileSync(f.stateFile), committedState);
  });
}

test('ordinary collection remains strict on already retired results while explicit resume is read-only', async t => {
  const f = await fixture(t); await f.admin('ack', { id: 'owned' });
  const before = readFileSync(f.stateFile);
  await assert.rejects(collectTask('owned', f.config), /no uncollected result/);
  assert.deepEqual(f.actions, ['/wait?id=owned']);
  assert.equal((await collectTask('owned', f.config, { resume: true })).disposition, 'already_collected');
  assert.deepEqual(f.actions, ['/wait?id=owned', '/reconcile?id=owned']);
  assert.deepEqual(readFileSync(f.stateFile), before);
});

for (const scenario of ['discarded', 'unconfirmed']) test(`ordinary collection CLI reports ${scenario} without false success or private output`, async t => {
  const f = await fixture(t, async ({ req, res, phase, admin }) => {
    if (phase !== 'before' || req.url !== '/collect') return;
    if (scenario === 'discarded') await admin('cancel', { id: 'owned' });
    else { reply(res, {}); return true; }
  });
  const file = join(f.dir, 'config.json'); writeFileSync(file, JSON.stringify(f.config));
  await assert.rejects(execute(process.execPath, [fileURLToPath(new URL('./client.mjs', import.meta.url)), 'collect', 'owned'], {
    env: { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: f.dir }, windowsHide: true, timeout: 10000,
  }), error => {
    assert.equal(error.code, 1); assert.equal(error.stdout, '');
    const diagnostic = JSON.parse(error.stderr.trim().replace(/^WebGPT: /, ''));
    assert.equal(diagnostic.code, scenario === 'discarded' ? 'COLLECTION_DISCARDED' : 'COLLECTION_UNCONFIRMED');
    for (const secret of [f.dir, f.task.token, 'PRIVATE_COLLECTION_FIXTURE']) assert.ok(!error.stderr.includes(secret));
    return true;
  });
  assert.deepEqual(f.actions, scenario === 'discarded' ? expectedCalls.slice(0, -1) : expectedCalls);
});


// Inject native read failures, not a fabricated reconciliation body. Restore the
// binding explicitly so cleanup and independent evidence reads are unaffected.
function failStateRead(t, path, enabled = () => true) {
  const read = fs.readFileSync;
  const mock = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === path && enabled()) throw Object.assign(Error('PRIVATE_STATE_READ_FAILURE'), { code: 'EIO' });
    return read(file, ...args);
  });
  syncBuiltinESMExports();
  return () => { mock.mock.restore(); syncBuiltinESMExports(); };
}

for (const filename of ['state.json', 'state.initialized']) {
  test(`resume needs current ${filename} evidence before interpreting any collection disposition`, async t => {
    for (const disposition of ['uncollected', 'collected', 'discarded', 'cancelled_without_result']) {
      const f = await fixture(t);
      let id = 'owned';
      if (disposition === 'collected') await collectTask(id, f.direct);
      if (disposition === 'discarded') await f.admin('cancel', { id });
      if (disposition === 'cancelled_without_result') {
        id = 'abandoned';
        await f.admin('register', { id, instructions: 'cancel without a result', inputs: {} });
        await f.admin('cancel', { id });
      }
      const before = readFileSync(f.stateFile), marker = readFileSync(join(f.dir, 'state.initialized'));
      const restore = failStateRead(t, join(f.dir, filename));
      try {
        const snapshot = await f.admin('reconcile', { ids: [id] });
        assert.equal(snapshot.health.stateVerified, false);
        assert.equal(snapshot.health.storage.code, 'EIO');
        assert.ok(!snapshot.health.issues.includes('STATE_INVALID'), 'read error is not invalid-state evidence');
        await assert.rejects(collectTask(id, f.config, { resume: true }), unconfirmed);
        assert.deepEqual(f.actions, ['/reconcile?id=' + id], 'no write, retry or broader observation');
      } finally { restore(); }
      assert.deepEqual(readFileSync(f.stateFile), before);
      assert.deepEqual(readFileSync(join(f.dir, 'state.initialized')), marker);
      assert.equal(readFileSync(f.artifact, 'utf8'), resultText);
      // A fresh state check can succeed despite the sticky storage diagnostic.
      if (disposition !== 'uncollected') {
        const result = await collectTask(id, f.config, { resume: true });
        assert.equal(result.health.stateVerified, true); assert.equal(result.health.ok, false);
        assert.equal(result.disposition, disposition === 'collected' ? 'already_collected' : disposition);
        assert.deepEqual(readFileSync(f.stateFile), before);
      }
    }
  });
}

for (const resume of [false, true]) test(`${resume ? 'resumed' : 'ordinary'} collection cannot confirm an ack while its state is unreadable`, async t => {
  let committed, armed = false;
  const f = await fixture(t, ({ phase, req, stateFile }) => {
    if (phase === 'after' && req.url === '/collect') { committed = readFileSync(stateFile); armed = true; }
  });
  const restore = failStateRead(t, f.stateFile, () => armed);
  try {
    await assert.rejects(collectTask('owned', f.config, { resume }), error => {
      unconfirmed(error); assert.equal(error.acknowledgment, 'accepted'); return true;
    });
    assert.deepEqual(f.actions, [...collectionStart(resume), '/collect', '/reconcile?id=owned']);
  } finally { restore(); }
  assert.deepEqual(readFileSync(f.stateFile), committed);
  assert.equal(f.state().collected, true); assert.equal(f.state().token, undefined);
  assert.equal(readFileSync(f.artifact, 'utf8'), resultText);
  const observed = await collectTask('owned', f.config, { resume: true });
  assert.equal(observed.disposition, 'already_collected');
  assert.deepEqual(f.actions, [...collectionStart(resume), '/collect', '/reconcile?id=owned', '/reconcile?id=owned']);
  assert.deepEqual(readFileSync(f.stateFile), committed, 'observation cannot repeat or roll back the ack');
});

test('missing or nonboolean current-state proof cannot certify legacy or partial controller replies', async t => {
  let proof;
  const f = await fixture(t, ({ phase, req, data, res }) => {
    if (phase !== 'after' || req.url !== '/reconcile?id=owned') return;
    if (proof === undefined) delete data.health.stateVerified; else data.health.stateVerified = proof;
    reply(res, data); return true;
  });
  await collectTask('owned', f.direct);
  const before = readFileSync(f.stateFile);
  for (proof of [undefined, false, null, 'true', 1])
    await assert.rejects(collectTask('owned', f.config, { resume: true }), unconfirmed);
  assert.deepEqual(f.actions, Array(5).fill('/reconcile?id=owned'));
  assert.deepEqual(readFileSync(f.stateFile), before);
});

test('unrelated readiness failures do not prevent collection backed by freshly verified state', async t => {
  const f = await fixture(t);
  await f.admin('register', { id: 'other', instructions: 'unrelated task', inputs: {} });
  const candidate = join(f.dir, 'other.result.txt.tmp'); writeFileSync(candidate, 'preserve unrelated evidence');
  assert.equal((await collectTask('owned', f.config)).collected, true);
  const before = readFileSync(f.stateFile), observed = await collectTask('owned', f.config, { resume: true });
  assert.equal(observed.disposition, 'already_collected');
  assert.equal(observed.health.ok, false); assert.equal(observed.health.stateVerified, true);
  assert.deepEqual(f.actions, [...expectedCalls, '/reconcile?id=owned']);
  assert.deepEqual(readFileSync(f.stateFile), before);
  assert.equal(readFileSync(candidate, 'utf8'), 'preserve unrelated evidence');
});

test('unverified-state resume CLI fails without a successful disposition or private diagnostic text', async t => {
  const f = await fixture(t); await collectTask('owned', f.direct);
  const file = join(f.dir, 'config.json'); writeFileSync(file, JSON.stringify(f.config));
  const before = readFileSync(f.stateFile), restore = failStateRead(t, f.stateFile);
  try {
    await assert.rejects(execute(process.execPath, [fileURLToPath(new URL('./client.mjs', import.meta.url)), 'collect', '--resume', 'owned'], {
      env: { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: f.dir }, windowsHide: true, timeout: 10000,
    }), error => {
      assert.equal(error.code, 1); assert.equal(error.stdout, '');
      const diagnostic = JSON.parse(error.stderr.trim().replace(/^WebGPT: /, ''));
      assert.equal(diagnostic.code, 'COLLECTION_UNCONFIRMED');
      assert.deepEqual(Object.keys(diagnostic).sort(), ['code', 'message']);
      for (const secret of [f.dir, f.task.token, 'PRIVATE_STATE_READ_FAILURE', resultText]) assert.ok(!error.stderr.includes(secret));
      return true;
    });
  } finally { restore(); }
  assert.deepEqual(f.actions, ['/reconcile?id=owned']);
  assert.deepEqual(readFileSync(f.stateFile), before);
});
