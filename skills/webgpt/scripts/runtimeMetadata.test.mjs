// Fixed-size runtime metadata must not become an unbounded whole-file read.
// Grow only disposable fixtures at the read boundary; no sleeps or memory stress.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { acquireRuntimeLock, createStateMarker, parseState, parseStateMarker, readStateBytes, readStateMarker } from './runtime.mjs';

const marker = Buffer.from('WebGPT state initialized v1\n');
const large = Buffer.alloc(2 * 1024 * 1024, 120);
function fixture(t, kind = 'marker') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-metadata-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = kind === 'marker' ? join(dir, 'state.initialized') : join(dir, 'worker.lock', 'owner.json');
  if (kind === 'owner') fs.mkdirSync(join(dir, 'worker.lock'));
  const bytes = kind === 'marker' ? marker : Buffer.from(JSON.stringify({ pid: 1, host: 'fixture', instanceId: 'original' }));
  fs.writeFileSync(file, bytes);
  let probes = 0;
  return { dir, file, bytes, limit: kind === 'marker' ? marker.length : 4096,
    invalid: { code: kind === 'marker' ? 'STATE_INVALID' : 'LOCK_UNCERTAIN' },
    run: () => kind === 'marker' ? readStateMarker(file)
      : acquireRuntimeLock(dir, { host: 'fixture', probe: () => { probes++; return 'alive'; } }),
    probes: () => probes };
}
function observeReads(t, file, operation, { beforeRead = () => {}, chunkSize = Infinity } = {}) {
  const native = { open: fs.openSync, read: fs.readSync, whole: fs.readFileSync, close: fs.closeSync };
  const opened = new Set(), observed = { bytes: 0, opens: 0 };
  let inWholeRead = false;
  t.mock.method(fs, 'openSync', (path, ...args) => {
    const fd = native.open(path, ...args);
    const flags = args[0];
    const reading = flags === 'r' || typeof flags === 'number' && !(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR));
    if (path === file && reading) { opened.add(fd); observed.opens++; }
    return fd;
  });
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    const tracked = opened.has(fd) && !inWholeRead;
    if (tracked) beforeRead();
    const count = native.read(fd, buffer, offset, tracked ? Math.min(length, chunkSize) : length, position);
    if (tracked) observed.bytes += count;
    return count;
  });
  // Count the previous implementation's real whole-file read too. A passing
  // rejection alone must not hide how many bytes were consumed before it failed.
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (path !== file && !opened.has(path)) return native.whole(path, ...args);
    beforeRead(); inWholeRead = true;
    try {
      const bytes = native.whole(path, ...args);
      observed.bytes += Buffer.byteLength(bytes);
      return bytes;
    } finally { inWholeRead = false; }
  });
  t.mock.method(fs, 'closeSync', fd => {
    const result = native.close(fd); opened.delete(fd); return result;
  });
  syncBuiltinESMExports();
  try { operation(); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(opened.size, 0, 'all opened metadata descriptors must close');
  return observed;
}

for (const kind of ['marker', 'owner']) {
  test(`${kind} metadata rejects an oversized file before reading its body`, t => {
    const f = fixture(t, kind); fs.writeFileSync(f.file, large);
    const reads = observeReads(t, f.file, () => assert.throws(f.run, f.invalid));
    assert.deepEqual(reads, { bytes: 0, opens: 0 });
    t.diagnostic(JSON.stringify({ kind, scenario: 'oversized', sourceBytes: large.length, ...reads }));
    assert.deepEqual(fs.readFileSync(f.file), large);
    assert.equal(f.probes(), 0);
  });

  test(`${kind} metadata bounds actual growth at the read boundary`, t => {
    const f = fixture(t, kind); let grew = false;
    const reads = observeReads(t, f.file, () => assert.throws(f.run, f.invalid), {
      beforeRead: () => { if (!grew) { fs.writeFileSync(f.file, large); grew = true; } },
    });
    assert.equal(grew, true, 'exercise content reading, not an earlier validation failure');
    assert.ok(reads.bytes <= f.limit + 1, `read ${reads.bytes} bytes; ceiling is ${f.limit + 1}`);
    t.diagnostic(JSON.stringify({ kind, scenario: 'growth', sourceBytes: large.length, ceiling: f.limit + 1, ...reads }));
    assert.deepEqual(fs.readFileSync(f.file), large);
    assert.equal(f.probes(), 0);
    assert.equal(fs.existsSync(join(f.dir, 'worker.recovery.lock')), false);
  });

  test(`${kind} metadata preserves exact-limit contents with short reads`, t => {
    const f = fixture(t, kind);
    const bytes = kind === 'owner' ? Buffer.concat([f.bytes, Buffer.alloc(f.limit - f.bytes.length, 32)]) : f.bytes;
    fs.writeFileSync(f.file, bytes);
    const reads = observeReads(t, f.file, () => {
      if (kind === 'marker') assert.equal(f.run(), true);
      else assert.throws(f.run, { code: 'LOCK_HELD' });
    }, { chunkSize: 3 });
    assert.equal(reads.bytes, bytes.length);
    assert.deepEqual(fs.readFileSync(f.file), bytes);
    assert.equal(f.probes(), kind === 'marker' ? 0 : 1);
  });

  test(`${kind} metadata keeps I/O error classification and closes the descriptor`, t => {
    const f = fixture(t, kind), failure = Object.assign(Error('fixture read failure'), { code: 'EIO' });
    observeReads(t, f.file, () => assert.throws(f.run,
      kind === 'marker' ? error => error === failure : f.invalid), { beforeRead: () => { throw failure; } });
    assert.deepEqual(fs.readFileSync(f.file), f.bytes);
    assert.equal(f.probes(), 0);
  });

  test(`${kind} metadata rejects directories and hardlinks without reading or modifying them`, t => {
    const f = fixture(t, kind), original = join(f.dir, 'original');
    fs.renameSync(f.file, original);
    for (const type of ['directory', 'hardlink']) {
      if (type === 'directory') fs.mkdirSync(f.file); else fs.linkSync(original, f.file);
      const reads = observeReads(t, f.file, () => assert.throws(f.run, f.invalid));
      assert.deepEqual(reads, { bytes: 0, opens: 0 });
      if (type === 'directory') fs.rmdirSync(f.file); else fs.unlinkSync(f.file);
      assert.deepEqual(fs.readFileSync(original), f.bytes);
    }
  });

  test(`${kind} metadata rejects a symbolic link without following its target`, t => {
    const f = fixture(t, kind), original = join(f.dir, 'original');
    fs.renameSync(f.file, original);
    try { fs.symlinkSync(original, f.file); }
    catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('file symlinks require Windows permission'); throw error; }
    const reads = observeReads(t, f.file, () => assert.throws(f.run, f.invalid));
    assert.deepEqual(reads, { bytes: 0, opens: 0 });
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
