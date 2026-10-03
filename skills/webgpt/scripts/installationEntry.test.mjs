import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatedEntryPath } from './installation.mjs';

const invalid = {
  code: 'CONFIG_INVALID', retryable: false,
  message: 'entryPath must identify the running installed module',
};
function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-entry-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

for (const [label, entryIsRaw, moduleIsRaw] of [
  ['entry alias differs from the Unicode module', true, false],
  ['module alias differs from the Unicode entry', false, true],
  ['both aliases identify the same non-UTF-8 module', true, true],
]) test(`entry validation rejects native bytes: ${label}`, {
  skip: process.platform !== 'linux' ? 'native arbitrary-byte directory fixture requires Linux' : false,
}, t => {
  const base = fixture(t), alias = join(base, 'launch-alias');
  const raw = Buffer.concat([Buffer.from(base + '/installed-'), Buffer.from([0xff])]);
  const replacement = join(base, 'installed-\ufffd');
  fs.mkdirSync(raw); fs.mkdirSync(replacement); fs.symlinkSync(raw, alias, 'dir');
  for (const name of ['service.mjs', 'worker.mjs']) {
    // Inert distinct files: validate their paths, never execute either fixture.
    const rawFile = Buffer.concat([raw, Buffer.from('/' + name)]);
    const aliasFile = join(alias, name), unicodeFile = join(replacement, name);
    fs.writeFileSync(rawFile, 'native installation'); fs.writeFileSync(unicodeFile, 'Unicode installation');
    const rawCanonical = fs.realpathSync.native(aliasFile, { encoding: 'buffer' });
    const unicodeCanonical = fs.realpathSync.native(unicodeFile, { encoding: 'buffer' });
    assert.equal(isUtf8(rawCanonical), false);
    assert.equal(isUtf8(unicodeCanonical), true);
    assert.equal(rawCanonical.equals(unicodeCanonical), false);
    assert.equal(rawCanonical.toString('utf8'), unicodeCanonical.toString('utf8'));
    assert.throws(() => validatedEntryPath(
      pathToFileURL(moduleIsRaw ? aliasFile : unicodeFile), entryIsRaw ? aliasFile : unicodeFile,
    ), invalid);
    assert.equal(fs.readFileSync(rawFile, 'utf8'), 'native installation');
    assert.equal(fs.readFileSync(unicodeFile, 'utf8'), 'Unicode installation');
  }
});

test('ill-formed entry paths are rejected before native filesystem lookup', t => {
  const base = fixture(t), script = join(base, 'entry-\ufffd.mjs');
  fs.writeFileSync(script, 'literal replacement character');
  const url = pathToFileURL(script);
  assert.equal(validatedEntryPath(url, script), script);
  const lookup = t.mock.method(fs.realpathSync, 'native');
  for (const surrogate of ['\ud800', '\udc00']) {
    assert.throws(() => validatedEntryPath(url, join(base, `entry-${surrogate}.mjs`)), invalid);
  }
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(fs.readFileSync(script, 'utf8'), 'literal replacement character');
});

test('valid Unicode entry aliases retain their launch spelling', t => {
  const base = fixture(t), real = join(base, 'installed 한글 🧪 \ufffd # %'), alias = join(base, 'launch 한글');
  fs.mkdirSync(real); fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const script = join(real, 'worker.mjs'), entry = join(alias, 'worker.mjs');
  fs.writeFileSync(script, 'inert module');
  const url = pathToFileURL(script);
  assert.equal(validatedEntryPath(url), script);
  assert.equal(validatedEntryPath(url, entry), resolve(entry));
  assert.equal(validatedEntryPath(pathToFileURL(entry), script), script);
  if (process.platform === 'win32') {
    const alternateCase = entry[0].toLowerCase() + entry.slice(1);
    assert.equal(validatedEntryPath(url, alternateCase), resolve(alternateCase));
  }
});

test('Windows short entry names retain their spelling after native identity checks', {
  skip: process.platform !== 'win32' ? 'requires native Windows short names' : false,
}, t => {
  const base = fixture(t), real = join(base, 'LongInstalledDirectory'), alias = join(base, 'LONGIN~1');
  fs.mkdirSync(real);
  if (!fs.existsSync(alias)) return t.skip('the temporary volume does not generate this NTFS short name');
  const script = join(real, 'worker.mjs'), entry = join(alias, 'worker.mjs');
  fs.writeFileSync(script, 'inert module');
  assert.deepEqual(fs.realpathSync.native(script, { encoding: 'buffer' }), fs.realpathSync.native(entry, { encoding: 'buffer' }));
  assert.equal(validatedEntryPath(pathToFileURL(script), entry), entry);
  assert.equal(validatedEntryPath(pathToFileURL(entry), script), script);
});
