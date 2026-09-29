import test from 'node:test';
import assert from 'node:assert/strict';
import fs, * as fsExports from 'node:fs';
import { constants } from 'node:buffer';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { readBoundedFile } from './bounded-read.mjs';
import { readFixture, observeFileRead } from './test-fixtures/file-read.mjs';

// Capture before any serial test installs mocks; assertions inside a test's finally
// cannot see the automatic MockTracker reset that runs after that test returns.
const nativeMethods = Object.fromEntries(
  ['lstatSync', 'openSync', 'fstatSync', 'readSync', 'readFileSync', 'closeSync', 'statSync']
    .map(name => [name, Object.getOwnPropertyDescriptor(fs, name)]));

const invalid = reason => Object.assign(Error('fixture file rejected'), { code: 'FIXTURE_INVALID', reason });
const rejected = reason => ({ code: 'FIXTURE_INVALID', reason });
function fixture(t, bytes = Buffer.from('exact 한국어 🧪\r\n')) {
  const file = join(readFixture(t), 'input'); fs.writeFileSync(file, bytes);
  return { file, bytes };
}

test('bounded file validates policy before filesystem access', t => {
  const lookup = t.mock.method(fs, 'lstatSync', () => assert.fail('no filesystem access'));
  syncBuiltinESMExports();
  try {
    for (const limit of [undefined, null, -1, 0.5, '1', NaN, Infinity, constants.MAX_LENGTH, Number.MAX_SAFE_INTEGER])
      assert.throws(() => readBoundedFile('unused', limit, invalid), RangeError);
    for (const factory of [undefined, null, {}, 1])
      assert.throws(() => readBoundedFile('unused', 1, factory), TypeError);
    assert.equal(lookup.mock.callCount(), 0);
  } finally { lookup.mock.restore(); syncBuiltinESMExports(); }
});

test('bounded file distinguishes absent and empty files even at a zero-byte limit', t => {
  const { file } = fixture(t, Buffer.alloc(0));
  assert.equal(readBoundedFile(file + '.missing', 0, invalid), null);
  const trace = observeFileRead(t, file);
  let result;
  try { result = readBoundedFile(file, 0, invalid); } finally { trace.restore(); }
  assert.deepEqual(result.bytes, Buffer.alloc(0)); assert.equal(result.stat.size, 0n);
  assert.deepEqual(trace.evidence, { opens: 1, closes: 1, reads: 1, bytes: 0 });
});

for (const bytes of [Buffer.from([0, 255, 192, 128]), Buffer.from('\uFEFF한국어 🧪\r\n')]) {
  test(`bounded file preserves opaque ${bytes.length}-byte input and opened metadata through short reads`, t => {
    const { file } = fixture(t, bytes), trace = observeFileRead(t, file, { chunkSize: 3 });
    let result;
    try { result = readBoundedFile(file, bytes.length, invalid); } finally { trace.restore(); }
    assert.deepEqual(result.bytes, bytes);
    assert.equal(result.stat.dev, fs.statSync(file, { bigint: true }).dev); assert.equal(result.stat.ino, fs.statSync(file, { bigint: true }).ino);
    assert.equal(trace.evidence.bytes, bytes.length); assert.equal(trace.evidence.closes, 1);
  });
}

for (const kind of ['oversized', 'directory', 'hardlink', 'symlink', 'dangling']) {
  test(`bounded file rejects known ${kind} before opening content and preserves evidence`, t => {
    const { file, bytes } = fixture(t), target = file + '.target';
    if (kind === 'directory') { fs.unlinkSync(file); fs.mkdirSync(file); }
    if (kind === 'hardlink') fs.linkSync(file, target);
    if (kind === 'symlink' || kind === 'dangling') {
      fs.renameSync(file, target);
      try { fs.symlinkSync(kind === 'dangling' ? target + '.missing' : target, file, 'file'); }
      catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code))
          return t.skip('native file symlink creation is unavailable');
        throw error;
      }
    }
    const trace = observeFileRead(t, file);
    try { assert.throws(() => readBoundedFile(file, kind === 'oversized' ? bytes.length - 1 : 4096, invalid), rejected('metadata')); }
    finally { trace.restore(); }
    assert.equal(trace.evidence.opens, 0); assert.equal(trace.evidence.bytes, 0);
    if (kind === 'directory') assert.ok(fs.lstatSync(file).isDirectory());
    else if (kind === 'symlink' || kind === 'dangling') {
      assert.ok(fs.lstatSync(file).isSymbolicLink()); assert.deepEqual(fs.readFileSync(target), bytes);
      assert.equal(fs.existsSync(target + '.missing'), false);
    } else assert.deepEqual(fs.readFileSync(file), bytes);
  });
}

for (const property of ['size', 'nlink', 'isFile']) test(`bounded file rechecks opened ${property} before reading`, t => {
  const { file, bytes } = fixture(t), trace = observeFileRead(t, file);
  const native = fs.fstatSync;
  const mock = t.mock.method(fs, 'fstatSync', (...args) => {
    const info = native(...args);
    if (property === 'size') info.size = BigInt(bytes.length) + 1n;
    if (property === 'nlink') info.nlink = 2n;
    if (property === 'isFile') info.isFile = () => false;
    return info;
  });
  syncBuiltinESMExports();
  try { assert.throws(() => readBoundedFile(file, bytes.length, invalid), rejected('metadata')); }
  finally {
    // This test owns both layers. Disassociate them before restoring in reverse
    // order, or automatic test cleanup can reinstall the inner layer's observer.
    t.mock.reset(); mock.mock.restore(); trace.restore();
  }
  assert.equal(trace.evidence.bytes, 0); assert.equal(trace.evidence.closes, 1);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

for (const [method, code, closed] of [
  ['lstatSync', 'EACCES', 0], ['openSync', 'ENOENT', 0], ['fstatSync', 'EIO', 1],
  ['readSync', 'EIO', 1], ['closeSync', 'EIO', 1],
]) test(`bounded file preserves native ${method} ${code} rather than domain success or absence`, t => {
  const { file, bytes } = fixture(t), trace = observeFileRead(t, file), native = fs[method];
  const failure = Object.assign(Error('native fixture failure'), { code });
  const mock = t.mock.method(fs, method, (...args) => {
    if (method === 'closeSync') native(...args); // Actually close the fixture, then surface its injected failure.
    throw failure;
  });
  syncBuiltinESMExports();
  try { assert.throws(() => readBoundedFile(file, bytes.length, invalid), error => error === failure); }
  finally { t.mock.reset(); mock.mock.restore(); trace.restore(); }
  assert.equal(trace.evidence.closes, closed); assert.deepEqual(fs.readFileSync(file), bytes);
});

test('bounded file allows within-budget growth; it is not an initial-size snapshot', t => {
  const { file } = fixture(t, Buffer.from('a')), grown = Buffer.from('abcdef');
  const trace = observeFileRead(t, file, { beforeRead: () => fs.writeFileSync(file, grown), chunkSize: 2 });
  let result;
  try { result = readBoundedFile(file, grown.length, invalid); } finally { trace.restore(); }
  assert.deepEqual(result.bytes, grown); assert.equal(result.stat.size, 1n);
  assert.equal(trace.evidence.bytes, grown.length); assert.equal(trace.evidence.closes, 1);
});

test('bounded file rejects overflow before domain decoding and preserves the rejection identity', t => {
  const { file } = fixture(t, Buffer.alloc(0)), failure = Error('domain overflow');
  const trace = observeFileRead(t, file, { beforeRead: () => fs.writeFileSync(file, 'xx') });
  try { assert.throws(() => readBoundedFile(file, 0, reason => {
    assert.equal(reason, 'overflow'); return failure;
  }), error => error === failure); } finally { trace.restore(); }
  assert.equal(trace.evidence.bytes, 1); assert.equal(trace.evidence.closes, 1);
});

for (const hook of ['beforeRead', 'afterStat']) {
  test(`native read instrumentation ignores its own growth writes at ${hook}`, t => {
    const { file, bytes } = fixture(t);
    let calls = 0;
    const trace = observeFileRead(t, file, { [hook]() { calls++; fs.writeFileSync(file, 'changed'); } });
    try {
      const result = readBoundedFile(file, 128, invalid);
      assert.equal(result.bytes.toString(), 'changed');
      assert.equal(result.stat.size, BigInt(bytes.length), 'retain the real pre-growth metadata observation');
    } finally { trace.restore(); }
    assert.equal(calls, 1);
    assert.equal(trace.evidence.opens, 1); assert.equal(trace.evidence.closes, 1); assert.equal(trace.evidence.bytes, 7);
  });
}

test('native read instrumentation scopes stat hooks across opens and restores only its own mocks', t => {
  const { file } = fixture(t, Buffer.from('first')), other = file + '.other';
  fs.writeFileSync(other, 'unrelated');
  const native = Object.fromEntries(['openSync', 'fstatSync', 'readSync', 'readFileSync', 'closeSync'].map(name => [name, fs[name]]));
  const unrelated = t.mock.method(fs, 'statSync', fs.statSync);
  t.after(() => { unrelated.mock.restore(); syncBuiltinESMExports(); });
  let calls = 0, bytesBeforeGrowth;
  const trace = observeFileRead(t, file, { afterStat() {
    if (++calls === 2) {
      bytesBeforeGrowth = trace.evidence.bytes;
      fs.writeFileSync(file, 'second');
    }
  } });
  try {
    const fd = fs.openSync(other, 'r');
    try { assert.equal(fs.fstatSync(fd).size, 9); } finally { fs.closeSync(fd); }
    assert.equal(calls, 0, 'unrelated file metadata must not trigger the hook');
    assert.equal(readBoundedFile(file, 128, invalid).bytes.toString(), 'first');
    const result = readBoundedFile(file, 128, invalid);
    assert.equal(result.bytes.toString(), 'second'); assert.equal(result.stat.size, 5n);
  } finally { trace.restore(); }
  assert.equal(calls, 2); assert.equal(bytesBeforeGrowth, 5);
  assert.equal(trace.evidence.bytes - bytesBeforeGrowth, 6);
  assert.equal(trace.evidence.opens, 2); assert.equal(trace.evidence.closes, 2);

  const failure = Error('stat hook fixture');
  const failed = observeFileRead(t, file, { afterStat() { throw failure; } });
  try { assert.throws(() => readBoundedFile(file, 128, invalid), error => error === failure); }
  finally { failed.restore(); }
  assert.equal(failed.evidence.opens, 1); assert.equal(failed.evidence.closes, 1); assert.equal(failed.evidence.bytes, 0);
  for (const [name, fn] of Object.entries(native)) assert.equal(fs[name], fn, `${name} restored`);
  assert.equal(fs.statSync, unrelated, 'restoration must not clear a caller-owned mock');
});

// A 64-bit identity can differ while its Number representation is identical.
// Only the identity fields are injected; metadata, descriptors and bytes stay real.
for (const property of ['dev', 'ino']) test(`bounded file compares full-width ${property} without Number collisions`, t => {
  const { file, bytes } = fixture(t), first = 2n ** 60n, second = first + 1n;
  assert.notEqual(first, second); assert.equal(Number(first), Number(second));
  for (const changed of [false, true]) {
    const trace = observeFileRead(t, file), nativeStat = fs.lstatSync, nativeOpened = fs.fstatSync;
    const named = t.mock.method(fs, 'lstatSync', (path, options) => {
      const info = nativeStat(path, options);
      if (path === file) info[property] = options?.bigint ? first : Number(first);
      return info;
    });
    const opened = t.mock.method(fs, 'fstatSync', (fd, options) => {
      const info = nativeOpened(fd, options), value = changed ? second : first;
      info[property] = options?.bigint ? value : Number(value);
      return info;
    });
    syncBuiltinESMExports();
    try {
      if (changed) assert.throws(() => readBoundedFile(file, bytes.length, invalid), rejected('identity'));
      else assert.deepEqual(readBoundedFile(file, bytes.length, invalid).bytes, bytes);
    } finally { t.mock.reset(); opened.mock.restore(); named.mock.restore(); trace.restore(); }
    assert.equal(trace.evidence.opens, 1); assert.equal(trace.evidence.closes, 1);
    assert.equal(trace.evidence.bytes, changed ? 0 : bytes.length);
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
});

// Keep this check after the fault cases: it observes their completed test cleanup,
// not just manual restoration while the same TestContext is still active.
test('bounded file instrumentation leaves native filesystem bindings intact after test cleanup', () => {
  for (const [name, descriptor] of Object.entries(nativeMethods)) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(fs, name), descriptor, `${name} default binding after cleanup`);
    assert.equal(fsExports[name], descriptor.value, `${name} ESM binding after cleanup`);
  }
});
