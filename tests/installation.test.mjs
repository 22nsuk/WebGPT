import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('repository README keeps fork installation and explicit chat retention/deletion policy', () => {
  const text = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(text, /Install https:\/\/github\.com\/22nsuk\/WebGPT\/tree\/main\/skills\/webgpt/);
  assert.match(text, /retain task chats by default/i);
  assert.match(text, /Delete a chat only when the user explicitly requests deletion/i);
  assert.doesNotMatch(text, /Workflow requests include permanent deletion|permanently delete its test chats|acknowledges and deletes that task chat|Delete the finished probe chat|delete task chats per SKILL\.md/i);
});

test('installed skill tests do not depend on surrounding repository files', async () => {
  const base = mkdtempSync(join(tmpdir(), 'webgpt-install-layout-'));
  const installed = join(base, 'skills', 'webgpt');
  try {
    cpSync(fileURLToPath(new URL('../skills/webgpt', import.meta.url)), installed, { recursive: true });
    assert.equal(existsSync(join(base, 'README.md')), false);
    assert.equal(existsSync(join(base, '.github')), false);
    // Run the installed command as an independent CLI, not as this runner's internal child.
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    // Exercise the documented installed-skill command so every shipped test must be self-contained.
    const { stdout } = await execute(process.execPath, ['--test', '--test-reporter=tap'], {
      cwd: installed, env, timeout: 60000, windowsHide: true,
    });
    assert.match(stdout, /# tests [1-9]\d*\b/);
    assert.match(stdout, /# pass [1-9]\d*\b/);
    assert.match(stdout, /# fail 0\b/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
