// Metadata-specific formats, path types and ownership lifecycle. Shared size,
// growth, short-read and I/O-error cases live in fileReadContract.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeFileRead } from './test-fixtures/file-read.mjs';
import { acquireRuntimeLock, createStateMarker, parseState, parseStateMarker, readStateBytes, readStateMarker } from './runtime.mjs';

const marker = Buffer.from('WebGPT state initialized v1\n');
function fixture(t, kind = 'marker') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-metadata-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = kind === 'state' ? join(dir, 'state.json')
    : kind === 'marker' ? join(dir, 'state.initialized') : join(dir, 'worker.lock', 'owner.json');
  if (kind === 'owner') fs.mkdirSync(join(dir, 'worker.lock'));
  const bytes = kind === 'state' ? Buffer.from('[]')
    : kind === 'marker' ? marker : Buffer.from(JSON.stringify({ pid: 1, host: 'fixture', instanceId: 'original' }));
  fs.writeFileSync(file, bytes);
  return { dir, file, bytes,
    invalid: { code: kind === 'owner' ? 'LOCK_UNCERTAIN' : 'STATE_INVALID' },
    run: () => kind === 'state' ? readStateBytes(file) : kind === 'marker' ? readStateMarker(file)
      : acquireRuntimeLock(dir, { host: 'fixture', probe: () => 'alive' }) };
}
for (const kind of ['marker', 'owner', 'state']) {
  test(`${kind} metadata rejects directories and hardlinks without reading or modifying them`, t => {
    const f = fixture(t, kind), original = join(f.dir, 'original');
    fs.renameSync(f.file, original);
    for (const type of ['directory', 'hardlink']) {
      if (type === 'directory') fs.mkdirSync(f.file); else fs.linkSync(original, f.file);
      const trace = observeFileRead(t, f.file);
      try { assert.throws(f.run, f.invalid); } finally { trace.restore(); }
      assert.equal(trace.evidence.bytes, 0); assert.equal(trace.evidence.opens, 0);
      assert.equal(trace.evidence.closes, 0);
      if (type === 'directory') fs.rmdirSync(f.file); else fs.unlinkSync(f.file);
      assert.deepEqual(fs.readFileSync(original), f.bytes);
    }
  });

  test(`${kind} metadata rejects a symbolic link without following its target`, t => {
    const f = fixture(t, kind), original = join(f.dir, 'original');
    fs.renameSync(f.file, original);
    try { fs.symlinkSync(original, f.file); }
    catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('file symlinks require Windows permission'); throw error; }
    const trace = observeFileRead(t, f.file);
    try { assert.throws(f.run, f.invalid); } finally { trace.restore(); }
    assert.equal(trace.evidence.bytes, 0); assert.equal(trace.evidence.opens, 0);
    assert.equal(trace.evidence.closes, 0);
    assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
    assert.deepEqual(fs.readFileSync(original), f.bytes);
  });
}

test('marker absence, exact bytes and invalid encodings retain their existing meaning', t => {
  const f = fixture(t); fs.unlinkSync(f.file);
  assert.equal(readStateMarker(f.file), false);
  createStateMarker(f.file);
  assert.equal(readStateMarker(f.file), true);
  assert.deepEqual(fs.readFileSync(f.file), marker);
  assert.throws(() => createStateMarker(f.file), { code: 'EEXIST' });
  assert.equal(parseStateMarker(null), false);
  for (const bytes of [Buffer.alloc(0), Buffer.from('wrong'), Buffer.from(marker.toString().replace('\n', '\r\n')),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), marker]), Buffer.from(marker.toString(), 'utf16le')]) {
    fs.writeFileSync(f.file, bytes);
    assert.throws(() => readStateMarker(f.file), { code: 'STATE_INVALID' });
    assert.deepEqual(fs.readFileSync(f.file), bytes);
  }
});

test('metadata limits do not impose a new cap on the committed task inventory', t => {
  const f = fixture(t), file = join(f.dir, 'state.json');
  const bytes = Buffer.from('[]' + ' '.repeat(2 * 1024 * 1024));
  fs.writeFileSync(file, bytes);
  assert.deepEqual(readStateBytes(file), bytes);
  assert.deepEqual(parseState(readStateBytes(file), f.dir), []);
});

// State intentionally has no domain byte quota, but still validates the exact
// opened file. Reuse the observer; no second FIFO child or native-open spy here.
for (const kind of ['replacement', 'hardlink', 'missing']) {
  test(`committed state rejects a late ${kind} without reading or changing evidence`, t => {
    const f = fixture(t, 'state'), original = f.file + '.original';
    let swaps = 0;
    const trace = observeFileRead(t, f.file, { beforeOpen() {
      fs.renameSync(f.file, original);
      if (kind === 'replacement') fs.writeFileSync(f.file, f.bytes);
      if (kind === 'hardlink') fs.linkSync(original, f.file);
      swaps++;
    } });
    try { assert.throws(f.run, kind === 'missing' ? { code: 'ENOENT' } : { code: 'STATE_INVALID', retryable: false }); }
    finally { trace.restore(); }
    assert.equal(swaps, 1);
    assert.equal(trace.evidence.bytes, 0);
    assert.equal(trace.evidence.opens, kind === 'missing' ? 0 : 1);
    assert.equal(trace.evidence.closes, trace.evidence.opens);
    assert.deepEqual(fs.readFileSync(original), f.bytes);
    if (kind === 'missing') assert.equal(fs.existsSync(f.file), false);
    else assert.deepEqual(fs.readFileSync(f.file), f.bytes);
  });
}

test('committed state reads the checked descriptor rather than reopening a changed path', t => {
  const f = fixture(t, 'state'), original = f.file + '.original', replacement = Buffer.from('[ ]');
  const trace = observeFileRead(t, f.file, { beforeRead() {
    fs.renameSync(f.file, original); fs.writeFileSync(f.file, replacement);
  } });
  try { assert.deepEqual(f.run(), f.bytes); } finally { trace.restore(); }
  assert.equal(trace.evidence.opens, 1); assert.equal(trace.evidence.closes, 1);
  assert.equal(trace.evidence.bytes, f.bytes.length);
  assert.deepEqual(fs.readFileSync(original), f.bytes);
  assert.deepEqual(fs.readFileSync(f.file), replacement);
});

test('committed state retains absence, empty bytes and native read failure with descriptor cleanup', t => {
  const f = fixture(t, 'state');
  assert.equal(readStateBytes(f.file + '.missing'), null);
  fs.writeFileSync(f.file, '');
  assert.deepEqual(f.run(), Buffer.alloc(0));
  assert.throws(() => parseState(f.run(), f.dir), { code: 'STATE_INVALID' });
  const failure = Object.assign(Error('state fixture I/O failure'), { code: 'EIO' });
  const trace = observeFileRead(t, f.file, { beforeRead() { throw failure; } });
  try { assert.throws(f.run, error => error === failure); } finally { trace.restore(); }
  assert.equal(trace.evidence.opens, 1); assert.equal(trace.evidence.closes, 1);
  assert.equal(trace.evidence.bytes, 0);
  assert.deepEqual(fs.readFileSync(f.file), Buffer.alloc(0));
});

test('valid worker and service ownership retains release and dead-owner archival', t => {
  const f = fixture(t, 'owner');
  const recovered = acquireRuntimeLock(f.dir, { host: 'fixture', probe: () => 'dead' });
  const archives = fs.readdirSync(f.dir).filter(name => name.startsWith('worker.lock.stale-'));
  assert.equal(archives.length, 1);
  assert.deepEqual(fs.readFileSync(join(f.dir, archives[0], 'owner.json')), f.bytes);
  recovered.release();
  for (const name of ['worker', 'service']) {
    const owner = acquireRuntimeLock(f.dir, { name });
    assert.throws(() => acquireRuntimeLock(f.dir, { name }), { code: 'LOCK_HELD' });
    owner.release(); owner.release();
    assert.equal(fs.existsSync(join(f.dir, name + '.lock')), false);
  }
});
