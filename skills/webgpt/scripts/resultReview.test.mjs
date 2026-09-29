// Read-only parent UX: real client, loopback HTTP and owned files. No browser proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import timers from 'node:timers/promises';
import { reviewTask, waitForTasks, retryableControllerError, verifyResult, collectTask, request } from './client.mjs';
import { readVerifiedResult } from './results.mjs';

const text = '\uFEFF한국어 🧪\r\n\u0000literal "quotes" \\ path\n';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const empty = () => ({ events: [], backupDue: [], settled: false });
const cli = fileURLToPath(new URL('./client.mjs', import.meta.url));
async function fixture(t, { content = text, status = 'completed' } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-review-')));
  const artifact = join(dir, 'owned.result.txt');
  const event = { id: 'owned', status, summary: 'fixture', artifact, sha256: digest(content) };
  fs.writeFileSync(artifact, content, { mode: 0o600 });
  fs.writeFileSync(join(dir, 'controller.key'), 'fixture-only-key', { mode: 0o600 });
  fs.writeFileSync(join(dir, 'state.json'), 'owned-evidence', { mode: 0o600 });
  const calls = [];
  let respond = (_req, res) => res.end(JSON.stringify({ ...empty(), events: [event], settled: true }));
  let reconcile = value => value;
  const server = createServer((req, res) => {
    calls.push({ method: req.method, path: req.url });
    if (req.headers.authorization !== 'Bearer fixture-only-key') { res.writeHead(401); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/reconcile?id=owned') {
      res.end(JSON.stringify(reconcile({ scope: ['owned'], health: { stateVerified: true, issues: [] },
        tasks: [{ ...event, collected: false, discarded: false, recoveryRequired: [], journalIssues: [], pendingResults: [] }] })));
      return;
    }
    respond(req, res);
  });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const config = { dataDir: dir, controlPort: server.address().port };
  const configFile = join(dir, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  const runCli = args => promisify(execFile)(process.execPath, [cli, ...args], {
    cwd: dir, env: { ...process.env, WEBGPT_CONFIG: configFile, WEBGPT_DATA_DIR: dir }, timeout: 10000, maxBuffer: 8 * 1024 * 1024,
  });
  return { dir, artifact, event, config, calls, runCli, respond: callback => { respond = callback; }, reconcile: callback => { reconcile = callback; } };
}
async function observeResultReads(t, f, run) {
  const original = { open: fs.openSync, read: fs.readSync, close: fs.closeSync };
  const descriptors = new Set(); let opens = 0, bytes = 0;
  const mocks = [
    t.mock.method(fs, 'openSync', (file, ...args) => {
      const fd = original.open(file, ...args);
      if (file === f.artifact && typeof args[0] === 'number'
          && !(args[0] & (fs.constants.O_WRONLY | fs.constants.O_RDWR))) { opens++; descriptors.add(fd); }
      return fd;
    }),
    t.mock.method(fs, 'readSync', (fd, ...args) => {
      const count = original.read(fd, ...args); if (descriptors.has(fd)) bytes += count; return count;
    }),
    t.mock.method(fs, 'closeSync', fd => { descriptors.delete(fd); return original.close(fd); }),
  ];
  syncBuiltinESMExports();
  try { await run(); }
  finally { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(descriptors.size, 0);
  return { opens, bytes };
}

for (const status of ['completed', 'failed', 'cancelled']) test(`review preserves ${status}, exact text and one-read cost without retirement`, async t => {
  const f = await fixture(t, { status });
  const reads = await observeResultReads(t, f, async () => {
    const result = await reviewTask('owned', f.config);
    assert.deepEqual(result.review, { ...f.event, content: text, integrity: 'verified' });
    assert.equal(result.browserChecked, false);
    assert.equal(result.review.collected, undefined);
    assert.deepEqual(result.events, [f.event]);
  });
  assert.deepEqual(reads, { opens: 1, bytes: Buffer.byteLength(text) });
  assert.deepEqual(f.calls, [{ method: 'GET', path: '/wait?id=owned' }, { method: 'GET', path: '/reconcile?id=owned' }]);
  assert.equal(fs.readFileSync(join(f.dir, 'state.json'), 'utf8'), 'owned-evidence');
  assert.equal(verifyResult(f.event, f.config), 'verified', 'legacy verification return stays compatible');
});

test('review renews empty waits inside one call and reads no unrelated artifact', async t => {
  const f = await fixture(t); fs.writeFileSync(join(f.dir, 'other.result.txt'), 'unrelated-private-result');
  f.respond((_req, res) => res.end(JSON.stringify(f.calls.length < 3 ? empty() : { ...empty(), events: [f.event] })));
  assert.equal((await reviewTask('owned', f.config)).review.content, text);
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.slice(0, 3).every(call => call.method === 'GET' && call.path === '/wait?id=owned'));
  assert.deepEqual(f.calls[3], { method: 'GET', path: '/reconcile?id=owned' });
});

for (const notice of [
  { backupDue: ['owned'], events: [] },
  { recoveryRequired: [{ id: 'owned' }] },
  { resultRecoveryRequired: [{ id: 'owned' }] },
  { interrupted: true },
  { settled: true, events: [] },
]) test(`review returns ${Object.keys(notice)[0]} without reading or collecting candidates`, async t => {
  const f = await fixture(t);
  f.respond((_req, res) => res.end(JSON.stringify({ ...empty(), events: [f.event], ...notice })));
  const reads = await observeResultReads(t, f, async () => {
    const result = await reviewTask('owned', f.config);
    assert.equal(result.review, null); assert.equal(result.browserChecked, false);
    for (const [key, value] of Object.entries(notice)) assert.deepEqual(result[key], value);
  });
  assert.deepEqual(reads, { opens: 0, bytes: 0 }); assert.equal(f.calls.length, 1);
});

for (const invalid of ['scope', 'duplicate', 'running', 'legacy']) test(`review refuses ${invalid} wait evidence before reading`, async t => {
  const f = await fixture(t);
  const events = invalid === 'scope' ? [{ ...f.event, id: 'other' }]
    : invalid === 'duplicate' ? [f.event, f.event] : [{ ...f.event, status: 'running' }];
  f.respond((_req, res) => res.end(JSON.stringify(invalid === 'legacy' ? {} : { ...empty(), events })));
  const reads = await observeResultReads(t, f, () => assert.rejects(reviewTask('owned', f.config)));
  assert.equal(reads.opens, 0); assert.equal(f.calls.length, 1);
});

for (const damage of ['missing', 'changed', 'directory', 'hardlink', 'oversized', 'wrong-path']) test(`review rejects ${damage} results and keeps evidence`, async t => {
  const f = await fixture(t);
  if (damage === 'missing' || damage === 'directory') fs.unlinkSync(f.artifact);
  if (damage === 'directory') fs.mkdirSync(f.artifact);
  if (damage === 'changed') fs.writeFileSync(f.artifact, 'changed-private-bytes');
  if (damage === 'hardlink') fs.linkSync(f.artifact, join(f.dir, 'second-link'));
  if (damage === 'oversized') fs.writeFileSync(f.artifact, Buffer.alloc(1024 * 1024 + 1));
  if (damage === 'wrong-path') f.event.artifact = join(f.dir, 'controller.key');
  await assert.rejects(reviewTask('owned', f.config));
  assert.equal(f.calls.length, 2); assert.equal(fs.readFileSync(join(f.dir, 'state.json'), 'utf8'), 'owned-evidence');
});

test('review rejects symlink results before following the target', async t => {
  const f = await fixture(t); fs.unlinkSync(f.artifact);
  try { fs.symlinkSync(join(f.dir, 'controller.key'), f.artifact); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('file symlinks require Windows privilege'); return; } throw error; }
  await assert.rejects(reviewTask('owned', f.config), { code: 'RESULT_INVALID' });
  assert.equal(fs.readFileSync(join(f.dir, 'controller.key'), 'utf8'), 'fixture-only-key');
});

test('review rejects invalid UTF-8 even with a matching SHA and supports the exact size limit', async t => {
  const f = await fixture(t, { content: Buffer.from([0xff]) });
  await assert.rejects(reviewTask('owned', f.config), { code: 'RESULT_INVALID' });
  const large = '\u0000'.repeat(1024 * 1024); fs.writeFileSync(f.artifact, large); f.event.sha256 = digest(large);
  const value = await reviewTask('owned', f.config);
  assert.equal(value.review.content, large); assert.equal(value.review.sha256, digest(large));
});

test('review display uses the bytes it verified rather than reopening after verification', async t => {
  const f = await fixture(t); const open = fs.openSync, close = fs.closeSync; let descriptor;
  const mocks = [
    t.mock.method(fs, 'openSync', (file, ...args) => { const fd = open(file, ...args); if (file === f.artifact) descriptor = fd; return fd; }),
    t.mock.method(fs, 'closeSync', fd => {
      const value = close(fd);
      if (fd === descriptor) { descriptor = undefined; fs.writeFileSync(f.artifact, 'changed after verified read'); }
      return value;
    }),
  ];
  syncBuiltinESMExports();
  try { assert.equal(readVerifiedResult(f.event, f.dir), text); }
  finally { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); }
  await assert.rejects(reviewTask('owned', f.config), { code: 'RESULT_INVALID' }, 'later review must reverify, not cache');
});

test('review bounds growth after stat and closes the failed read', async t => {
  const f = await fixture(t); const stat = fs.fstatSync;
  const mock = t.mock.method(fs, 'fstatSync', fd => { const info = stat(fd); fs.writeFileSync(f.artifact, Buffer.alloc(1024 * 1024 + 10)); return info; });
  syncBuiltinESMExports();
  try {
    const reads = await observeResultReads(t, f, () => assert.rejects(reviewTask('owned', f.config), { code: 'RESULT_INVALID' }));
    assert.deepEqual(reads, { opens: 1, bytes: 1024 * 1024 + 1 });
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test('review propagates explicit cancellation without another request or a task mutation', async t => {
  const f = await fixture(t), controller = new AbortController(), reason = Error('owned cancellation');
  controller.abort(reason);
  await assert.rejects(reviewTask('owned', f.config, { signal: controller.signal }), error => error === reason);
  assert.equal(f.calls.length, 0);
  const during = new AbortController();
  f.respond((_req, res) => { during.abort(reason); res.end(JSON.stringify({ ...empty(), events: [f.event] })); });
  await assert.rejects(reviewTask('owned', f.config, { signal: during.signal }), error => error === reason);
  assert.equal(f.calls.length, 1);
});

test('review retains the finite wait retry budget across healthy empty renewals', async t => {
  const f = await fixture(t);
  f.respond((req, res) => {
    if (f.calls.length % 2) req.socket.destroy(); else res.end(JSON.stringify(empty()));
  });
  await assert.rejects(reviewTask('owned', f.config, { retryDelays: [0, 0] }));
  assert.equal(f.calls.length, 5); assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('review CLI takes an ID, returns one JSON body and never resolves a same-named payload', async t => {
  const f = await fixture(t); fs.writeFileSync(join(f.dir, 'owned'), '{"id":"other"}');
  const result = await f.runCli(['review', 'owned']);
  assert.equal(JSON.parse(result.stdout).review.content, text); assert.equal(result.stderr, '');
  for (const args of [['review'], ['review', 'owned', 'other'], ['review', '--file', 'owned'], ['review', './owned']]) {
    await assert.rejects(f.runCli(args), error => {
      assert.equal(error.code, 1); assert.equal(error.stdout, ''); assert.match(error.stderr, /REVIEW_USAGE/); return true;
    });
  }
  assert.deepEqual(f.calls, [{ method: 'GET', path: '/wait?id=owned' }, { method: 'GET', path: '/reconcile?id=owned' }]);
});

test('review CLI redacts native failures and rejected controller bodies without retries', async t => {
  const f = await fixture(t); fs.unlinkSync(f.artifact);
  await assert.rejects(f.runCli(['review', 'owned']), error => {
    assert.equal(error.code, 1); assert.equal(error.stdout, ''); assert.match(error.stderr, /ENOENT/);
    assert.ok(!error.stderr.includes(f.dir)); return true;
  });
  f.respond((_req, res) => { res.writeHead(409); res.end(JSON.stringify({ error: 'private-body-token', code: 'private-error-code' })); });
  await assert.rejects(f.runCli(['review', 'owned']), error => {
    assert.equal(error.stdout, ''); assert.match(error.stderr, /REVIEW_FAILED/);
    assert.doesNotMatch(error.stderr, /private-body|private-error/); return true;
  });
  assert.equal(f.calls.length, 3);
});

// Dynamic imports keep the client-only tests usable with a verified dependency
// subset; CI always runs these real-worker tests in both repository/install layouts.
for (const problem of ['none', 'pending-result', 'journal', 'changed-result']) test(`real worker review keeps tokens and guarded collection: ${problem}`, async t => {
  const { start } = await import('./worker.mjs');
  const { callTool } = await import('./test-fixtures/worker-http.mjs');
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-review-worker-')));
  let worker;
  t.after(async () => { await worker?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  worker = await start({ dir, port: 0, controlPort: 0, configFile: join(dir, 'config.json'), waitMs: 20 });
  const config = { dataDir: dir, controlPort: worker.controlPort };
  const registration = await request('register', { id: 'owned', instructions: 'owned fixture', inputs: { note: 'private-input' } }, config);
  const token = registration.token;
  assert.equal(typeof token, 'string');
  const submitted = await callTool(worker, 'submit_result', { token, status: 'completed', summary: 'fixture', result: text });
  assert.equal(submitted?.isError, false);
  assert.equal(submitted.structuredContent.accepted, true);
  assert.equal(submitted.structuredContent.sha256, digest(text));
  const state = fs.readFileSync(join(dir, 'state.json'));
  assert.equal((await reviewTask('owned', config)).review.content, text);
  const first = (await reviewTask('owned', config, { limit: 1, expectedSha256: digest(text) })).review;
  assert.equal(first.content, text.slice(0, text.indexOf('\n') + 1));
  assert.equal(first.partial, true); assert.equal(first.nextOffset, 2); assert.equal(first.sha256, digest(text));
  assert.deepEqual(fs.readFileSync(join(dir, 'state.json')), state);
  assert.equal((await callTool(worker, 'get_task', { token }))?.isError, false);
  if (problem === 'changed-result') {
    fs.writeFileSync(join(dir, 'owned.result.txt'), 'changed after parent review');
    await assert.rejects(reviewTask('owned', config, { limit: 1 }), { code: 'RESULT_INVALID' });
    await assert.rejects(collectTask('owned', config), { code: 'RESULT_INVALID' });
    assert.deepEqual(fs.readFileSync(join(dir, 'state.json')), state);
  } else if (problem !== 'none') {
    if (problem === 'pending-result') fs.writeFileSync(join(dir, 'owned.result.txt.tmp'), 'candidate evidence');
    else { fs.mkdirSync(join(dir, 'recovery', 'owned'), { recursive: true }); fs.writeFileSync(join(dir, 'recovery', 'owned', 'broken.json'), '{}'); }
    // Terminal wait notices alone omit this evidence. Review and collection
    // must both inspect it independently before presenting/retiring a result.
    const review = await reviewTask('owned', config);
    assert.equal(review.review, null);
    assert.equal(review.attention, problem === 'journal' ? 'inspect_recovery' : 'inspect_uncommitted_result');
    assert.deepEqual(await reviewTask('owned', config, { limit: 1 }), review);
    await assert.rejects(collectTask('owned', config), { code: 'COLLECTION_RECOVERY_REQUIRED' });
    assert.deepEqual(fs.readFileSync(join(dir, 'state.json')), state);
  } else {
    assert.equal((await collectTask('owned', config)).collected, true);
    assert.equal((await callTool(worker, 'get_task', { token }))?.isError, true);
    const retired = await reviewTask('owned', config);
    assert.equal(retired.review, null); assert.equal(retired.settled, true);
    assert.equal(fs.readFileSync(join(dir, 'owned.result.txt'), 'utf8'), text);
  }
});


test('real worker review returns a running task candidate notice without publishing or retiring it', async t => {
  const { start } = await import('./worker.mjs');
  const { callTool } = await import('./test-fixtures/worker-http.mjs');
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-review-pending-')));
  let worker;
  t.after(async () => { await worker?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  worker = await start({ dir, port: 0, controlPort: 0, configFile: join(dir, 'config.json'), waitMs: 20 });
  const config = { dataDir: dir, controlPort: worker.controlPort };
  const { token } = await request('register', { id: 'owned', instructions: 'owned fixture', inputs: {} }, config);
  const state = fs.readFileSync(join(dir, 'state.json'));
  const candidate = join(dir, 'owned.result.txt.tmp');
  fs.writeFileSync(candidate, 'uncommitted candidate');
  const result = await reviewTask('owned', config);
  assert.equal(result.review, null);
  assert.equal(result.browserChecked, false);
  assert.equal(result.settled, false);
  assert.deepEqual(result.events, []);
  assert.ok(result.resultRecoveryRequired.some(event => event.id === 'owned'));
  assert.deepEqual(fs.readFileSync(join(dir, 'state.json')), state);
  assert.equal(fs.readFileSync(candidate, 'utf8'), 'uncommitted candidate');
  assert.equal(fs.existsSync(join(dir, 'owned.result.txt')), false);
  assert.equal((await callTool(worker, 'get_task', { token }))?.isError, false);
});


for (const field of ['recoveryRequired', 'journalIssues', 'pendingResults']) test(`review withholds terminal body for ${field} without reading or collecting`, async t => {
  const f = await fixture(t);
  f.reconcile(value => { value.tasks[0][field] = ['owned fixture evidence']; return value; });
  const reads = await observeResultReads(t, f, async () => {
    const result = await reviewTask('owned', f.config);
    assert.equal(result.review, null);
    assert.equal(result.attention, field === 'pendingResults' ? 'inspect_uncommitted_result' : 'inspect_recovery');
  });
  assert.equal(reads.opens, 0); assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

for (const problem of ['unverified', 'invalid-state', 'collected', 'discarded', 'status', 'artifact', 'sha256',
  'missing-recovery', 'missing-scope', 'wrong-task']) test(`review fails closed on ${problem} terminal evidence`, async t => {
  const f = await fixture(t);
  f.reconcile(value => {
    const task = value.tasks[0];
    if (problem === 'unverified') delete value.health.stateVerified;
    else if (problem === 'invalid-state') value.health.issues = ['STATE_INVALID'];
    else if (problem === 'collected' || problem === 'discarded') task[problem] = true;
    else if (problem === 'status') task.status = 'cancelled';
    else if (problem === 'artifact') task.artifact = join(f.dir, 'other.result.txt');
    else if (problem === 'sha256') task.sha256 = '0'.repeat(64);
    else if (problem === 'missing-recovery') delete task.journalIssues;
    else if (problem === 'missing-scope') delete value.scope;
    else task.id = 'other';
    return value;
  });
  const reads = await observeResultReads(t, f, () => assert.rejects(reviewTask('owned', f.config)));
  assert.equal(reads.opens, 0); assert.equal(f.calls.length, 2);
});

test('unrelated readiness warnings do not replace freshly verified task evidence', async t => {
  const f = await fixture(t);
  f.reconcile(value => { value.health.ok = false; value.health.issues = ['WORKSPACE_UNAVAILABLE']; return value; });
  assert.equal((await reviewTask('owned', f.config)).review.content, text);
});

test('review windows reconstruct exact lines and preserve terminal status and full-read shape', async t => {
  const lines = ['\uFEFF한국어 🧪\r\n', '\u0000literal "quotes" \\ path\n', 'CR only\r', 'last'];
  for (const status of ['completed', 'failed', 'cancelled']) {
    const content = lines.join(''), f = await fixture(t, { content, status });
    let offset = 1, restored = '';
    while (offset !== null) {
      const result = await reviewTask('owned', f.config, { offset, limit: 1, expectedSha256: f.event.sha256 });
      assert.deepEqual(result.review, { ...f.event, content: lines[offset - 1], integrity: 'verified',
        partial: true, startLine: offset, endLine: offset, totalLines: 4, nextOffset: offset === 4 ? null : offset + 1 });
      assert.equal(result.browserChecked, false); restored += result.review.content; offset = result.review.nextOffset;
    }
    assert.equal(restored, content);
    assert.deepEqual((await reviewTask('owned', f.config, { expectedSha256: f.event.sha256 })).review,
      { ...f.event, content, integrity: 'verified' }, 'a pin alone does not opt into a window');
    assert.equal(fs.readFileSync(join(f.dir, 'state.json'), 'utf8'), 'owned-evidence');
    assert.ok(f.calls.every(call => call.method === 'GET'));
  }
  const f = await fixture(t, { content: '' });
  assert.deepEqual((await reviewTask('owned', f.config, { limit: 1 })).review,
    { ...f.event, content: '', integrity: 'verified', partial: false, startLine: 1, endLine: 0, totalLines: 0, nextOffset: null });
});

test('review windows validate options before I/O and never silently widen an impossible range', async t => {
  const f = await fixture(t, { content: '1234\n5678\nlast' });
  for (const options of [{ offset: 0 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: 5001 }, { limit: '1' },
    { maxChars: 0 }, { maxChars: 200001 }, { maxChars: 1.5 }, { expectedSha256: null }, { expectedSha256: 'private-invalid-pin' }])
    await assert.rejects(reviewTask('owned', f.config, options), { code: 'REVIEW_USAGE' });
  assert.equal(f.calls.length, 0);
  const page = (await reviewTask('owned', f.config, { maxChars: 5 })).review;
  assert.equal(page.content, '1234\n'); assert.equal(page.nextOffset, 2);
  for (const options of [{ maxChars: 4 }, { offset: 4 }])
    await assert.rejects(reviewTask('owned', f.config, options), { code: 'REVIEW_RANGE' });
  assert.equal((await reviewTask('owned', f.config)).review.content, '1234\n5678\nlast');
  const many = 'a\n'.repeat(450); fs.writeFileSync(f.artifact, many); f.event.sha256 = digest(many);
  const defaults = (await reviewTask('owned', f.config, { offset: 1 })).review;
  assert.equal(defaults.endLine, 400); assert.equal(defaults.nextOffset, 401);
});

test('review windows reduce returned bytes while still reading and verifying the entire result once', async t => {
  const line = 'x'.repeat(63) + '\n', content = line.repeat(16384);
  const f = await fixture(t, { content });
  const full = await reviewTask('owned', f.config); let page;
  const reads = await observeResultReads(t, f, async () => {
    page = await reviewTask('owned', f.config, { maxChars: 128 });
  });
  assert.deepEqual(reads, { opens: 1, bytes: 1024 * 1024 });
  assert.equal(page.review.content, line.repeat(2)); assert.equal(page.review.sha256, digest(content));
  assert.equal(page.review.partial, true); assert.equal(page.review.totalLines, 16384); assert.equal(page.review.nextOffset, 3);
  const fullBytes = Buffer.byteLength(JSON.stringify(full)), windowBytes = Buffer.byteLength(JSON.stringify(page));
  assert.ok(windowBytes < fullBytes / 100);
  t.diagnostic(JSON.stringify({ sourceBytes: Buffer.byteLength(content), fullJsonBytes: fullBytes, windowJsonBytes: windowBytes,
    selectedCodeUnits: page.review.content.length, resultReads: reads.opens, bytesVerified: reads.bytes }));
  assert.equal(f.calls.length, 4); assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('review windows pin the whole revision and reject corruption outside the visible lines', async t => {
  const f = await fixture(t, { content: 'same first line\nold tail\n' }), pin = f.event.sha256;
  const first = (await reviewTask('owned', f.config, { limit: 1 })).review;
  assert.equal(first.content, 'same first line\n');
  const changed = 'same first line\nnew tail\n'; fs.writeFileSync(f.artifact, changed); f.event.sha256 = digest(changed);
  const reads = await observeResultReads(t, f, () => assert.rejects(
    reviewTask('owned', f.config, { limit: 1, expectedSha256: pin }), { code: 'REVIEW_REVISION_CONFLICT' }));
  assert.equal(reads.opens, 0);
  f.event.sha256 = pin;
  await assert.rejects(reviewTask('owned', f.config, { limit: 1 }), { code: 'RESULT_INVALID' });
  const invalid = Buffer.concat([Buffer.from('same first line\n'), Buffer.from([0xff])]);
  fs.writeFileSync(f.artifact, invalid); f.event.sha256 = digest(invalid);
  await assert.rejects(reviewTask('owned', f.config, { limit: 1 }), { code: 'RESULT_INVALID' });
  assert.equal(fs.readFileSync(join(f.dir, 'state.json'), 'utf8'), 'owned-evidence');
});

test('review windows CLI accepts explicit bounds and rejects ambiguous options without private diagnostics', async t => {
  const f = await fixture(t); fs.writeFileSync(join(f.dir, 'owned'), '{"id":"other"}');
  const args = ['review', 'owned', '--offset', '2', '--limit', '1', '--max-chars', '100', '--expected-sha256', f.event.sha256];
  const response = await f.runCli(args), value = JSON.parse(response.stdout);
  assert.equal(response.stderr, ''); assert.equal(value.review.content, text.slice(text.indexOf('\n') + 1));
  assert.equal(value.review.startLine, 2); assert.equal(value.review.nextOffset, null); assert.equal(value.review.partial, true);
  const before = f.calls.length;
  for (const flags of [['--limit'], ['--limit', '1', '--limit', '2'], ['--limit', '1.2'], ['--offset', '0'],
    ['--offset', '9007199254740992'], ['--max-chars', '200001'], ['--expected-sha256', 'private-invalid-pin'],
    ['--file', 'private.json'], ['--resume', 'owned'], ['--unknown', 'private'], ['--limit=1'], ['--', 'private']]) {
    await assert.rejects(f.runCli(['review', 'owned', ...flags]), error => {
      assert.equal(error.code, 1); assert.equal(error.stdout, ''); assert.match(error.stderr, /REVIEW_USAGE/);
      assert.ok(!error.stderr.includes(f.dir)); assert.doesNotMatch(error.stderr, /private/); return true;
    });
  }
  assert.equal(f.calls.length, before);
  for (const [flags, code] of [[['--max-chars', '1'], 'REVIEW_RANGE'],
    [['--expected-sha256', '0'.repeat(64)], 'REVIEW_REVISION_CONFLICT']]) {
    await assert.rejects(f.runCli(['review', 'owned', ...flags]), error => {
      assert.equal(error.code, 1); assert.equal(error.stdout, ''); assert.ok(error.stderr.includes(code));
      for (const secret of [f.dir, text, f.event.sha256]) assert.ok(!error.stderr.includes(secret)); return true;
    });
  }
  // Usage validation must precede even a malformed local configuration read.
  fs.writeFileSync(join(f.dir, 'config.json'), 'private invalid configuration');
  const requests = f.calls.length;
  await assert.rejects(f.runCli(['review', 'owned', '--limit', '0']), error => {
    assert.equal(error.stdout, ''); assert.match(error.stderr, /REVIEW_USAGE/);
    assert.doesNotMatch(error.stderr, /private/); return true;
  });
  assert.equal(f.calls.length, requests);
});

test('review windows retain recovery, current-state and abort gates before any result read', async t => {
  const f = await fixture(t), options = { limit: 1, expectedSha256: f.event.sha256 };
  const reads = await observeResultReads(t, f, async () => {
    for (const field of ['recoveryRequired', 'journalIssues', 'pendingResults']) {
      f.reconcile(value => { value.tasks[0][field] = ['owned evidence']; return value; });
      const result = await reviewTask('owned', f.config, options);
      assert.equal(result.review, null); assert.equal(result.browserChecked, false);
      assert.equal(result.attention, field === 'pendingResults' ? 'inspect_uncommitted_result' : 'inspect_recovery');
    }
    f.reconcile(value => { value.health.stateVerified = false; return value; });
    await assert.rejects(reviewTask('owned', f.config, options), { code: 'REVIEW_UNCONFIRMED' });
    const before = f.calls.length, controller = new AbortController(), reason = Error('owned stop'); controller.abort(reason);
    await assert.rejects(reviewTask('owned', f.config, { ...options, signal: controller.signal }), error => error === reason);
    assert.equal(f.calls.length, before);
    f.respond((_req, res) => res.end(JSON.stringify({ ...empty(), resultRecoveryRequired: [{ id: 'owned' }] })));
    assert.equal((await reviewTask('owned', f.config, options)).review, null);
  });
  assert.deepEqual(reads, { opens: 0, bytes: 0 }); assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('review API rejects unknown option names before any controller or result access', async t => {
  const f = await fixture(t, { content: 'first\nsecond\n' });
  const reads = await observeResultReads(t, f, async () => {
    for (const options of [{ maxchars: 6 }, { 'max-chars': 6 }, { expectedSHA256: '0'.repeat(64) },
      { limit: 1, maxBytes: 6 }, { limit: 1, unexpected: undefined }, { timeoutMs: 1 }])
      await assert.rejects(reviewTask('owned', f.config, options), { code: 'REVIEW_USAGE' });
  });
  assert.deepEqual(reads, { opens: 0, bytes: 0 }); assert.equal(f.calls.length, 0);
  const options = Object.freeze({ offset: 2, limit: 1, maxChars: 7, expectedSha256: f.event.sha256,
    signal: new AbortController().signal, retryDelays: [] });
  const value = await reviewTask('owned', f.config, options);
  assert.equal(value.review.content, 'second\n'); assert.equal(value.review.sha256, f.event.sha256);
  assert.equal(fs.readFileSync(join(f.dir, 'state.json'), 'utf8'), 'owned-evidence');
});

test('review API retains the initially validated pin and bounds while caller options are reused', async t => {
  const f = await fixture(t, { content: 'first\nsecond\n' }), wrong = '0'.repeat(64);
  for (const [initial, later, conflict] of [[wrong, f.event.sha256, true], [wrong, undefined, true],
    [f.event.sha256, wrong, false], [undefined, wrong, false]]) {
    const options = { limit: 1, maxChars: 6, expectedSha256: initial };
    const reads = await observeResultReads(t, f, async () => {
      const pending = reviewTask('owned', f.config, options);
      // Reuse by the caller must not rewrite this invocation after it starts waiting.
      if (later === undefined) delete options.expectedSha256; else options.expectedSha256 = later;
      options.limit = 2; options.maxChars = 20;
      if (conflict) await assert.rejects(pending, { code: 'REVIEW_REVISION_CONFLICT' });
      else {
        const result = await pending;
        assert.equal(result.review.content, 'first\n'); assert.equal(result.review.nextOffset, 2);
        assert.equal(result.review.sha256, f.event.sha256); assert.equal(result.browserChecked, false);
      }
    });
    assert.deepEqual(reads, conflict ? { opens: 0, bytes: 0 } : { opens: 1, bytes: 13 });
  }
  assert.equal(f.calls.length, 8); assert.ok(f.calls.every(call => call.method === 'GET'));
  assert.equal(fs.readFileSync(join(f.dir, 'state.json'), 'utf8'), 'owned-evidence');
});

test('review API retains its original live abort signal through reconciliation', async t => {
  const f = await fixture(t);
  for (const replace of [false, true]) {
    const controller = new AbortController(), reason = Error('owned review stopped');
    const options = { limit: 1, signal: controller.signal };
    f.reconcile(value => { controller.abort(reason); return value; });
    const reads = await observeResultReads(t, f, async () => {
      const pending = reviewTask('owned', f.config, options);
      if (replace) options.signal = new AbortController().signal; else delete options.signal;
      await assert.rejects(pending, error => error === reason);
    });
    assert.deepEqual(reads, { opens: 0, bytes: 0 });
  }
  f.reconcile(value => value);
  const original = new AbortController(), options = { signal: original.signal };
  const pending = reviewTask('owned', f.config, options);
  options.signal = AbortSignal.abort(Error('another invocation stopped'));
  assert.equal((await pending).review.content, text, 'a replacement signal cannot cancel the original invocation');
  assert.equal(f.calls.length, 6); assert.ok(f.calls.every(call => call.method === 'GET'));
  assert.equal(fs.readFileSync(join(f.dir, 'state.json'), 'utf8'), 'owned-evidence');
});


// Exercise the shared wait policy through both public entrypoints. Reuse the
// owned loopback fixture; no new worker, retry implementation or clock budget.
for (const entry of ['wait', 'review']) {
  const run = (f, options) => entry === 'wait' ? waitForTasks(['owned'], f.config, options) : reviewTask('owned', f.config, options);

  test(`${entry} retry policy rejects holes and invalid values before I/O`, async t => {
    const f = await fixture(t);
    const reads = await observeResultReads(t, f, async () => {
      for (const retryDelays of [Array(1), [0, , 0], [undefined], [null], [-1], [10001], [0.5],
        [NaN], [Infinity], ['0'], [0, 0, 0, 0], null, '0', new Uint8Array([0])])
        await assert.rejects(run(f, { retryDelays }), /invalid bounded wait retry policy/);
    });
    assert.deepEqual(reads, { opens: 0, bytes: 0 }); assert.equal(f.calls.length, 0);
  });

  test(`${entry} retry policy cannot grow across transport failures and healthy renewals`, async t => {
    for (const budget of [0, 1, 3]) {
      const f = await fixture(t), retryDelays = Array(budget).fill(0);
      f.respond((req, res) => {
        // The ceiling also bounds the deliberately broken pre-fix run.
        if (f.calls.length >= 9) { res.end(JSON.stringify({ ...empty(), events: [f.event] })); return; }
        if (f.calls.length % 2) { retryDelays.push(0); req.socket.destroy(); }
        else res.end(JSON.stringify(empty()));
      });
      const reads = await observeResultReads(t, f, () => assert.rejects(run(f, { retryDelays }), retryableControllerError));
      assert.equal(f.calls.length, 2 * budget + 1);
      assert.ok(f.calls.every(call => call.method === 'GET' && call.path === '/wait?id=owned'));
      assert.deepEqual(reads, { opens: 0, bytes: 0 });
      assert.equal(fs.readFileSync(join(f.dir, 'state.json'), 'utf8'), 'owned-evidence');
    }
  });

  test(`${entry} retry policy retains captured delay values and survives caller truncation`, async t => {
    const observed = [];
    const mock = t.mock.method(timers, 'setTimeout', async ms => { observed.push(ms); });
    syncBuiltinESMExports();
    try {
      for (const change of [values => { values.length = 0; }, values => { values[0] = 10001; },
        values => { delete values[0]; }]) {
        const f = await fixture(t), retryDelays = [0]; observed.length = 0;
        f.respond((req, res) => {
          if (f.calls.length === 1) { change(retryDelays); req.socket.destroy(); }
          else res.end(JSON.stringify({ ...empty(), events: [f.event] }));
        });
        let value;
        await assert.doesNotReject(async () => { value = await run(f, { retryDelays }); },
          'the original retry remains available despite caller mutation');
        assert.deepEqual(observed, [0], 'only the original validated delay reaches the timer');
        assert.deepEqual(value.events, [f.event]);
        if (entry === 'review') assert.equal(value.review.content, text);
        assert.equal(f.calls.length, entry === 'review' ? 3 : 2);
        assert.ok(f.calls.every(call => call.method === 'GET'));
        assert.equal(fs.readFileSync(join(f.dir, 'state.json'), 'utf8'), 'owned-evidence');
      }
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  });

  test(`${entry} retry policy keeps defaults, frozen arrays and HTTP rejection classification`, async t => {
    const observed = [];
    const mock = t.mock.method(timers, 'setTimeout', async ms => { observed.push(ms); });
    syncBuiltinESMExports();
    try {
      for (const policy of [undefined, Object.freeze([]), Object.freeze([0]), Object.freeze([0, 0, 10000])]) {
        const f = await fixture(t), expected = policy ?? [250, 1000, 3000]; observed.length = 0;
        f.respond((req, res) => {
          if (f.calls.length <= expected.length) req.socket.destroy();
          else res.end(JSON.stringify({ ...empty(), events: [f.event] }));
        });
        assert.deepEqual((await run(f, { retryDelays: policy })).events, [f.event]);
        assert.equal(observed.length, expected.length);
        observed.forEach((ms, i) => assert.ok(ms >= expected[i] && ms <= expected[i] + Math.min(expected[i] / 4, 250)));
        assert.equal(f.calls.length, expected.length + (entry === 'review' ? 2 : 1));
        const before = f.calls.length; observed.length = 0;
        f.respond((_req, res) => { res.writeHead(401); res.end('{}'); });
        await assert.rejects(run(f, { retryDelays: policy }), { statusCode: 401 });
        assert.equal(f.calls.length, before + 1); assert.deepEqual(observed, []);
      }
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  });
}
