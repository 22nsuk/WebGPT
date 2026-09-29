import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const scripts = dirname(fileURLToPath(import.meta.url));
const entries = [
  ['artifact-input.mjs', 'buildArtifactInput', [], 1, /"code":"INVALID_ARGUMENT"/],
  ['client.mjs', 'reviewTask', ['review'], 1, /REVIEW_USAGE/],
  ['worker.mjs', 'start', [], 78, /"event":"startup_failed","code":"CONFIG_INVALID"/],
  ['service.mjs', 'runService', [], 78, /"event":"service_failed".*"code":"CONFIG_INVALID"/],
  ['diagnose.mjs', 'diagnoseTask', [], 1, /usage: diagnose\.mjs/],
  ['verification.mjs', 'prepareVerification', [], 1, /WebGPT verification: unavailable or invalid input/],
];
function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'webgpt-cli-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, 'invalid-private-config.json');
  fs.writeFileSync(config, '{');
  const data = join(dir, 'must-not-create-runtime');
  const env = { ...process.env, WEBGPT_CONFIG: config, WEBGPT_DATA_DIR: data };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  const run = (args, input) => {
    const result = spawnSync(process.execPath, args, { env, cwd: dir, input, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(fs.readFileSync(config, 'utf8'), '{');
    assert.equal(fs.existsSync(data), false, 'CLI identity must not create runtime state');
    return result;
  };
  return { dir, run };
}
function quiet(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
}

for (const [file, exported, args, status, diagnostic] of entries) {
  const script = join(scripts, file), url = pathToFileURL(script).href;
  const importBody = `const m = await import(${JSON.stringify(url)}); if (typeof m[${JSON.stringify(exported)}] !== 'function') throw Error('missing export');`;
  test(`${file}: eval arguments do not become filesystem paths or trigger CLI actions`, t => {
    const { dir, run } = fixture(t);
    quiet(run(['--input-type=module', '-e', importBody]));
    for (const argument of [join(dir, 'missing-private-argument'), script])
      quiet(run(['--input-type=module', '-e', importBody, argument, ...args]));
  });
  test(`${file}: script and stdin imports stay quiet, including a renamed importer`, t => {
    const { dir, run } = fixture(t);
    const importer = join(dir, 'importer.mjs');
    fs.writeFileSync(importer, importBody);
    quiet(run([importer]));
    fs.writeFileSync(importer, `import fs from 'node:fs';\nfs.renameSync(${JSON.stringify(importer)}, ${JSON.stringify(join(dir, 'renamed.mjs'))});\n` + importBody);
    quiet(run([importer]));
    assert.equal(fs.existsSync(importer), false);
    assert.equal(fs.existsSync(join(dir, 'renamed.mjs')), true);
    quiet(run(['--input-type=module', '-', 'private-argument'], importBody));
  });
  for (const flags of [[], ['--preserve-symlinks-main'], ['--preserve-symlinks', '--preserve-symlinks-main']]) {
    test(`${file}: linked CLI runs its validation with ${flags.join(' ') || 'default flags'}`, t => {
      const { dir, run } = fixture(t);
      const alias = join(dir, 'scripts 한글 # %');
      fs.symlinkSync(scripts, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const result = run([...flags, join(alias, file), ...args]);
      assert.equal(result.status, status, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, diagnostic);
      assert.ok(!result.stderr.includes(dir), 'private paths must not appear in entry diagnostics');
    });
  }
}

test('client.mjs: preserved linked preflight returns its actual receipt without configuration access', t => {
  const { dir, run } = fixture(t);
  const alias = join(dir, 'scripts');
  fs.symlinkSync(scripts, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = run(['--preserve-symlinks-main', join(alias, 'client.mjs'), 'dispatch', 'preflight']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { runtime: 'node', ready: true });
});
