// Owned loopback fixtures only. The guarded command is not an OS transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { start } from './worker.mjs';
import { request, collectTask, reviewTask, reconcileTasks } from './client.mjs';
import { changeWorkspace, grantWorkspace, inspectRecovery } from './workspace.mjs';
import { callTool, controllerProxy, replyJson as json } from './test-fixtures/worker-http.mjs';

const text = 'Guarded result 한국어 🧪\r\nPRIVATE_GUARD_FIXTURE';
const hash = createHash('sha256').update(text).digest('hex');
async function fixture(t, { status = 'completed', intercept = async () => false } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt guarded collection ')));
  const dir = join(base, 'runtime'), root = join(base, 'project'); fs.mkdirSync(root);
  let worker, proxy;
  t.after(async () => {
    await proxy?.close();
    await worker?.close(); fs.rmSync(base, { recursive: true, force: true });
    assert.deepEqual(proxy?.failures ?? [], []);
  });
  const direct = { dataDir: dir };
  const boot = async () => {
    worker = await start({ dir, port: 0, controlPort: 0, configFile: join(base, 'config.json'), waitMs: 20 });
    direct.controlPort = worker.controlPort;
  };
  await boot();
  const admin = (action, payload) => request(action, payload, direct);
  const task = await admin('register', { id: 'owned', instructions: 'Retain instructions', inputs: { sample: text }, workspace: { root, mode: 'edit' } });
  const call = (name, args) => callTool(worker, name, args);
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
  const f = { base, dir, root, direct, admin, task, call, stateFile, artifact, state, payload, post,
    restart: async () => { await worker.close(); await boot(); } };
  proxy = await controllerProxy(direct, event => intercept({ ...f, ...event }));
  return { ...f, actions: proxy.actions, config: { ...direct, controlPort: proxy.port } };
}
function inject(f, kind) {
  if (kind === 'result-changed') fs.writeFileSync(f.artifact, 'changed after client verification');
  else if (kind === 'result-missing') fs.unlinkSync(f.artifact);
  else if (kind === 'journal') {
    const path = join(f.dir, 'recovery', 'owned'); fs.mkdirSync(path, { recursive: true });
    fs.writeFileSync(join(path, 'unresolved.json'), '{}');
  } else if (kind === 'unrecorded-applied') {
    // A direct fixture-owned mutation models late/restored valid evidence, not
    // MCP authority to edit a terminal task. The real writer creates its backup.
    fs.writeFileSync(join(f.root, 'late.txt'), text);
    return changeWorkspace(grantWorkspace({ root: f.root, mode: 'edit' }), f.dir, 'owned',
      { path: 'late.txt', expectedSha256: hash }, true);
  } else fs.writeFileSync(f.artifact + '.tmp', text);
}
async function patched(t, name, replacement, run) {
  const mock = t.mock.method(fs, name, replacement); syncBuiltinESMExports();
  try { return await run(); } finally { mock.mock.restore(); syncBuiltinESMExports(); }
}
const isCommit = req => ['/ack', '/collect'].includes(req.url);

for (const kind of ['pending-result', 'journal', 'unrecorded-applied', 'result-changed', 'result-missing']) for (const resume of [false, true]) {
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
    assert.deepEqual(f.actions, [resume ? '/reconcile?id=owned' : '/wait?id=owned', '/collect']);
    assert.equal((await f.call('get_task', { token: f.task.token })).isError, false);
    if (kind === 'unrecorded-applied') {
      const recovery = inspectRecovery(f.dir, 'owned');
      assert.equal(recovery.receipts.length, 1); assert.deepEqual(recovery.unresolved, []);
      assert.deepEqual(f.state().changes, []);
      assert.equal(fs.readFileSync(recovery.receipts[0].backup, 'utf8'), text);
      assert.equal(fs.existsSync(join(f.root, 'late.txt')), false);
      assert.equal(fs.readFileSync(f.artifact, 'utf8'), text);
    }
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

for (const kind of ['pending-result', 'unrecorded-applied']) test(`external ${kind} inside publication remains outside serialization but is detected afterward`, async t => {
  const f = await fixture(t), rename = fs.renameSync;
  // Deterministic stand-in for an external writer between guard and rename. It
  // demonstrates the limit; normal worker requests cannot run in this stack.
  await patched(t, 'renameSync', (from, to) => {
    if (to === f.stateFile) inject(f, kind);
    return rename(from, to);
  }, () => assert.rejects(collectTask('owned', f.config), { code: 'COLLECTION_UNCONFIRMED' }));
  assert.equal(f.state().collected, true); assert.equal(f.state().token, undefined);
  if (kind === 'pending-result') assert.equal(fs.readFileSync(f.artifact + '.tmp', 'utf8'), text);
  else assert.equal(fs.readFileSync(inspectRecovery(f.dir, 'owned').receipts[0].backup, 'utf8'), text);
  assert.deepEqual(f.actions, ['/wait?id=owned', '/collect', '/reconcile?id=owned']);
  assert.equal((await collectTask('owned', f.direct, { resume: true })).attention,
    kind === 'pending-result' ? 'inspect_uncommitted_result' : 'inspect_recovery');
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

// Terminal tasks do not enter readiness's running-task quarantine or startup
// receipt adoption. Their fresh read-only detail must still check both directions.
for (const status of ['completed', 'failed', 'cancelled']) for (const phase of ['live', 'restart']) {
  test(`unrecorded applied journal blocks ${status} review and collection at ${phase} without changing evidence`, async t => {
    const f = await fixture(t, { status: 'running' });
    const other = await f.admin('register', { id: 'other', instructions: '', inputs: {} });
    const written = await f.call('write_file', { token: f.task.token, path: 'recorded.txt', text, expectedSha256: null });
    assert.equal(written.isError, false);
    const recorded = written.structuredContent;
    assert.equal((await f.call('submit_result', { token: f.task.token, status, summary: 'done', result: text })).isError, false);
    assert.equal((await reviewTask('owned', f.config)).review.content, text, 'matching receipts remain reviewable');
    const receipt = inject(f, 'unrecorded-applied');
    const journal = join(f.dir, 'recovery', 'owned', receipt.operation + '.json');
    const journalBytes = fs.readFileSync(journal), terminal = f.state();
    if (phase === 'restart') await f.restart();
    assert.deepEqual(f.state(), terminal, 'terminal startup must not adopt the extra receipt');
    const before = fs.readFileSync(f.stateFile); // Unrelated running tasks may gain startup diagnostics.
    assert.equal((await f.admin('ready')).ok, true, 'terminal attention is not global active-task quarantine');
    const inspected = await reconcileTasks(f.config, { ids: ['owned'] });
    assert.deepEqual(inspected.tasks[0].journalIssues, [journal]);
    assert.deepEqual(inspected.tasks[0].recoveryRequired, [], 'read-only detail does not mutate quarantine');
    assert.equal(inspected.tasks[0].attention, 'inspect_recovery');
    const review = await reviewTask('owned', f.config);
    assert.equal(review.review, null); assert.equal(review.attention, 'inspect_recovery');
    assert.equal(review.browserChecked, false);
    const reply = await f.post({ ...f.payload, expectedStatus: status });
    assert.equal(reply.status, 409); assert.equal(reply.data.code, 'COLLECTION_RECOVERY_REQUIRED');
    assert.deepEqual(reply.data.reconciliation.journalIssues, [journal]);
    for (const resume of [false, true])
      await assert.rejects(collectTask('owned', f.config, { resume }), { code: 'COLLECTION_RECOVERY_REQUIRED' });
    assert.deepEqual(fs.readFileSync(f.stateFile), before);
    assert.deepEqual(f.state().changes, [recorded]); assert.equal(f.state().token, f.task.token);
    assert.equal((await f.call('read_input', { token: f.task.token, name: 'sample' })).structuredContent.text, text);
    assert.deepEqual(fs.readFileSync(journal), journalBytes);
    assert.equal(fs.readFileSync(receipt.backup, 'utf8'), text);
    assert.equal(fs.readFileSync(f.artifact, 'utf8'), text);
    assert.equal(fs.readFileSync(join(f.root, 'recorded.txt'), 'utf8'), text);
    assert.equal(fs.existsSync(join(f.root, 'late.txt')), false, 'no replay of the fixture deletion');
    const owned = f.state();
    assert.equal((await f.call('submit_result', { token: other.token, status: 'completed', summary: 'other', result: 'other result' })).isError, false);
    assert.equal((await collectTask('other', f.config)).collected, true);
    assert.deepEqual(f.state(), owned, 'unrelated collection must not alter this task');
  });
}

test('running-task startup still adopts valid unrecorded receipts before normal completion and collection', async t => {
  const f = await fixture(t, { status: 'running' }), receipt = inject(f, 'unrecorded-applied');
  await assert.rejects(f.admin('ready'), error => error.details.issues.includes('RECOVERY_REQUIRED'));
  await f.restart();
  assert.deepEqual(f.state().changes, [receipt]); assert.deepEqual(f.state().recoveryRequired, []);
  assert.equal((await f.admin('ready')).ok, true);
  assert.equal((await f.call('submit_result', { token: f.task.token, status: 'completed', summary: 'done', result: text })).isError, false);
  assert.equal((await collectTask('owned', f.config)).collected, true);
  assert.equal(fs.readFileSync(receipt.backup, 'utf8'), text);
});

for (const disposition of ['collected', 'discarded', 'cancelled-without-result']) {
  test(`unrecorded journal attention survives ${disposition} without reviving retired authority`, async t => {
    const f = await fixture(t, { status: disposition === 'cancelled-without-result' ? 'running' : 'completed' });
    if (disposition === 'collected') await collectTask('owned', f.config);
    else await f.admin('cancel', { id: 'owned' });
    const receipt = inject(f, 'unrecorded-applied');
    const journal = join(f.dir, 'recovery', 'owned', receipt.operation + '.json');
    const before = fs.readFileSync(f.stateFile);
    const resumed = await collectTask('owned', f.config, { resume: true });
    assert.equal(resumed.attention, 'inspect_recovery');
    assert.deepEqual(resumed.journalIssues, [journal]); assert.equal(resumed.collected, true);
    assert.equal(resumed.disposition, disposition === 'collected' ? 'already_collected'
      : disposition === 'discarded' ? 'discarded' : 'cancelled_without_result');
    assert.equal((await f.call('get_task', { token: f.task.token })).isError, true);
    assert.deepEqual(fs.readFileSync(f.stateFile), before);
    assert.equal(f.state().token, undefined); assert.deepEqual(f.state().inputs, {});
    assert.equal(fs.readFileSync(receipt.backup, 'utf8'), text);
  });
}

// A lost reply is not permission to repeat a committed retirement. The fresh
// post-commit read must surface late valid evidence even without HTTP success.
test('unrecorded journal after a lost collection reply stays uncertain without another write', async t => {
  let receipt, injected = 0;
  const f = await fixture(t, { intercept: async f => {
    if (f.phase === 'after' && f.req.url === '/collect') {
      assert.equal(f.data.collected, true);
      receipt = inject(f, 'unrecorded-applied'); injected++;
      f.res.destroy(); return true;
    }
  } });
  await assert.rejects(collectTask('owned', f.config), error => {
    assert.equal(error.code, 'COLLECTION_UNCONFIRMED');
    assert.equal(error.acknowledgment, 'unknown'); return true;
  });
  assert.equal(injected, 1);
  assert.deepEqual(f.actions, ['/wait?id=owned', '/collect', '/reconcile?id=owned']);
  const committed = fs.readFileSync(f.stateFile);
  assert.equal(f.state().collected, true); assert.equal(f.state().token, undefined);
  assert.deepEqual(f.state().inputs, {}); assert.deepEqual(f.state().changes, []);
  const resumed = await collectTask('owned', f.config, { resume: true });
  assert.equal(resumed.disposition, 'already_collected'); assert.equal(resumed.attention, 'inspect_recovery');
  assert.deepEqual(resumed.journalIssues, [join(f.dir, 'recovery', 'owned', receipt.operation + '.json')]);
  assert.deepEqual(f.actions, ['/wait?id=owned', '/collect', '/reconcile?id=owned', '/reconcile?id=owned']);
  assert.deepEqual(fs.readFileSync(f.stateFile), committed);
  assert.equal(fs.readFileSync(receipt.backup, 'utf8'), text);
  assert.equal(fs.readFileSync(f.artifact, 'utf8'), text);
  assert.equal((await f.call('get_task', { token: f.task.token })).isError, true);
});

test('full and scoped terminal inspection deduplicate conflicts with one fresh read per recovery file', async t => {
  const f = await fixture(t, { status: 'running' });
  const written = await f.call('write_file', { token: f.task.token, path: 'recorded.txt', text, expectedSha256: null });
  assert.equal(written.isError, false);
  const recorded = written.structuredContent;
  assert.equal((await f.call('submit_result', { token: f.task.token, status: 'completed', summary: 'done', result: text })).isError, false);
  const late = inject(f, 'unrecorded-applied');
  const journal = receipt => join(f.dir, 'recovery', 'owned', receipt.operation + '.json');
  // This valid journal mismatches the same-ID state receipt: it is both a
  // forward conflict and an unmatched journal, but should be reported once.
  fs.writeFileSync(journal(recorded), JSON.stringify({ ...recorded, afterSha256: '0'.repeat(64), state: 'applied' }));
  const evidence = new Map([journal(recorded), journal(late), late.backup].map(file => [file, fs.readFileSync(file)]));
  const state = fs.readFileSync(f.stateFile), nativeOpen = fs.openSync;
  for (const scope of [undefined, { ids: ['owned'] }]) {
    const opens = new Map();
    const result = await patched(t, 'openSync', (file, ...args) => {
      if (evidence.has(file)) opens.set(file, (opens.get(file) ?? 0) + 1);
      return nativeOpen(file, ...args);
    }, () => f.admin('reconcile', scope));
    assert.deepEqual(result.tasks[0].journalIssues, [journal(recorded), journal(late)]);
    assert.deepEqual(result.tasks[0].recoveryRequired, []);
    assert.deepEqual(result.tasks[0].changes, [recorded]);
    assert.equal(result.health.ok, true);
    assert.deepEqual([...opens.keys()].sort(), [...evidence.keys()].sort());
    for (const count of opens.values()) assert.equal(count, 1);
    for (const [file, bytes] of evidence) assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(fs.readFileSync(f.stateFile), state);
  }
});

// Scoped IDs and stateVerified alone do not prove the recovery/lifecycle fields
// survived a partial or incompatible controller response. Keep real disk state
// and the real guarded command; alter only the returned observation.
for (const mode of ['active-resume', 'retired-resume', 'ordinary-after', 'resumed-after']) {
  for (const field of ['recoveryRequired', 'journalIssues', 'pendingResults']) {
    test(`collection requires ${field} evidence at ${mode} before certifying or reading results`, async t => {
      const postAck = mode.endsWith('-after'), resume = mode !== 'ordinary-after';
      let altered = 0, resultReads = 0;
      const f = await fixture(t, { intercept: async f => {
        if (f.phase === 'after' && f.req.url === '/reconcile?id=owned'
            && (!postAck || f.state().collected)) {
          delete f.data.tasks[0][field]; altered++;
        }
      } });
      if (mode === 'retired-resume') await f.admin('collect', f.payload);
      const before = fs.readFileSync(f.stateFile), open = fs.openSync;
      await patched(t, 'openSync', (path, ...args) => {
        if (path === f.artifact) resultReads++;
        return open(path, ...args);
      }, () => assert.rejects(collectTask('owned', f.config, { resume }), error => {
        assert.equal(error.code, 'COLLECTION_UNCONFIRMED');
        assert.equal(error.acknowledgment, postAck ? 'accepted' : undefined);
        return true;
      }));
      assert.equal(altered, 1);
      assert.deepEqual(f.actions, postAck
        ? [resume ? '/reconcile?id=owned' : '/wait?id=owned', '/collect', '/reconcile?id=owned']
        : ['/reconcile?id=owned']);
      assert.equal(resultReads, postAck ? 2 : 0, 'incomplete evidence must not trigger another result read');
      if (!postAck) assert.deepEqual(fs.readFileSync(f.stateFile), before);
      else { assert.equal(f.state().collected, true); assert.equal(f.state().token, undefined); }
      assert.equal(fs.readFileSync(f.artifact, 'utf8'), text);
      if (mode === 'active-resume') {
        assert.equal(f.state().token, f.task.token);
        assert.equal(f.state().inputs.sample, text);
      }
    });
  }
}

const incompleteTaskEvidence = [
  ['null recovery list', task => { task.recoveryRequired = null; }],
  ['object journal list', task => { task.journalIssues = {}; }],
  ['string pending list', task => { task.pendingResults = ''; }],
  ['missing collected', task => { delete task.collected; }],
  ['string collected', task => { task.collected = 'false'; }],
  ['missing discarded', task => { delete task.discarded; }],
  ['null discarded', task => { task.discarded = null; }],
  ['string discarded', task => { task.discarded = 'false'; }],
  ['missing status', task => { delete task.status; }],
  ['unknown status', task => { task.status = 'finished'; }],
  ['missing artifact', task => { delete task.artifact; }],
  ['missing hash', task => { delete task.sha256; }],
];
for (const [name, alter] of incompleteTaskEvidence) {
  test(`collection resume rejects ${name} without retiring inputs`, async t => {
    const f = await fixture(t, { intercept: async f => {
      if (f.phase === 'after' && f.req.url === '/reconcile?id=owned') alter(f.data.tasks[0]);
    } }), before = fs.readFileSync(f.stateFile);
    await assert.rejects(collectTask('owned', f.config, { resume: true }), { code: 'COLLECTION_UNCONFIRMED' });
    assert.deepEqual(f.actions, ['/reconcile?id=owned']);
    assert.deepEqual(fs.readFileSync(f.stateFile), before);
    assert.equal((await f.call('get_task', { token: f.task.token })).isError, false);
  });
}

test('cancelled resume needs explicit null result metadata, not omitted fields', async t => {
  let omit = true;
  const f = await fixture(t, { status: 'running', intercept: async f => {
    if (omit && f.phase === 'after' && f.req.url === '/reconcile?id=owned') {
      delete f.data.tasks[0].artifact; delete f.data.tasks[0].sha256;
    }
  } });
  await f.admin('cancel', { id: 'owned' });
  const before = fs.readFileSync(f.stateFile);
  await assert.rejects(collectTask('owned', f.config, { resume: true }), { code: 'COLLECTION_UNCONFIRMED' });
  omit = false;
  const result = await collectTask('owned', f.config, { resume: true });
  assert.equal(result.disposition, 'cancelled_without_result');
  assert.equal(result.integrity, 'not_expected');
  assert.deepEqual(f.actions, ['/reconcile?id=owned', '/reconcile?id=owned']);
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
});

for (const resume of [false, true]) {
  test(`${resume ? 'resumed' : 'ordinary'} collection cannot certify lost replies with omitted late journal evidence`, async t => {
    let receipt, omit = true;
    const f = await fixture(t, { intercept: async f => {
      if (f.phase === 'after' && f.req.url === '/collect') {
        receipt = inject(f, 'unrecorded-applied'); f.res.destroy(); return true;
      }
      if (omit && receipt && f.phase === 'after' && f.req.url === '/reconcile?id=owned') {
        assert.deepEqual(f.data.tasks[0].journalIssues, [join(f.dir, 'recovery', 'owned', receipt.operation + '.json')]);
        delete f.data.tasks[0].journalIssues;
      }
    } });
    await assert.rejects(collectTask('owned', f.config, { resume }), {
      code: 'COLLECTION_UNCONFIRMED', acknowledgment: 'unknown',
    });
    assert.equal(f.actions.filter(action => action === '/collect').length, 1);
    const before = fs.readFileSync(f.stateFile);
    assert.equal(f.state().collected, true); assert.equal(f.state().token, undefined);
    assert.equal(fs.readFileSync(receipt.backup, 'utf8'), text);
    omit = false;
    const observed = await collectTask('owned', f.config, { resume: true });
    assert.equal(observed.disposition, 'already_collected');
    assert.equal(observed.attention, 'inspect_recovery');
    assert.deepEqual(fs.readFileSync(f.stateFile), before);
    assert.equal(f.actions.filter(action => action === '/collect').length, 1);
    assert.equal(fs.readFileSync(f.artifact, 'utf8'), text);
  });
}


test('collection CLI reports incomplete evidence without success, private data or retirement', async t => {
  const f = await fixture(t, { intercept: async f => {
    if (f.phase === 'after' && f.req.url === '/reconcile?id=owned') {
      delete f.data.tasks[0].journalIssues;
      f.data.privateDiagnostic = text + f.task.token + f.dir;
    }
  } });
  const configFile = join(f.base, 'client.json');
  fs.writeFileSync(configFile, JSON.stringify({ ...f.config, mcpPort: 1 }), { mode: 0o600 });
  const before = fs.readFileSync(f.stateFile);
  const result = await new Promise(resolve => {
    const child = execFile(process.execPath, [fileURLToPath(new URL('./client.mjs', import.meta.url)),
      'collect', '--resume', 'owned'], {
      env: { ...process.env, WEBGPT_CONFIG: configFile, WEBGPT_DATA_DIR: f.dir },
      timeout: 10000, maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  });
  assert.equal(result.error?.code, 1); assert.equal(result.stdout, '');
  const diagnostic = JSON.parse(result.stderr.trim().replace(/^WebGPT: /, ''));
  assert.equal(diagnostic.code, 'COLLECTION_UNCONFIRMED');
  assert.deepEqual(Object.keys(diagnostic).sort(), ['code', 'message']);
  assert.ok(Buffer.byteLength(result.stderr) < 1024);
  for (const privateValue of [text, f.task.token, f.dir, fs.readFileSync(join(f.dir, 'controller.key'), 'utf8')])
    assert.equal(result.stderr.includes(privateValue), false);
  assert.deepEqual(f.actions, ['/reconcile?id=owned']);
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
});
