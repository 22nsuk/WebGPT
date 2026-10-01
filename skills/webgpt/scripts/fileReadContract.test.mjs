import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { acquireRuntimeLock, createStateMarker, readStateMarker, readStateBytes, writeStateBytes } from './runtime.mjs';
import { readVerifiedResult, storeResult } from './results.mjs';
import { readDiagnosticBytes } from './audit.mjs';
import { grantWorkspace, readWorkspace } from './workspace.mjs';
import { dispatchCli, inspectDispatch, registerDispatch } from './dispatch.mjs';
import { readFixture, observeFileRead } from './test-fixtures/file-read.mjs';

const MiB = 1024 * 1024;
const text = '\uFEFF한국어 🧪\r\nexact bytes\n';
const spec = { taskId: 'owned', mode: 'pro', prompt: 'private fixture', target: { tabId: 'fixture', chatUrl: null } };

// Domain adapters retain their own decoding, authority and error classification.
// New bounded materializing readers belong in this matrix, not a copied read loop.
async function fixture(t, kind) {
  const dir = readFixture(t);
  let file = join(dir, 'data.txt'), limit = MiB, run, expected, invalid, probes = 0;
  if (kind === 'marker') {
    file = join(dir, 'state.initialized'); createStateMarker(file); limit = 28;
    run = () => readStateMarker(file); expected = true; invalid = { code: 'STATE_INVALID' };
  } else if (kind === 'owner') {
    const lock = join(dir, 'worker.lock'); fs.mkdirSync(lock);
    file = join(lock, 'owner.json'); limit = 4096;
    // Preserve the metadata suite's exact 4096-byte owner/short-read boundary.
    const owner = JSON.stringify({ pid: process.pid, host: 'fixture' });
    fs.writeFileSync(file, owner.padEnd(limit, ' '));
    run = () => {
      try { acquireRuntimeLock(dir, { host: 'fixture', probe: () => { probes++; return 'alive'; } }); }
      catch (error) { if (error.code === 'LOCK_HELD') return 'live'; throw error; }
      assert.fail('a live owner cannot be acquired');
    };
    expected = 'live'; invalid = { code: 'LOCK_UNCERTAIN' };
  } else if (kind === 'result') {
    const saved = storeResult(dir, 'owned', text); file = saved.artifact;
    run = () => readVerifiedResult({ id: 'owned', ...saved }, dir);
    expected = text; invalid = { code: 'RESULT_INVALID' };
  } else if (kind === 'workspace') {
    fs.writeFileSync(file, text); limit = 10 * MiB;
    const grant = grantWorkspace({ root: dir, mode: 'read' });
    run = () => readWorkspace(grant, 'data.txt').text;
    expected = text; invalid = /file must be|UTF-8 text/;
  } else if (kind === 'diagnostic') {
    fs.writeFileSync(file, text); limit = 4096;
    run = () => readDiagnosticBytes(file, limit);
    expected = Buffer.from(text); invalid = /diagnostic data unavailable/;
  } else {
    const ledger = join(dir, 'task.json'); await registerDispatch(ledger, spec); limit = 2 * MiB;
    file = kind === 'dispatch-ledger' ? ledger : join(dir, 'payload.json');
    if (kind === 'dispatch-ledger') {
      run = async () => (await inspectDispatch(ledger)).state; invalid = { code: 'DISPATCH_LEDGER' };
    } else {
      fs.writeFileSync(file, JSON.stringify(spec));
      run = async () => (await dispatchCli(['register', ledger, file])).state;
      invalid = { code: 'DISPATCH_INPUT', reason: 'register_payload_file_invalid' };
    }
    expected = 'registered';
  }
  return { dir, file, limit, run, expected, invalid, bytes: fs.readFileSync(file), probes: () => probes };
}

for (const kind of ['marker', 'owner', 'result', 'workspace', 'diagnostic', 'dispatch-ledger', 'dispatch-payload']) {
  test(`${kind} read contract preserves exact content through short native reads`, async t => {
    const f = await fixture(t, kind), trace = observeFileRead(t, f.file, { chunkSize: 3 });
    try { assert.deepEqual(await f.run(), f.expected); }
    finally { trace.restore(); }
    assert.equal(trace.evidence.opens, 1); assert.equal(trace.evidence.closes, 1);
    assert.equal(trace.evidence.bytes, f.bytes.length);
    assert.deepEqual(fs.readFileSync(f.file), f.bytes);
    assert.equal(f.probes(), kind === 'owner' ? 1 : 0);
    if (kind === 'marker' || kind === 'owner') assert.equal(f.bytes.length, f.limit);
  });

  test(`${kind} read contract rejects growth without returning a bounded prefix`, async t => {
    const f = await fixture(t, kind), grown = Buffer.alloc(f.limit + 128, 120);
    const trace = observeFileRead(t, f.file, { beforeRead: () => fs.writeFileSync(f.file, grown) });
    try { await assert.rejects(async () => f.run(), f.invalid); }
    finally { trace.restore(); }
    assert.equal(trace.evidence.bytes, f.limit + 1);
    assert.equal(trace.evidence.opens, 1); assert.equal(trace.evidence.closes, 1);
    assert.deepEqual(fs.readFileSync(f.file), grown);
    assert.equal(f.probes(), 0);
    assert.equal(fs.existsSync(join(f.dir, 'worker.recovery.lock')), false);
  });

  test(`${kind} read contract rejects an initially oversized file without content I/O`, async t => {
    const f = await fixture(t, kind), grown = Buffer.alloc(f.limit + 1, 120);
    fs.writeFileSync(f.file, grown);
    const trace = observeFileRead(t, f.file);
    try { await assert.rejects(async () => f.run(), f.invalid); }
    finally { trace.restore(); }
    assert.equal(trace.evidence.bytes, 0); assert.equal(trace.evidence.opens, 0);
    assert.deepEqual(fs.readFileSync(f.file), grown);
    assert.equal(f.probes(), 0);
    assert.equal(fs.existsSync(join(f.dir, 'worker.recovery.lock')), false);
  });

  test(`${kind} read contract retains its native read-failure classification`, async t => {
    const f = await fixture(t, kind), failure = Object.assign(Error('private I/O fixture'), { code: 'EIO' });
    const trace = observeFileRead(t, f.file, { beforeRead() { throw failure; } });
    const expected = kind === 'owner' ? { code: 'LOCK_UNCERTAIN' }
      : kind.startsWith('dispatch-') ? { code: 'DISPATCH_STORAGE',
        stage: kind === 'dispatch-ledger' ? 'ledger_read' : 'payload_read', reason: 'io_failed' }
      : error => error === failure;
    try { await assert.rejects(async () => f.run(), expected); }
    finally { trace.restore(); }
    assert.equal(trace.evidence.bytes, 0); assert.equal(trace.evidence.closes, 1);
    assert.deepEqual(fs.readFileSync(f.file), f.bytes);
    assert.equal(f.probes(), 0);
    assert.equal(fs.existsSync(join(f.dir, 'worker.recovery.lock')), false);
  });

  test(`${kind} read contract binds the opened file to the checked identity`, async t => {
    const f = await fixture(t, kind), held = f.file + '.held', replacement = f.file + '.replacement';
    fs.writeFileSync(replacement, f.bytes);
    const trace = observeFileRead(t, f.file, { beforeOpen() {
      fs.renameSync(f.file, held); fs.renameSync(replacement, f.file);
    } });
    try { await assert.rejects(async () => f.run(), f.invalid); }
    finally { trace.restore(); }
    assert.equal(trace.evidence.bytes, 0);
    assert.equal(trace.evidence.opens, 1); assert.equal(trace.evidence.closes, 1);
    assert.deepEqual(fs.readFileSync(held), f.bytes);
    assert.deepEqual(fs.readFileSync(f.file), f.bytes);
    assert.equal(f.probes(), 0);
    assert.equal(fs.existsSync(join(f.dir, 'worker.recovery.lock')), false);
  });
}

for (const size of [0, 31, 2 * MiB]) test(`state retry compares at most its ${size}-byte candidate plus a sentinel`, t => {
  const dir = readFixture(t), file = join(dir, 'state.json'), stage = file + '.tmp';
  const committed = Buffer.from('committed evidence'), candidate = Buffer.alloc(size, 32);
  fs.writeFileSync(file, committed); fs.writeFileSync(stage, candidate, { mode: 0o600 });
  const grown = Buffer.concat([candidate, Buffer.alloc(2 * MiB, 120)]);
  const trace = observeFileRead(t, stage, { beforeRead: () => fs.writeFileSync(stage, grown) });
  try { assert.throws(() => writeStateBytes(file, candidate), { code: 'STATE_STAGING_CONFLICT' }); }
  finally { trace.restore(); }
  assert.equal(trace.evidence.bytes, size + 1);
  assert.equal(trace.evidence.opens, 1); assert.equal(trace.evidence.closes, 1);
  assert.deepEqual(fs.readFileSync(file), committed); assert.deepEqual(fs.readFileSync(stage), grown);
  t.diagnostic(JSON.stringify({ candidateBytes: size, grownBytes: grown.length, readBytes: trace.evidence.bytes }));
});

test('large byte-identical state retry still flushes and publishes without a new inventory cap', t => {
  const dir = readFixture(t), file = join(dir, 'state.json'), stage = file + '.tmp';
  const bytes = Buffer.from('[' + ' '.repeat(2 * MiB) + ']');
  fs.writeFileSync(stage, bytes, { mode: 0o600 });
  const trace = observeFileRead(t, stage);
  try { writeStateBytes(file, bytes); }
  finally { trace.restore(); }
  assert.equal(trace.evidence.bytes, bytes.length);
  assert.equal(trace.evidence.closes, 1); assert.equal(fs.existsSync(stage), false);
  assert.deepEqual(readStateBytes(file), bytes);
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    createHash('sha256').update(bytes).digest('hex'));
});

test('owner lookup preserves its native metadata I/O error boundary', async t => {
  const f = await fixture(t, 'owner'), native = fs.lstatSync;
  const failure = Object.assign(Error('private owner lookup fixture'), { code: 'EIO' });
  const mock = t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (file === f.file) throw failure;
    return native(file, ...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(f.run, error => error === failure); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(f.file), f.bytes);
});
