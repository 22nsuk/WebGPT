import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeWorkspace, grantWorkspace, readWorkspace } from './workspace.mjs';

test('read-only project grant cannot delete an existing file and preserves its content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-readonly-delete-'));
  const root = join(dir, 'project');
  const path = 'source.txt';
  const content = 'keep this content';

  try {
    mkdirSync(root);
    writeFileSync(join(root, path), content);

    const grant = grantWorkspace({root, mode:'read'});
    const before = readWorkspace(grant, path);
    assert.equal(before.text, content);

    assert.throws(
      () => changeWorkspace(grant, dir, 'read-only-delete', {path, expectedSha256:before.sha256}, true),
      /read-only/,
    );

    assert.equal(readFileSync(join(root, path), 'utf8'), content);
    const after = readWorkspace(grant, path);
    assert.equal(after.sha256, before.sha256);
    assert.equal(after.text, content);
  } finally {
    rmSync(dir, {recursive:true, force:true});
  }
});
