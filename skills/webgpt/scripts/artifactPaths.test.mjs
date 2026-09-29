import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildArtifactInput } from './artifact-input.mjs';

const script = fileURLToPath(new URL('./artifact-input.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'webgpt-artifact-paths-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.txt');
  fs.writeFileSync(source, 'approved evidence\n');
  return { dir, source };
}
const node = (args, env = process.env, cwd) => spawnSync(process.execPath, args, { env, cwd, encoding: 'utf8', timeout: 10000 });

for (const flag of ['-prof', '-expose-gc']) {
  test(`artifact runtime option ${flag} does not suppress direct or preloaded execution`, t => {
    const { dir, source } = fixture(t);
    for (const preload of [false, true]) {
      const out = join(dir, `evidence-${preload}.json`);
      const result = node([flag, ...(preload ? ['--import', pathToFileURL(script).href] : []), script,
        '--source', source, '--label', 'fixture', '--out', out], process.env, dir);
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
      assert.notEqual(result.stdout, '', 'a runtime option cannot suppress the receipt');
      const bytes = fs.readFileSync(out);
      assert.deepEqual(JSON.parse(result.stdout), { ok: true, inputBytes: bytes.length, sha256: hash(bytes) });
      assert.equal(JSON.parse(bytes).source.sha256, hash('approved evidence\n'));
    }
  });
}

test('artifact locked globals allow one linked CLI execution and one redacted failure', t => {
  const { dir, source } = fixture(t), alias = join(dir, 'scripts');
  fs.symlinkSync(dirname(script), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const lock = join(dir, 'lock.mjs'), out = join(dir, 'evidence.json');
  fs.writeFileSync(lock, 'Object.preventExtensions(globalThis);');
  const flags = ['--preserve-symlinks', '--preserve-symlinks-main', '--import', pathToFileURL(lock).href,
    '--import', pathToFileURL(script).href, join(alias, 'artifact-input.mjs')];
  const result = node([...flags, '--source', source, '--label', 'fixture', '--out', out]);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const bytes = fs.readFileSync(out);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, inputBytes: bytes.length, sha256: hash(bytes) });
  assert.equal(JSON.parse(bytes).source.sha256, hash('approved evidence\n'));
  const failed = node([...flags, '--unknown']);
  assert.equal(failed.status, 1); assert.equal(failed.stdout, '');
  assert.equal(JSON.parse(failed.stderr).code, 'ERR_PARSE_ARGS_UNKNOWN_OPTION');
  assert.ok(!failed.stderr.includes(dir));
});

test('artifact a locked marker host reports a redacted failure without inspecting source', t => {
  const { dir, source } = fixture(t), out = join(dir, 'must-not-create.json');
  const lock = join(dir, 'lock-process.mjs');
  fs.writeFileSync(lock, `import fs from 'node:fs';
    Object.preventExtensions(process);
    const stat = fs.lstatSync;
    fs.lstatSync = (path, ...args) => {
      if (path === ${JSON.stringify(source)}) throw Error('unclaimed CLI inspected source');
      return stat(path, ...args);
    };`);
  const result = node(['--import', pathToFileURL(lock).href, script,
    '--source', source, '--label', 'fixture', '--out', out]);
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).code, 'CLI_STATE_UNAVAILABLE');
  assert.ok(!result.stderr.includes(dir)); assert.equal(fs.existsSync(out), false);
});

for (const flag of ['-e', '-p', '-pe', '--eval', '--print', '--eval=']) {
  test(`artifact ${flag} treats a script-shaped positional argument as data`, t => {
    const { dir, source } = fixture(t), out = join(dir, 'must-not-create.json');
    // Dynamic import works in CommonJS print mode on the complete Node 22 baseline.
    const body = `void import(${JSON.stringify(pathToFileURL(script).href)})`;
    const args = flag.endsWith('=') ? [flag + body] : [flag, body];
    const result = node([...args, script, '--source', source, '--label', 'fixture', '--out', out]);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    assert.equal(result.stdout, flag.includes('p') ? 'undefined\n' : '');
    assert.equal(fs.existsSync(out), false);
  });
}

for (const code of ['EACCES', 'EIO']) {
  test(`artifact unrelated importer remains quiet on ${code} lookup failures`, t => {
    const { dir, source } = fixture(t), out = join(dir, 'must-not-create.json');
    const importer = join(dir, 'importer.mjs');
    for (const failingPath of [importer, script]) {
      fs.writeFileSync(importer, `import fs from 'node:fs'; import assert from 'node:assert/strict';
        const original = fs.realpathSync, stat = fs.lstatSync;
        fs.realpathSync = (path, ...args) => {
          if (path === ${JSON.stringify(failingPath)})
            throw Object.assign(Error(${JSON.stringify(dir)}), { code: ${JSON.stringify(code)} });
          return original(path, ...args);
        };
        let reads = 0;
        fs.lstatSync = (path, ...args) => { if (path === ${JSON.stringify(source)}) reads++; return stat(path, ...args); };
        const previousExit = process.exitCode;
        const m = await import(${JSON.stringify(pathToFileURL(script).href)});
        assert.equal(process.exitCode, previousExit);
        assert.equal(reads, 0);
        assert.equal(fs.existsSync(${JSON.stringify(out)}), false);
        fs.realpathSync = original; fs.lstatSync = stat;
        assert.equal(m.buildArtifactInput({ source: ${JSON.stringify(source)}, label: 'fixture' }).source.sha256,
          ${JSON.stringify(hash('approved evidence\n'))});`);
      const result = node(['--preserve-symlinks', '--preserve-symlinks-main', importer,
        '--source', source, '--label', 'fixture', '--out', out]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
      assert.equal(fs.existsSync(out), false);
    }
  });
}

test('API rejects unpaired-surrogate paths before filesystem access, not by replacement', t => {
  const { dir } = fixture(t);
  fs.writeFileSync(join(dir, '\ufffd.txt'), 'different file');
  const stat = t.mock.method(fs, 'lstatSync', () => assert.fail('invalid path reached filesystem'));
  for (const name of ['\ud800.txt', '\udfff.txt']) {
    assert.throws(() => buildArtifactInput({ source: join(dir, name), label: 'fixture' }),
      { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(stat.mock.callCount(), 0);
});

test('deliberate replacement characters and ordinary Unicode paths remain exact', t => {
  const { dir } = fixture(t);
  for (const name of ['\ufffd.txt', '한글 😀 #%.txt', 'e\u0301.txt']) {
    const source = join(dir, name);
    fs.writeFileSync(source, name);
    const result = buildArtifactInput({ source, label: 'fixture' });
    assert.equal(result.source.sha256, hash(name));
    assert.equal(result.source.sizeBytes, Buffer.byteLength(name));
    assert.equal(fs.readFileSync(source, 'utf8'), name);
  }
});

test('CLI rejects malformed in-memory output paths without creating replacement-named files', t => {
  const { dir, source } = fixture(t);
  // A preload injects the malformed JS string before the real CLI entry runs.
  // argv cannot carry it losslessly; importing from eval must NOT launch the CLI.
  for (const name of ['\ud800.json', '\udfff.json']) {
    const argv = [process.execPath, script, '--source', source, '--label', 'fixture', '--out', join(dir, name)];
    const preload = join(dir, 'argv-preload.mjs');
    fs.writeFileSync(preload, `process.argv = ${JSON.stringify(argv)};`);
    const result = node(['--import', pathToFileURL(preload).href, script]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 'INVALID_ARGUMENT');
    assert.ok(!result.stderr.includes(dir), 'error must not disclose the private path');
    assert.equal(fs.existsSync(join(dir, '\ufffd.json')), false);
  }
  assert.equal(fs.readFileSync(source, 'utf8'), 'approved evidence\n');
});

for (const flags of [[], ['--preserve-symlinks-main'], ['--preserve-symlinks'],
  ['--preserve-symlinks', '--preserve-symlinks-main']]) {
  test(`directory-linked CLI creates verified evidence with ${flags.join(' ') || 'default flags'}`, t => {
    const { dir, source } = fixture(t);
    const alias = join(dir, 'scripts 한글 #');
    fs.symlinkSync(dirname(script), alias, process.platform === 'win32' ? 'junction' : 'dir');
    const out = join(dir, 'evidence.json');
    const result = node([...flags, join(alias, 'artifact-input.mjs'),
      '--source', source, '--label', 'fixture', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.notEqual(result.stdout, '', 'exit zero without a receipt is not execution');
    const bytes = fs.readFileSync(out);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, inputBytes: bytes.length, sha256: hash(bytes) });
    assert.equal(JSON.parse(bytes).source.sha256, hash('approved evidence\n'));
  });
}

test('leaf-linked CLI runs with preserved main symlinks', t => {
  const { dir } = fixture(t);
  const alias = join(dir, 'artifact-link.mjs');
  try { fs.symlinkSync(script, alias, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('symlink creation not permitted'); return; }
    throw error;
  }
  const result = node(['--preserve-symlinks-main', alias, '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Parent-only/);
  assert.equal(result.stderr, '');
});

test('preserved symlink imports remain side-effect free', t => {
  const { dir } = fixture(t);
  const alias = join(dir, 'scripts');
  fs.symlinkSync(dirname(script), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const importer = join(dir, 'importer.mjs');
  fs.writeFileSync(importer, `import { buildArtifactInput } from ${JSON.stringify(pathToFileURL(join(alias, 'artifact-input.mjs')).href)};\n` +
    `if (typeof buildArtifactInput !== 'function') throw Error('missing export');\n`);
  const result = node(['--preserve-symlinks', '--preserve-symlinks-main', importer]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

for (const mode of ['import', 'require']) {
  test(`artifact ${mode} with CLI-shaped eval arguments does no source I/O or output creation`, t => {
    const { dir, source } = fixture(t), out = join(dir, 'must-not-create.json');
    const [major, minor] = process.versions.node.split('.').map(Number);
    // Node 22.0-22.11 requires the ESM require flag; through 22.12 the loader
    // emits ExperimentalWarning. Limit compatibility flags to this child case.
    const flags = mode === 'import' ? ['--input-type=module']
      : major === 22 && minor < 13
        ? [...(minor < 12 ? ['--experimental-require-module'] : []), '--disable-warning=ExperimentalWarning'] : [];
    const load = mode === 'import' ? `await import(${JSON.stringify(pathToFileURL(script).href)})`
      : `require(${JSON.stringify(script)})`;
    const body = `${mode === 'import' ? "import fs from 'node:fs'; import assert from 'node:assert/strict';"
      : "const fs = require('node:fs'), assert = require('node:assert/strict');"}
      const source = ${JSON.stringify(source)}, out = ${JSON.stringify(out)};
      const stat = fs.lstatSync, open = fs.openSync;
      let observations = 0;
      fs.lstatSync = (path, ...args) => { if (path === source) observations++; return stat(path, ...args); };
      fs.openSync = (path, ...args) => { if (path === source) observations++; return open(path, ...args); };
      const m = ${load};
      assert.equal(observations, 0, 'an import must not inspect the CLI source');
      assert.equal(fs.existsSync(out), false, 'an import must not create CLI output');
      fs.lstatSync = stat; fs.openSync = open;
      assert.equal(m.buildArtifactInput({ source, label: 'fixture' }).source.sha256, ${JSON.stringify(hash('approved evidence\n'))});
      assert.equal(fs.existsSync(out), false, 'the explicit read-only API still does not write output');`;
    const result = node([...flags, '-e', body, script,
      '--source', source, '--label', 'fixture', '--out', out]);
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.readFileSync(source, 'utf8'), 'approved evidence\n');
  });
}

for (const suffix of ['', '?preloaded', '#preloaded']) {
  test(`artifact preload ${suffix || '(same URL)'} executes the CLI exactly once`, t => {
    const { dir, source } = fixture(t), out = join(dir, 'evidence.json');
    const result = node(['--import', pathToFileURL(script).href + suffix, script,
      '--source', source, '--label', 'fixture', '--out', out]);
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    assert.notEqual(result.stdout, '', 'a cached preload must still produce the CLI receipt');
    const bytes = fs.readFileSync(out);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, inputBytes: bytes.length, sha256: hash(bytes) });
    assert.equal(JSON.parse(bytes).source.sha256, hash('approved evidence\n'));
    assert.equal(fs.readFileSync(source, 'utf8'), 'approved evidence\n');
  });
}

for (const route of ['default', 'flags', 'NODE_OPTIONS', 'NODE_PRESERVE_SYMLINKS_MAIN']) {
  test(`artifact linked preload executes once with ${route}`, t => {
    const { dir, source } = fixture(t), alias = join(dir, 'scripts 한글 #');
    fs.symlinkSync(dirname(script), alias, process.platform === 'win32' ? 'junction' : 'dir');
    const entry = join(alias, 'artifact-input.mjs'), env = { ...process.env };
    delete env.NODE_OPTIONS; delete env.NODE_PRESERVE_SYMLINKS_MAIN;
    const flags = route === 'flags' ? ['--preserve-symlinks', '--preserve-symlinks-main'] : [];
    if (route === 'NODE_OPTIONS') env.NODE_OPTIONS = '"--preserve-symlinks" "--preserve-symlinks-main"';
    if (route === 'NODE_PRESERVE_SYMLINKS_MAIN') env.NODE_PRESERVE_SYMLINKS_MAIN = '1';
    for (const [index, preload] of [script, entry].entries()) {
      const out = join(dir, `evidence-${index}.json`);
      const result = node([...flags, '--import', pathToFileURL(preload).href, entry,
        '--source', source, '--label', 'fixture', '--out', out], env);
      assert.equal(result.error, undefined); assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
      assert.notEqual(result.stdout, '', 'preloading the entry cannot suppress execution');
      const bytes = fs.readFileSync(out);
      assert.deepEqual(JSON.parse(result.stdout), { ok: true, inputBytes: bytes.length, sha256: hash(bytes) });
      assert.equal(JSON.parse(bytes).source.sha256, hash('approved evidence\n'));
    }
    // A failed first invocation must not be retried by the other module URL.
    const failed = node([...flags, '--import', pathToFileURL(script).href, entry, '--unknown'], env);
    assert.equal(failed.status, 1); assert.equal(failed.stdout, '');
    assert.equal(JSON.parse(failed.stderr).code, 'ERR_PARSE_ARGS_UNKNOWN_OPTION');
    assert.equal(fs.readFileSync(source, 'utf8'), 'approved evidence\n');
  });
}

for (const code of ['EACCES', 'EIO']) {
  test(`artifact failed preload lookup ${code} prevents later linked main execution`, t => {
    const { dir, source } = fixture(t), out = join(dir, 'must-not-create.json');
    const alias = join(dir, 'scripts'), preload = join(dir, 'failed-preload.mjs');
    fs.symlinkSync(dirname(script), alias, process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(preload, `import fs from 'node:fs';
      const original = fs.realpathSync, stat = fs.lstatSync;
      fs.realpathSync = (path, ...args) => {
        if (path === ${JSON.stringify(script)})
          throw Object.assign(Error(${JSON.stringify(dir)}), { code: ${JSON.stringify(code)} });
        return original(path, ...args);
      };
      fs.lstatSync = (path, ...args) => {
        if (path === ${JSON.stringify(source)}) throw Error('failed entry inspected source');
        return stat(path, ...args);
      };
      await import(${JSON.stringify(pathToFileURL(script).href)});`);
    const result = node(['--preserve-symlinks', '--preserve-symlinks-main', '--import', pathToFileURL(preload).href,
      join(alias, 'artifact-input.mjs'), '--source', source, '--label', 'fixture', '--out', out]);
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, code, 'one redacted failure, no retry diagnostic');
    assert.ok(!result.stderr.includes(dir)); assert.equal(fs.existsSync(out), false);
    assert.equal(fs.readFileSync(source, 'utf8'), 'approved evidence\n');
  });

  test(`artifact entry preserves ${code} without false success or private diagnostics`, t => {
    const { dir, source } = fixture(t), out = join(dir, 'evidence.json');
    const preload = join(dir, 'entry-failure.mjs');
    fs.writeFileSync(preload, `import fs from 'node:fs';
      const original = fs.realpathSync;
      fs.realpathSync = (path, ...args) => {
        if (path === ${JSON.stringify(script)})
          throw Object.assign(Error(${JSON.stringify(dir)}), { code: ${JSON.stringify(code)} });
        return original(path, ...args);
      };`);
    // Preserve main's spelling so the loader does not need the lookup under test.
    const result = node(['--preserve-symlinks-main', '--import', pathToFileURL(preload).href, script,
      '--source', source, '--label', 'fixture', '--out', out]);
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    if (typeof import.meta.main === 'boolean') {
      // Native main identity is authoritative and needs no realpath lookup.
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
      const bytes = fs.readFileSync(out);
      assert.deepEqual(JSON.parse(result.stdout), { ok: true, inputBytes: bytes.length, sha256: hash(bytes) });
      assert.equal(JSON.parse(bytes).source.sha256, hash('approved evidence\n'));
    } else {
      assert.equal(result.status, 1, 'fallback lookup failures must not become successful no-ops');
      assert.equal(result.stdout, '');
      const diagnostic = JSON.parse(result.stderr);
      assert.equal(diagnostic.ok, false); assert.equal(diagnostic.code, code);
      assert.ok(!result.stderr.includes(dir), 'native errors must not expose private paths');
      assert.equal(fs.existsSync(out), false);
    }
    assert.equal(fs.readFileSync(source, 'utf8'), 'approved evidence\n');
  });
}
