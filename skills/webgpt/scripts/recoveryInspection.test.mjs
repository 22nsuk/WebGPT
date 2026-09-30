// Traversal work and diagnostic composition, not a second bounded-reader matrix.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { inspectRecovery } from './workspace.mjs';
import { readFixture, observeFileRead } from './test-fixtures/file-read.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const operation = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
function fixture(t, count = 0) {
  const dir = readFixture(t), recovery = join(dir, 'recovery', 'owned');
  fs.mkdirSync(recovery, { recursive: true });
  const receipts = [], bytes = new Map();
  const save = (name, text) => {
    const file = join(recovery, name), content = Buffer.from(text);
    fs.writeFileSync(file, content); bytes.set(file, content); return file;
  };
  for (let i = 0; i < count; i++) {
    const id = operation(i), text = `Original ${i} 한국어 🧪\r\n`;
    const backup = save(id + '.before.txt', text);
    const receipt = { operation: id, path: 'notes.txt', action: 'edit',
      beforeSha256: hash(text), afterSha256: hash('changed'), backup };
    save(id + '.json', JSON.stringify({ ...receipt, state: 'applied' }));
    receipts.push(receipt);
  }
  return { dir, recovery, receipts, bytes, save, run: () => inspectRecovery(dir, 'owned'),
    preserved() {
      assert.deepEqual(fs.readdirSync(recovery).sort(), [...bytes.keys()].map(file => file.slice(recovery.length + 1)).sort());
      for (const [file, content] of bytes) assert.deepEqual(fs.readFileSync(file), content);
    } };
}

for (const count of [0, 1, 64]) test(`recovery inspection reads ${count} receipts without redundant leaf metadata`, t => {
  const f = fixture(t, count), native = fs.lstatSync, calls = new Map();
  const metadata = t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (f.bytes.has(file)) calls.set(file, (calls.get(file) ?? 0) + 1);
    return native(file, ...args);
  });
  syncBuiltinESMExports();
  // Two observers suffice regardless of history size; do not layer one per file.
  const observed = [...f.bytes.keys()].slice(-2).map(file => ({ file,
    trace: observeFileRead(t, file, { chunkSize: 3 }) }));
  let result;
  try { result = f.run(); }
  finally {
    t.mock.reset();
    for (const { trace } of [...observed].reverse()) trace.restore();
    metadata.mock.restore(); syncBuiltinESMExports();
  }
  assert.deepEqual(result, { receipts: f.receipts, unresolved: [] });
  for (const { file, trace } of observed) {
    assert.equal(trace.evidence.opens, 1); assert.equal(trace.evidence.closes, 1);
    assert.equal(trace.evidence.bytes, f.bytes.get(file).length);
  }
  f.preserved();
  t.diagnostic(JSON.stringify({ receipts: count, leafMetadataCalls: [...calls.values()].reduce((a, b) => a + b, 0) }));
  assert.deepEqual([...calls.keys()].sort(), [...f.bytes.keys()].sort(), 'visit every journal and original');
  for (const [file, callsForFile] of calls) assert.equal(callsForFile, 1, file);
});

test('orphaned recovery stages retain ordered diagnostics without accumulated array scans', t => {
  const f = fixture(t), count = 64;
  const stages = Array.from({ length: count }, (_, i) => f.save(operation(i) + '.json.tmp', 'staged evidence'));
  const queries = new Set(stages.map(file => file.slice(0, -4)));
  const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'includes');
  const setDescriptor = Object.getOwnPropertyDescriptor(Set.prototype, 'has');
  const includes = arrayDescriptor.value, has = setDescriptor.value;
  let scanSlots = 0, setProbes = 0, result;
  // Node's mock.method rejects Array.prototype. Scope descriptor observers to
  // this synchronous call and restore both originals even if inspection throws.
  try {
    Object.defineProperty(Array.prototype, 'includes', { ...arrayDescriptor, value(value, ...args) {
      if (has.call(queries, value)) scanSlots += this.length; // Every query is absent in this fixture.
      return includes.call(this, value, ...args);
    } });
    Object.defineProperty(Set.prototype, 'has', { ...setDescriptor, value(value) {
      if (has.call(queries, value)) setProbes++;
      return has.call(this, value);
    } });
    result = f.run();
  } finally {
    Object.defineProperty(Set.prototype, 'has', setDescriptor);
    Object.defineProperty(Array.prototype, 'includes', arrayDescriptor);
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(Array.prototype, 'includes'), arrayDescriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Set.prototype, 'has'), setDescriptor);
  assert.deepEqual(result, { receipts: [], unresolved: stages });
  f.preserved();
  t.diagnostic(JSON.stringify({ orphanStages: count, scanSlots, setProbes }));
  assert.ok(scanSlots + setProbes <= count, 'stage diagnostics must not scan the accumulated history');
});

test('mixed recovery diagnostics preserve valid receipts, suppression, order and fresh backup checks', t => {
  const f = fixture(t, 4), journal = i => join(f.recovery, operation(i) + '.json');
  // Applied + stage: keep the receipt AND report its stage. Invalid + stage:
  // report the final journal once, never promote or delete either candidate.
  f.save(operation(0) + '.json.tmp', 'uncommitted');
  f.save(operation(1) + '.json', '{malformed'); f.save(operation(1) + '.json.tmp', 'uncommitted');
  f.save(operation(2) + '.json', JSON.stringify({ ...f.receipts[2], state: 'prepared' }));
  f.save(operation(2) + '.json.tmp', 'uncommitted');
  f.save(operation(4) + '.json.tmp', 'orphan');
  const unresolved = [journal(0) + '.tmp', journal(1), journal(2), journal(4) + '.tmp'];
  assert.deepEqual(f.run(), { receipts: [f.receipts[0], f.receipts[3]], unresolved });
  f.save(operation(3) + '.before.txt', 'changed original');
  assert.deepEqual(f.run(), { receipts: [f.receipts[0]], unresolved: [...unresolved.slice(0, 3), journal(3), unresolved[3]] });
  f.preserved();
});

for (const kind of ['journal', 'backup']) test(`recovery ${kind} failures remain unresolved without losing sibling receipts`, async t => {
  for (const damage of ['missing', 'hardlink', 'oversize', 'invalid-utf8', 'read-error', 'identity-swap']) {
    await t.test(damage, t => {
      const f = fixture(t, 2), journal = join(f.recovery, operation(0) + '.json');
      const file = kind === 'journal' ? journal : f.receipts[0].backup, original = f.bytes.get(file);
      let hook = {}, extra;
      if (damage === 'missing') { fs.unlinkSync(file); f.bytes.delete(file); }
      if (damage === 'hardlink') { extra = file + '.held'; fs.linkSync(file, extra); f.bytes.set(extra, original); }
      if (damage === 'oversize') { fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 120)); f.bytes.set(file, fs.readFileSync(file)); }
      if (damage === 'invalid-utf8') { fs.writeFileSync(file, Buffer.from([0xff])); f.bytes.set(file, Buffer.from([0xff])); }
      if (damage === 'read-error') hook = { beforeRead() { throw Object.assign(Error('fixture'), { code: 'EIO' }); } };
      if (damage === 'identity-swap') hook = { beforeOpen() {
        extra = file + '.held'; fs.renameSync(file, extra); fs.writeFileSync(file, original); f.bytes.set(extra, original);
      } };
      // A missing journal is absent from readdir; simulate disappearance AFTER
      // listing instead so the inspector must report this discovered record.
      if (damage === 'missing' && kind === 'journal') {
        fs.writeFileSync(file, original); f.bytes.set(file, original);
        hook = { beforeOpen() { fs.unlinkSync(file); f.bytes.delete(file); } };
      }
      const trace = observeFileRead(t, file, hook);
      let result;
      try { result = f.run(); } finally { trace.restore(); }
      assert.deepEqual(result, { receipts: [f.receipts[1]], unresolved: [journal] });
      assert.equal(trace.evidence.opens, trace.evidence.closes);
      if (['missing', 'hardlink', 'oversize', 'read-error', 'identity-swap'].includes(damage)) assert.equal(trace.evidence.bytes, 0);
      if (['read-error', 'identity-swap', 'invalid-utf8'].includes(damage)) assert.equal(trace.evidence.opens, 1);
      if (['hardlink', 'oversize'].includes(damage)) assert.equal(trace.evidence.opens, 0);
      f.preserved();
    });
  }
});

test('recovery directory absence and invalid ancestors keep the existing array response', t => {
  const dir = readFixture(t), root = join(dir, 'recovery'), task = join(root, 'owned');
  assert.deepEqual(inspectRecovery(dir, 'owned'), { receipts: [], unresolved: [] });
  fs.writeFileSync(root, 'ancestor evidence');
  assert.deepEqual(inspectRecovery(dir, 'owned'), { receipts: [], unresolved: [task] });
  assert.equal(fs.readFileSync(root, 'utf8'), 'ancestor evidence');
  fs.renameSync(root, root + '.held'); fs.mkdirSync(root);
  assert.deepEqual(inspectRecovery(dir, 'owned'), { receipts: [], unresolved: [] });
  fs.writeFileSync(task, 'task evidence');
  assert.deepEqual(inspectRecovery(dir, 'owned'), { receipts: [], unresolved: [task] });
  assert.equal(fs.readFileSync(task, 'utf8'), 'task evidence');
  assert.equal(fs.readFileSync(root + '.held', 'utf8'), 'ancestor evidence');
});
