import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { storeResult, verifySavedResult, inspectPendingResults } from './results.mjs';
import { readFixture, observeFileRead } from './test-fixtures/file-read.mjs';

const text = '\uFEFFresult 한국어 😀\r\n', bytes = Buffer.from(text);
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t, mode, value = text, dir = readFixture(t)) {
  const artifact = join(dir, 'owned.result.txt');
  const file = mode === 'saved' ? artifact : artifact + '.tmp';
  const original = file + '.original', replacement = file + '.replacement';
  const other = join(dir, 'unrelated.txt');
  if (mode !== 'new') fs.writeFileSync(file, value, { mode: 0o600 });
  fs.writeFileSync(replacement, Buffer.alloc(Buffer.byteLength(value), 120), { mode: 0o600 });
  fs.writeFileSync(other, 'unrelated evidence');
  return { dir, artifact, file, original, replacement, other };
}
function swap(f) { fs.renameSync(f.file, f.original); fs.renameSync(f.replacement, f.file); }
function restore(t, trace, mocks) {
  // Disassociate tracked mocks before reverse restoration; otherwise automatic
  // test cleanup can reinstall an observer underneath a restored fault mock.
  t.mock.reset();
  for (const mock of [...mocks].reverse()) mock.mock.restore();
  trace.restore();
}
function afterFlush(t, f, action) {
  const trace = observeFileRead(t, f.file), close = fs.closeSync, sync = fs.fsyncSync;
  let flushed = 0, injected = false;
  const mocks = [t.mock.method(fs, 'fsyncSync', fd => { const value = sync(fd); flushed++; return value; })];
  mocks.push(t.mock.method(fs, 'closeSync', fd => {
    const before = trace.evidence.closes, value = close(fd);
    if (!injected && flushed && trace.evidence.closes > before) { injected = true; action(); }
    return value;
  }));
  syncBuiltinESMExports();
  return { trace, get flushed() { return flushed; }, get injected() { return injected; },
    restore: () => restore(t, trace, mocks) };
}

for (const mode of ['new', 'staged', 'saved']) {
  test(`result publication preserves ${mode} bytes, flushes once and returns no metadata`, t => {
    // Empty, Unicode and exact-limit results share the same publication contract.
    for (const value of ['', text, 'x'.repeat(1024 * 1024)]) {
      const f = fixture(t, mode, value), trace = observeFileRead(t, f.file, { chunkSize: 4096 });
      const sync = fs.fsyncSync; let flushed = 0;
      const mock = t.mock.method(fs, 'fsyncSync', fd => { flushed++; return sync(fd); });
      syncBuiltinESMExports();
      let receipt;
      try { receipt = storeResult(f.dir, 'owned', value); }
      finally { restore(t, trace, [mock]); }
      assert.equal(flushed, 1);
      assert.equal(trace.evidence.opens, trace.evidence.closes);
      assert.equal(trace.evidence.bytes, mode === 'new' ? 0 : 2 * Buffer.byteLength(value));
      assert.deepEqual(receipt, { artifact: f.artifact, sha256: hash(value) });
      assert.deepEqual(fs.readFileSync(f.artifact), Buffer.from(value));
      assert.equal(verifySavedResult({ id: 'owned', ...receipt }, f.dir), 'verified');
      assert.equal(fs.existsSync(f.artifact + '.tmp'), false);
      assert.equal(fs.readFileSync(f.other, 'utf8'), 'unrelated evidence');
    }
  });

  test(`result publication rejects ${mode} path replacement after flush and close`, t => {
    const f = fixture(t, mode), trace = afterFlush(t, f, () => swap(f));
    try { assert.throws(() => storeResult(f.dir, 'owned', text), { code: 'RESULT_CONFLICT', retryable: false }); }
    finally { trace.restore(); }
    assert.equal(trace.injected, true); assert.equal(trace.flushed, 1);
    assert.equal(trace.trace.evidence.opens, trace.trace.evidence.closes);
    assert.deepEqual(fs.readFileSync(f.original), bytes);
    assert.deepEqual(fs.readFileSync(f.file), Buffer.alloc(bytes.length, 120));
    if (mode !== 'saved') assert.equal(fs.existsSync(f.artifact), false);
    assert.equal(fs.readFileSync(f.other, 'utf8'), 'unrelated evidence');
  });
}

for (const mode of ['staged', 'saved']) test(`result publication binds ${mode} retry before reading or flushing`, t => {
  const f = fixture(t, mode); fs.writeFileSync(f.replacement, bytes);
  let attempts = 0, swapped = false, flushed = 0;
  const trace = observeFileRead(t, f.file, { beforeOpen() {
    if (++attempts === 2) { swap(f); swapped = true; }
  } });
  const sync = fs.fsyncSync, mock = t.mock.method(fs, 'fsyncSync', fd => { flushed++; return sync(fd); });
  syncBuiltinESMExports();
  try { assert.throws(() => storeResult(f.dir, 'owned', text), { code: 'RESULT_CONFLICT', retryable: false }); }
  finally { restore(t, trace, [mock]); }
  assert.equal(swapped, true); assert.equal(flushed, 0);
  assert.equal(trace.evidence.bytes, bytes.length, 'only the initial candidate was read');
  assert.equal(trace.evidence.opens, trace.evidence.closes);
  assert.deepEqual(fs.readFileSync(f.original), bytes); assert.deepEqual(fs.readFileSync(f.file), bytes);
  if (mode !== 'saved') assert.equal(fs.existsSync(f.artifact), false);
});

for (const field of ['dev', 'ino']) test(`result publication compares full-width ${field} through retry and publication`, t => {
  for (const phase of ['retry-open', 'publish']) for (const changed of [false, true]) {
    const f = fixture(t, 'staged'); let opens = 0, closed = false;
    const trace = observeFileRead(t, f.file, { beforeOpen() { opens++; } });
    const lstat = fs.lstatSync, fstat = fs.fstatSync, close = fs.closeSync;
    const base = 2n ** 60n;
    const metadata = (info, options, later) => {
      const convert = value => options?.bigint ? value : Number(value);
      // Isolate each field: the other identity must not mask precision loss.
      return Object.assign(info, { dev: convert(7n), ino: convert(9n),
        [field]: convert(base + (changed && later ? 1n : 0n)) });
    };
    const mocks = [t.mock.method(fs, 'lstatSync', (path, options) => {
      const info = lstat(path, options);
      return path === f.file ? metadata(info, options, closed) : info;
    }), t.mock.method(fs, 'fstatSync', (fd, options) => metadata(fstat(fd, options), options, phase === 'retry-open' && opens === 2)),
    t.mock.method(fs, 'closeSync', fd => {
      const before = trace.evidence.closes, value = close(fd);
      if (phase === 'publish' && opens === 2 && trace.evidence.closes > before) closed = true;
      return value;
    })];
    syncBuiltinESMExports();
    try {
      if (changed) assert.throws(() => storeResult(f.dir, 'owned', text), { code: 'RESULT_CONFLICT' });
      else assert.equal(storeResult(f.dir, 'owned', text).sha256, hash(bytes));
    } finally { restore(t, trace, mocks); }
    assert.equal(trace.evidence.opens, trace.evidence.closes);
    assert.equal(fs.existsSync(f.artifact), !changed);
    assert.deepEqual(fs.readFileSync(changed ? f.file : f.artifact), bytes);
  }
});

// Store failures must retain bytes and never return a receipt. Existing recovery
// suites own restart, collection and fault classification beyond this boundary.
for (const method of ['writeFileSync', 'fsyncSync', 'closeSync', 'renameSync']) {
  test(`result publication preserves new candidate evidence on ${method} failure`, t => {
    const f = fixture(t, 'new'), trace = observeFileRead(t, f.file), native = fs[method];
    const failure = Object.assign(Error('fixture I/O failure'), { code: 'EIO' });
    let injected = false;
    const mock = t.mock.method(fs, method, (...args) => {
      // Partial write and post-close failures reflect their actual side effects.
      if (method === 'writeFileSync') native(args[0], bytes.subarray(0, 4));
      if (method === 'closeSync') native(...args);
      injected = true; throw failure;
    });
    syncBuiltinESMExports();
    try { assert.throws(() => storeResult(f.dir, 'owned', text), error => error === failure); }
    finally { restore(t, trace, [mock]); }
    assert.equal(injected, true);
    assert.equal(trace.evidence.opens, trace.evidence.closes);
    assert.equal(fs.existsSync(f.artifact), false);
    assert.deepEqual(fs.readFileSync(f.file), method === 'writeFileSync' ? bytes.subarray(0, 4) : bytes);
    assert.equal(fs.readFileSync(f.other, 'utf8'), 'unrelated evidence');
  });
}

test('result publication keeps both equal retained candidates without deleting evidence', t => {
  const f = fixture(t, 'saved'); fs.writeFileSync(f.artifact + '.tmp', bytes);
  const receipt = storeResult(f.dir, 'owned', text);
  assert.equal(verifySavedResult({ id: 'owned', ...receipt }, f.dir), 'verified');
  const pending = inspectPendingResults({ id: 'owned', status: 'completed', artifact: receipt.artifact }, f.dir);
  assert.deepEqual(pending, [{ artifact: f.artifact + '.tmp', sha256: hash(bytes), bytes: bytes.length, integrity: 'uncommitted' }]);
  assert.deepEqual(fs.readFileSync(f.artifact + '.tmp'), bytes);
});

test('result publication checks current type, link count and size after flushing', t => {
  for (const damage of ['missing', 'hardlink', 'growth']) {
    const f = fixture(t, 'new'), trace = afterFlush(t, f, () => {
      if (damage === 'missing') fs.renameSync(f.file, f.original);
      else if (damage === 'hardlink') fs.linkSync(f.file, f.original);
      else fs.appendFileSync(f.file, 'x');
    });
    try { assert.throws(() => storeResult(f.dir, 'owned', text), {
      code: damage === 'missing' ? 'ENOENT' : damage === 'hardlink' ? 'RESULT_INVALID' : 'RESULT_CONFLICT',
    }); } finally { trace.restore(); }
    assert.equal(trace.injected, true); assert.equal(fs.existsSync(f.artifact), false);
    assert.equal(trace.trace.evidence.opens, trace.trace.evidence.closes);
    assert.deepEqual(fs.readFileSync(damage === 'growth' ? f.file : f.original),
      damage === 'growth' ? Buffer.concat([bytes, Buffer.from('x')]) : bytes);
  }
});

for (const mode of ['new', 'staged', 'saved']) test(`result publication MCP ${mode} conflict preserves running state and recovery`, async t => {
  const { start } = await import('./worker.mjs');
  const { request, collectTask, reconcileTasks } = await import('./client.mjs');
  const { callTool } = await import('./test-fixtures/worker-http.mjs');
  const base = readFixture(t), dir = join(base, 'runtime');
  const worker = await start({ dir, port: 0, controlPort: 0, waitMs: 20, closeGraceMs: 50 });
  try {
    const config = { dataDir: dir, controlPort: worker.controlPort };
    const owned = await request('register', { id: 'owned', instructions: 'retain', inputs: { source: 'private input' } }, config);
    const other = await request('register', { id: 'other', instructions: '', inputs: {} }, config);
    const f = fixture(t, mode, text, dir), state = fs.readFileSync(join(dir, 'state.json'));
    const trace = afterFlush(t, f, () => swap(f));
    let reply;
    try { reply = await callTool(worker, 'submit_result', { token: owned.token, status: 'completed', summary: 'fixture', result: text }); }
    finally { trace.restore(); }
    assert.equal(trace.injected, true); assert.equal(reply.isError, true);
    assert.equal(JSON.stringify(reply).includes(dir), false);
    assert.equal(JSON.stringify(reply).includes(owned.token), false);
    assert.deepEqual(fs.readFileSync(join(dir, 'state.json')), state);
    const task = (await callTool(worker, 'get_task', { token: owned.token })).structuredContent;
    assert.equal(task.status, 'running');
    assert.equal((await callTool(worker, 'read_input', { token: owned.token, name: 'source' })).isError, false);
    const inspection = (await reconcileTasks(config, { ids: ['owned'] })).tasks[0];
    assert.equal(inspection.collected, false); assert.equal(inspection.artifact, null);
    assert.equal(inspection.attention, 'inspect_uncommitted_result');
    await assert.rejects(collectTask('owned', config));
    assert.deepEqual(fs.readFileSync(f.original), bytes);
    assert.deepEqual(fs.readFileSync(f.file), Buffer.alloc(bytes.length, 120));
    // The conflict is task-local, not authority to revoke or block other work.
    assert.equal((await callTool(worker, 'submit_result', { token: other.token, status: 'completed', summary: 'other', result: 'other result' })).isError, false);
    assert.equal((await collectTask('other', config)).integrity, 'verified');
    await request('cancel', { id: 'owned' }, config);
    assert.deepEqual(fs.readFileSync(f.file), Buffer.alloc(bytes.length, 120));
    assert.equal((await callTool(worker, 'get_task', { token: owned.token })).isError, true);
  } finally { await worker.close(); }
});
