import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { stateBytesEqual, readStateBytes } from './runtime.mjs';
import { readFixture, observeFileRead } from './test-fixtures/file-read.mjs';

const bytes = Buffer.alloc(200000, 97);
function fixture(t, content = bytes) {
  const file = join(readFixture(t), 'state.json');
  fs.writeFileSync(file, content);
  return file;
}

test('each comparison freshly reads all bytes, including short reads', t => {
  const file = fixture(t), trace = observeFileRead(t, file, { chunkSize: 137 });
  try {
    for (let i = 0; i < 3; i++) assert.equal(stateBytesEqual(file, bytes), true);
  } finally { trace.restore(); }
  assert.equal(trace.evidence.bytes, 3 * bytes.length);
  assert.equal(trace.evidence.opens, 3);
  assert.equal(trace.evidence.closes, 3);
  assert.ok(trace.evidence.reads > 3 * bytes.length / 137);
});

for (const position of [0, 4095, 4096, 12287, 12288, bytes.length - 1]) {
  test(`corruption at ${position} with restored mtime still scans to EOF`, t => {
    const file = fixture(t), info = fs.statSync(file), corrupt = Buffer.from(bytes);
    corrupt[position] ^= 1;
    fs.writeFileSync(file, corrupt);
    fs.utimesSync(file, info.atime, info.mtime);
    const trace = observeFileRead(t, file);
    try { assert.equal(stateBytesEqual(file, bytes), false); }
    finally { trace.restore(); }
    assert.equal(trace.evidence.bytes, corrupt.length);
    assert.equal(trace.evidence.closes, 1);
    assert.deepEqual(fs.readFileSync(file), corrupt);
  });
}

for (const content of [Buffer.alloc(bytes.length + 100000, 97), bytes.subarray(0, 5000)]) {
  test(`concurrent size change to ${content.length} reads the actual EOF`, t => {
    const file = fixture(t), trace = observeFileRead(t, file, {
      afterStat: () => fs.writeFileSync(file, content), chunkSize: 311
    });
    try { assert.equal(stateBytesEqual(file, bytes), false); }
    finally { trace.restore(); }
    assert.equal(trace.evidence.bytes, content.length);
    assert.equal(trace.evidence.closes, 1);
  });
}

test('absence differs from empty, and null expectation still scans present content', t => {
  const file = fixture(t, Buffer.alloc(0));
  assert.equal(stateBytesEqual(file, Buffer.alloc(0)), true);
  assert.equal(stateBytesEqual(file, null), false);
  fs.unlinkSync(file);
  assert.equal(stateBytesEqual(file, null), true);
  assert.equal(stateBytesEqual(file, Buffer.alloc(0)), false);
  fs.writeFileSync(file, bytes);
  const trace = observeFileRead(t, file);
  try { assert.equal(stateBytesEqual(file, null), false); }
  finally { trace.restore(); }
  assert.equal(trace.evidence.bytes, bytes.length);
  assert.equal(trace.evidence.closes, 1);
});

test('identical private replacement between calls is compatible', t => {
  const file = fixture(t);
  assert.equal(stateBytesEqual(file, bytes), true);
  fs.renameSync(file, file + '.old');
  fs.writeFileSync(file, bytes);
  assert.equal(stateBytesEqual(file, bytes), true);
  assert.deepEqual(readStateBytes(file), bytes);
});

for (const kind of ['replacement', 'disappearance']) {
  test(`pre-open ${kind} retains failure semantics`, t => {
    const file = fixture(t), trace = observeFileRead(t, file, { beforeOpen() {
      fs.renameSync(file, file + '.old');
      if (kind === 'replacement') fs.writeFileSync(file, bytes);
    } });
    try {
      assert.throws(() => stateBytesEqual(file, bytes),
        { code: kind === 'replacement' ? 'STATE_INVALID' : 'ENOENT' });
    } finally { trace.restore(); }
    assert.equal(trace.evidence.bytes, 0);
    assert.equal(trace.evidence.closes, kind === 'replacement' ? 1 : 0);
    assert.deepEqual(fs.readFileSync(file + '.old'), bytes);
  });
}

for (const kind of ['hardlink', 'symlink', 'dangling', 'directory']) {
  test(`strict state policy rejects ${kind}`, t => {
    const file = fixture(t), target = file + '.target';
    if (kind === 'hardlink') fs.linkSync(file, target);
    else {
      fs.renameSync(file, target);
      if (kind === 'directory') fs.mkdirSync(file);
      else {
        try { fs.symlinkSync(kind === 'dangling' ? target + '.missing' : target, file, 'file'); }
        catch (error) {
          if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code))
            return t.skip('native file symlink creation is unavailable');
          throw error;
        }
      }
    }
    const trace = observeFileRead(t, file);
    try { assert.throws(() => stateBytesEqual(file, bytes), { code: 'STATE_INVALID' }); }
    finally { trace.restore(); }
    assert.equal(trace.evidence.opens, 0);
    assert.deepEqual(fs.readFileSync(target), bytes);
  });
}

test('native EIO after a mismatching chunk overrides false and closes the descriptor', t => {
  const file = fixture(t), corrupt = Buffer.from(bytes);
  corrupt[0] ^= 1;
  fs.writeFileSync(file, corrupt);
  const trace = observeFileRead(t, file), native = fs.readSync;
  const failure = Object.assign(Error('injected native read failure'), { code: 'EIO' });
  let reads = 0;
  const mock = t.mock.method(fs, 'readSync', (...args) => {
    if (++reads === 2) throw failure;
    return native(...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => stateBytesEqual(file, bytes), error => error === failure); }
  finally { mock.mock.restore(); trace.restore(); }
  assert.equal(trace.evidence.bytes, 4096);
  assert.equal(trace.evidence.closes, 1);
  assert.deepEqual(fs.readFileSync(file), corrupt);
});
