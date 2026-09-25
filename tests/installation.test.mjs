import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstalledSuite, cleanupInstallation } from './helpers/installed-suite.mjs';

test('repository README keeps fork installation and explicit chat retention/deletion policy', () => {
  const text = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(text, /Install https:\/\/github\.com\/22nsuk\/WebGPT\/tree\/main\/skills\/webgpt/);
  assert.match(text, /retain task chats by default/i);
  assert.match(text, /Delete a chat only when the user explicitly requests deletion/i);
  assert.doesNotMatch(text, /Workflow requests include permanent deletion|permanently delete its test chats|acknowledges and deletes that task chat|Delete the finished probe chat|delete task chats per SKILL\.md/i);
});

test('installed skill tests do not depend on surrounding repository files', async t => {
  const base = mkdtempSync(join(tmpdir(), 'webgpt-install-layout-'));
  const installed = join(base, 'skills', 'webgpt');
  let failure;
  try {
    // Native cpSync crashes on Node 22 with this checkout's Unicode path.
    await cp(fileURLToPath(new URL('../skills/webgpt', import.meta.url)), installed, { recursive: true });
    assert.equal(existsSync(join(base, 'README.md')), false);
    assert.equal(existsSync(join(base, '.github')), false);
    const counts = await runInstalledSuite(installed);
    t.diagnostic('Installed suite: ' + Object.entries(counts).map(([key, value]) => `${key} ${value}`).join('; '));
  } catch (error) { failure = error; }
  await cleanupInstallation(base, failure);
});
