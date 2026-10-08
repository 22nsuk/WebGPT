import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resultMessages, saveReviewedResult } from './result-export.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const review = content => ({ id: 'owned', status: 'completed', content, integrity: 'verified', sha256: hash(content) });
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-export-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, destination: join(root, 'new') };
}

test('message files preserve Unicode, boundaries, empty results and a maximum-size single line', () => {
  for (const content of ['', '\ufeff한글 🧪\r\n\0"\\\rEND', 'a'.repeat(17999) + '🧪tail',
    'a'.repeat(17999) + '\r\ntail', ('한글\r\n'.repeat(6000)), 'x'.repeat(1024 * 1024)]) {
    const parts = resultMessages('owned', content, hash(content));
    let offset = 0, reconstructed = '';
    for (const [i, p] of parts.entries()) {
      assert.equal(p.index, i + 1); assert.equal(p.start, offset);
      assert.ok(p.text.length <= 20000); assert.ok(p.text.isWellFormed());
      assert.equal(p.chars, p.text.length); assert.equal(p.bytes, Buffer.byteLength(p.text));
      assert.equal(p.sha256, hash(p.text));
      assert.match(p.text, new RegExp(`Part ${i + 1}/${parts.length}\\n\\n`));
      const body = p.text.slice(p.headerChars);
      assert.equal(body, content.slice(p.start, p.end));
      if (p.end < content.length) assert.ok(!(body.endsWith('\r') && content[p.end] === '\n'));
      reconstructed += body; offset = p.end;
    }
    assert.equal(offset, content.length);
    assert.deepEqual(Buffer.from(reconstructed), Buffer.from(content));
  }
});

test('export writes exact UTF-8 and an ordered manifest without inventing chat evidence', t => {
  const { destination } = fixture(t), content = '\ufeff한글 🧪\0\r\n'.repeat(4000);
  const receipt = saveReviewedResult(review(content), destination);
  const manifest = JSON.parse(fs.readFileSync(receipt.manifest, 'utf8'));
  assert.equal(manifest.sourceSha256, hash(content));
  assert.equal(manifest.chatDelivery, 'NOT_OBSERVED'); assert.equal(manifest.collectedByExport, false);
  assert.equal(receipt.messageCount, manifest.messages.length);
  assert.deepEqual(fs.readFileSync(receipt.full.path), Buffer.from(content));
  const joined = manifest.messages.map(p => {
    const bytes = fs.readFileSync(join(destination, p.file));
    assert.equal(hash(bytes), p.sha256); assert.equal(bytes.length, p.bytes);
    assert.equal(bytes.toString('utf8').length, p.chars);
    return bytes.toString('utf8').slice(p.headerChars);
  }).join('');
  assert.equal(joined, content);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(destination).mode & 0o777, 0o700);
    for (const file of fs.readdirSync(destination)) assert.equal(fs.statSync(join(destination, file)).mode & 0o777, 0o600);
  }
});

test('export rejects invalid or partial input before creating files', t => {
  const { destination } = fixture(t);
  for (const value of [{ ...review('x'), partial: false }, { ...review('x'), status: 'running' },
    { ...review('x'), sha256: '0'.repeat(64) }, { ...review('x'), integrity: 'unknown' },
    review('\ud800'), review('a'.repeat(1024 * 1024 + 1))]) {
    assert.throws(() => saveReviewedResult(value, destination)); assert.equal(fs.existsSync(destination), false);
  }
  assert.throws(() => saveReviewedResult(review('x'), 'relative'));
});

test('export refuses existing files, directories and directory links without overwriting', t => {
  const { root } = fixture(t), existing = join(root, 'existing');
  fs.mkdirSync(existing); fs.writeFileSync(join(existing, 'keep.txt'), 'keep');
  const file = join(root, 'file'); fs.writeFileSync(file, 'keep-file');
  const link = join(root, 'link'); fs.symlinkSync(existing, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const destination of [existing, file, link]) assert.throws(() => saveReviewedResult(review('private'), destination));
  assert.deepEqual(fs.readdirSync(existing), ['keep.txt']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep-file');
});

test('failed flush preserves partial evidence and cannot be retried over it', t => {
  const { destination } = fixture(t);
  const mock = t.mock.method(fs, 'fsyncSync', () => { throw Error('disk failure'); });
  assert.throws(() => saveReviewedResult(review('private'), destination)); mock.mock.restore();
  assert.equal(fs.existsSync(join(destination, 'result.txt')), true);
  assert.equal(fs.existsSync(join(destination, 'manifest.json')), false);
  assert.throws(() => saveReviewedResult(review('private'), destination));
});

test('a replaced earlier export file is detected before manifest publication', t => {
  const { destination } = fixture(t), original = fs.openSync;
  const mock = t.mock.method(fs, 'openSync', (path, ...args) => {
    if (path === join(destination, 'message-001.txt') && args[0] === 'wx') {
      fs.renameSync(join(destination, 'result.txt'), join(destination, 'preserved.txt'));
      fs.writeFileSync(join(destination, 'result.txt'), 'foreign');
    }
    return original(path, ...args);
  });
  assert.throws(() => saveReviewedResult(review('original'), destination), { code: 'REVIEW_EXPORT' });
  mock.mock.restore();
  assert.equal(fs.existsSync(join(destination, 'manifest.json')), false);
  assert.equal(fs.readFileSync(join(destination, 'preserved.txt'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(join(destination, 'result.txt'), 'utf8'), 'foreign');
});
