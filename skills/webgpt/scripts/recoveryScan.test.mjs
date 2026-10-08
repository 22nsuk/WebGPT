// Integrity observations use real checked reads and disposable local evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as bounded from './bounded-read.mjs';
import { inspectRecovery } from './workspace.mjs';
import { readFixture, observeFileRead } from './test-fixtures/file-read.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = reason => Object.assign(Error('rejected fixture'), { code: reason });
const scan = (...args) => bounded.scanBoundedFile(...args);
function original(t, bytes) {
  const dir = readFixture(t), recovery = join(dir, 'recovery', 'owned'), operation = randomUUID();
  fs.mkdirSync(recovery, { recursive: true });
  const backup = join(recovery, operation + '.before.txt'), journal = join(recovery, operation + '.json');
  const receipt = { operation, path: 'owned.txt', action: 'edit', beforeSha256: digest(bytes),
    afterSha256: digest('new'), backup };
  fs.writeFileSync(backup, bytes);
  fs.writeFileSync(journal, JSON.stringify({ ...receipt, state: 'applied' }));
  return { dir, backup, journal, receipt };
}

for (const size of [0, 1, 4097, 128 * 1024 + 7]) test(`bounded scan consumes ${size} bytes with short reads and no body retention`, t => {
  const file = join(readFixture(t), 'original'), bytes = Buffer.alloc(size, 0x71);
  fs.writeFileSync(file, bytes);
  const observed = observeFileRead(t, file, { chunkSize: 17 }), hash = createHash('sha256');
  let result, largest = 0, consumed = 0;
  try {
    result = scan(file, size, invalid, chunk => {
      largest = Math.max(largest, chunk.length); consumed += chunk.length; hash.update(chunk);
    });
  } finally { observed.restore(); }
  assert.equal(result.bytesRead, size); assert.equal(consumed, size);
  assert.equal(Object.hasOwn(result, 'bytes'), false);
  assert.equal(hash.digest('hex'), digest(bytes)); assert.ok(largest <= 64 * 1024);
  assert.equal(observed.evidence.bytes, size);
  assert.equal(observed.evidence.opens, 1); assert.equal(observed.evidence.closes, 1);
});

test('bounded scan validates its policy and distinguishes initial from late absence', t => {
  const file = join(readFixture(t), 'original');
  for (const limit of [-1, null, undefined, NaN, Infinity, 0.5])
    assert.throws(() => scan(file, limit, invalid, () => {}), RangeError);
  assert.throws(() => scan(file, 1, invalid, undefined), TypeError);
  assert.equal(scan(file, 1, invalid, () => assert.fail('missing file has no chunks')), null);
  fs.writeFileSync(file, 'a');
  const observed = observeFileRead(t, file, { beforeOpen: () => fs.unlinkSync(file) });
  try { assert.throws(() => scan(file, 1, invalid, () => assert.fail('late absence')), { code: 'ENOENT' }); }
  finally { observed.restore(); }
  assert.equal(observed.evidence.bytes, 0);
});

for (const failure of ['growth', 'identity', 'read', 'consumer']) test(`bounded scan rejects ${failure} and closes its descriptor`, t => {
  const file = join(readFixture(t), 'original'); fs.writeFileSync(file, 'original');
  const fault = Object.assign(Error('fixture failure'), { code: 'EIO' });
  const hooks = failure === 'growth' ? { afterStat: () => fs.appendFileSync(file, 'x'.repeat(100)) }
    : failure === 'identity' ? { beforeOpen: () => { fs.renameSync(file, file + '.saved'); fs.writeFileSync(file, 'original'); } }
    : failure === 'read' ? { beforeRead: () => { throw fault; } } : {};
  const observed = observeFileRead(t, file, hooks);
  try {
    assert.throws(() => scan(file, 8, invalid, () => { if (failure === 'consumer') throw fault; }),
      failure === 'growth' ? { code: 'overflow' } : failure === 'identity' ? { code: 'identity' } : error => error === fault);
  } finally { observed.restore(); }
  assert.equal(observed.evidence.opens, 1); assert.equal(observed.evidence.closes, 1);
  assert.equal(observed.evidence.bytes, failure === 'growth' ? 9 : failure === 'consumer' ? 8 : 0);
});

for (const kind of ['directory', 'hardlink', 'oversized']) test(`bounded scan refuses ${kind} before content I/O`, t => {
  const file = join(readFixture(t), 'original');
  if (kind === 'directory') fs.mkdirSync(file);
  else { fs.writeFileSync(file, 'original'); if (kind === 'hardlink') fs.linkSync(file, file + '.link'); }
  const observed = observeFileRead(t, file);
  try { assert.throws(() => scan(file, kind === 'oversized' ? 7 : 8, invalid, () => assert.fail('untrusted bytes')), { code: 'metadata' }); }
  finally { observed.restore(); }
  assert.equal(observed.evidence.opens, 0); assert.equal(observed.evidence.bytes, 0);
});

test('recovery inspections reread every byte without whole-backup concatenation or string decoding', t => {
  const bytes = Buffer.from('\ufeff한글 🧪\r\n'.repeat(65536)), f = original(t, bytes);
  const observed = observeFileRead(t, f.backup), concat = Buffer.concat, decode = Buffer.prototype.toString;
  let concatenated = 0, decoded = 0;
  const mocks = [
    t.mock.method(Buffer, 'concat', function (chunks, size) {
      if (size > 64 * 1024) concatenated += size;
      return concat(chunks, size);
    }),
    t.mock.method(Buffer.prototype, 'toString', function (...args) {
      if (this.length > 64 * 1024) decoded += this.length;
      return Reflect.apply(decode, this, args);
    }),
  ];
  try {
    for (let i = 0; i < 2; i++) assert.deepEqual(inspectRecovery(f.dir, 'owned'), { receipts: [f.receipt], unresolved: [] });
  } finally { for (const mock of mocks) mock.mock.restore(); observed.restore(); }
  t.diagnostic(JSON.stringify({ originalBytes: bytes.length, scans: observed.evidence.opens,
    verifiedBytes: observed.evidence.bytes, wholeBackupConcatBytes: concatenated, wholeBackupDecodedBytes: decoded }));
  assert.equal(observed.evidence.bytes, bytes.length * 2);
  assert.equal(observed.evidence.opens, 2); assert.equal(observed.evidence.closes, 2);
  assert.equal(concatenated, 0); assert.equal(decoded, 0);
  assert.deepEqual(fs.readFileSync(f.backup), bytes);
});

for (const [width, text] of [[2, 'é'], [3, '한'], [4, '🧪']]) for (let split = 1; split < width; split++) {
  test(`recovery accepts a ${width}-byte UTF-8 sequence split after byte ${split}`, t => {
    const bytes = Buffer.concat([Buffer.alloc(4096 - split, 0x78), Buffer.from(text + '\ufeff\r\n')]);
    const f = original(t, bytes);
    assert.deepEqual(inspectRecovery(f.dir, 'owned'), { receipts: [f.receipt], unresolved: [] });
  });
}

for (const [label, tail] of [
  ['truncated', [0xf0, 0x9f, 0xa7]], ['invalid continuation', [0xe2, 0x28, 0xa1]],
  ['overlong', [0xc0, 0xaf]], ['surrogate', [0xed, 0xa0, 0x80]], ['NUL', [0]],
]) test(`recovery rejects ${label} even with a matching stored SHA`, t => {
  const f = original(t, Buffer.concat([Buffer.alloc(4095, 0x78), Buffer.from(tail)]));
  const observed = observeFileRead(t, f.backup);
  try { assert.deepEqual(inspectRecovery(f.dir, 'owned'), { receipts: [], unresolved: [f.journal] }); }
  finally { observed.restore(); }
  assert.equal(observed.evidence.opens, 1); assert.equal(observed.evidence.closes, 1);
});

test('recovery retains the exact 10 MiB allowance and detects later same-size corruption', t => {
  const bytes = Buffer.alloc(10 * 1024 * 1024, 0x78), f = original(t, bytes);
  assert.deepEqual(inspectRecovery(f.dir, 'owned'), { receipts: [f.receipt], unresolved: [] });
  const before = fs.statSync(f.backup), changed = Buffer.from(bytes); changed[changed.length - 1] = 0x79;
  fs.writeFileSync(f.backup, changed); fs.utimesSync(f.backup, before.atime, before.mtime);
  assert.deepEqual(inspectRecovery(f.dir, 'owned'), { receipts: [], unresolved: [f.journal] });
  assert.deepEqual(fs.readFileSync(f.backup), changed);
  assert.equal(fs.statSync(f.backup).ino, before.ino);
});


test('bounded scan rejects a known and substituted POSIX FIFO without waiting for a writer',
  { skip: process.platform === 'win32' ? 'POSIX filesystem FIFO contract' : false }, t => {
    const dir = readFixture(t), file = join(dir, 'original'), fifo = join(dir, 'fifo');
    fs.writeFileSync(file, 'original');
    const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
    assert.ifError(made.error); assert.equal(made.status, 0, made.stderr);
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import test from 'node:test';
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { scanBoundedFile } from ${JSON.stringify(new URL('./bounded-read.mjs', import.meta.url).href)};
      import { observeFileRead } from ${JSON.stringify(new URL('./test-fixtures/file-read.mjs', import.meta.url).href)};
      const file = ${JSON.stringify(file)}, fifo = ${JSON.stringify(fifo)};
      const reject = reason => Object.assign(Error('rejected'), { code: reason });
      test('FIFO inspection', t => {
        assert.throws(() => scanBoundedFile(fifo, 8, reject, () => assert.fail('FIFO bytes')), { code: 'metadata' });
        const observed = observeFileRead(t, file, { beforeOpen() {
          fs.renameSync(file, file + '.saved'); fs.renameSync(fifo, file);
        } });
        try { assert.throws(() => scanBoundedFile(file, 8, reject, () => assert.fail('FIFO bytes')), { code: 'metadata' }); }
        finally { observed.restore(); }
        assert.deepEqual(observed.evidence, { opens: 1, closes: 1, bytes: 0, reads: 0 });
        assert.ok(fs.lstatSync(file).isFIFO());
        assert.equal(fs.readFileSync(file + '.saved', 'utf8'), 'original');
      });
    `], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
    assert.ifError(child.error); assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
