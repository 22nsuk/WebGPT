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
import { reviewTask, verifyResult, collectTask, request } from './client.mjs';
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
  const server = createServer((req, res) => {
    calls.push({ method: req.method, path: req.url });
    if (req.headers.authorization !== 'Bearer fixture-only-key') { res.writeHead(401); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
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
  return { dir, artifact, event, config, calls, runCli, respond: callback => { respond = callback; } };
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
  assert.deepEqual(f.calls, [{ method: 'GET', path: '/wait?id=owned' }]);
  assert.equal(fs.readFileSync(join(f.dir, 'state.json'), 'utf8'), 'owned-evidence');
  assert.equal(verifyResult(f.event, f.config), 'verified', 'legacy verification return stays compatible');
});

test('review renews empty waits inside one call and reads no unrelated artifact', async t => {
  const f = await fixture(t); fs.writeFileSync(join(f.dir, 'other.result.txt'), 'unrelated-private-result');
  f.respond((_req, res) => res.end(JSON.stringify(f.calls.length < 3 ? empty() : { ...empty(), events: [f.event] })));
  assert.equal((await reviewTask('owned', f.config)).review.content, text);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(call => call.method === 'GET' && call.path === '/wait?id=owned'));
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
  assert.equal(f.calls.length, 1); assert.equal(fs.readFileSync(join(f.dir, 'state.json'), 'utf8'), 'owned-evidence');
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
  assert.deepEqual(f.calls, [{ method: 'GET', path: '/wait?id=owned' }]);
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
  assert.equal(f.calls.length, 2);
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
  const state = fs.readFileSync(join(dir, 'state.json'));
  assert.equal((await reviewTask('owned', config)).review.content, text);
  assert.deepEqual(fs.readFileSync(join(dir, 'state.json')), state);
  assert.equal((await callTool(worker, 'get_task', { token }))?.isError, false);
  if (problem === 'changed-result') {
    fs.writeFileSync(join(dir, 'owned.result.txt'), 'changed after parent review');
    await assert.rejects(collectTask('owned', config), { code: 'RESULT_INVALID' });
    assert.deepEqual(fs.readFileSync(join(dir, 'state.json')), state);
  } else if (problem !== 'none') {
    if (problem === 'pending-result') fs.writeFileSync(join(dir, 'owned.result.txt.tmp'), 'candidate evidence');
    else { fs.mkdirSync(join(dir, 'recovery', 'owned'), { recursive: true }); fs.writeFileSync(join(dir, 'recovery', 'owned', 'broken.json'), '{}'); }
    assert.equal((await reviewTask('owned', config)).review, null);
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
