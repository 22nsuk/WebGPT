import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildArtifactInput, serializeArtifactInput, MAX_SOURCE_BYTES, MAX_WINDOW_BYTES, MAX_INPUT_BYTES } from './artifact-input.mjs';

const script = fileURLToPath(new URL('./artifact-input.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const code = expected => error => error.code === expected;
function fixture(t, bytes = 'hello\n') {
  const dir = fs.mkdtempSync(join(tmpdir(), 'webgpt-artifact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source 한글 #.bin');
  fs.writeFileSync(source, bytes);
  return { dir, source, label: 'fixture' };
}
const cli = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 });
const text = (f, ranges) => buildArtifactInput({ ...f, view: 'text', ranges });

test('metadata hashes a >1 MiB file without returning bytes or private paths', t => {
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 7, 0xa5);
  const f = fixture(t, bytes);
  const result = buildArtifactInput(f);
  assert.deepEqual(result, { kind: 'webgpt-artifact-input', version: 1,
    source: { label: 'fixture', sizeBytes: bytes.length, sha256: hash(bytes) },
    view: 'metadata', textValidation: null, omittedBytes: bytes.length, windows: [] });
  assert.ok(!serializeArtifactInput(result).includes(f.source));
  assert.deepEqual(fs.readFileSync(f.source), bytes);
});

test('one scan returns sorted nonoverlapping windows across read-block boundaries', t => {
  const bytes = Buffer.from('0123456789abcdef'.repeat(150000));
  const f = fixture(t, bytes);
  const original = fs.readSync;
  let requested = 0;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    requested += length;
    assert.ok(buffer.length <= 64 * 1024);
    return original(fd, buffer, offset, length, position);
  });
  const result = text(f, [{ offset: 131060, length: 24 }, { offset: 65530, length: 20 }]);
  assert.equal(result.source.sha256, hash(bytes));
  assert.equal(result.omittedBytes, bytes.length - 44);
  assert.equal(result.textValidation, 'selected-windows-only');
  assert.deepEqual(result.windows.map(w => w.offsetBytes), [65530, 131060]);
  for (const window of result.windows) {
    const selected = bytes.subarray(window.offsetBytes, window.endExclusiveBytes);
    assert.equal(window.content, selected.toString('utf8'));
    assert.equal(window.sha256, hash(selected));
    assert.equal(window.truncatedAtEof, false);
  }
  assert.ok(requested <= bytes.length + 2, 'single full scan including EOF sentinel, not one scan per window');
});

test('text preserves BOM, CRLF, Unicode and JSON escaping; it does not normalize', t => {
  const bytes = Buffer.from('\ufeff안녕\r\n"\\\t😀\n');
  const f = fixture(t, bytes);
  const result = text(f, [{ offset: 0, length: bytes.length }]);
  assert.equal(result.windows[0].content, bytes.toString('utf8'));
  assert.equal(result.windows[0].sha256, hash(bytes));
  assert.equal(result.omittedBytes, 0);
  assert.deepEqual(JSON.parse(serializeArtifactInput(result)), result);
});

test('hex is exact for binary bytes; UTF-8 scope never certifies bytes outside selected windows', t => {
  const bytes = Buffer.from([0, 255, 0x61, 0x62, 0xc0]);
  const f = fixture(t, bytes);
  const result = buildArtifactInput({ ...f, view: 'hex', ranges: [{ offset: 0, length: 10 }] });
  assert.equal(result.windows[0].content, '00ff6162c0');
  assert.equal(result.windows[0].truncatedAtEof, true);
  assert.equal(result.windows[0].returnedBytes, 5);
  assert.equal(result.windows[0].requestedBytes, 10);
  assert.equal(result.windows[0].sha256, hash(bytes));
  assert.equal(result.omittedBytes, 0);
  assert.equal(text(f, [{ offset: 2, length: 2 }]).windows[0].content, 'ab');
  assert.equal(text(f, [{ offset: 2, length: 2 }]).textValidation, 'selected-windows-only');
});

test('empty sources and EOF windows are explicit, not evidence of a successful command', t => {
  const f = fixture(t, '');
  const result = text(f, [{ offset: 0, length: 20 }]);
  assert.equal(result.source.sha256, hash(''));
  assert.deepEqual(result.windows[0], { offsetBytes: 0, requestedBytes: 20, returnedBytes: 0,
    endExclusiveBytes: 0, truncatedAtEof: true, sha256: hash(''), content: '' });
  assert.equal(result.omittedBytes, 0);
  assert.equal(Object.hasOwn(result, 'exitCode'), false);
  assert.equal(Object.hasOwn(result, 'passed'), false);
  assert.throws(() => text(f, [{ offset: 1, length: 1 }]), code('INVALID_ARGUMENT'));
});

test('invalid, overlong, NUL and split UTF-8 windows reject without replacement decoding', t => {
  for (const bytes of [Buffer.from([255]), Buffer.from([0xc0, 0xaf]), Buffer.from('a\0b')]) {
    const f = fixture(t, bytes);
    assert.throws(() => text(f, [{ offset: 0, length: bytes.length }]), code('UNSUPPORTED_TEXT'));
  }
  const f = fixture(t, '가나다');
  assert.throws(() => text(f, [{ offset: 1, length: 2 }]), code('UNSUPPORTED_TEXT'));
  assert.throws(() => text(f, [{ offset: 0, length: 2 }]), code('UNSUPPORTED_TEXT'));
  assert.equal(text(f, [{ offset: 0, length: 3 }]).windows[0].content, '가');
});

test('argument validation rejects unsafe, ambiguous and excessive requests before I/O', t => {
  const f = fixture(t);
  for (const patch of [
    { source: 'relative' }, { source: f.source + '\0' }, { label: '../secret' }, { label: '' },
    { label: 'x'.repeat(65) }, { view: 'base64' }, { ranges: null },
    { ranges: [{ offset: 0, length: 1 }] }, { view: 'text' }, { expectedSha256: null },
    { expectedSha256: 'A'.repeat(64) }, { expectedSha256: 'f'.repeat(63) },
  ]) assert.throws(() => buildArtifactInput({ ...f, ...patch }), code('INVALID_ARGUMENT'));
  for (const ranges of [
    [null], [{ offset: -1, length: 1 }], [{ offset: 0, length: 0 }],
    [{ offset: 0.5, length: 1 }], [{ offset: 0, length: Infinity }],
    [{ offset: Number.MAX_SAFE_INTEGER, length: 1 }],
    [{ offset: 0, length: MAX_WINDOW_BYTES + 1 }],
    Array.from({ length: 9 }, (_, i) => ({ offset: i, length: 1 })),
    [{ offset: 0, length: 2 }, { offset: 1, length: 2 }],
    [{ offset: 0, length: 1 }, { offset: 0, length: 1 }],
  ]) assert.throws(() => text(f, ranges), code('INVALID_ARGUMENT'));
});

test('adjacent windows and maximum aggregate window/JSON budgets work without silent clipping', t => {
  const f = fixture(t, '\u0001'.repeat(MAX_WINDOW_BYTES));
  const result = text(f, Array.from({ length: 8 }, (_, i) => ({ offset: i * 1024, length: 1024 })));
  const encoded = serializeArtifactInput(result);
  assert.ok(Buffer.byteLength(encoded) <= MAX_INPUT_BYTES);
  assert.equal(result.omittedBytes, 0);
  assert.equal(result.windows.reduce((n, w) => n + w.returnedBytes, 0), MAX_WINDOW_BYTES);
  assert.throws(() => serializeArtifactInput({ content: 'x'.repeat(MAX_INPUT_BYTES) }), code('INPUT_TOO_LARGE'));
});

test('whole-source pin rejects changes outside a returned window', t => {
  const f = fixture(t, 'abc\nold');
  const first = text(f, [{ offset: 0, length: 3 }]);
  assert.deepEqual(buildArtifactInput({ ...f, expectedSha256: first.source.sha256 }), buildArtifactInput(f));
  fs.writeFileSync(f.source, 'abc\nnew');
  assert.throws(() => buildArtifactInput({ ...f, expectedSha256: first.source.sha256 }), code('REVISION_CONFLICT'));
});

test('oversized sources reject before opening/reading; the cap is not a prefix hash', t => {
  const f = fixture(t);
  const fd = fs.openSync(f.source, 'r+');
  try { fs.ftruncateSync(fd, MAX_SOURCE_BYTES + 1); } finally { fs.closeSync(fd); }
  const open = t.mock.method(fs, 'openSync', () => assert.fail('must reject before open'));
  assert.throws(() => buildArtifactInput(f), code('SOURCE_TOO_LARGE'));
  assert.equal(open.mock.callCount(), 0);
});

test('short reads refill correctly without exposing uninitialized buffer bytes', t => {
  const f = fixture(t, '0123456789abcdef'.repeat(50));
  const original = fs.readSync;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) =>
    original(fd, buffer, offset, Math.min(7, length), position));
  const result = text(f, [{ offset: 5, length: 37 }]);
  assert.equal(result.windows[0].content, '0123456789abcdef'.repeat(50).slice(5, 42));
  assert.equal(result.source.sha256, hash('0123456789abcdef'.repeat(50)));
});

test('growth is rejected after at most initial size plus one byte; descriptor closes', t => {
  const f = fixture(t, 'a'.repeat(100));
  const read = fs.readSync, close = fs.closeSync;
  let changed = false, consumed = 0, closed = 0;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    const n = read(fd, buffer, offset, length, position);
    consumed += n;
    if (!changed) { changed = true; fs.appendFileSync(f.source, 'b'.repeat(10000)); }
    return n;
  });
  t.mock.method(fs, 'closeSync', fd => { closed++; return close(fd); });
  assert.throws(() => buildArtifactInput(f), code('SOURCE_CHANGED'));
  assert.equal(consumed, 101);
  assert.ok(closed >= 1);
});

test('shrink during read rejects rather than certifying a truncated source', t => {
  const f = fixture(t, 'a'.repeat(100000));
  const read = fs.readSync;
  let altered = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const n = read(...args);
    if (!altered) { altered = true; fs.truncateSync(f.source, 2); }
    return n;
  });
  assert.throws(() => buildArtifactInput(f), code('SOURCE_CHANGED'));
});

test('same-size concurrent edits are rejected by post-read identity/metadata checks', t => {
  const f = fixture(t, 'original');
  const read = fs.readSync;
  let altered = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const n = read(...args);
    if (!altered) {
      altered = true;
      fs.writeFileSync(f.source, 'modified');
      fs.utimesSync(f.source, new Date(0), new Date(0));
    }
    return n;
  });
  assert.throws(() => buildArtifactInput(f), code('SOURCE_CHANGED'));
});

test('path replacement with identical bytes is not the original file revision', t => {
  const f = fixture(t, 'original');
  const read = fs.readSync;
  let altered = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const n = read(...args);
    if (!altered) {
      altered = true;
      fs.renameSync(f.source, join(f.dir, 'original-moved'));
      fs.writeFileSync(f.source, 'original');
    }
    return n;
  });
  assert.throws(() => buildArtifactInput(f), code('SOURCE_CHANGED'));
});

test('directories and hard-linked sources are rejected', t => {
  const f = fixture(t);
  assert.throws(() => buildArtifactInput({ ...f, source: f.dir }), code('UNSUPPORTED_SOURCE'));
  fs.linkSync(f.source, join(f.dir, 'hard-link'));
  assert.throws(() => buildArtifactInput(f), code('UNSUPPORTED_SOURCE'));
});

test('symlink source is rejected even when its target is a permitted regular file', t => {
  const f = fixture(t);
  const link = join(f.dir, 'symlink');
  try { fs.symlinkSync(f.source, link, 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('symlink creation not permitted'); return; } throw error; }
  assert.throws(() => buildArtifactInput({ ...f, source: link }), code('UNSUPPORTED_SOURCE'));
});

test('CLI creates UTF-8 evidence exclusively and returns a verifiable receipt, not source content', t => {
  const f = fixture(t, '\ufeff한글\r\n');
  const out = join(f.dir, 'evidence 한글 #.json');
  const result = cli(['--source', f.source, '--label', f.label, '--out', out, '--view', 'text', '--range', '0:20']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const bytes = fs.readFileSync(out);
  const receipt = JSON.parse(result.stdout);
  assert.deepEqual(receipt, { ok: true, inputBytes: bytes.length, sha256: hash(bytes) });
  assert.equal(JSON.parse(bytes.toString('utf8')).windows[0].content, '\ufeff한글\r\n');
  assert.equal(fs.readFileSync(f.source, 'utf8'), '\ufeff한글\r\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

test('CLI never overwrites the source or an existing evidence file', t => {
  const f = fixture(t);
  const out = join(f.dir, 'existing.json');
  fs.writeFileSync(out, 'preserve');
  for (const target of [f.source, out]) {
    const result = cli(['--source', f.source, '--label', f.label, '--out', target]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 'EEXIST');
    assert.ok(!result.stderr.includes(f.dir));
  }
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'hello\n');
  assert.equal(fs.readFileSync(out, 'utf8'), 'preserve');
});

test('CLI rejects stale pins and invalid UTF-8 before creating any output', t => {
  const f = fixture(t, Buffer.from([255]));
  const out = join(f.dir, 'evidence.json');
  for (const extra of [['--expected-sha256', '0'.repeat(64)], ['--view', 'text', '--range', '0:1']]) {
    const result = cli(['--source', f.source, '--label', f.label, '--out', out, ...extra]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(out), false);
  }
});

test('CLI accepts repeated ranges but rejects duplicate options, unsafe numbers, commands and positional input', t => {
  const f = fixture(t, 'abcdef');
  const out = join(f.dir, 'evidence.json');
  const base = ['--source', f.source, '--label', f.label, '--out', out];
  for (const extra of [
    ['--source', f.source], ['--view', 'text', '--range', '1e3:2'],
    ['--view', 'hex', '--range', '01:2'], ['--view', 'text', '--range', '9007199254740992:1'],
    ['--view', 'text', '--range', '0:0'], ['--command', 'private-secret'], ['private-secret'], ['--help'],
  ]) {
    const result = cli([...base, ...extra]);
    assert.equal(result.status, 1, JSON.stringify(extra));
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(out), false);
    assert.ok(!result.stderr.includes('private-secret'));
  }
  const result = cli([...base, '--view', 'text', '--range', '4:2', '--range', '0:2']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).windows.map(w => w.content), ['ab', 'ef']);
});

test('CLI filesystem errors do not disclose absolute paths, and help does not read files', t => {
  const f = fixture(t);
  const missing = join(f.dir, 'private-missing');
  const result = cli(['--source', missing, '--label', f.label, '--out', join(f.dir, 'out')]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, 'ENOENT');
  assert.ok(!result.stderr.includes(f.dir));
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Parent-only/);
  assert.equal(help.stderr, '');
});
