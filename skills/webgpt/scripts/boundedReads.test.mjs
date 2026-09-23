// Real file bytes, with deterministic growth immediately after a metadata snapshot.
// Only disposable fixtures are mutated; no timing assumptions or large-memory stress.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { grantWorkspace, readWorkspace, changeWorkspace, inspectRecovery } from './workspace.mjs';
import { verifySavedResult, inspectPendingResults, storeResult } from './results.mjs';
import { start } from './worker.mjs';
import { request, collectTask } from './client.mjs';
import { readBytesUpTo } from './bounded-read.mjs';

const LIMIT = 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, cleanup = true) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-bounded-')));
  const root = join(base, 'project'), dir = join(base, 'runtime');
  fs.mkdirSync(root); fs.mkdirSync(dir);
  if (cleanup) t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const path = 'source.txt', file = join(root, path);
  fs.writeFileSync(file, 'original');
  return { base, root, dir, path, file, grant: grantWorkspace({ root, mode: 'edit' }) };
}
function growAfterStat(t, file, operation, { at = 1 } = {}) {
  const opened = new Set();
  const native = { open: fs.openSync, stat: fs.fstatSync, read: fs.readSync, close: fs.closeSync };
  let metadataReads = 0, bytesRead = 0, grew = false;
  t.mock.method(fs, 'openSync', (path, ...args) => {
    const fd = native.open(path, ...args);
    if (path === file) opened.add(fd);
    return fd;
  });
  t.mock.method(fs, 'fstatSync', (fd, ...args) => {
    const info = native.stat(fd, ...args);
    if (opened.has(fd) && ++metadataReads === at) {
      // Another writer can change the file after this returned size was observed.
      fs.writeFileSync(file, Buffer.alloc(2 * LIMIT, 120));
      grew = true;
    }
    return info;
  });
  t.mock.method(fs, 'readSync', (fd, ...args) => {
    const count = native.read(fd, ...args);
    if (grew && opened.has(fd)) bytesRead += count;
    return count;
  });
  t.mock.method(fs, 'closeSync', fd => {
    const result = native.close(fd); opened.delete(fd); return result;
  });
  syncBuiltinESMExports();
  const finish = () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(grew, true, 'the regression must reach the post-stat growth window');
    assert.equal(opened.size, 0, 'every opened descriptor must close on rejection');
    assert.ok(bytesRead <= LIMIT + 1, `read ${bytesRead} bytes; limit plus sentinel is ${LIMIT + 1}`);
    assert.equal(fs.statSync(file).size, 2 * LIMIT, 'a rejected read must not rewrite its input');
  };
  // Async operations are used only for the real loopback integration tests.
  try {
    const result = operation();
    if (result?.then) return result.finally(finish);
    finish();
    return result;
  } catch (error) {
    t.mock.restoreAll(); syncBuiltinESMExports();
    throw error;
  }
}

for (const options of [{}, { offset: 1, limit: 1, maxChars: 100 }]) {
  test(`workspace ${Object.keys(options).length ? 'window' : 'whole-file'} reads stop after limit plus sentinel`, t => {
    const f = fixture(t);
    growAfterStat(t, f.file, () => {
      assert.throws(() => readWorkspace(f.grant, f.path, options), /UTF-8 text file required/);
    });
  });
}

for (const deleting of [false, true]) test(`${deleting ? 'delete' : 'edit'} preflight rejects growth before journals or mutation`, t => {
  const f = fixture(t);
  growAfterStat(t, f.file, () => {
    assert.throws(() => changeWorkspace(f.grant, f.dir, 'owned', {
      path: f.path, text: 'replacement', expectedSha256: hash('original'),
    }, deleting), /UTF-8 text file required/);
    assert.equal(fs.existsSync(join(f.dir, 'recovery')), false);
  });
});

for (const kind of ['verify', 'candidate', 'retry-flush']) test(`result ${kind} reads enforce a byte cap even after growth`, t => {
  const f = fixture(t), file = join(f.dir, 'owned.result.txt');
  fs.writeFileSync(file, 'original');
  growAfterStat(t, file, () => {
    if (kind === 'verify') assert.throws(() => verifySavedResult({
      id: 'owned', artifact: file, sha256: hash('original'),
    }, f.dir), { code: 'RESULT_INVALID' });
    else if (kind === 'candidate') {
      const found = inspectPendingResults({ id: 'owned', status: 'running' }, f.dir);
      assert.equal(found.length, 1); assert.equal(found[0].integrity, 'unreadable');
      assert.equal(found[0].code, 'RESULT_INVALID');
    } else {
      assert.throws(() => storeResult(f.dir, 'owned', 'original'), { code: 'RESULT_CONFLICT' });
    }
    assert.equal(fs.existsSync(file + '.tmp'), false);
  }, { at: kind === 'retry-flush' ? 2 : 1 });
});

for (const kind of ['journal', 'backup']) test(`recovery ${kind} growth remains unresolved without reading beyond the cap`, t => {
  const f = fixture(t);
  const receipt = changeWorkspace(f.grant, f.dir, 'owned', {
    path: f.path, text: 'changed', expectedSha256: hash('original'),
  });
  const journal = join(f.dir, 'recovery', 'owned', receipt.operation + '.json');
  growAfterStat(t, kind === 'journal' ? journal : receipt.backup, () => {
    const recovery = inspectRecovery(f.dir, 'owned');
    assert.deepEqual(recovery.receipts, []); assert.deepEqual(recovery.unresolved, [journal]);
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'changed');
  });
});

async function workerFixture(t) {
  const f = fixture(t, false);
  const service = await start({ dir: f.dir, port: 0, controlPort: 0, waitMs: 20 });
  t.after(async () => { await service.close(); fs.rmSync(f.base, { recursive: true, force: true }); });
  const config = { dataDir: f.dir, controlPort: service.controlPort };
  const registration = await request('register', { id: 'owned', instructions: 'fixture', inputs: {},
    workspace: { root: f.root, mode: 'edit' } }, config);
  const call = async (name, args) => (await (await fetch(`http://127.0.0.1:${service.mcpPort}/mcp`, {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: { token: registration.token, ...args } } }),
  })).json()).result;
  return { ...f, service, config, call };
}

test('MCP growth rejection keeps the editor usable and does not publish a receipt', async t => {
  const f = await workerFixture(t);
  await growAfterStat(t, f.file, async () => {
    const result = await f.call('read_file', { path: f.path, offset: 1, limit: 1 });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /UTF-8 text file required/);
  });
  const task = (await f.call('get_task', {})).structuredContent;
  assert.equal(task.status, 'running'); assert.deepEqual(task.changes, []);
  const write = await f.call('write_file', { path: 'unrelated.txt', text: 'allowed', expectedSha256: null });
  assert.equal(write.isError, false);
});

test('collection rejects a growing result without acknowledgment or token retirement', async t => {
  const f = await workerFixture(t);
  assert.equal((await f.call('submit_result', { status: 'completed', summary: 'done', result: 'original' })).isError, false);
  const before = fs.readFileSync(join(f.dir, 'state.json'));
  const file = join(f.dir, 'owned.result.txt');
  await growAfterStat(t, file, () => assert.rejects(collectTask('owned', f.config), { code: 'RESULT_INVALID' }));
  assert.deepEqual(fs.readFileSync(join(f.dir, 'state.json')), before);
  assert.equal((await f.call('get_task', {})).isError, false);
  assert.equal((await request('status', undefined, f.config)).events.length, 1);
});

for (const size of [0, 1, 4095, 4096, 4097, 65536, LIMIT, LIMIT + 1]) {
  test(`byte reader returns initialized bytes and respects its ceiling for ${size} bytes`, t => {
    const f = fixture(t), body = Buffer.alloc(size, 123);
    fs.writeFileSync(f.file, body);
    const fd = fs.openSync(f.file, 'r');
    try {
      const ceiling = Math.min(LIMIT + 1, Math.max(1, size));
      assert.deepEqual(readBytesUpTo(fd, ceiling), body.subarray(0, ceiling));
      assert.equal(fs.fstatSync(fd).size, size, 'the helper must not close or modify the descriptor');
    } finally { fs.closeSync(fd); }
  });
}

test('byte reader handles short reads and split UTF-8 characters without exposing the tail', t => {
  const f = fixture(t), body = Buffer.from('한글 🧪\r\n'.repeat(1000));
  fs.writeFileSync(f.file, body);
  const fd = fs.openSync(f.file, 'r'), original = fs.readSync;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) =>
    original(fd, buffer, offset, Math.min(3, length), position));
  syncBuiltinESMExports();
  try { assert.deepEqual(readBytesUpTo(fd, body.length + 1), body); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.closeSync(fd); }
});

test('byte reader starts at the current descriptor offset and does not seek', t => {
  const f = fixture(t); fs.writeFileSync(f.file, '0123456789');
  const fd = fs.openSync(f.file, 'r');
  try {
    fs.readSync(fd, Buffer.alloc(2), 0, 2, null);
    assert.equal(readBytesUpTo(fd, 3).toString(), '234');
    assert.equal(readBytesUpTo(fd, 10).toString(), '56789');
  } finally { fs.closeSync(fd); }
});

test('byte reader ends at its ceiling even when every read appends more bytes', t => {
  const f = fixture(t); fs.writeFileSync(f.file, Buffer.alloc(4096, 120));
  const fd = fs.openSync(f.file, 'r'), original = fs.readSync;
  let total = 0;
  t.mock.method(fs, 'readSync', (descriptor, ...args) => {
    fs.appendFileSync(f.file, Buffer.alloc(4096, 120));
    const count = original(descriptor, ...args); total += count; return count;
  });
  syncBuiltinESMExports();
  try { assert.deepEqual(readBytesUpTo(fd, 5000), Buffer.alloc(5000, 120)); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.closeSync(fd); }
  assert.equal(total, 5000);
});

test('byte reader returns only the remaining bytes when the file shrinks between reads', t => {
  const f = fixture(t); fs.writeFileSync(f.file, Buffer.alloc(8000, 120));
  const fd = fs.openSync(f.file, 'r'), original = fs.readSync;
  let calls = 0;
  t.mock.method(fs, 'readSync', (descriptor, ...args) => {
    if (++calls === 2) fs.truncateSync(f.file, 4500);
    return original(descriptor, ...args);
  });
  syncBuiltinESMExports();
  try { assert.deepEqual(readBytesUpTo(fd, 8001), Buffer.alloc(4500, 120)); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.closeSync(fd); }
});

test('byte reader rejects invalid ceilings before any I/O', t => {
  let read = false;
  t.mock.method(fs, 'readSync', () => { read = true; throw Error('must not read'); });
  syncBuiltinESMExports();
  try {
    for (const ceiling of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null])
      assert.throws(() => readBytesUpTo(-1, ceiling), RangeError);
    assert.equal(read, false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('I/O failures propagate while the caller retains descriptor ownership', t => {
  const f = fixture(t), fd = fs.openSync(f.file, 'r');
  const failure = Object.assign(Error('fixture read failure'), { code: 'EIO' });
  t.mock.method(fs, 'readSync', () => { throw failure; }); syncBuiltinESMExports();
  try {
    assert.throws(() => readBytesUpTo(fd, 10), error => error === failure);
    assert.equal(fs.fstatSync(fd).isFile(), true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.closeSync(fd); }
});

test('exact-limit Korean, emoji and CRLF contents keep whole-file revisions and result integrity', t => {
  const f = fixture(t), prefix = '한글 🧪\r\n';
  const text = prefix + 'x'.repeat(LIMIT - Buffer.byteLength(prefix));
  fs.writeFileSync(f.file, text);
  const whole = readWorkspace(f.grant, f.path);
  assert.equal(whole.text, text); assert.equal(whole.sha256, hash(text));
  const part = readWorkspace(f.grant, f.path, { offset: 1, limit: 1 });
  assert.equal(part.text, prefix); assert.equal(part.sha256, whole.sha256); assert.equal(part.partial, true);
  const saved = storeResult(f.dir, 'boundary', text);
  assert.equal(verifySavedResult({ id: 'boundary', ...saved }, f.dir), 'verified');
  assert.deepEqual(storeResult(f.dir, 'boundary', text), saved, 'identical result retry still succeeds');
  assert.equal(fs.existsSync(saved.artifact + '.tmp'), false);
});

test('workspace rejects invalid UTF-8 and NUL rather than decoding a partial prefix', t => {
  const f = fixture(t);
  for (const bytes of [Buffer.from([0xff]), Buffer.from('ok\0not-text'), Buffer.from([0xf0, 0x9f, 0xa7])]) {
    fs.writeFileSync(f.file, bytes);
    assert.throws(() => readWorkspace(f.grant, f.path), /UTF-8 text file required/);
  }
});
