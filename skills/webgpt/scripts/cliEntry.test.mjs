import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
    t.mock.method(fs.realpathSync, 'native', () => assert.fail('native identity must not resolve paths'));
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
    t.mock.method(fs.realpathSync, 'native', () => { throw error; });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    if (['ENOENT', 'ENOTDIR'].includes(code)) assert.equal(isCliEntry({ url: import.meta.url }), false);
    else assert.throws(() => isCliEntry({ url: import.meta.url }), value => value === error);
    // The same lookup error in an unrelated importing application owns no CLI diagnostic.
    assert.equal(isCliEntry({ url: new URL('./artifact-input.mjs', import.meta.url).href }), false);
  });
}

// POSIX permits filename bytes that cannot be represented in a JavaScript path.
// The aliases are valid strings; only their native targets differ from U+FFFD.
test('fallback distinguishes native-byte siblings instead of running an imported module',
  { skip: process.platform === 'win32' }, t => {
    const { dir: temporary, real } = fixture(t);
    // macOS exposes tmpdir through /var -> /private/var. Use one root identity
    // so this regression isolates the undecodable target, not loader aliases.
    const dir = fs.realpathSync.native(temporary);
    const replacement = join(dir, '\ufffd'); fs.renameSync(real, replacement);
    const raw = Buffer.concat([Buffer.from(dir + '/'), Buffer.from([0xff])]);
    fs.mkdirSync(raw);
    const imported = join(replacement, 'main.mjs');
    const helper = new URL('./cli-entry.mjs', import.meta.url).href;
    fs.writeFileSync(imported, `import fs from 'node:fs'; import {fileURLToPath} from 'node:url';\n` +
      `import {isCliEntry} from ${JSON.stringify(helper)};\n` +
      `if (isCliEntry({url:import.meta.url})) { console.log('CLI');\n` +
      `  if (process.argv[2] === 'import-probe') console.error(JSON.stringify({argv:process.argv[1],url:import.meta.url,` +
      `entry:fs.realpathSync.native(process.argv[1],{encoding:'buffer'}).toString('hex'),` +
      `module:fs.realpathSync.native(fileURLToPath(import.meta.url),{encoding:'buffer'}).toString('hex')})); }\n`);
    fs.writeFileSync(Buffer.concat([raw, Buffer.from('/main.mjs')]),
      `await import(${JSON.stringify(pathToFileURL(imported).href)});`);
    const alias = join(dir, 'alias'); fs.symlinkSync(raw, alias, 'dir');
    assert.notDeepEqual(fs.realpathSync.native(join(alias, 'main.mjs'), { encoding: 'buffer' }),
      fs.realpathSync.native(imported, { encoding: 'buffer' }));
    for (const flags of [['--preserve-symlinks-main'], ['--preserve-symlinks', '--preserve-symlinks-main']]) {
      const result = run([...flags, join(alias, 'main.mjs'), 'import-probe']);
      if (result.stdout !== '') t.diagnostic(result.stderr);
      output(result);
    }
    output(run([imported]), 'CLI\n'); // A literal replacement character remains valid.
  });

test('fallback recognizes an identical native-byte target through a valid alias',
  { skip: process.platform === 'win32' }, t => {
    const { dir, real } = fixture(t);
    const raw = Buffer.concat([Buffer.from(dir + '/'), Buffer.from([0xff])]);
    fs.renameSync(real, raw);
    const alias = join(dir, 'alias'); fs.symlinkSync(raw, alias, 'dir');
    output(run(['--preserve-symlinks-main', join(alias, 'main.mjs')]), 'CLI\n');
  });

for (const successful of ['entry', 'module']) {
  test(`fallback preserves an I/O diagnostic identified by the successful ${successful} lookup`, t => {
    const url = new URL('./artifact-input.mjs', import.meta.url);
    const entryPath = resolve(process.argv[1]), modulePath = fileURLToPath(url);
    const error = Object.assign(Error('fixture'), { code: 'EIO' });
    t.mock.method(fs.realpathSync, 'native', path => {
      if (path === (successful === 'entry' ? entryPath : modulePath))
        return Buffer.from(successful === 'entry' ? modulePath : entryPath);
      throw error;
    });
    assert.throws(() => isCliEntry({ url: url.href }), value => value === error);
  });
}
