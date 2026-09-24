// Real loopback worker and disposable retained results; no timing thresholds or cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { start } from './worker.mjs';
import { collectTask, reconcileTasks, request } from './client.mjs';

const text = '\uFEFFRetained 한국어 🧪\r\n';
const sha256 = createHash('sha256').update(text).digest('hex');
async function fixture(t, { count = 8, status = 'completed', collected = false, discarded = false, artifact = true } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-collection-reads-')));
  let worker;
  t.after(async () => { await worker?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const path = id => join(dir, id + '.result.txt');
  const tasks = Array.from({ length: count }, (_, index) => {
    const id = index === 0 ? 'owned' : 'retained-' + index;
    const saved = index !== 0 || artifact;
    if (saved) fs.writeFileSync(path(id), text, { mode: 0o600 });
    return { id, instructions: '', inputs: {}, status: index === 0 ? status : 'completed',
      collected: index === 0 ? collected : true, ...(index === 0 && discarded ? { discarded } : {}),
      ...(index === 0 && !collected ? { token: 'fixture-only-owned-token' } : {}),
      summary: 'done', nextCheck: null, changes: [], ...(saved ? { artifact: path(id), sha256 } : {}) };
  });
  fs.writeFileSync(join(dir, 'state.json'), JSON.stringify(tasks), { mode: 0o600 });
  worker = await start({ dir, port: 0, controlPort: 0, configFile: join(dir, 'config.json'), waitMs: 20 });
  const config = { dataDir: dir, controlPort: worker.controlPort };
  return { dir, config, path, tasks, state: () => fs.readFileSync(join(dir, 'state.json')) };
}
async function observeReads(t, f, run) {
  const original = { open: fs.openSync, read: fs.readSync, close: fs.closeSync };
  const descriptors = new Map(), reads = [], artifacts = new Set(f.tasks.map(task => f.path(task.id)));
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
  test(`ordinary ${status} collection reads only its result twice with ${count} saved tasks`, async t => {
    const f = await fixture(t, { count, status });
    const reads = await observeReads(t, f, async () => {
      assert.deepEqual(await collectTask('owned', f.config), { id: 'owned', status, summary: 'done',
        artifact: f.path('owned'), sha256, integrity: 'verified', collected: true });
    });
    assert.deepEqual(reads, expectedReads(f, 2));
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
    assert.deepEqual(reads, expectedReads(f, collected ? 1 : 2));
    if (collected) assert.deepEqual(f.state(), before, 'retired-result inspection is read-only');
  });
}

for (const resume of [false, true]) test(`${resume ? 'resume' : 'ordinary'} collection does not audit unrelated result bytes; full reconciliation still does`, async t => {
  const f = await fixture(t);
  fs.unlinkSync(f.path('retained-1')); fs.writeFileSync(f.path('retained-2'), 'different bytes');
  const reads = await observeReads(t, f, async () => assert.equal((await collectTask('owned', f.config, { resume })).collected, true));
  assert.deepEqual(reads, expectedReads(f, 2));
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
