import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { grantWorkspace, readWorkspace, changeWorkspace, inspectRecovery } from './workspace.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
function fixture(t, text = '\uFEFFfirst\r\nconst label = "한국어 🧪";\r\nlast\n') {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-exact-edit-')));
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-exact-data-')));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = join(root, 'a.txt'); fs.writeFileSync(file, text, { mode: 0o640 });
  const grant = grantWorkspace({ root, mode: 'edit' });
  const write = args => changeWorkspace(grant, dir, 'owned', { path: 'a.txt', expectedSha256: hash(text), ...args });
  return { root, dir, file, text, grant, write };
}

test('exact edit from a bounded window preserves all other bytes, modes and recovery receipts', t => {
  const f = fixture(t), beforeMode = fs.statSync(f.file).mode;
  const window = readWorkspace(f.grant, 'a.txt', { offset: 2, limit: 1 });
  assert.equal(window.partial, true); assert.equal(window.sha256, hash(f.text));
  const replacement = 'const label = "$& literal 🧪";\r\n';
  const receipt = f.write({ oldText: window.text, text: replacement, expectedSha256: window.sha256 });
  const after = '\uFEFFfirst\r\n' + replacement + 'last\n';
  assert.equal(fs.readFileSync(f.file, 'utf8'), after);
  assert.equal(fs.statSync(f.file).mode, beforeMode);
  assert.equal(receipt.beforeSha256, hash(f.text)); assert.equal(receipt.afterSha256, hash(after));
  assert.equal(fs.readFileSync(receipt.backup, 'utf8'), f.text);
  assert.deepEqual(inspectRecovery(f.dir, 'owned'), { receipts: [receipt], unresolved: [] });
});

test('exact removal and whole-file creation/replacement remain distinct supported operations', t => {
  const f = fixture(t, 'prefix remove suffix');
  f.write({ oldText: 'remove ', text: '' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'prefix suffix');
  changeWorkspace(f.grant, f.dir, 'owned', { path: 'new.txt', expectedSha256: null, text: 'new' });
  changeWorkspace(f.grant, f.dir, 'owned', { path: 'new.txt', expectedSha256: hash('new'), text: 'whole' });
  assert.equal(fs.readFileSync(join(f.root, 'new.txt'), 'utf8'), 'whole');
});

for (const [name, original, oldText, text] of [
  ['absent', 'abc', 'missing', 'x'], ['ambiguous', 'a a', 'a', 'x'],
  ['overlapping', 'aaa', 'aa', 'x'], ['empty match', 'abc', '', 'x'],
  ['no-op', 'abc', 'b', 'b'], ['NUL match', 'abc', '\0', 'x'],
  ['bad Unicode match', 'abc', '\uD800', 'x'], ['bad Unicode replacement', 'abc', 'b', '\uD800'],
  ['NUL replacement', 'abc', 'b', '\0'], ['output too large', 'a'.repeat(10 * 1024 * 1024 - 1) + 'b', 'b', 'xx'],
]) test(`exact edit rejects ${name} before creating recovery artifacts`, t => {
  const f = fixture(t, original);
  assert.throws(() => f.write({ oldText, text }));
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('exact edit cannot create files or silently retry a stale whole-file revision', t => {
  const f = fixture(t);
  assert.throws(() => f.write({ path: 'new/child.txt', expectedSha256: null, oldText: 'x', text: 'y' }));
  assert.equal(fs.existsSync(join(f.root, 'new')), false);
  fs.appendFileSync(f.file, 'external change');
  assert.throws(() => f.write({ oldText: 'first', text: 'changed' }), /revision conflict/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.text + 'external change');
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('exact edit uses the unchanged late-revision guard and preserves prepared recovery evidence', t => {
  const f = fixture(t, 'before'), original = fs.fsyncSync;
  const mock = t.mock.method(fs, 'fsyncSync', fd => { original(fd); fs.writeFileSync(f.file, 'external'); });
  syncBuiltinESMExports();
  try { assert.throws(() => f.write({ oldText: 'before', text: 'after' }), /revision conflict/); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'external');
  const recovery = inspectRecovery(f.dir, 'owned');
  assert.equal(recovery.receipts.length, 0); assert.equal(recovery.unresolved.length, 1);
  const journal = JSON.parse(fs.readFileSync(recovery.unresolved[0], 'utf8'));
  assert.equal(fs.readFileSync(journal.backup, 'utf8'), 'before');
});

test('exact edit retains read-only, link and Git metadata denial', t => {
  const f = fixture(t, 'before');
  assert.throws(() => changeWorkspace({ ...f.grant, mode: 'read' }, f.dir, 'owned',
    { path: 'a.txt', expectedSha256: hash('before'), oldText: 'before', text: 'after' }), /read-only/);
  fs.linkSync(f.file, join(f.root, 'hardlink'));
  assert.throws(() => f.write({ oldText: 'before', text: 'after' }), /hardlink/);
  fs.mkdirSync(join(f.root, '.git')); fs.writeFileSync(join(f.root, '.git', 'config'), 'before');
  assert.throws(() => f.write({ path: '.git/config', oldText: 'before', text: 'after' }), /Git metadata/);
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('revision-bound windows reject changed or missing files rather than mixing snapshots', t => {
  const f = fixture(t, 'a\nb\nc\n');
  const first = readWorkspace(f.grant, 'a.txt', { limit: 1 });
  const next = { offset: first.nextOffset, limit: 1, expectedSha256: first.sha256 };
  assert.equal(readWorkspace(f.grant, 'a.txt', next).text, 'b\n');
  assert.equal(readWorkspace(f.grant, 'a.txt', { expectedSha256: first.sha256 }).text, f.text);
  fs.writeFileSync(f.file, 'a\nchanged\nc\n');
  assert.throws(() => readWorkspace(f.grant, 'a.txt', next), /revision conflict/);
  fs.unlinkSync(f.file);
  assert.throws(() => readWorkspace(f.grant, 'a.txt', next), /revision conflict/);
  assert.equal(readWorkspace(f.grant, 'a.txt').exists, false);
});

test('invalid read revisions/options and exact-delete arguments fail closed', t => {
  const f = fixture(t);
  for (const expectedSha256 of [null, '', 'x', 1, {}, 'A'.repeat(64)])
    assert.throws(() => readWorkspace(f.grant, 'a.txt', { expectedSha256 }));
  for (const options of [null, [], { unknown: true }])
    assert.throws(() => readWorkspace(f.grant, 'a.txt', options));
  assert.throws(() => changeWorkspace(f.grant, f.dir, 'owned', { path: 'a.txt', oldText: 'first', expectedSha256: hash(f.text) }, true));
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('small exact edits and deletion preserve 10 MiB files and original backups', t => {
  const limit = 10 * 1024 * 1024, f = fixture(t, 'a'.repeat(limit - 1) + 'b');
  const whole = { path: 'a.txt', expectedSha256: hash(f.text), text: f.text.slice(0, -1) + 'c' };
  const exact = { path: 'a.txt', expectedSha256: hash(f.text), oldText: 'b', text: 'c' };
  assert.ok(Buffer.byteLength(JSON.stringify(exact)) < 200);
  assert.ok(Buffer.byteLength(JSON.stringify(whole)) > limit);
  const receipt = f.write(exact);
  assert.equal(fs.statSync(f.file).size, limit);
  assert.equal(receipt.afterSha256, hash(whole.text));
  assert.equal(fs.readFileSync(receipt.backup, 'utf8'), f.text);
  assert.deepEqual(inspectRecovery(f.dir, 'owned'), { receipts: [receipt], unresolved: [] });
  const deleted = changeWorkspace(f.grant, f.dir, 'owned', {
    path: 'a.txt', expectedSha256: receipt.afterSha256,
  }, true);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.readFileSync(deleted.backup, 'utf8'), whole.text);
  const recovery = inspectRecovery(f.dir, 'owned');
  assert.deepEqual(recovery.unresolved, []);
  assert.deepEqual(new Map(recovery.receipts.map(item => [item.operation, item])),
    new Map([receipt, deleted].map(item => [item.operation, item])));
});

// Real MCP boundary tests run in the repository and standalone-installed suites.
// Dynamic import also permits focused workspace tests with a dependency subset.
async function mcpFixture(t, mode = 'edit') {
  const { start } = await import('./worker.mjs');
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-exact-mcp-')));
  const root = join(base, 'project'), dir = join(base, 'data');
  fs.mkdirSync(root); fs.mkdirSync(dir);
  const file = join(root, 'a.txt'), text = 'first\r\nchange me\r\nlast\n';
  fs.writeFileSync(file, text);
  let worker;
  t.after(async () => { await worker?.close(); fs.rmSync(base, { recursive: true, force: true }); });
  worker = await start({ dir, port: 0, controlPort: 0, configFile: join(base, 'config.json'), waitMs: 20 });
  const post = async (port, path, value, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value),
    });
    assert.equal(response.status, 200); return response.json();
  };
  const { token } = await post(worker.controlPort, '/register', {
    id: 'owned', instructions: 'owned exact-edit fixture', inputs: {}, workspace: { root, mode },
  }, { authorization: 'Bearer ' + worker.key });
  assert.equal(typeof token, 'string');
  const rpc = async (method, params = {}) => (await post(worker.mcpPort, '/mcp', { jsonrpc: '2.0', id: 1, method, params })).result;
  const call = (name, args = {}) => rpc('tools/call', { name, arguments: { token, ...args } });
  return { root, dir, file, text, call, rpc };
}

test('MCP exact edits advertise optional fields and preserve legacy tools, receipts and terminal closure', async t => {
  const f = await mcpFixture(t);
  const listed = (await f.rpc('tools/list')).tools;
  assert.equal(listed.length, 7);
  const writeSchema = listed.find(tool => tool.name === 'write_file').inputSchema;
  assert.deepEqual(writeSchema.required, ['token', 'path', 'text', 'expectedSha256']);
  assert.equal(writeSchema.properties.oldText.type, 'string');
  const readSchema = listed.find(tool => tool.name === 'read_file').inputSchema;
  assert.deepEqual(readSchema.required, ['token', 'path']);
  assert.equal(readSchema.properties.expectedSha256.type, 'string');
  const page = await f.call('read_file', { path: 'a.txt', offset: 2, limit: 1 });
  assert.equal(page.isError, false); assert.equal(page.structuredContent.partial, true);
  const sha = page.structuredContent.sha256;
  const pinned = await f.call('read_file', { path: 'a.txt', offset: 3, limit: 1, expectedSha256: sha });
  assert.equal(pinned.isError, false, pinned.content?.[0]?.text); assert.equal(pinned.structuredContent.text, 'last\n');
  for (const args of [{ oldText: null }, { unexpected: 'x' }]) {
    assert.equal((await f.call('write_file', { path: 'a.txt', expectedSha256: sha, text: 'new', ...args })).isError, true);
  }
  const changed = await f.call('write_file', { path: 'a.txt', expectedSha256: sha, oldText: page.structuredContent.text, text: 'changed\r\n' });
  assert.equal(changed.isError, false, changed.content?.[0]?.text);
  const receipt = changed.structuredContent;
  assert.equal(receipt.beforeSha256, sha); assert.equal(receipt.afterSha256, hash('first\r\nchanged\r\nlast\n'));
  assert.equal(fs.readFileSync(receipt.backup, 'utf8'), f.text);
  assert.deepEqual((await f.call('get_task')).structuredContent.changes, [receipt]);
  // Stale reads never return a mixed-revision excerpt; stale edits never apply twice.
  const stale = await f.call('read_file', { path: 'a.txt', offset: 3, limit: 1, expectedSha256: sha });
  assert.equal(stale.isError, true); assert.equal(stale.structuredContent, undefined);
  assert.match(stale.content[0].text, /revision conflict/, 'a malformed read must not satisfy stale-revision coverage');
  assert.equal((await f.call('write_file', { path: 'a.txt', expectedSha256: sha, oldText: 'changed', text: 'again' })).isError, true);
  assert.equal((await f.call('write_file', { path: 'new.txt', expectedSha256: null, text: 'legacy create' })).isError, false);
  assert.equal((await f.call('write_file', { path: 'new.txt', expectedSha256: hash('legacy create'), text: 'legacy replace' })).isError, false);
  assert.equal((await f.call('submit_result', { status: 'completed', summary: 'fixture', result: 'owned fixture result' })).isError, false);
  const state = fs.readFileSync(join(f.dir, 'state.json'));
  assert.equal((await f.call('read_file', { path: 'a.txt', expectedSha256: receipt.afterSha256 })).isError, true);
  assert.equal((await f.call('write_file', { path: 'a.txt', expectedSha256: receipt.afterSha256, oldText: 'changed', text: 'later' })).isError, true);
  assert.deepEqual(fs.readFileSync(join(f.dir, 'state.json')), state);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'first\r\nchanged\r\nlast\n');
});

for (const problem of ['read-only', 'pending-result', 'journal', 'state-stage']) test(`MCP exact edits retain ${problem} guard without changing project bytes`, async t => {
  const f = await mcpFixture(t, problem === 'read-only' ? 'read' : 'edit');
  if (problem === 'pending-result') fs.writeFileSync(join(f.dir, 'owned.result.txt.tmp'), 'candidate');
  if (problem === 'journal') {
    fs.mkdirSync(join(f.dir, 'recovery', 'owned'), { recursive: true });
    fs.writeFileSync(join(f.dir, 'recovery', 'owned', 'broken.json'), '{}');
  }
  if (problem === 'state-stage') fs.writeFileSync(join(f.dir, 'state.json.tmp'), 'candidate state');
  const state = fs.readFileSync(join(f.dir, 'state.json'));
  const result = await f.call('write_file', { path: 'a.txt', expectedSha256: hash(f.text), oldText: 'change me', text: 'changed' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, problem === 'read-only' ? /read-only/ : problem === 'pending-result' ? /uncommitted result/
    : problem === 'journal' ? /recovery required/ : /state/i);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.text);
  assert.deepEqual(fs.readFileSync(join(f.dir, 'state.json')), state);
  if (problem === 'pending-result') assert.equal(fs.readFileSync(join(f.dir, 'owned.result.txt.tmp'), 'utf8'), 'candidate');
  if (problem === 'state-stage') assert.equal(fs.readFileSync(join(f.dir, 'state.json.tmp'), 'utf8'), 'candidate state');
});
