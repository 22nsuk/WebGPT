// Real loopback worker and disposable retained results; no timing thresholds or cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { start } from './worker.mjs';
import { collectTask, reconcileTasks, request } from './client.mjs';
import * as resultFiles from './results.mjs';
import { callTool } from './test-fixtures/worker-http.mjs';

const text = '\uFEFFRetained 한국어 🧪\r\n';
const sha256 = createHash('sha256').update(text).digest('hex');
async function fixture(t, { count = 8, status = 'completed', collected = false, discarded = false, artifact = true, recovery = false, running = [] } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-collection-reads-')));
  let worker;
  t.after(async () => { await worker?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const path = id => join(dir, id + '.result.txt');
  const tasks = Array.from({ length: count }, (_, index) => {
    const id = index === 0 ? 'owned' : 'retained-' + index;
    const active = running.includes(index), saved = !active && (index !== 0 || artifact);
    if (saved) fs.writeFileSync(path(id), text, { mode: 0o600 });
    const changes = [];
    if (recovery) {
      const operation = randomUUID(), directory = join(dir, 'recovery', id);
      fs.mkdirSync(directory, { recursive: true });
      const backup = join(directory, operation + '.before.txt'); fs.writeFileSync(backup, text);
      const receipt = { operation, path: 'notes.txt', action: 'edit', beforeSha256: sha256, afterSha256: sha256, backup };
      fs.writeFileSync(join(directory, operation + '.json'), JSON.stringify({ ...receipt, state: 'applied' }));
      changes.push(receipt);
    }
    return { id, instructions: '', inputs: {}, status: active ? 'running' : index === 0 ? status : 'completed',
      collected: active ? false : index === 0 ? collected : true, ...(index === 0 && discarded ? { discarded } : {}),
      ...(active ? { token: 'fixture-active-' + id } : index === 0 && !collected ? { token: 'fixture-only-owned-token' } : {}),
      summary: 'done', nextCheck: active ? Date.now() + 900000 : null, changes, ...(saved ? { artifact: path(id), sha256 } : {}) };
  });
  fs.writeFileSync(join(dir, 'state.json'), JSON.stringify(tasks), { mode: 0o600 });
  worker = await start({ dir, port: 0, controlPort: 0, configFile: join(dir, 'config.json'), waitMs: 20 });
  const config = { dataDir: dir, controlPort: worker.controlPort };
  return { dir, worker, config, path, tasks, state: () => fs.readFileSync(join(dir, 'state.json')) };
}
async function observeReads(t, f, run) {
  const original = { open: fs.openSync, read: fs.readSync, close: fs.closeSync };
  const descriptors = new Map(), reads = [], artifacts = new Set(f.files ?? f.tasks.map(task => f.path(task.id)));
  const mocks = [
    t.mock.method(fs, 'openSync', (file, ...args) => {
      const fd = original.open(file, ...args);
      if (artifacts.has(file)) { const entry = { file, bytes: 0 }; reads.push(entry); descriptors.set(fd, entry); }
      return fd;
    }),
    t.mock.method(fs, 'readSync', (fd, ...args) => {
      const bytes = original.read(fd, ...args);
      if (descriptors.has(fd)) descriptors.get(fd).bytes += bytes;
      return bytes;
    }),
    t.mock.method(fs, 'closeSync', fd => { descriptors.delete(fd); return original.close(fd); }),
  ];
  syncBuiltinESMExports();
  try { await run(reads); }
  finally { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(descriptors.size, 0, 'measured result descriptors are closed');
  return reads;
}
const expectedReads = (f, count) => Array.from({ length: count }, () => ({ file: f.path('owned'), bytes: Buffer.byteLength(text) }));

for (const count of [1, 8]) for (const status of ['completed', 'failed', 'cancelled']) {
  test(`ordinary ${status} collection reads only its result: two client verifications and one guarded controller verification with ${count} saved tasks`, async t => {
    const f = await fixture(t, { count, status });
    const reads = await observeReads(t, f, async () => {
      assert.deepEqual(await collectTask('owned', f.config), { id: 'owned', status, summary: 'done',
        artifact: f.path('owned'), sha256, integrity: 'verified', collected: true });
    });
    assert.deepEqual(reads, expectedReads(f, 3));
    const stored = JSON.parse(f.state());
    assert.equal(stored[0].token, undefined); assert.equal(stored[0].collected, true);
    assert.equal(fs.readFileSync(f.path('owned'), 'utf8'), text);
  });
}

for (const disposition of ['uncollected', 'already_collected', 'discarded']) {
  test(`resume ${disposition} verifies only the selected result once per observation`, async t => {
    const collected = disposition !== 'uncollected';
    const f = await fixture(t, { collected, discarded: disposition === 'discarded' }), before = f.state();
    const reads = await observeReads(t, f, async () => {
      const result = await collectTask('owned', f.config, { resume: true });
      assert.equal(result.disposition, collected ? disposition : 'collected');
      assert.equal(result.integrity, 'verified'); assert.equal(result.browserChecked, false);
      assert.equal(result.attention, 'already_collected_or_cancelled');
      assert.equal(result.health.ok, true);
    });
    assert.deepEqual(reads, expectedReads(f, collected ? 1 : 3));
    if (collected) assert.deepEqual(f.state(), before, 'retired-result inspection is read-only');
  });
}

for (const resume of [false, true]) test(`${resume ? 'resume' : 'ordinary'} collection does not audit unrelated result bytes; full reconciliation still does`, async t => {
  const f = await fixture(t);
  fs.unlinkSync(f.path('retained-1')); fs.writeFileSync(f.path('retained-2'), 'different bytes');
  const reads = await observeReads(t, f, async () => assert.equal((await collectTask('owned', f.config, { resume })).collected, true));
  assert.deepEqual(reads, expectedReads(f, 3));
  let snapshot;
  const fullReads = await observeReads(t, f, async () => { snapshot = await reconcileTasks(f.config); });
  assert.equal(snapshot.tasks.length, 8); assert.equal(snapshot.browserChecked, false);
  assert.equal(snapshot.tasks.find(t => t.id === 'retained-1').integrity, 'missing');
  assert.equal(snapshot.tasks.find(t => t.id === 'retained-2').integrity, 'mismatch_or_unreadable');
  assert.equal(snapshot.tasks.find(t => t.id === 'retained-2').attention, 'inspect_result');
  assert.equal(fullReads.length, 7); assert.equal(new Set(fullReads.map(r => r.file)).size, 7);
});

for (const issue of ['journal', 'pending-result']) test(`target ${issue} attention still blocks resume before acknowledgment`, async t => {
  const f = await fixture(t), before = f.state();
  if (issue === 'journal') {
    const recovery = join(f.dir, 'recovery', 'owned'); fs.mkdirSync(recovery, { recursive: true });
    fs.writeFileSync(join(recovery, 'unresolved.json'), '{}');
  } else fs.writeFileSync(f.path('owned') + '.tmp', text);
  const reads = await observeReads(t, f, async () => {
    await assert.rejects(collectTask('owned', f.config, { resume: true }), error => {
      assert.equal(error.code, 'COLLECTION_RECOVERY_REQUIRED');
      assert.equal(error.attention, issue === 'journal' ? 'inspect_recovery' : 'inspect_uncommitted_result');
      return true;
    });
  });
  assert.deepEqual(reads, expectedReads(f, 1)); assert.deepEqual(f.state(), before);
});

test('cancelled task without a result requires no result-file reads on resume', async t => {
  const f = await fixture(t, { status: 'cancelled', collected: true, artifact: false });
  const before = f.state();
  const reads = await observeReads(t, f, async () => {
    const result = await collectTask('owned', f.config, { resume: true });
    assert.equal(result.disposition, 'cancelled_without_result'); assert.equal(result.integrity, 'not_expected');
  });
  assert.deepEqual(reads, []); assert.deepEqual(f.state(), before);
});

test('resume rejects invalid shared state before reading result bytes', async t => {
  const f = await fixture(t); fs.writeFileSync(join(f.dir, 'state.json'), '[]');
  const reads = await observeReads(t, f, () => assert.rejects(collectTask('owned', f.config, { resume: true }), { code: 'STATE_INVALID' }));
  assert.deepEqual(reads, []);
});

test('target verification is fresh on later resume and full reconciliation remains diagnostic', async t => {
  const f = await fixture(t); await collectTask('owned', f.config);
  const before = f.state(); fs.writeFileSync(f.path('owned'), 'changed after collection');
  await assert.rejects(collectTask('owned', f.config, { resume: true }), { code: 'RESULT_INVALID' });
  const snapshot = await reconcileTasks(f.config);
  assert.equal(snapshot.tasks.find(t => t.id === 'owned').integrity, 'mismatch_or_unreadable');
  assert.deepEqual(f.state(), before);
  assert.equal((await request('tasks', undefined, f.config)).running, 0);
});

// Reuse the same reader instrumentation for retained originals as for results.
const originals = f => ({ ...f, path: id => f.tasks.find(task => task.id === id).changes[0].backup });
for (const mode of ['ordinary', 'resume', 'retired']) test(`${mode} collection does not read unrelated retained original backups`, async t => {
  const f = await fixture(t, { recovery: true, collected: mode === 'retired' });
  const measured = originals(f), before = f.state();
  const reads = await observeReads(t, measured, async () => {
    const result = await collectTask('owned', f.config, { resume: mode !== 'ordinary' });
    assert.equal(result.collected, true); assert.equal(result.integrity, 'verified');
  });
  assert.deepEqual(reads, expectedReads(measured, mode === 'ordinary' ? 2 : mode === 'resume' ? 3 : 1));
  if (mode === 'retired') assert.deepEqual(f.state(), before);
});

test('scoped reconciliation is read-only, deduplicates IDs and preserves global health and full diagnostics', async t => {
  const f = await fixture(t, { recovery: true, collected: true });
  await request('register', { id: 'active', instructions: '', inputs: {} }, f.config);
  fs.writeFileSync(f.path('active') + '.tmp', 'pending evidence');
  fs.writeFileSync(originals(f).path('retained-2'), 'corrupted original');
  const before = f.state();
  const reads = await observeReads(t, originals(f), async () => {
    const selected = await reconcileTasks(f.config, { ids: ['owned', 'retained-1', 'owned'] });
    assert.deepEqual(selected.scope, ['owned', 'retained-1']);
    assert.deepEqual(selected.tasks.map(task => task.id), ['owned', 'retained-1']);
    assert.ok(selected.tasks.every(task => task.integrity === 'verified'));
    assert.equal(selected.browserChecked, false);
    assert.ok(selected.health.issues.includes('RESULT_RECOVERY_REQUIRED'), 'unrelated active-task health remains visible');
  });
  assert.deepEqual(reads.map(read => read.file), ['owned', 'retained-1'].map(originals(f).path));
  assert.deepEqual(f.state(), before);
  const full = await reconcileTasks(f.config);
  assert.equal(full.scope, undefined); assert.equal(full.tasks.length, 9);
  assert.equal(full.tasks.find(task => task.id === 'retained-2').attention, 'inspect_recovery');
});

test('scoped reconciliation rejects invalid requests and missing, widened or duplicate response scopes', async t => {
  const f = await fixture(t, { collected: true }), before = f.state();
  const url = `http://127.0.0.1:${f.config.controlPort}/reconcile`;
  const headers = { authorization: 'Bearer ' + fs.readFileSync(join(f.dir, 'controller.key'), 'utf8') };
  assert.equal((await fetch(url + '?id=owned')).status, 401);
  for (const query of ['?id=', '?id=../other', '?id=missing', '?other=owned', '?id=owned&other=1'])
    assert.equal((await fetch(url + query, { headers })).status, 400);
  const valid = await request('reconcile', { ids: ['owned'] }, f.config);
  for (const bad of [
    { ...valid, scope: undefined }, { ...valid, scope: ['retained-1'] },
    { ...valid, tasks: [] }, { ...valid, tasks: [valid.tasks[0], valid.tasks[0]] },
    { ...valid, tasks: [{ ...valid.tasks[0], id: 'retained-1' }] },
  ]) {
    let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify(bad)); });
    try { await assert.rejects(request('reconcile', { ids: ['owned'] }, f.config), /task-scoped reconciliation/); }
    finally { mock.mock.restore(); }
    assert.equal(calls, 1, 'no automatic full-scope fallback');
  }
  await assert.rejects(request('reconcile', { ids: [] }, f.config));
  assert.deepEqual(f.state(), before);
});

test('reconcile CLI accepts task IDs without collecting or exposing private inputs', async t => {
  const f = await fixture(t);
  const privateTask = await request('register', { id: 'private', instructions: 'PRIVATE_RECONCILIATION_INSTRUCTION',
    inputs: { sample: 'PRIVATE_RECONCILIATION_INPUT' } }, f.config);
  const before = f.state();
  const file = join(f.dir, 'config.json'); fs.writeFileSync(file, JSON.stringify(f.config));
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('./client.mjs', import.meta.url)), 'reconcile', 'owned', 'private'], {
      env: { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: f.dir }, windowsHide: true, timeout: 10000,
    });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.scope, ['owned', 'private']); assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].integrity, 'verified'); assert.equal(result.browserChecked, false);
  assert.equal(result.tasks[1].integrity, 'not_expected');
  for (const secret of ['fixture-only-owned-token', privateTask.token, 'PRIVATE_RECONCILIATION_INSTRUCTION', 'PRIVATE_RECONCILIATION_INPUT'])
    assert.ok(!stdout.includes(secret));
  assert.deepEqual(f.state(), before);
});


// Health and detail share one fresh journal observation within a reconcile response,
// not across requests or across collection's pre/post-commit checks.
for (const scope of ['full', 'active', 'retired']) test(`${scope} reconciliation reads each required recovery history exactly once`, async t => {
  const f = await fixture(t, { count: 4, recovery: true, running: [0, 1], collected: true });
  const measured = originals(f), before = f.state();
  const ids = scope === 'full' ? undefined : [scope === 'active' ? 'owned' : 'retained-2'];
  const expected = scope === 'full' ? f.tasks : f.tasks.slice(0, scope === 'active' ? 2 : 3);
  for (let attempt = 0; attempt < 2; attempt++) {
    let snapshot;
    const reads = await observeReads(t, measured, async () => { snapshot = await reconcileTasks(f.config, { ids }); });
    assert.deepEqual(reads, expected.map(task => ({ file: measured.path(task.id), bytes: Buffer.byteLength(text) })),
      'every needed backup is fully read once, including unselected active work; no retained-history fallback');
    assert.equal(snapshot.health.ok, true);
    assert.deepEqual(snapshot.tasks.map(task => task.id), ids ?? f.tasks.map(task => task.id));
    assert.ok(snapshot.tasks.every(task => task.journalIssues.length === 0 && task.recoveryRequired.length === 0));
    for (const task of snapshot.tasks) assert.deepEqual(task.changes, f.tasks.find(saved => saved.id === task.id).changes);
  }
  assert.deepEqual(f.state(), before);
});

test('a transient backup read failure is shared within one response but rechecked on the next request', async t => {
  const f = await fixture(t, { recovery: true, running: [0], collected: true });
  const backup = originals(f).path('owned'), journal = backup.replace(/\.before\.txt$/, '.json');
  const before = f.state(), bytes = fs.readFileSync(backup), open = fs.openSync;
  let attempts = 0, snapshot;
  const mock = t.mock.method(fs, 'openSync', (file, ...args) => {
    if (file === backup && ++attempts === 1) throw Object.assign(Error('fixture transient read failure'), { code: 'EIO' });
    return open(file, ...args);
  });
  syncBuiltinESMExports();
  try { snapshot = await request('reconcile', { ids: ['owned'] }, f.config); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(attempts, 1, 'do not silently re-read a failed observation in the same response');
  assert.deepEqual(snapshot.health.recoveryRequired, ['owned']);
  assert.deepEqual(snapshot.tasks[0].journalIssues, [journal]);
  assert.deepEqual(snapshot.tasks[0].recoveryRequired, [journal]);
  const next = await request('reconcile', { ids: ['owned'] }, f.config);
  assert.deepEqual(next.tasks[0].journalIssues, [], 'a later observation reopens the recovered backup');
  assert.deepEqual(next.tasks[0].recoveryRequired, [journal], 'sticky quarantine is not silently repaired');
  assert.deepEqual(f.state(), before); assert.deepEqual(fs.readFileSync(backup), bytes);
});

test('scoped recovery reuse retains global active warnings and does not hide later terminal damage', async t => {
  const f = await fixture(t, { count: 4, recovery: true, running: [0, 1], collected: true });
  const measured = originals(f), before = f.state();
  await request('reconcile', { ids: ['owned'] }, f.config);
  for (const id of ['retained-1', 'retained-3']) fs.writeFileSync(measured.path(id), text.replace('Retained', 'Damaged!'));
  const selected = await request('reconcile', { ids: ['owned'] }, f.config);
  assert.deepEqual(selected.health.recoveryRequired, ['retained-1']);
  assert.deepEqual(selected.tasks[0].journalIssues, []); assert.equal(selected.tasks.length, 1);
  const full = await request('reconcile', undefined, f.config);
  for (const id of ['retained-1', 'retained-3']) {
    const task = full.tasks.find(task => task.id === id);
    assert.deepEqual(task.journalIssues, [measured.path(id).replace(/\.before\.txt$/, '.json')]);
  }
  assert.deepEqual(f.state(), before);
});

test('external changes after the shared journal observation require a fresh request, not a response-time atomicity claim', async t => {
  const f = await fixture(t, { count: 2, recovery: true, running: [0], collected: true });
  const backup = originals(f).path('owned'), before = f.state(), stat = fs.lstatSync;
  let injected = false;
  // Pending-result inspection follows the recovery scan inside readiness. Model
  // an external writer at this boundary; no worker mutation or clock race is used.
  const mock = t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (!injected && file === f.path('owned')) { injected = true; fs.writeFileSync(backup, text.replace('Retained', 'Damaged!')); }
    return stat(file, ...args);
  });
  syncBuiltinESMExports();
  let observed;
  try { observed = await request('reconcile', { ids: ['owned'] }, f.config); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(observed.health.ok, true); assert.deepEqual(observed.tasks[0].journalIssues, []);
  const next = await request('reconcile', { ids: ['owned'] }, f.config);
  assert.equal(next.health.ok, false);
  assert.deepEqual(next.tasks[0].journalIssues, [backup.replace(/\.before\.txt$/, '.json')]);
  assert.deepEqual(f.state(), before, 'read-only observations do not retire inputs or authorize collection');
});


// Presence-only gates must not confuse "needs inspection" with verified bytes.
test('candidate presence follows pending paths without reading or validating result bodies', async t => {
  const f = await fixture(t, { count: 1, running: [0] }), task = f.tasks[0];
  const file = f.path('owned'), stage = file + '.tmp', measured = { ...f, files: [file, stage] };
  assert.equal(typeof resultFiles.hasPendingResults, 'function');
  const check = async (expected, value = task) => {
    const reads = await observeReads(t, measured, () => assert.equal(resultFiles.hasPendingResults(value, f.dir), expected));
    assert.deepEqual(reads, []);
  };
  await check(false);
  for (const target of [file, stage]) {
    for (const bytes of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.alloc(1024 * 1024 + 1)]) {
      fs.writeFileSync(target, bytes); await check(true); fs.unlinkSync(target);
    }
    fs.mkdirSync(target); await check(true); fs.rmdirSync(target);
  }
  fs.writeFileSync(file, text);
  for (const status of ['completed', 'failed', 'cancelled']) {
    await check(false, { ...task, status, artifact: file });
    await check(true, { ...task, status, collected: true });
  }
  fs.linkSync(file, stage);
  await check(true, { ...task, status: 'completed', artifact: file });
  fs.unlinkSync(stage); fs.unlinkSync(file);
  await check(false, { ...task, artifact: '/not-an-input-path' });
  for (const id of ['../other', '', 'con']) assert.throws(() => resultFiles.hasPendingResults({ ...task, id }, f.dir));
});

test('candidate presence detects a dangling link without following or creating its target', async t => {
  const f = await fixture(t, { count: 1, running: [0] }), link = f.path('owned') + '.tmp', target = join(f.dir, 'absent');
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; t.skip('link privilege unavailable'); return; }
  assert.equal(resultFiles.hasPendingResults(f.tasks[0], f.dir), true);
  const details = resultFiles.inspectPendingResults(f.tasks[0], f.dir);
  assert.equal(details[0].integrity, 'unreadable');
  assert.equal(fs.existsSync(target), false); assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test('candidate presence treats metadata errors as blocking, never as absence', async t => {
  const f = await fixture(t, { count: 1, running: [0] }), file = f.path('owned'), stat = fs.lstatSync;
  for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'ELOOP']) {
    const mock = t.mock.method(fs, 'lstatSync', (path, ...args) => {
      if (path === file) throw Object.assign(Error('fixture metadata failure'), { code });
      return stat(path, ...args);
    });
    syncBuiltinESMExports();
    try {
      assert.equal(resultFiles.hasPendingResults(f.tasks[0], f.dir), true, code);
      await assert.rejects(request('ready', undefined, f.config), e => e.details.pendingResultTasks.includes('owned'));
      assert.deepEqual(resultFiles.inspectPendingResults(f.tasks[0], f.dir), [{ artifact: file, integrity: 'unreadable', code }]);
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  }
  assert.equal(resultFiles.hasPendingResults(f.tasks[0], f.dir), false);
  assert.equal((await request('ready', undefined, f.config)).ok, true, 'presence errors are freshly observed, not cached');
});

test('candidate health and wait notices read no bodies and observe later appearance and removal', async t => {
  const f = await fixture(t, { count: 8, running: [0, 1, 2, 3, 4, 5, 6, 7] });
  const files = f.tasks.flatMap(task => [f.path(task.id), f.path(task.id) + '.tmp']), before = f.state();
  assert.equal((await request('ready', undefined, f.config)).ok, true);
  for (const file of files) fs.writeFileSync(file, text);
  const reads = await observeReads(t, { ...f, files }, async () => {
    for (let repeat = 0; repeat < 2; repeat++) {
      await assert.rejects(request('ready', undefined, f.config), error => {
        assert.deepEqual(error.details.pendingResultTasks, f.tasks.map(task => task.id)); return true;
      });
      assert.deepEqual((await request('status', undefined, f.config)).resultRecoveryRequired, f.tasks.map(task => ({ id: task.id })));
      assert.deepEqual((await request('wait', { ids: ['owned'] }, f.config)).resultRecoveryRequired, [{ id: 'owned' }]);
    }
  });
  assert.deepEqual(reads, []); assert.deepEqual(f.state(), before);
  for (const file of files) { assert.equal(fs.readFileSync(file, 'utf8'), text); fs.unlinkSync(file); }
  assert.equal((await request('ready', undefined, f.config)).ok, true);
  assert.equal((await request('status', undefined, f.config)).resultRecoveryRequired, undefined);
});

test('candidate reconciliation still reads every selected candidate once and reports its actual bytes', async t => {
  const f = await fixture(t, { count: 3, running: [0, 1, 2] });
  const files = f.tasks.flatMap(task => [f.path(task.id), f.path(task.id) + '.tmp']), before = f.state();
  for (const file of files) fs.writeFileSync(file, text);
  for (const ids of [['owned'], undefined]) {
    const selected = ids ? files.slice(0, 2) : files;
    const reads = await observeReads(t, { ...f, files }, async () => {
      const snapshot = await reconcileTasks(f.config, { ids });
      assert.deepEqual(snapshot.health.pendingResultTasks, f.tasks.map(task => task.id));
      assert.deepEqual(snapshot.tasks.flatMap(task => task.pendingResults), selected.map(artifact => ({
        artifact, sha256, bytes: Buffer.byteLength(text), integrity: 'uncommitted',
      })));
    });
    assert.deepEqual(reads, selected.map(file => ({ file, bytes: Buffer.byteLength(text) })));
  }
  fs.writeFileSync(files[1], 'later bytes');
  const fresh = await reconcileTasks(f.config, { ids: ['owned'] });
  assert.equal(fresh.tasks[0].pendingResults[1].sha256, createHash('sha256').update('later bytes').digest('hex'));
  fs.unlinkSync(files[1]); fs.mkdirSync(files[1]);
  assert.equal((await reconcileTasks(f.config, { ids: ['owned'] })).tasks[0].pendingResults[1].integrity, 'unreadable');
  assert.deepEqual(f.state(), before);
});

test('candidate gates block valid project mutations without reading candidates or retiring input', async t => {
  const f = await fixture(t, { count: 0 }), root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-candidate-project-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const task = await request('register', { id: 'owned', instructions: 'keep', inputs: { sample: text }, workspace: { root, mode: 'edit' } }, f.config);
  const file = f.path('owned'), stage = file + '.tmp', project = join(root, 'original.txt');
  fs.writeFileSync(file, text); fs.writeFileSync(stage, text); fs.writeFileSync(project, text);
  const before = f.state();
  const reads = await observeReads(t, { ...f, files: [file, stage] }, async () => {
    for (const [name, args] of [
      ['write_file', { path: 'new/child.txt', text: 'blocked', expectedSha256: null }],
      ['write_file', { path: 'original.txt', text: 'blocked', expectedSha256: sha256 }],
      ['delete_file', { path: 'original.txt', expectedSha256: sha256 }],
    ]) {
      const reply = await callTool(f.worker, name, { token: task.token, ...args });
      assert.equal(reply.isError, true); assert.match(reply.content[0].text, /uncommitted result/);
    }
  });
  assert.deepEqual(reads, []); assert.deepEqual(f.state(), before);
  assert.equal(fs.existsSync(join(root, 'new')), false); assert.equal(fs.existsSync(join(f.dir, 'recovery', 'owned')), false);
  assert.equal(fs.readFileSync(project, 'utf8'), text);
  assert.equal((await callTool(f.worker, 'read_input', { token: task.token, name: 'sample' })).structuredContent.text, text);
  assert.equal((await callTool(f.worker, 'read_file', { token: task.token, path: 'original.txt' })).isError, false);
  assert.equal((await callTool(f.worker, 'submit_result', { token: task.token, status: 'completed', summary: 'done', result: 'different' })).isError, true);
  assert.deepEqual(f.state(), before); assert.equal(fs.readFileSync(file, 'utf8'), text); assert.equal(fs.readFileSync(stage, 'utf8'), text);
  // Explicit identical recovery still reads and flushes bytes; no automatic cleanup.
  fs.unlinkSync(stage);
  assert.equal((await callTool(f.worker, 'submit_result', { token: task.token, status: 'completed', summary: 'done', result: text })).isError, false);
  assert.equal((await collectTask('owned', f.config)).integrity, 'verified');
});

test('candidate absence never replaces the conditional collection result-integrity guard', async t => {
  const f = await fixture(t, { count: 1 }), task = f.tasks[0], before = f.state();
  fs.writeFileSync(f.path('owned'), 'changed committed bytes');
  assert.equal(resultFiles.hasPendingResults(task, f.dir), false, 'a committed artifact is not a pending candidate');
  await assert.rejects(request('collect', { id: task.id, expectedStatus: task.status, expectedSha256: task.sha256 }, f.config),
    { code: 'COLLECTION_UNCONFIRMED', statusCode: 409 });
  assert.deepEqual(f.state(), before);
  fs.writeFileSync(f.path('owned'), text); fs.writeFileSync(f.path('owned') + '.tmp', text);
  await assert.rejects(request('collect', { id: task.id, expectedStatus: task.status, expectedSha256: task.sha256 }, f.config),
    { code: 'COLLECTION_RECOVERY_REQUIRED', statusCode: 409 });
  assert.deepEqual(f.state(), before);
});
