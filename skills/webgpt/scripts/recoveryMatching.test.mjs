// Indexing may narrow candidates, never replace byte checks or full receipt equality.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import util from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { start } from './worker.mjs';
import { request, collectTask } from './client.mjs';
import { grantWorkspace, inspectRecovery } from './workspace.mjs';
import { callTool } from './test-fixtures/worker-http.mjs';

const text = 'Original 한국어 🧪\r\n', hash = createHash('sha256').update(text).digest('hex');
async function fixture(t, { count = 4, recorded = values => values, status = 'running' } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-recovery-matching-')));
  const dir = join(base, 'runtime'), root = join(base, 'project'), recovery = join(dir, 'recovery', 'owned');
  fs.mkdirSync(recovery, { recursive: true }); fs.mkdirSync(root);
  fs.writeFileSync(join(root, 'notes.txt'), text);
  const receipts = [];
  const journal = receipt => join(recovery, receipt.operation + '.json');
  const addReceipt = () => {
    const operation = randomUUID(), backup = join(recovery, operation + '.before.txt');
    const receipt = { operation, path: 'notes.txt', action: 'edit', beforeSha256: hash, afterSha256: hash, backup };
    fs.writeFileSync(backup, text, { mode: 0o600 });
    fs.writeFileSync(journal(receipt), JSON.stringify({ ...receipt, state: 'applied' }), { mode: 0o600 });
    receipts.push(receipt); return receipt;
  };
  for (let i = 0; i < count; i++) addReceipt();
  const token = 'fixture-only-recovery-token', state = join(dir, 'state.json');
  const task = { id: 'owned', token, instructions: 'fixture', inputs: { sample: text }, status,
    nextCheck: status === 'running' ? Date.now() + 900000 : null, collected: false, workspace: grantWorkspace({ root, mode: 'edit' }),
    changes: recorded(structuredClone(receipts)), ...(status === 'running' ? {} : {
      artifact: join(dir, 'owned.result.txt'), sha256: hash, summary: 'done',
    }) };
  if (task.artifact) fs.writeFileSync(task.artifact, text, { mode: 0o600 });
  fs.writeFileSync(state, JSON.stringify([task]), { mode: 0o600 });
  let worker;
  t.after(async () => { await worker?.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const config = { dataDir: dir };
  const boot = async () => { worker = await start({ dir, port: 0, controlPort: 0, waitMs: 20, configFile: join(base, 'config.json') }); config.controlPort = worker.controlPort; };
  const call = (name, args) => callTool(worker, name, args);
  const admin = (action, payload) => request(action, payload, config);
  return { dir, root, recovery, state, config, task, receipts, token, journal, addReceipt, boot,
    close: () => worker.close(), call, admin, inspect: async () => (await admin('reconcile', { ids: ['owned'] })).tasks[0] };
}
async function comparisons(t, run) {
  const equal = util.isDeepStrictEqual;
  let count = 0;
  const operations = new Set();
  const mock = t.mock.method(util, 'isDeepStrictEqual', (a, b) => {
    if (typeof a?.operation === 'string' && typeof b?.operation === 'string') {
      count++;
      if (a.operation === b.operation) operations.add(a.operation);
    }
    return equal(a, b);
  });
  syncBuiltinESMExports();
  try { await run(); } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  return { count, operations };
}

for (const count of [0, 1, 64]) test(`receipt matching stays linear for ${count} records at restart, readiness, reconciliation and collection`, async t => {
  const f = await fixture(t, { count });
  const check = async (label, budget, run) => {
    const observed = await comparisons(t, run);
    assert.ok(observed.count <= budget, `${label}: ${observed.count} full comparisons exceeds ${budget}`);
    assert.deepEqual([...observed.operations].sort(), f.receipts.map(receipt => receipt.operation).sort(),
      `${label}: every operation must receive a full same-ID comparison, not just a low total`);
  };
  await check('startup', count * 2, f.boot);
  const saved = fs.readFileSync(f.state);
  await check('readiness', count, async () => assert.equal((await f.admin('ready')).ok, true));
  await check('reconcile', count * 2, async () => assert.deepEqual((await f.inspect()).journalIssues, []));
  assert.deepEqual(fs.readFileSync(f.state), saved);
  assert.equal((await f.call('submit_result', { token: f.token, status: 'completed', summary: 'done', result: text })).isError, false);
  await check('collection', count * 2, async () => assert.equal((await collectTask('owned', f.config)).collected, true));
  const stored = JSON.parse(fs.readFileSync(f.state))[0];
  assert.equal(stored.token, undefined); assert.deepEqual(stored.changes, f.task.changes);
  for (const receipt of f.receipts) assert.equal(fs.readFileSync(receipt.backup, 'utf8'), text);
});

for (const ordering of ['matching-first', 'conflict-first']) test(`duplicate operations retain full comparison and first-match startup behavior: ${ordering}`, async t => {
  const f = await fixture(t, { recorded: values => {
    const conflict = { ...values[0], afterSha256: '0'.repeat(64) };
    return ordering === 'matching-first' ? [values[0], conflict, ...values.slice(1)] : [conflict, ...values];
  } });
  await f.boot();
  const stored = JSON.parse(fs.readFileSync(f.state))[0], path = f.journal(f.receipts[0]);
  assert.deepEqual(stored.changes, f.task.changes, 'do not discard or overwrite duplicate evidence');
  assert.deepEqual(stored.recoveryRequired, [path], 'diagnostics are unique, not the conflicting state receipts');
  const before = fs.readFileSync(f.state), inspected = await f.inspect();
  assert.deepEqual(inspected.journalIssues, [path]);
  assert.deepEqual(inspected.recoveryRequired, [path]);
  const reply = await f.call('write_file', { token: f.token, path: 'new.txt', expectedSha256: null, text: 'blocked' });
  assert.equal(reply.isError, true); assert.equal(fs.existsSync(join(f.root, 'new.txt')), false);
  assert.deepEqual(fs.readFileSync(f.state), before);
  assert.equal((await f.call('read_input', { token: f.token, name: 'sample' })).structuredContent.text, text);
  await f.close(); await f.boot();
  assert.deepEqual(fs.readFileSync(f.state), before, 'restart does not multiply diagnostics or remove conflicting evidence');
});

test('a 64-record history validates every field of its last receipt and preserves diagnostic ordering', async t => {
  for (const mismatch of ['path', 'action', 'beforeSha256', 'afterSha256', 'backup', 'extra', 'missing', 'invalid']) {
    const f = await fixture(t, { count: 64, status: 'completed', recorded: values => {
      const last = values.at(-1);
      if (mismatch === 'invalid') return [...values.slice(0, -1), { operation: 'not-a-uuid' }, { ...last, extra: true }];
      if (mismatch === 'missing') return [...values, { ...last, operation: randomUUID() }];
      return [...values.slice(0, -1), { ...last, [mismatch]: mismatch.endsWith('Sha256') ? '0'.repeat(64) : 'different' }];
    } });
    await f.boot();
    const before = fs.readFileSync(f.state), actual = await f.inspect();
    const expected = mismatch === 'invalid' ? [f.recovery] : [f.journal(mismatch === 'missing' ? f.task.changes.at(-1) : f.receipts.at(-1))];
    assert.deepEqual(actual.journalIssues, expected, mismatch);
    await assert.rejects(collectTask('owned', f.config), { code: 'COLLECTION_RECOVERY_REQUIRED' });
    assert.deepEqual(fs.readFileSync(f.state), before); await f.close();
  }
});

test('an invalid operation does not suppress unrecorded live receipts or invent conflicts for matching later receipts', async t => {
  const f = await fixture(t, { recorded: values => [{ operation: 'not-a-uuid' }, ...values] });
  await f.boot();
  const extra = f.addReceipt(), before = fs.readFileSync(f.state), actual = await f.inspect();
  assert.deepEqual(actual.journalIssues, [f.recovery]);
  assert.deepEqual(actual.recoveryRequired, [f.recovery, f.journal(extra)]);
  assert.deepEqual(actual.changes, f.task.changes);
  assert.deepEqual(fs.readFileSync(f.state), before);
});

test('unrecorded applied receipts are quarantined live but recovered once at a deliberate restart', async t => {
  const f = await fixture(t); await f.boot();
  const extra = f.addReceipt(), before = fs.readFileSync(f.state);
  assert.deepEqual((await f.inspect()).recoveryRequired, [f.journal(extra)]);
  assert.deepEqual(fs.readFileSync(f.state), before);
  await f.close(); await f.boot();
  const recovered = await f.inspect();
  assert.deepEqual(recovered.recoveryRequired, []); assert.deepEqual(recovered.journalIssues, []);
  assert.deepEqual(recovered.changes, [...f.task.changes, extra]);
  await f.close(); await f.boot();
  assert.deepEqual((await f.inspect()).changes, recovered.changes);
});

for (const damage of ['backup', 'journal', 'directory']) test(`fresh recovery inspection still detects later ${damage} damage`, async t => {
  const f = await fixture(t); await f.boot();
  assert.equal((await f.admin('ready')).ok, true);
  const before = fs.readFileSync(f.state);
  if (damage === 'backup') fs.writeFileSync(f.receipts[0].backup, 'changed original');
  else if (damage === 'journal') fs.unlinkSync(f.journal(f.receipts[0]));
  else { fs.renameSync(f.recovery, f.recovery + '-saved'); fs.writeFileSync(f.recovery, 'not a directory'); }
  const actual = await f.inspect(), expected = damage === 'directory' ? f.recovery : f.journal(f.receipts[0]);
  assert.deepEqual(actual.journalIssues, [expected]); assert.deepEqual(actual.recoveryRequired, [expected]);
  await assert.rejects(f.admin('ready'), error => error.details.issues.includes('RECOVERY_REQUIRED'));
  assert.deepEqual(fs.readFileSync(f.state), before);
});

// Put the conflict after 63 matching state receipts. Exercise startup and a fresh
// live observation separately so one phase cannot conceal another's skipped work.
for (const phase of ['startup', 'live']) test(`64-record ${phase} check quarantines only the late mismatch and preserves evidence`, async t => {
  const f = await fixture(t, { count: 64, recorded: values => phase === 'startup'
    ? [...values.slice(0, -1), { ...values.at(-1), afterSha256: '0'.repeat(64) }] : values });
  await f.boot();
  const last = f.receipts.at(-1), path = f.journal(last);
  if (phase === 'live') {
    assert.equal((await f.admin('ready')).ok, true);
    fs.writeFileSync(path, JSON.stringify({ ...last, afterSha256: '0'.repeat(64), state: 'applied' }));
  }
  const state = fs.readFileSync(f.state), journal = fs.readFileSync(path), backup = fs.readFileSync(last.backup);
  if (phase === 'startup') assert.deepEqual(JSON.parse(state)[0].recoveryRequired, [path]);
  await assert.rejects(f.admin('ready'), error => {
    assert.deepEqual(error.details.recoveryRequired, ['owned']); return true;
  });
  const inspected = await f.inspect();
  assert.deepEqual(inspected.journalIssues, [path]); assert.deepEqual(inspected.recoveryRequired, [path]);
  assert.deepEqual(inspected.changes, f.task.changes);
  const changed = await f.call('write_file', { token: f.token, path: 'new.txt', expectedSha256: null, text: 'blocked' });
  assert.equal(changed.isError, true); assert.equal(fs.existsSync(join(f.root, 'new.txt')), false);
  assert.equal((await f.call('submit_result', { token: f.token, status: 'completed', summary: 'not safe', result: text })).isError, true);
  assert.equal((await f.call('read_input', { token: f.token, name: 'sample' })).structuredContent.text, text);
  assert.deepEqual(fs.readFileSync(f.state), state); assert.deepEqual(fs.readFileSync(path), journal);
  assert.deepEqual(fs.readFileSync(last.backup), backup); assert.equal(fs.readFileSync(join(f.root, 'notes.txt'), 'utf8'), text);
});

// Test the producer's uniqueness contract using actual files, not a fabricated
// inspectRecovery return value. A second filename must never supply the same ID.
for (const order of ['before', 'after']) for (const conflicting of [false, true]) {
  test(`journal identity rejects a ${conflicting ? 'conflicting' : 'matching'} same-ID copy sorted ${order} its canonical file`, async t => {
    const f = await fixture(t), receipt = f.receipts[0];
    const name = order === 'before' ? '00000000-0000-0000-0000-000000000000' : 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const copy = f.journal({ operation: name });
    assert.equal(order === 'before' ? copy < f.journal(receipt) : copy > f.journal(receipt), true);
    const bytes = Buffer.from(JSON.stringify({ ...receipt, ...(conflicting ? { afterSha256: '0'.repeat(64) } : {}), state: 'applied' }));
    fs.writeFileSync(copy, bytes, { mode: 0o600 });
    const parsed = inspectRecovery(f.dir, 'owned');
    assert.deepEqual(parsed.receipts, [...f.receipts].sort((a, b) => a.operation.localeCompare(b.operation)));
    assert.deepEqual(parsed.unresolved, [copy]);
    await f.boot();
    const state = fs.readFileSync(f.state), inspected = await f.inspect();
    assert.deepEqual(inspected.changes, f.task.changes); assert.deepEqual(inspected.recoveryRequired, [copy]);
    assert.deepEqual(inspected.journalIssues, [copy]);
    assert.equal((await f.call('submit_result', { token: f.token, status: 'completed', summary: 'blocked', result: text })).isError, true);
    assert.deepEqual(fs.readFileSync(f.state), state); assert.deepEqual(fs.readFileSync(copy), bytes);
    assert.equal((await f.call('get_task', { token: f.token })).isError, false);
  });
}

test('a misnamed sole journal cannot be promoted into startup state', async t => {
  const f = await fixture(t, { count: 1, recorded: () => [] }), receipt = f.receipts[0];
  const copy = f.journal({ operation: '00000000-0000-0000-0000-000000000000' });
  fs.renameSync(f.journal(receipt), copy);
  const bytes = fs.readFileSync(copy);
  assert.deepEqual(inspectRecovery(f.dir, 'owned'), { receipts: [], unresolved: [copy] });
  await f.boot();
  const stored = JSON.parse(fs.readFileSync(f.state))[0];
  assert.deepEqual(stored.changes, []); assert.deepEqual(stored.recoveryRequired, [copy]);
  assert.equal(stored.token, f.token); assert.deepEqual(fs.readFileSync(copy), bytes);
});
