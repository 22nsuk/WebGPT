import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grantWorkspace, listWorkspace, readWorkspace, changeWorkspace } from './workspace.mjs';
import { start } from './worker.mjs';
import { request } from './client.mjs';

const cases = ['.git', '.giT', '.gIt', '.gIT', '.Git', '.GiT', '.GIt', '.GIT'];
const aliases = ['.git.', '.GIT ', '.Git. .', 'git~1', 'GIT~1.', 'GiT~1 ',
  '.git:stream', '.GIT::$DATA', '.git::$INDEX_ALLOCATION', '.GiT:$I30:$INDEX_ALLOCATION',
  '.git. :stream', 'GIT~1::$INDEX_ALLOCATION'];
const original = 'private Git metadata\n';
const revision = createHash('sha256').update(original).digest('hex');

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-git-protection-'));
  const root = join(dir, 'project');
  mkdirSync(root);
  const grant = grantWorkspace({ root, mode: 'edit' });
  try { await run({ dir, root, grant }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function rejectOperations(grant, dir, path) {
  assert.throws(() => listWorkspace(grant, path), /invalid path or Git metadata/, `list ${path}`);
  assert.throws(() => readWorkspace(grant, path), /invalid path or Git metadata/, `read ${path}`);
  assert.throws(() => changeWorkspace(grant, dir, 'blocked', {
    path, text: 'unauthorized', expectedSha256: null,
  }), /invalid path or Git metadata/, `create ${path}`);
  assert.throws(() => changeWorkspace(grant, dir, 'blocked', {
    path, text: 'unauthorized', expectedSha256: revision,
  }), /invalid path or Git metadata/, `edit ${path}`);
  assert.throws(() => changeWorkspace(grant, dir, 'blocked', {
    path, expectedSha256: revision,
  }, true), /invalid path or Git metadata/, `delete ${path}`);
}

test('all Git metadata case variants are rejected at every path depth before side effects', () => fixture(({ dir, root, grant }) => {
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'config'), original);
  for (const name of cases) {
    for (const path of [name, `${name}/config`, `nested/${name}/config`, `new/${name}/new.txt`]) {
      rejectOperations(grant, dir, path);
    }
  }
  assert.equal(readFileSync(join(root, '.git', 'config'), 'utf8'), original);
  assert.equal(existsSync(join(root, 'new')), false);
  assert.equal(existsSync(join(root, 'nested')), false);
  assert.equal(existsSync(join(dir, 'recovery')), false);
}));

test('Windows dot, space, short-name and stream aliases cannot bypass Git metadata protection', () => fixture(({ dir, root, grant }) => {
  for (const name of aliases) {
    for (const path of [name, `${name}/config`, `new/${name}/config`]) {
      rejectOperations(grant, dir, path);
    }
  }
  assert.deepEqual(listWorkspace(grant, '.').entries, []);
  assert.equal(existsSync(join(dir, 'recovery')), false);
}));

test('Git worktree pointer files receive the same protection as metadata directories', () => fixture(({ dir, root, grant }) => {
  writeFileSync(join(root, '.git'), original);
  for (const name of cases) rejectOperations(grant, dir, name);
  assert.equal(readFileSync(join(root, '.git'), 'utf8'), original);
  assert.deepEqual(listWorkspace(grant, '.').entries, []);
}));

test('directory listings hide protected spellings at the root and in nested directories', async () => {
  // Use separate fixtures: case-insensitive filesystems cannot store these side by side.
  for (const name of [...cases, 'GIT~1']) {
    await fixture(({ root, grant }) => {
      mkdirSync(join(root, name));
      mkdirSync(join(root, 'nested'));
      writeFileSync(join(root, 'nested', name), original);
      writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
      writeFileSync(join(root, 'nested', '.gitkeep'), '');
      assert.deepEqual(listWorkspace(grant, '.').entries.map(e => e.name), ['.gitignore', 'nested']);
      assert.deepEqual(listWorkspace(grant, 'nested').entries.map(e => e.name), ['.gitkeep']);
    });
  }
});

test('ordinary Git-related project files still support read, write, delete and recovery', () => fixture(({ dir, root, grant }) => {
  for (const path of ['.gitignore', '.gitattributes', '.gitmodules', '.gitkeep', '.gitconfig',
    '.github/workflows/check.yml', 'docs/.git-notes.md', 'git~10/notes.txt']) {
    const created = changeWorkspace(grant, dir, 'allowed', { path, text: 'first', expectedSha256: null });
    const before = readWorkspace(grant, path);
    assert.equal(before.sha256, created.afterSha256);
    const edited = changeWorkspace(grant, dir, 'allowed', { path, text: 'second', expectedSha256: before.sha256 });
    assert.equal(readFileSync(edited.backup, 'utf8'), 'first');
    assert.throws(() => changeWorkspace(grant, dir, 'allowed', {
      path, text: 'stale', expectedSha256: before.sha256,
    }), /revision conflict/);
    const removed = changeWorkspace(grant, dir, 'allowed', { path, expectedSha256: edited.afterSha256 }, true);
    assert.equal(readFileSync(removed.backup, 'utf8'), 'second');
    assert.equal(existsSync(join(root, path)), false);
  }
  const readonly = grantWorkspace({ root, mode: 'read' });
  assert.throws(() => changeWorkspace(readonly, dir, 'readonly', {
    path: 'ordinary.txt', text: 'no', expectedSha256: null,
  }), /read-only/);
}));

test('drive-relative, stream and dot-space traversal syntax is rejected before path resolution', () => fixture(({ dir, root, grant }) => {
  for (const path of ['C:.git/config', 'C:outside.txt', 'src/D:.GIT/config',
    'ordinary.txt:stream', '.. /outside.txt', 'new/.../outside.txt', ' /outside.txt',
    '.git\\config', '../outside.txt', 'new//file.txt']) {
    rejectOperations(grant, dir, path);
  }
  assert.deepEqual(listWorkspace(grant, '.').entries, []);
  assert.equal(existsSync(join(root, 'new')), false);
}));

test('Windows filesystem case aliases cannot expose or change existing .git files', {
  skip: process.platform !== 'win32' && 'requires a native Windows filesystem',
}, t => fixture(({ dir, root, grant }) => {
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'config'), original);
  if (!existsSync(join(root, '.GIT', 'config'))) {
    t.skip('the temporary filesystem is case-sensitive');
    return;
  }
  // Prove the alias reaches the real file without the worker, then prove the worker refuses it.
  assert.equal(readFileSync(join(root, '.GIT', 'config'), 'utf8'), original);
  for (const name of cases) rejectOperations(grant, dir, `${name}/config`);
  assert.equal(readFileSync(join(root, '.git', 'config'), 'utf8'), original);
}));

for (const pointer of [false, true]) test(`Windows alternate short names protect Git ${pointer ? 'pointer files' : 'directories and new descendants'}`, {
  skip: process.platform !== 'win32' && 'requires a native Windows filesystem',
}, t => fixture(({ dir, root, grant }) => {
  // Occupy the first short name so the filesystem must choose a different alias.
  mkdirSync(join(root, 'GIT~1'));
  if (pointer) writeFileSync(join(root, '.git'), original);
  else { mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git', 'config'), original); }
  const alias = join(root, 'GIT~2');
  if (!existsSync(alias)) { t.skip('the temporary volume does not generate this NTFS short name'); return; }
  assert.equal(realpathSync.native(alias), realpathSync.native(join(root, '.git')));
  for (const path of pointer ? ['GIT~2'] : ['GIT~2', 'GIT~2/config', 'GIT~2/new/deep.txt']) {
    rejectOperations(grant, dir, path);
  }
  assert.equal(readFileSync(join(root, '.git', ...(pointer ? [] : ['config'])), 'utf8'), original);
  if (!pointer) assert.equal(existsSync(join(root, '.git', 'new')), false);
  assert.equal(existsSync(join(dir, 'recovery')), false);
}));

test('MCP file tools reject protected paths for both read and edit grants without recording changes', () => fixture(async ({ dir, root }) => {
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'config'), original);
  const service = await start({ dir: join(dir, 'state'), port: 0, controlPort: 0 });
  const config = { dataDir: join(dir, 'state'), controlPort: service.controlPort };
  const call = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${service.mcpPort}/mcp`, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  try {
    for (const mode of ['read', 'edit']) {
      const { token } = await request('register', { id: mode, instructions: 'test boundaries', inputs: {}, workspace: { root, mode } }, config);
      for (const path of ['.GIT/config', 'nested/.GiT/config', '.git. /config', 'GIT~1/config', '.git::$INDEX_ALLOCATION/config']) {
        for (const name of ['list_files', 'read_file', 'write_file', 'delete_file']) {
          const args = { token, path };
          if (name === 'write_file') args.text = 'unauthorized';
          if (name === 'write_file' || name === 'delete_file') args.expectedSha256 = revision;
          const result = await call(name, args);
          assert.equal(result.isError, true, `${mode}: ${name} ${path}`);
          assert.match(result.content[0].text, /invalid path or Git metadata/, `${mode}: ${name} must reach path validation`);
        }
      }
      const listed = await call('list_files', { token, path: '.' });
      assert.deepEqual(listed.structuredContent.entries, []);
      const task = await call('get_task', { token });
      assert.deepEqual(task.structuredContent.changes, []);
      // Same schemas must reach ordinary files, rather than fail on extra keys.
      writeFileSync(join(root, 'ordinary.txt'), original);
      const read = await call('read_file', { token, path: 'ordinary.txt' });
      assert.equal(read.isError, false);
      assert.equal(read.structuredContent.sha256, revision);
      const ordinaryList = await call('list_files', { token, path: '.' });
      assert.equal(ordinaryList.isError, false);
      assert.deepEqual(ordinaryList.structuredContent.entries.map(entry => entry.name), ['ordinary.txt']);
      const edited = await call('write_file', { token, path: 'ordinary.txt', text: 'allowed', expectedSha256: revision });
      assert.equal(edited.isError, mode === 'read');
      if (mode === 'read') assert.match(edited.content[0].text, /read-only/);
      const removed = await call('delete_file', { token, path: 'ordinary.txt',
        expectedSha256: mode === 'edit' ? edited.structuredContent.afterSha256 : revision });
      assert.equal(removed.isError, mode === 'read');
      if (mode === 'read') {
        assert.match(removed.content[0].text, /read-only/);
        assert.equal(readFileSync(join(root, 'ordinary.txt'), 'utf8'), original);
        rmSync(join(root, 'ordinary.txt'));
      } else assert.equal(existsSync(join(root, 'ordinary.txt')), false);
      await request('cancel', { id: mode }, config);
    }
    assert.equal(readFileSync(join(root, '.git', 'config'), 'utf8'), original);
    assert.equal(existsSync(join(root, 'nested')), false);
  } finally { await service.close(); }
}));
