import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { isCliEntry } from './cli-entry.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'webgpt-cli-entry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = join(dir, 'real 한글 # %'); fs.mkdirSync(real);
  const helper = new URL('./cli-entry.mjs', import.meta.url).href;
  const script = join(real, 'main.mjs');
  // Omit .main deliberately: exercise the old Node 22 fallback on newer CI too.
  fs.writeFileSync(script, `import { isCliEntry } from ${JSON.stringify(helper)};\n` +
    `export const entry = isCliEntry({url: import.meta.url});\n` +
    `if (entry) console.log('CLI');\n`);
  return { dir, real, script };
}
function run(args, input) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, args, { env, input, encoding: 'utf8', timeout: 10000 });
}
function output(result, text = '') {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, text);
  assert.equal(result.stderr, '');
}

for (const main of [true, false]) {
  test(`native main=${main} is authoritative without path lookup`, t => {
    t.mock.method(fs, 'realpathSync', () => assert.fail('native identity must not resolve paths'));
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    assert.equal(isCliEntry({ main }), main);
  });
}

for (const flags of [[], ['-expose-gc'], ['--preserve-symlinks-main'], ['--preserve-symlinks'],
  ['--preserve-symlinks', '--preserve-symlinks-main']]) {
  test(`fallback executes linked directory once: ${flags.join(' ') || 'default'}`, t => {
    const { dir, real, script } = fixture(t);
    const alias = join(dir, 'alias');
    fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    output(run([...flags, join(alias, 'main.mjs')]), 'CLI\n');
    output(run([...flags, script]), 'CLI\n');
  });
}

test('fallback executes a leaf link with preserved main identity', t => {
  const { dir, script } = fixture(t);
  const alias = join(dir, 'entry.mjs');
  try { fs.symlinkSync(script, alias, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('file symlinks not permitted'); return; }
    throw error;
  }
  output(run(['--preserve-symlinks-main', alias]), 'CLI\n');
});

for (const mode of ['-e', '--eval', '--eval=']) {
  test(`fallback ignores eval arguments (${mode}), including its own filename`, t => {
    const { dir, script } = fixture(t);
    const body = `const m = await import(${JSON.stringify(pathToFileURL(script).href)}); if(m.entry) throw Error('import ran CLI');`;
    const options = mode.endsWith('=') ? [mode + body] : [mode, body];
    for (const argument of [join(dir, 'missing-private-path'), script])
      output(run(['--input-type=module', ...options, argument]));
  });
}

test('fallback imports from stdin, normal files and a renamed importer without CLI side effects', t => {
  const { dir, script } = fixture(t);
  const url = pathToFileURL(script).href;
  output(run(['--input-type=module', '-', 'private-argument'], `await import(${JSON.stringify(url)});`));
  const importer = join(dir, 'importer.mjs');
  fs.writeFileSync(importer, `import ${JSON.stringify(url)};`);
  output(run([importer]));
  fs.writeFileSync(importer, `import fs from 'node:fs'; import {fileURLToPath} from 'node:url';\n` +
    `fs.renameSync(fileURLToPath(import.meta.url), ${JSON.stringify(join(dir, 'renamed.mjs'))});\n` +
    `await import(${JSON.stringify(url)});`);
  output(run([importer]));
});

test('fallback refuses query/fragment variants of the invoked file', t => {
  const { script } = fixture(t);
  const helper = new URL('./cli-entry.mjs', import.meta.url).href;
  fs.writeFileSync(script, `import {isCliEntry} from ${JSON.stringify(helper)};\n` +
    `if(isCliEntry({url: import.meta.url})) { await import(import.meta.url+'?copy'); await import(import.meta.url+'#copy'); console.log('CLI'); }\n`);
  output(run([script]), 'CLI\n');
});

for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'EIO']) {
  test(`fallback handles ${code} without converting I/O failures into a successful no-op`, t => {
    const error = Object.assign(Error('fixture'), { code });
    t.mock.method(fs, 'realpathSync', () => { throw error; });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    if (['ENOENT', 'ENOTDIR'].includes(code)) assert.equal(isCliEntry({ url: import.meta.url }), false);
    else assert.throws(() => isCliEntry({ url: import.meta.url }), value => value === error);
    // The same lookup error in an unrelated importing application owns no CLI diagnostic.
    assert.equal(isCliEntry({ url: new URL('./artifact-input.mjs', import.meta.url).href }), false);
  });
}
