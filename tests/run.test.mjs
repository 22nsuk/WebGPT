import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const failure of [null, 'repository', 'installation']) {
  test(`test runner discovers both layouts and propagates ${failure ?? 'no'} failure`, () => {
    const root = mkdtempSync(join(tmpdir(), 'webgpt test runner '));
    try {
      const scripts = join(root, 'skills', 'webgpt', 'scripts'), tests = join(root, 'tests');
      mkdirSync(scripts, { recursive: true }); mkdirSync(tests);
      cpSync(new URL('./run.mjs', import.meta.url), join(tests, 'run.mjs'));
      const trace = join(root, 'trace.jsonl');
      const source = name => `
        import {appendFileSync} from 'node:fs';
        appendFileSync(${JSON.stringify(trace)}, JSON.stringify(${JSON.stringify(name)}) + '\\n');
        ${failure === name ? "throw Error('fixture phase failed');" : ''}
      `;
      writeFileSync(join(scripts, 'a.test.mjs'), source('repository'));
      writeFileSync(join(scripts, 'b.test.mjs'), source('second shipped file'));
      mkdirSync(join(scripts, 'nested'));
      writeFileSync(join(scripts, 'nested', 'c.test.mjs'), source('nested shipped file'));
      writeFileSync(join(tests, 'policy.test.mjs'), source('repository policy'));
      writeFileSync(join(tests, 'installation.test.mjs'), source('installation'));
      // The entrypoint must resolve its own checkout, not the caller's directory.
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [join(tests, 'run.mjs')], {
        cwd: tmpdir(), env, encoding: 'utf8', windowsHide: true, timeout: 15000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.status, failure ? 1 : 0, result.stdout + result.stderr);
      const entries = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(entries.slice(0, 4).sort(), ['nested shipped file', 'repository', 'repository policy', 'second shipped file']);
      if (failure === 'repository') assert.equal(entries.length, 4);
      else assert.deepEqual(entries.slice(4), ['installation']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
