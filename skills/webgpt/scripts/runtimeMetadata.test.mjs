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
  const file = kind === 'marker' ? join(dir, 'state.initialized') : join(dir, 'worker.lock', 'owner.json');
  if (kind === 'owner') fs.mkdirSync(join(dir, 'worker.lock'));
  const bytes = kind === 'marker' ? marker : Buffer.from(JSON.stringify({ pid: 1, host: 'fixture', instanceId: 'original' }));
  fs.writeFileSync(file, bytes);
  return { dir, file, bytes,
    invalid: { code: kind === 'marker' ? 'STATE_INVALID' : 'LOCK_UNCERTAIN' },
    run: () => kind === 'marker' ? readStateMarker(file)
      : acquireRuntimeLock(dir, { host: 'fixture', probe: () => 'alive' }) };
}
for (const kind of ['marker', 'owner']) {
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
