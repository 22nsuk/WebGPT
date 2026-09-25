// Local controller/MCP fixtures exercise the parent checker, not a signed-in web model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { start } from './worker.mjs';
import { request, collectTask } from './client.mjs';
import { callTool, controllerProxy, replyJson } from './test-fixtures/worker-http.mjs';
import { prepareVerification, checkVerification, verificationScenarios } from './verification.mjs';
import { registerDispatch, beginDispatch, confirmDispatch, textDigest, inspectDispatchEvidence } from './dispatch.mjs';

const exec = promisify(execFile), script = fileURLToPath(new URL('./verification.mjs', import.meta.url));
const clientScript = fileURLToPath(new URL('./client.mjs', import.meta.url));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
function baseFixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-verification-')));
  const f = { base, run: join(base, 'exercise') };
  t.after(async () => { await f.worker?.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return f;
}
async function fixture(t, scenario = 'text') {
  const f = baseFixture(t);
  f.prepared = prepareVerification(scenario, f.run, 'pro');
  f.registration = readJson(join(f.run, 'request.json'));
  f.dir = join(f.base, 'runtime');
  f.worker = await start({ dir: f.dir, port: 0, controlPort: 0, waitMs: 20 });
  f.config = { dataDir: f.dir, controlPort: f.worker.controlPort };
  f.task = await request('register', f.registration, f.config);
  f.state = () => fs.readFileSync(join(f.dir, 'state.json'));
  f.check = () => checkVerification(f.run, f.config);
  f.tool = (name, args = {}) => callTool(f.worker, name, { token: f.task.token, ...args });
  f.submit = async (result, status = 'completed') => {
    const reply = await f.tool('submit_result', { status, summary: 'Local test fixture', result: JSON.stringify(result) });
    assert.equal(reply.isError, false); return reply;
  };
  return f;
}
const resultFor = scenario => scenario === 'read' ? { actual: 17, expected: 34, finding: 'quantity_ignored' }
  : { total: 34, units: 4, ...(scenario === 'edit' ? { staleWriteRejected: true } : {}) };
async function performFixture(f, scenario) {
  assert.equal((await f.tool('read_input', { name: 'orders' })).isError, false);
  if (['read', 'edit'].includes(scenario)) {
    const before = (await f.tool('read_file', { path: 'total.mjs' })).structuredContent;
    const attempt = { path: 'total.mjs', expectedSha256: before.sha256,
      text: before.text.replace('sum + row.unitPrice', 'sum + row.quantity * row.unitPrice') };
    const changed = await f.tool('write_file', attempt);
    assert.equal(changed.isError, scenario === 'read');
    if (scenario === 'edit') assert.equal((await f.tool('write_file', attempt)).isError, true);
  }
  await f.submit(resultFor(scenario));
}
async function recordFixtureDispatch(f, { taskId = f.task.id, mode = 'pro', confirmed = true } = {}) {
  const path = join(f.run, 'dispatch.json'), prompt = 'Fixture prompt with PRIVATE_TOKEN',
    target = { tabId: 'private-tab', chatUrl: 'https://chatgpt.com/c/private-chat' };
  await registerDispatch(path, { taskId, mode, connectorRequired: true, prompt, target });
  const observation = { target, mode, connectorSelected: true, approvalPending: false, composerSha256: null, lastUserMessageId: null };
  await beginDispatch(path, { prompt, observation });
  if (confirmed) await confirmDispatch(path, { ...observation, lastUserMessageId: 'private-message', userMessage: {
    id: 'private-message', previousId: null, role: 'user', bodySha256: textDigest(prompt),
  } });
  return path;
}
function assertNotLive(report) {
  assert.equal(report.browserChecked, false); assert.equal(report.liveVerdict, 'NOT_EVALUATED');
  assert.ok(report.parentMustVerify.includes('actual_browser_mode_connector_and_new_message'));
}

test('preparation only creates a new private fixture and leaves registration and runtime untouched', t => {
  const f = baseFixture(t);
  t.mock.method(globalThis, 'fetch', () => { throw Error('prepare must not use the network'); });
  const prepared = prepareVerification('text', f.run, 'xhigh');
  assert.equal(prepared.registered, false); assert.equal(prepared.browserChecked, false);
  assert.deepEqual(fs.readdirSync(f.run).sort(), ['measurements.json', 'request.json', 'verification.json']);
  const req = readJson(join(f.run, 'request.json'));
  assert.equal(req.id, prepared.taskId); assert.equal(req.workspace, undefined);
  assert.ok(!req.instructions.includes('34'), 'do not put the numerical answer in the worker prompt');
  assert.ok(Object.entries(readJson(join(f.run, 'measurements.json'))).filter(([name]) => name !== 'taskId').every(([, value]) => value === null));
  const before = fs.readFileSync(join(f.run, 'request.json'));
  assert.throws(() => prepareVerification('text', f.run, 'pro'), { code: 'EEXIST' });
  assert.deepEqual(fs.readFileSync(join(f.run, 'request.json')), before);
  for (const args of [['unknown', join(f.base, 'bad'), 'pro'], ['text', 'relative', 'pro'], ['text', join(f.base, 'bad'), 'other']])
    assert.throws(() => prepareVerification(...args));
});

for (const scenario of verificationScenarios) test(`${scenario} exercise checks real local evidence without acknowledging or claiming live success`, async t => {
  const f = await fixture(t, scenario);
  assert.equal((await f.check()).localVerdict, 'PENDING');
  await performFixture(f, scenario);
  const before = f.state(), report = await f.check();
  assert.equal(report.localVerdict, 'PASS'); assert.equal(report.collection, 'uncollected'); assertNotLive(report);
  assert.equal(report.dispatch.availability, 'not_recorded'); assert.equal(report.measurements.availability, 'not_recorded');
  if (scenario === 'edit') {
    assert.deepEqual(report.unverifiedClaims, ['staleWriteRejected']);
    assert.ok(report.parentMustVerify.includes('actual_stale_write_rejection_call'));
  }
  assert.deepEqual(f.state(), before, 'checks cannot retire input/token or publish another result');
  assert.equal((await f.tool('get_task')).isError, false);
  assert.equal((await collectTask(f.task.id, f.config)).collected, true);
  const collected = f.state(), after = await f.check();
  assert.equal(after.collection, 'collected'); assert.equal(after.localVerdict, 'PASS'); assertNotLive(after);
  assert.deepEqual(f.state(), collected);
  const stored = readJson(join(f.dir, 'state.json'))[0];
  assert.equal(stored.token, undefined); assert.deepEqual(stored.inputs, {});
});

test('checker uses only one owned scoped read and never emits controller secrets or unrelated work', async t => {
  const f = await fixture(t); await performFixture(f, 'text');
  await request('register', { id: 'unrelated-secret', instructions: 'PRIVATE_INSTRUCTIONS', inputs: {} }, f.config);
  const proxy = await controllerProxy(f.config); t.after(() => proxy.close());
  const before = f.state(), report = await checkVerification(f.run, { ...f.config, controlPort: proxy.port });
  assert.deepEqual(proxy.actions, ['/reconcile?id=' + f.task.id]); assert.deepEqual(f.state(), before);
  assert.equal(report.localVerdict, 'PASS');
  const publicText = JSON.stringify(report);
  for (const secret of [f.base, f.task.token, 'PRIVATE_INSTRUCTIONS', 'unrelated-secret', 'controller.key'])
    assert.equal(publicText.includes(secret), false);
});

test('a verified result hash or self-reported success cannot replace fixture acceptance', async t => {
  for (const scenario of ['text', 'edit']) {
    const f = await fixture(t, scenario);
    // edit claims a fix and conflict rejection, but never changes the project.
    await f.submit(scenario === 'text' ? { total: 17, units: 4 } : resultFor('edit'));
    const before = f.state(), report = await f.check();
    assert.equal(report.localVerdict, 'FAIL'); assertNotLive(report); assert.deepEqual(f.state(), before);
    if (scenario === 'text') assert.equal(report.checks.result, 'FAIL');
    else assert.equal(report.checks.files, 'FAIL');
  }
});

test('later tampering, missing results and recovery candidates fail freshly without collection', async t => {
  const f = await fixture(t); await performFixture(f, 'text');
  const path = join(f.dir, f.task.id + '.result.txt'), bytes = fs.readFileSync(path), before = f.state();
  assert.equal((await f.check()).localVerdict, 'PASS');
  fs.writeFileSync(path, 'changed'); assert.equal((await f.check()).localVerdict, 'FAIL');
  fs.unlinkSync(path); assert.equal((await f.check()).localVerdict, 'FAIL');
  fs.writeFileSync(path, bytes); fs.writeFileSync(path + '.tmp', bytes);
  const report = await f.check();
  assert.equal(report.checks.recovery, 'FAIL'); assert.equal(report.localVerdict, 'FAIL');
  assert.deepEqual(fs.readFileSync(path + '.tmp'), bytes); assert.deepEqual(f.state(), before);
});

test('project checks never evaluate arbitrary returned code or silently ignore extra files', async t => {
  const f = await fixture(t, 'edit'); await performFixture(f, 'edit');
  const path = join(f.run, 'project', 'total.mjs'), saved = fs.readFileSync(path), before = f.state();
  fs.writeFileSync(path, 'globalThis.__webgptProbeExecuted = true;\nexport const total = () => 34;\n');
  const changed = await f.check();
  assert.equal(changed.checks.files, 'FAIL'); assert.equal(changed.checks.arithmetic, 'NOT_RUN');
  assert.equal(globalThis.__webgptProbeExecuted, undefined);
  fs.writeFileSync(path, saved); fs.writeFileSync(join(f.run, 'project', 'extra.txt'), 'not requested');
  assert.equal((await f.check()).localVerdict, 'FAIL'); assert.deepEqual(f.state(), before);
});

test('failed and discarded outcomes remain failures even when the submitted JSON is expected', async t => {
  const f = await fixture(t); await f.submit(resultFor('text'), 'failed');
  assert.equal((await f.check()).localVerdict, 'FAIL');
  await request('cancel', { id: f.task.id }, f.config);
  const before = f.state(), report = await f.check();
  assert.equal(report.collection, 'discarded'); assert.equal(report.localVerdict, 'FAIL');
  assert.deepEqual(f.state(), before);
});

test('recorded dispatch timings are task-bound redacted wall-clock evidence, not a browser check', async t => {
  const f = await fixture(t); await performFixture(f, 'text');
  const path = await recordFixtureDispatch(f), ledger = readJson(path);
  Object.assign(ledger.dispatch, { registeredAt: '2026-01-01T00:00:00.000Z', preparedAt: '2026-01-01T00:00:01.000Z',
    sendingAt: '2026-01-01T00:00:03.000Z', submittedAt: '2026-01-01T00:00:04.000Z' });
  writeJson(path, ledger);
  const before = fs.readFileSync(path), report = await f.check();
  assert.equal(report.dispatch.submissionConfirmed, true); assertNotLive(report);
  assert.equal(report.dispatch.timingSource, 'recorded_wall_clock');
  assert.deepEqual(report.dispatch.timingMs, { preparation: 1000, readyToSend: 2000, confirmation: 1000 });
  assert.deepEqual(fs.readFileSync(path), before);
  for (const secret of ['PRIVATE_TOKEN', 'private-tab', 'private-chat', 'private-message', 'promptSha256', 'chatUrl', 'target'])
    assert.equal(JSON.stringify(report).includes(secret), false);
  await assert.rejects(inspectDispatchEvidence(path, 'other-id'));
  ledger.dispatch.submittedAt = '2025-01-01T00:00:00.000Z'; writeJson(path, ledger);
  assert.equal((await f.check()).dispatch.timingMs.confirmation, null);
});

test('missing, pending, wrong-task and wrong-mode dispatch evidence cannot imply live acceptance', async t => {
  const f = await fixture(t); await performFixture(f, 'text');
  const path = await recordFixtureDispatch(f, { confirmed: false }), ledger = readJson(path);
  let report = await f.check();
  assert.equal(report.dispatch.submissionConfirmed, false); assert.equal(report.dispatch.resendBlocked, true);
  assert.equal(report.dispatch.timingMs.confirmation, null); assertNotLive(report);
  ledger.dispatch.taskId = 'wrong'; writeJson(path, ledger);
  report = await f.check(); assert.equal(report.dispatch.availability, 'invalid_or_unavailable'); assertNotLive(report);
  fs.unlinkSync(path); await recordFixtureDispatch(f, { mode: 'xhigh' });
  assert.equal((await f.check()).dispatch.availability, 'mismatched');
});

test('numeric parent measurements keep unknowns null and reject injected output or mismatched runs', async t => {
  const f = await fixture(t), path = join(f.run, 'measurements.json'), original = readJson(path);
  const valid = { ...original, browserToolCalls: 6, returnedBytes: 120, sendAttempts: 1, parentInterventions: 0 };
  writeJson(path, valid);
  const report = await f.check();
  assert.equal(report.measurements.source, 'parent_reported'); assert.equal(report.measurements.values.inputTokens, null);
  assert.equal(report.measurements.values.browserToolCalls, 6);
  for (const bad of [{ ...valid, token: 'PRIVATE_TOKEN' }, { ...valid, browserToolCalls: 'PRIVATE_TOKEN' },
    { ...valid, parentInterventions: -1 }, { ...valid, returnedBytes: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, taskId: 'other' }]) {
    writeJson(path, bad); const invalid = await f.check();
    assert.equal(invalid.measurements.availability, 'invalid_or_unavailable');
    assert.equal(JSON.stringify(invalid).includes('PRIVATE_TOKEN'), false);
  }
});

test('fresh parent CLI checks do not redispatch, while explicit resume observes the retained result', async t => {
  const f = await fixture(t, 'resume'); await performFixture(f, 'resume');
  const configPath = join(f.base, 'config.json'); writeJson(configPath, f.config);
  const env = { ...process.env, WEBGPT_CONFIG: configPath, WEBGPT_DATA_DIR: f.dir }, before = f.state();
  const checked = await exec(process.execPath, [script, 'check', f.run], { env, timeout: 10000 });
  assert.equal(JSON.parse(checked.stdout).localVerdict, 'PASS'); assert.deepEqual(f.state(), before);
  assert.equal((await collectTask(f.task.id, f.config)).collected, true);
  const collected = f.state();
  const resumed = await exec(process.execPath, [clientScript, 'collect', '--resume', f.task.id], { env, timeout: 10000 });
  assert.equal(JSON.parse(resumed.stdout).disposition, 'already_collected');
  const second = JSON.parse((await exec(process.execPath, [script, 'check', f.run], { env, timeout: 10000 })).stdout);
  assert.equal(second.collection, 'collected'); assertNotLive(second); assert.deepEqual(f.state(), collected);
  assert.equal(fs.existsSync(join(f.run, 'dispatch.json')), false);
});

test('unavailable controller is blocked and malformed local input produces no raw CLI error', async t => {
  const f = await fixture(t); await f.worker.close();
  assert.equal((await f.check()).checks.controller, 'UNAVAILABLE');
  const path = join(f.run, 'verification.json'), bytes = fs.readFileSync(path);
  for (const malformed of [Buffer.from([0xff]), Buffer.alloc(32769, 32)]) {
    fs.writeFileSync(path, malformed); await assert.rejects(checkVerification(f.run, f.config));
  }
  fs.writeFileSync(path, bytes);
  try { await exec(process.execPath, [script, 'prepare', 'text', f.run, 'pro'], { timeout: 10000 }); assert.fail('must refuse overwrite'); }
  catch (error) { assert.equal(error.code, 1); assert.equal(error.stdout, ''); assert.equal(error.stderr.includes(f.run), false); }
});

// Missing proof fields are not the same as an explicit empty, inspected array.
test('partial controller evidence stays blocked rather than inventing clean recovery', async t => {
  const f = await fixture(t); await performFixture(f, 'text');
  let field = 'journalIssues';
  const proxy = await controllerProxy(f.config, ({ phase, data, res }) => {
    if (phase !== 'after') return false;
    delete data.tasks[0][field]; replyJson(res, data); return true;
  });
  t.after(() => proxy.close());
  const before = f.state();
  for (field of ['changes', 'journalIssues', 'recoveryRequired', 'pendingResults', 'discarded']) {
    const report = await checkVerification(f.run, { ...f.config, controlPort: proxy.port });
    assert.equal(report.localVerdict, 'BLOCKED'); assert.equal(report.checks.controller, 'UNAVAILABLE');
    assertNotLive(report);
  }
  assert.deepEqual(f.state(), before);
});
