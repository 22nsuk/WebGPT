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
import { grantWorkspace } from './workspace.mjs';
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
  const mock = t.mock.method(util, 'isDeepStrictEqual', (a, b) => {
    if (typeof a?.operation === 'string' && typeof b?.operation === 'string') count++;
    return equal(a, b);
  });
  syncBuiltinESMExports();
  try { await run(); } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  return count;
}

for (const count of [0, 1, 64]) test(`receipt matching stays linear for ${count} records at restart, readiness, reconciliation and collection`, async t => {
  const f = await fixture(t, { count });
  const check = async (label, budget, run) => {
    const calls = await comparisons(t, run);
    assert.ok((count === 0 ? calls === 0 : calls > 0) && calls <= budget, `${label}: ${calls} full comparisons exceeds ${budget}`);
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
  assert.deepEqual(stored.recoveryRequired, ordering === 'conflict-first' ? [path, path] : [path]);
  const before = fs.readFileSync(f.state), inspected = await f.inspect();
  assert.deepEqual(inspected.journalIssues, [path]);
  assert.deepEqual(inspected.recoveryRequired, [path]);
  const reply = await f.call('write_file', { token: f.token, path: 'new.txt', expectedSha256: null, text: 'blocked' });
  assert.equal(reply.isError, true); assert.equal(fs.existsSync(join(f.root, 'new.txt')), false);
  assert.deepEqual(fs.readFileSync(f.state), before);
  assert.equal((await f.call('read_input', { token: f.token, name: 'sample' })).structuredContent.text, text);
});

test('all receipt fields, missing journals and malformed operations retain diagnostic ordering', async t => {
  for (const mismatch of ['path', 'action', 'beforeSha256', 'afterSha256', 'backup', 'extra', 'missing', 'invalid']) {
    const f = await fixture(t, { status: 'completed', recorded: values => {
      if (mismatch === 'invalid') return [{ operation: 'not-a-uuid' }, { ...values[0], extra: true }, ...values.slice(1)];
      if (mismatch === 'missing') return [...values, { ...values[0], operation: randomUUID() }];
      return [{ ...values[0], [mismatch]: mismatch.endsWith('Sha256') ? '0'.repeat(64) : 'different' }, ...values.slice(1)];
    } });
    await f.boot();
    const before = fs.readFileSync(f.state), actual = await f.inspect();
    const expected = mismatch === 'invalid' ? [f.recovery] : [f.journal(mismatch === 'missing' ? f.task.changes.at(-1) : f.receipts[0])];
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
