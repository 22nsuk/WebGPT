// Owned loopback fixtures only. The guarded command is not an OS transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { start } from './worker.mjs';
import { request, collectTask } from './client.mjs';

const text = 'Guarded result 한국어 🧪\r\nPRIVATE_GUARD_FIXTURE';
const hash = createHash('sha256').update(text).digest('hex');
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
async function fixture(t, { status = 'completed', intercept = async () => false } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt guarded collection ')));
  const dir = join(base, 'runtime'), root = join(base, 'project'); fs.mkdirSync(root);
  let worker, proxy;
  const failures = [], actions = [];
  t.after(async () => {
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
    await worker?.close(); fs.rmSync(base, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  });
  const direct = { dataDir: dir };
  const boot = async () => {
    worker = await start({ dir, port: 0, controlPort: 0, configFile: join(base, 'config.json'), waitMs: 20 });
    direct.controlPort = worker.controlPort;
  };
  await boot();
  const admin = (action, payload) => request(action, payload, direct);
  const task = await admin('register', { id: 'owned', instructions: 'Retain instructions', inputs: { sample: text }, workspace: { root, mode: 'edit' } });
  const call = async (name, args) => (await (await fetch(`http://127.0.0.1:${worker.mcpPort}/mcp`, {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })).json()).result;
  if (status !== 'running') assert.equal((await call('submit_result', { token: task.token, status, summary: 'done', result: text })).isError, false);
  const stateFile = join(dir, 'state.json'), artifact = join(dir, 'owned.result.txt');
  const state = () => JSON.parse(fs.readFileSync(stateFile)).find(t => t.id === 'owned');
  const payload = { id: 'owned', expectedStatus: status === 'running' ? 'completed' : status, expectedSha256: hash };
  const post = async (body = payload, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${worker.controlPort}/collect`, {
      method: 'POST', headers: { authorization: 'Bearer ' + worker.key, ...headers }, body: JSON.stringify(body), redirect: 'error',
    });
    return { status: response.status, data: await response.json() };
  };
  const f = { base, dir, root, direct, admin, task, call, stateFile, artifact, state, payload, post, actions,
    restart: async () => { await worker.close(); await boot(); } };
  proxy = createServer((req, res) => {
    Promise.resolve().then(async () => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      actions.push(req.url);
      if (await intercept({ ...f, req, res, phase: 'before' })) return;
      const response = await fetch(`http://127.0.0.1:${worker.controlPort}${req.url}`, {
        method: req.method, headers: { authorization: req.headers.authorization, 'content-type': 'application/json' },
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}), redirect: 'error',
      });
      const data = await response.json();
      if (!await intercept({ ...f, req, res, phase: 'after', data })) json(res, data, response.status);
    }).catch(error => { failures.push(error.message); res.destroy(); });
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return { ...f, config: { ...direct, controlPort: proxy.address().port } };
}
function inject(f, kind) {
  if (kind === 'result-changed') fs.writeFileSync(f.artifact, 'changed after client verification');
  else if (kind === 'result-missing') fs.unlinkSync(f.artifact);
  else if (kind === 'journal') {
    const path = join(f.dir, 'recovery', 'owned'); fs.mkdirSync(path, { recursive: true });
    fs.writeFileSync(join(path, 'unresolved.json'), '{}');
  } else fs.writeFileSync(f.artifact + '.tmp', text);
}
async function patched(t, name, replacement, run) {
  const mock = t.mock.method(fs, name, replacement); syncBuiltinESMExports();
  try { return await run(); } finally { mock.mock.restore(); syncBuiltinESMExports(); }
}
const isCommit = req => ['/ack', '/collect'].includes(req.url);

for (const kind of ['pending-result', 'journal', 'result-changed', 'result-missing']) for (const resume of [false, true]) {
  test(`${resume ? 'resumed' : 'ordinary'} collection rejects ${kind} arriving after the client observation, before retirement`, async t => {
    const f = await fixture(t, { intercept: async f => {
      if (f.phase === 'before' && isCommit(f.req)) inject(f, kind);
    } }), before = fs.readFileSync(f.stateFile);
    await assert.rejects(collectTask('owned', f.config, { resume }), error => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, kind.startsWith('result-') ? 'COLLECTION_UNCONFIRMED' : 'COLLECTION_RECOVERY_REQUIRED');
      assert.equal(error.acknowledgment, undefined); return true;
    });
    assert.deepEqual(fs.readFileSync(f.stateFile), before);
    assert.equal(f.state().token, f.task.token); assert.equal(f.state().inputs.sample, text);
    assert.deepEqual(f.actions, [resume ? '/reconcile' : '/wait?id=owned', '/collect']);
    assert.equal((await f.call('get_task', { token: f.task.token })).isError, false);
  });
}

for (const status of ['completed', 'failed', 'cancelled']) test(`conditional ${status} collection is durable, task-scoped and explicitly idempotent across restart`, async t => {
  const f = await fixture(t, { status });
  const other = await f.admin('register', { id: 'other', instructions: '', inputs: {} });
  fs.writeFileSync(join(f.dir, 'other.result.txt.tmp'), 'unrelated evidence');
  const untouched = JSON.parse(fs.readFileSync(f.stateFile))[1];
  assert.deepEqual(await f.post(), { status: 200, data: { ok: true, id: 'owned', status, sha256: hash, collected: true, duplicate: false } });
  const committed = fs.readFileSync(f.stateFile);
  assert.equal(f.state().token, undefined); assert.deepEqual(f.state().inputs, {});
  assert.equal(f.state().instructions, ''); assert.equal(fs.readFileSync(f.artifact, 'utf8'), text);
  assert.deepEqual(JSON.parse(committed)[1], untouched);
  const duplicate = await f.post(); assert.equal(duplicate.status, 200); assert.equal(duplicate.data.duplicate, true);
  assert.deepEqual(fs.readFileSync(f.stateFile), committed, 'a duplicate must not republish state');
  await f.restart();
  assert.equal((await f.post()).data.duplicate, true);
  assert.equal((await f.call('get_task', { token: other.token })).isError, false);
});

for (const input of [null, [], {}, { id: 'owned' }, { id: 'owned', expectedStatus: 'running', expectedSha256: hash },
  { id: 'owned', expectedStatus: 'completed', expectedSha256: '0' },
  { id: 'owned', expectedStatus: 'completed', expectedSha256: hash, force: true }]) {
  test(`conditional collection rejects malformed preconditions ${JSON.stringify(input)} without retiring inputs`, async t => {
    const f = await fixture(t), before = fs.readFileSync(f.stateFile);
    assert.equal((await f.post(input)).status, 400);
    assert.deepEqual(fs.readFileSync(f.stateFile), before);
  });
}
for (const field of ['expectedStatus', 'expectedSha256']) test(`a stale ${field} cannot collect a different result`, async t => {
  const f = await fixture(t), before = fs.readFileSync(f.stateFile);
  const reply = await f.post({ ...f.payload, [field]: field === 'expectedStatus' ? 'failed' : '0'.repeat(64) });
  assert.equal(reply.status, 409); assert.equal(reply.data.code, 'COLLECTION_UNCONFIRMED');
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
});
for (const headers of [{ authorization: 'Bearer invalid' }, { origin: 'https://example.invalid' }]) test('conditional collection retains controller authentication and Origin boundary', async t => {
  const f = await fixture(t), before = fs.readFileSync(f.stateFile);
  assert.equal((await f.post(f.payload, headers)).status, headers.origin ? 403 : 401);
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
});

test('running and discarded tasks cannot pass the conditional collection guard', async t => {
  const f = await fixture(t, { status: 'running' });
  assert.equal((await f.post()).status, 409); assert.equal(f.state().token, f.task.token);
  assert.equal((await f.call('submit_result', { token: f.task.token, status: 'completed', summary: 'done', result: text })).isError, false);
  await f.admin('cancel', { id: 'owned' });
  const before = fs.readFileSync(f.stateFile), reply = await f.post();
  assert.equal(reply.status, 409); assert.equal(reply.data.code, 'COLLECTION_DISCARDED');
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
});

test('simultaneous collectors produce one transition and one duplicate, never two writes', async t => {
  const f = await fixture(t), rename = fs.renameSync;
  let commits = 0;
  const replies = await patched(t, 'renameSync', (from, to) => {
    if (to === f.stateFile) commits++; return rename(from, to);
  }, () => Promise.all([f.post(), f.post()]));
  assert.deepEqual(replies.map(r => r.status), [200, 200]);
  assert.deepEqual(replies.map(r => r.data.duplicate).sort(), [false, true]);
  assert.equal(commits, 1); assert.equal(f.state().collected, true);
});

test('cancel racing collection has an ordered outcome and cannot relabel a collected result as discarded', async t => {
  const f = await fixture(t);
  const [collected] = await Promise.all([f.post(), f.admin('cancel', { id: 'owned' })]);
  assert.equal(f.state().collected, true);
  if (collected.status === 200) assert.equal(f.state().discarded ?? false, false);
  else { assert.equal(collected.data.code, 'COLLECTION_DISCARDED'); assert.equal(f.state().discarded, true); }
});

test('failed state publication preserves inputs and candidate; an explicit same-byte conditional retry succeeds', async t => {
  const f = await fixture(t), before = fs.readFileSync(f.stateFile), rename = fs.renameSync;
  const reply = await patched(t, 'renameSync', (from, to) => {
    if (to === f.stateFile) throw Object.assign(Error('fixture publication failure'), { code: 'EIO' });
    return rename(from, to);
  }, () => f.post());
  assert.equal(reply.status, 503); assert.equal(reply.data.code, 'EIO');
  assert.deepEqual(fs.readFileSync(f.stateFile), before); assert.equal(f.state().token, f.task.token);
  const stage = fs.readFileSync(f.stateFile + '.tmp'); assert.equal(JSON.parse(stage)[0].collected, true);
  assert.equal((await f.post()).status, 200);
  assert.deepEqual(fs.readFileSync(f.stateFile), stage);
});

test('an unsupported worker causes no automatic downgrade to unchecked ack', async t => {
  const f = await fixture(t, { intercept: async ({ req, res, phase }) => {
    if (phase === 'before' && req.url === '/collect') { json(res, {}, 404); return true; }
  } }), before = fs.readFileSync(f.stateFile);
  await assert.rejects(collectTask('owned', f.config), { code: 'COLLECTION_UNSUPPORTED' });
  assert.deepEqual(f.actions, ['/wait?id=owned', '/collect']);
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
});

test('legacy low-level ack is still a deliberate administrative override, not the collection fallback', async t => {
  const f = await fixture(t); inject(f, 'pending-result');
  assert.equal((await f.post()).data.code, 'COLLECTION_RECOVERY_REQUIRED');
  assert.equal((await f.admin('ack', { id: 'owned' })).ok, true);
  assert.equal(f.state().collected, true); assert.ok(fs.existsSync(f.artifact + '.tmp'));
});

test('external evidence introduced inside filesystem publication is outside the controller serialization guarantee', async t => {
  const f = await fixture(t), rename = fs.renameSync;
  // Deterministic stand-in for an external writer between guard and rename. It
  // demonstrates the limit; normal worker requests cannot run in this stack.
  await patched(t, 'renameSync', (from, to) => {
    if (to === f.stateFile) inject(f, 'pending-result');
    return rename(from, to);
  }, () => assert.rejects(collectTask('owned', f.config), { code: 'COLLECTION_UNCONFIRMED' }));
  assert.equal(f.state().collected, true); assert.equal(f.state().token, undefined);
  assert.equal(fs.readFileSync(f.artifact + '.tmp', 'utf8'), text);
  assert.deepEqual(f.actions, ['/wait?id=owned', '/collect', '/reconcile']);
  assert.equal((await collectTask('owned', f.direct, { resume: true })).attention, 'inspect_uncommitted_result');
});

test('the guard does not yield to an event-loop continuation before committed retirement', async t => {
  const f = await fixture(t), open = fs.openSync, close = fs.closeSync;
  const results = new Set(); let observed;
  await patched(t, 'openSync', (path, ...args) => {
    const fd = open(path, ...args); if (path === f.artifact) results.add(fd); return fd;
  }, () => patched(t, 'closeSync', fd => {
    if (results.delete(fd)) queueMicrotask(() => { observed = f.state().collected; });
    return close(fd);
  }, async () => assert.equal((await f.post()).status, 200)));
  assert.equal(observed, true, 'even a queued microtask observes the committed state');
});

test('a command whose body arrives after cancellation rechecks the latest task, not its earlier expectation', async t => {
  const { request: httpRequest } = await import('node:http');
  const f = await fixture(t), bytes = JSON.stringify(f.payload);
  let upload;
  const response = new Promise((resolve, reject) => {
    upload = httpRequest(`http://127.0.0.1:${f.direct.controlPort}/collect`, {
      method: 'POST', headers: { authorization: 'Bearer ' + fs.readFileSync(join(f.dir, 'controller.key'), 'utf8') },
      timeout: 5000,
    }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) }));
      res.on('error', reject);
    });
    upload.on('timeout', () => upload.destroy(Error('fixture upload timeout')));
    upload.on('error', reject);
    upload.write(bytes.slice(0, -1));
  });
  try {
    await f.admin('cancel', { id: 'owned' });
    const cancelled = fs.readFileSync(f.stateFile); upload.end(bytes.slice(-1));
    const reply = await response;
    assert.equal(reply.status, 409); assert.equal(reply.data.code, 'COLLECTION_DISCARDED');
    assert.deepEqual(fs.readFileSync(f.stateFile), cancelled);
  } finally { upload.destroy(); await response.catch(() => {}); }
});
