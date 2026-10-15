import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveReviewedResult } from './result-export.mjs';
import { buildHandoff } from './handoff.mjs';
import { saveHandoffPacket } from './handoff-file.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-export-path-')));
  t.after(() => { t.mock.restoreAll(); fs.rmSync(base, { recursive: true, force: true }); });
  const content = '\ufeffprivate fixture 한글 🧪\r\n', source = join(base, 'brief.txt');
  fs.writeFileSync(source, content);
  const review = { id: 'owned', status: 'completed', content, integrity: 'verified', sha256: hash(content) };
  const packet = buildHandoff({ assignment: { id: 'owned', revision: 'rev1' }, assignee: 'pro',
    files: [{ label: 'brief', role: 'brief', source, requiredFor: ['implementation'], delivery: 'named input' }],
    checks: [] });
  return { base, content, review, packet };
}

const writers = [
  { name: 'result export', leaf: '결과-\uFFFD-🧪', code: 'REVIEW_EXPORT',
    save: (f, destination) => saveReviewedResult(f.review, destination),
    path: receipt => receipt.directory, file: destination => join(destination, 'result.txt'),
    bytes: f => Buffer.from(f.content) },
  { name: 'handoff packet', leaf: '인계-\uFFFD-🧪.json', code: 'HANDOFF_FILE_INVALID',
    save: (f, destination) => saveHandoffPacket(f.packet, destination),
    path: receipt => receipt.saved.path, file: destination => destination,
    bytes: f => Buffer.from(JSON.stringify(f.packet)) },
];
const marker = directory => Buffer.isBuffer(directory)
  ? Buffer.concat([directory, Buffer.from('/keep.txt')]) : join(directory, 'keep.txt');
function seed(directory) {
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(marker(directory), 'keep unchanged');
}
function unchanged(directory) {
  assert.deepEqual(fs.readdirSync(directory), ['keep.txt']);
  assert.equal(fs.readFileSync(marker(directory), 'utf8'), 'keep unchanged');
}
function reject(writer, f, destination) {
  assert.throws(() => writer.save(f, destination), error => {
    assert.equal(error.code, writer.code);
    assert.equal(error.cause, undefined);
    for (const privateText of [f.base, f.content]) assert.equal(error.message.includes(privateText), false);
    return true;
  });
}

for (const writer of writers) {
  test(`${writer.name} rejects lossy native parent bytes before creating any output`, t => {
    const f = fixture(t), selected = join(f.base, 'selected-parent');
    const bytes = Buffer.concat([Buffer.from(join(f.base, 'native-')), Buffer.from([0xff])]);
    const replacement = bytes.toString('utf8');
    seed(selected); seed(replacement);
    const native = fs.realpathSync.native;
    // Portable native-return injection; the Linux test below uses real byte names.
    t.mock.method(fs.realpathSync, 'native', (path, options) => path === selected
      ? options?.encoding === 'buffer' ? bytes : replacement : native(path, options));
    reject(writer, f, join(selected, writer.leaf));
    unchanged(selected); unchanged(replacement);
  });

  test(`${writer.name} rejects a real non-UTF-8 parent alias without selecting its Unicode sibling`, {
    skip: process.platform !== 'linux' ? 'native arbitrary-byte directory fixture requires Linux' : false,
  }, t => {
    const f = fixture(t), alias = join(f.base, 'selected-parent');
    const raw = Buffer.concat([Buffer.from(f.base + '/native-'), Buffer.from([0xff])]);
    const replacement = join(f.base, 'native-\uFFFD');
    seed(raw); seed(replacement); fs.symlinkSync(raw, alias, 'dir');
    assert.equal(alias.isWellFormed(), true);
    assert.deepEqual(fs.realpathSync.native(alias, { encoding: 'buffer' }), raw);
    reject(writer, f, join(alias, writer.leaf));
    unchanged(raw); unchanged(replacement);
    assert.ok(fs.lstatSync(alias).isSymbolicLink());
  });

  for (const alias of [false, true]) {
    test(`${writer.name} preserves normal Unicode and literal U+FFFD through a ${alias ? 'parent alias' : 'direct parent'}`, t => {
      const f = fixture(t), parent = join(f.base, '한글-🧪-\uFFFD-e\u0301');
      seed(parent);
      let selected = parent;
      if (alias) {
        selected = join(f.base, 'selected-parent');
        try { fs.symlinkSync(parent, selected, process.platform === 'win32' ? 'junction' : 'dir'); }
        catch (error) {
          if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('directory aliases unavailable');
          throw error;
        }
      }
      const expected = join(fs.realpathSync.native(parent), writer.leaf);
      const receipt = writer.save(f, join(selected, writer.leaf));
      assert.equal(writer.path(receipt), expected);
      assert.deepEqual(fs.readFileSync(writer.file(expected)), writer.bytes(f));
      assert.equal(fs.readFileSync(marker(parent), 'utf8'), 'keep unchanged');
      assert.deepEqual(fs.readdirSync(parent).sort(), ['keep.txt', writer.leaf].sort());
      if (alias) assert.ok(fs.lstatSync(selected).isSymbolicLink());
    });
  }
}
