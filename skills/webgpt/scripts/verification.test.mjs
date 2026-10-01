// Local controller/MCP fixtures exercise the parent checker, not a signed-in web model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { start } from './worker.mjs';
import { request, collectTask } from './client.mjs';
import { callTool, controllerProxy, replyJson } from './test-fixtures/worker-http.mjs';
import { observeFileRead } from './test-fixtures/file-read.mjs';
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
async function fixture(t, scenario = 'text', changeRegistration = () => {}) {
  const f = baseFixture(t);
  f.prepared = prepareVerification(scenario, f.run, 'pro');
  f.registration = readJson(join(f.run, 'request.json'));
  changeRegistration(f.registration, f);
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
const connectionSeed = 'status=before\n한글 🧪\nkeep=this line\n';
const connectionFinal = 'status=after\n한글 🧪\nkeep=this line\n';
const connectionSample = '연결 검증 입력\n한글 🧪\n';
const connectionClaims = ['pinnedReadVerified', 'staleReadRejected', 'staleWriteRejected', 'temporaryLifecycleVerified'];
const resultFor = scenario => scenario === 'connection' ? { sample: connectionSample,
  seedSha256: createHash('sha256').update(connectionFinal).digest('hex'),
  ...Object.fromEntries(connectionClaims.map(name => [name, true])) } : scenario === 'read' ? { actual: 17, expected: 34, finding: 'quantity_ignored' }
  : { total: 34, units: 4, ...(scenario === 'edit' ? { staleWriteRejected: true } : {}) };
async function performConnection(f) {
  const assigned = await f.tool('get_task'); assert.equal(assigned.isError, false);
  assert.equal(assigned.structuredContent.id, f.task.id);
  const input = await f.tool('read_input', { name: 'sample' }); assert.equal(input.isError, false);
  assert.equal(input.structuredContent.text, connectionSample);
  const initial = await f.tool('list_files', { path: '.' }); assert.equal(initial.isError, false);
  assert.deepEqual(initial.structuredContent.entries.map(entry => entry.name), ['seed.txt']);
  const before = await f.tool('read_file', { path: 'seed.txt' }); assert.equal(before.isError, false);
  assert.equal(before.structuredContent.text, connectionSeed);
  const edit = { path: 'seed.txt', oldText: 'status=before', text: 'status=after', expectedSha256: before.structuredContent.sha256 };
  const changed = await f.tool('write_file', edit); assert.equal(changed.isError, false);
  const pinned = await f.tool('read_file', { path: 'seed.txt', expectedSha256: changed.structuredContent.afterSha256 });
  assert.equal(pinned.isError, false); assert.equal(pinned.structuredContent.text, connectionFinal);
  const state = f.state();
  for (const [name, args] of [['read_file', { path: 'seed.txt', expectedSha256: edit.expectedSha256 }], ['write_file', edit]]) {
    const rejected = await f.tool(name, args);
    assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, /file revision conflict/);
    assert.deepEqual(f.state(), state, 'a rejected call cannot add a receipt or change task state');
  }
  const preserved = await f.tool('read_file', { path: 'seed.txt', expectedSha256: pinned.structuredContent.sha256 });
  assert.equal(preserved.isError, false); assert.equal(preserved.structuredContent.text, connectionFinal);
  const created = await f.tool('write_file', { path: 'temp.txt', text: '임시 연결 검증\n', expectedSha256: null });
  assert.equal(created.isError, false);
  const temporary = await f.tool('read_file', { path: 'temp.txt' }); assert.equal(temporary.isError, false);
  assert.equal(temporary.structuredContent.text, '임시 연결 검증\n');
  assert.equal(temporary.structuredContent.sha256, created.structuredContent.afterSha256);
  assert.equal((await f.tool('delete_file', { path: 'temp.txt', expectedSha256: temporary.structuredContent.sha256 })).isError, false);
  const absent = await f.tool('read_file', { path: 'temp.txt' }); assert.equal(absent.isError, false);
  assert.equal(absent.structuredContent.exists, false);
  const listing = await f.tool('list_files', { path: '.' }); assert.equal(listing.isError, false);
  assert.deepEqual(listing.structuredContent.entries.map(entry => entry.name), ['seed.txt']);
  const final = await f.tool('read_file', { path: 'seed.txt' }); assert.equal(final.isError, false);
  assert.equal(final.structuredContent.text, connectionFinal); assert.equal(final.structuredContent.sha256, pinned.structuredContent.sha256);
  return { ...resultFor('connection'), sample: input.structuredContent.text, seedSha256: final.structuredContent.sha256 };
}
async function performFixture(f, scenario) {
  if (scenario === 'connection') { await f.submit(await performConnection(f)); return; }
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
  // Extend the existing acceptance fixture instead of running a second copy
  // just to measure I/O. Collection still owns its separate fresh verification.
  const checkOnce = async () => {
    const path = join(f.dir, f.task.id + '.result.txt'), size = fs.statSync(path).size;
    const read = observeFileRead(t, path);
    let report;
    try { report = await f.check(); } finally { read.restore(); }
    const { opens, closes, bytes } = read.evidence;
    assert.deepEqual({ opens, closes, bytes }, { opens: 1, closes: 1, bytes: size },
      'verify and parse one fresh result snapshot; neither rescan nor cache acceptance');
    return report;
  };
  const before = f.state(), report = await checkOnce();
  assert.equal(report.localVerdict, 'PASS'); assert.equal(report.collection, 'uncollected'); assertNotLive(report);
  assert.equal(report.dispatch.availability, 'not_recorded'); assert.equal(report.measurements.availability, 'not_recorded');
  if (scenario === 'connection') {
    assert.deepEqual(report.unverifiedClaims, connectionClaims);
    assert.equal(report.checks.arithmetic, 'NOT_APPLICABLE');
    assert.ok(report.parentMustVerify.includes('actual_pinned_and_stale_read_calls'));
    assert.ok(report.parentMustVerify.includes('actual_temporary_file_read_and_absence_calls'));
  }
  if (scenario === 'edit') {
    assert.deepEqual(report.unverifiedClaims, ['staleWriteRejected']);
    assert.ok(report.parentMustVerify.includes('actual_stale_write_rejection_call'));
  }
  assert.deepEqual(f.state(), before, 'checks cannot retire input/token or publish another result');
  assert.equal((await f.tool('get_task')).isError, false);
  assert.equal((await collectTask(f.task.id, f.config)).collected, true);
  const collected = f.state(), after = await checkOnce();
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
  for (const scenario of ['text', 'edit', 'connection']) {
    const f = await fixture(t, scenario);
    // edit claims a fix and conflict rejection, but never changes the project.
    await f.submit(scenario === 'text' ? { total: 17, units: 4 } : resultFor(scenario));
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

test('verification keeps the existing JSON BOM policy with the shared verified-result reader', async t => {
  for (const [prefix, expected] of [['\ufeff', 'PASS'], ['\ufeff\ufeff', 'FAIL'], [' \ufeff', 'FAIL']]) {
    const f = await fixture(t);
    const result = prefix + JSON.stringify(resultFor('text'));
    assert.equal((await f.tool('submit_result', { status: 'completed', summary: 'BOM fixture', result })).isError, false);
    const before = f.state(), report = await f.check();
    assert.equal(report.checks.result, expected); assert.equal(report.localVerdict, expected);
    assertNotLive(report); assert.deepEqual(f.state(), before);
  }
});

test('verification does not trust a result path or an integrity label from the controller', async t => {
  const f = await fixture(t); await performFixture(f, 'text');
  const other = join(f.base, 'not-the-owned-result.txt');
  fs.copyFileSync(join(f.dir, f.task.id + '.result.txt'), other);
  const proxy = await controllerProxy(f.config, ({ phase, data, res }) => {
    if (phase !== 'after') return false;
    Object.assign(data.tasks[0], { artifact: other, integrity: 'verified' });
    replyJson(res, data); return true;
  });
  t.after(() => proxy.close());
  const before = f.state(), read = observeFileRead(t, other);
  let report;
  try { report = await checkVerification(f.run, { ...f.config, controlPort: proxy.port }); }
  finally { read.restore(); }
  assert.equal(report.checks.result, 'FAIL'); assert.equal(report.localVerdict, 'FAIL'); assertNotLive(report);
  assert.equal(read.evidence.opens, 0); assert.equal(read.evidence.bytes, 0);
  assert.deepEqual(proxy.actions, ['/reconcile?id=' + f.task.id]); assert.deepEqual(f.state(), before);
  assert.equal(JSON.stringify(report).includes(other), false);
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


// Check the actual CLI contract, not just the in-process report.
async function cliCheck(f) {
  const config = join(f.base, 'checker-config.json'); writeJson(config, f.config);
  const options = { env: { ...process.env, WEBGPT_CONFIG: config, WEBGPT_DATA_DIR: f.dir }, timeout: 10000 };
  try { const { stdout, stderr } = await exec(process.execPath, [script, 'check', f.run], options);
    assert.equal(stderr, ''); return { code: 0, report: JSON.parse(stdout) };
  } catch (error) { assert.equal(error.stderr, ''); return { code: error.code, report: JSON.parse(error.stdout) }; }
}

for (const cause of ['candidate', 'journal', 'workspace'])
  test(`unrelated ${cause} readiness failures do not fail an accepted local fixture`, async t => {
    const f = await fixture(t); await performFixture(f, 'text');
    const root = join(f.base, 'unrelated-project'); fs.mkdirSync(root);
    await request('register', { id: 'unrelated', instructions: 'not part of the exercise', inputs: {},
      workspace: { root, mode: 'read' } }, f.config);
    if (cause === 'candidate') fs.writeFileSync(join(f.dir, 'unrelated.result.txt.tmp'), 'preserve');
    else if (cause === 'journal') {
      fs.mkdirSync(join(f.dir, 'recovery', 'unrelated'), { recursive: true });
      fs.writeFileSync(join(f.dir, 'recovery', 'unrelated', 'broken.json'), '{}');
    } else fs.rmdirSync(root);
    if (cause === 'candidate') await recordFixtureDispatch(f, { mode: 'xhigh' });
    const before = f.state(), { code, report } = await cliCheck(f);
    assert.equal(code, 0); assert.equal(report.version, 2); assert.equal(report.taskStatus, 'completed');
    assert.equal(report.localVerdict, 'PASS'); assert.equal(report.checks.globalHealth, 'FAIL');
    assert.equal(report.checks.controllerState, 'PASS'); assert.equal(report.checks.recovery, 'PASS'); assertNotLive(report);
    if (cause === 'candidate') assert.equal(report.dispatch.availability, 'mismatched');
    assert.deepEqual(f.state(), before); assert.equal(report.collection, 'uncollected');
    assert.equal(JSON.stringify(report).includes('unrelated'), false, 'do not export unrelated diagnostic IDs');
    // A candidate belonging to this task is still a local acceptance failure.
    fs.writeFileSync(join(f.dir, f.task.id + '.result.txt.tmp'), 'owned candidate');
    const rejected = await cliCheck(f);
    assert.equal(rejected.code, 2); assert.equal(rejected.report.localVerdict, 'FAIL');
    assert.equal(rejected.report.checks.recovery, 'FAIL'); assert.deepEqual(f.state(), before);
  });

test('write readiness failure is independent, but unavailable current state blocks local acceptance', async t => {
  const f = await fixture(t); await performFixture(f, 'text');
  const before = f.state(), write = fs.writeFileSync;
  const mock = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (typeof file === 'string' && file.startsWith(join(f.dir, '.health-')))
      throw Object.assign(Error('fixture full disk'), { code: 'ENOSPC' });
    return write(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    const report = await f.check();
    assert.equal(report.checks.controllerState, 'PASS'); assert.equal(report.checks.globalHealth, 'FAIL');
    assert.equal(report.localVerdict, 'PASS');
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal((await cliCheck(f)).code, 0, 'sticky write failure is still separate from freshly verified state');
  const stateFile = join(f.dir, 'state.json');
  const unreadable = observeFileRead(t, stateFile, { afterStat() {
    throw Object.assign(Error('fixture unreadable state'), { code: 'EIO' });
  } });
  try {
    const report = await f.check();
    assert.equal(report.checks.controllerState, 'UNAVAILABLE'); assert.equal(report.localVerdict, 'BLOCKED');
  } finally { unreadable.restore(); }
  assert.ok(unreadable.evidence.opens > 0, 'the real current-state read reached the injected failure');
  assert.equal(unreadable.evidence.opens, unreadable.evidence.closes);
  assert.equal(unreadable.evidence.bytes, 0);
  // A subsequent check verifies the bytes again; a prior PASS is not cached.
  assert.equal((await cliCheck(f)).code, 0);
  fs.writeFileSync(stateFile, 'invalid current state');
  const invalid = await cliCheck(f);
  assert.equal(invalid.code, 2); assert.equal(invalid.report.localVerdict, 'BLOCKED');
  assert.equal(invalid.report.checks.controllerState, 'UNAVAILABLE'); assertNotLive(invalid.report);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), 'invalid current state');
  fs.writeFileSync(stateFile, before); // Fixture restoration is not controller repair.
  assert.equal((await f.check()).localVerdict, 'BLOCKED', 'existing state quarantine remains sticky');
});

test('PENDING describes the running lifecycle even when final fixture checks currently fail', async t => {
  const f = await fixture(t, 'edit'), before = f.state(), pending = await cliCheck(f);
  assert.equal(pending.code, 2); assert.equal(pending.report.taskStatus, 'running');
  assert.equal(pending.report.localVerdict, 'PENDING'); assert.equal(pending.report.checks.files, 'FAIL');
  assert.equal(pending.report.checks.receipts, 'FAIL'); assert.equal(pending.report.checks.result, 'NOT_RUN');
  assert.deepEqual(f.state(), before);
  await f.submit(resultFor('edit'));
  const terminal = await cliCheck(f);
  assert.equal(terminal.code, 2); assert.equal(terminal.report.taskStatus, 'completed');
  assert.equal(terminal.report.localVerdict, 'FAIL'); assertNotLive(terminal.report);
});

for (const scenario of ['read', 'edit', 'connection'])
  test(`${scenario} acceptance binds receipts and local fixture bytes to the owner-recorded root`, async t => {
    const f = await fixture(t, scenario, (registration, f) => {
      const other = join(f.base, 'other-project'); fs.cpSync(join(f.run, 'project'), other, { recursive: true });
      registration.workspace.root = other;
    });
    await performFixture(f, scenario);
    // Equal contents and relative receipt paths are not evidence of the same root.
    if (scenario !== 'read') {
      const name = scenario === 'connection' ? 'seed.txt' : 'total.mjs';
      fs.copyFileSync(join(f.registration.workspace.root, name), join(f.run, 'project', name));
    }
    const before = f.state(), { code, report } = await cliCheck(f);
    for (const key of ['files', 'receipts', 'result']) assert.equal(report.checks[key], 'PASS', key);
    assert.equal(report.checks.arithmetic, scenario === 'connection' ? 'NOT_APPLICABLE' : 'PASS');
    assert.equal(report.checks.workspaceGrant, 'FAIL'); assert.equal(report.localVerdict, 'FAIL'); assert.equal(code, 2);
    assertNotLive(report); assert.deepEqual(f.state(), before); assert.equal(JSON.stringify(report).includes(f.base), false);
  });

test('recorded grant mode and explicit no-workspace scenarios are part of acceptance', async t => {
  for (const scenario of ['read', 'text', 'resume']) {
    const f = await fixture(t, scenario, (registration, f) => {
      if (scenario === 'read') registration.workspace.mode = 'edit';
      else { const root = join(f.base, 'extra-grant'); fs.mkdirSync(root); registration.workspace = { root, mode: 'read' }; }
    });
    await f.submit(resultFor(scenario));
    const before = f.state(), { code, report } = await cliCheck(f);
    assert.equal(report.checks.result, 'PASS'); assert.equal(report.checks.workspaceGrant, 'FAIL');
    assert.equal(report.localVerdict, 'FAIL'); assert.equal(code, 2); assert.deepEqual(f.state(), before);
  }
});

test('replacing a retired fixture directory with identical bytes cannot reuse its registered identity', async t => {
  const f = await fixture(t, 'read'); await performFixture(f, 'read');
  await collectTask(f.task.id, f.config);
  const before = f.state(), root = join(f.run, 'project');
  assert.equal((await f.check()).checks.workspaceGrant, 'PASS');
  fs.renameSync(root, root + '-retained'); fs.cpSync(root + '-retained', root, { recursive: true });
  const { code, report } = await cliCheck(f);
  assert.equal(report.checks.files, 'PASS'); assert.equal(report.checks.result, 'PASS');
  assert.equal(report.checks.workspaceGrant, 'FAIL'); assert.equal(report.localVerdict, 'FAIL'); assert.equal(code, 2);
  assert.deepEqual(f.state(), before); assert.equal(report.collection, 'collected');
});

test('scoped reconciliation exposes recorded grant identity without credentials', async t => {
  const f = await fixture(t, 'read'), before = f.state();
  const snapshot = await request('reconcile', { ids: [f.task.id] }, f.config);
  assert.equal(snapshot.health.stateVerified, true);
  const info = fs.lstatSync(join(f.run, 'project'));
  assert.deepEqual(snapshot.tasks[0].workspace, {
    root: fs.realpathSync.native(join(f.run, 'project')), mode: 'read', device: info.dev, inode: info.ino,
  });
  const serialized = JSON.stringify(snapshot);
  for (const secret of [f.task.token, f.registration.instructions, 'controller.key']) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(f.state(), before);
});

test('missing owner proof remains BLOCKED instead of inferring no grant or healthy state', async t => {
  const f = await fixture(t); await performFixture(f, 'text');
  let remove;
  const proxy = await controllerProxy(f.config, ({ phase, data, res }) => {
    if (phase !== 'after') return false;
    remove(data); replyJson(res, data); return true;
  });
  t.after(() => proxy.close());
  const before = f.state();
  for (const [field, change] of [
    ['workspaceGrant', data => { delete data.tasks[0].workspace; }],
    ['controllerState', data => { delete data.health.stateVerified; }],
    ['controllerState', data => { data.health.stateVerified = 'true'; }],
    ['controllerState', data => { data.health = null; }],
  ]) {
    remove = change;
    const local = { ...f, config: { ...f.config, controlPort: proxy.port } }, { code, report } = await cliCheck(local);
    assert.equal(report.checks[field], 'UNAVAILABLE'); assert.equal(report.localVerdict, 'BLOCKED'); assert.equal(code, 2);
    assertNotLive(report);
  }
  assert.deepEqual(f.state(), before);
  assert.ok(proxy.actions.every(action => action === '/reconcile?id=' + f.task.id), 'never widen to /tasks or retry an old endpoint');
});


test('connection preparation creates only the private Unicode seed, without registration or executable fixture code', async t => {
  const f = baseFixture(t); f.run = join(f.base, '연결 검증 #');
  const { stdout, stderr } = await exec(process.execPath, [script, 'prepare', 'connection', f.run, 'pro'], { cwd: f.base, timeout: 10000 });
  assert.equal(stderr, ''); const prepared = JSON.parse(stdout);
  assert.equal(prepared.scenario, 'connection'); assert.equal(prepared.registered, false); assert.equal(prepared.browserChecked, false);
  const registration = readJson(join(f.run, 'request.json'));
  assert.deepEqual(registration.inputs, { sample: connectionSample });
  assert.equal(registration.workspace.mode, 'edit'); assert.equal(registration.workspace.root, join(f.run, 'project'));
  assert.deepEqual(fs.readdirSync(registration.workspace.root), ['seed.txt']);
  assert.equal(fs.readFileSync(join(registration.workspace.root, 'seed.txt'), 'utf8'), connectionSeed);
  assert.deepEqual(fs.readdirSync(f.run).sort(), ['measurements.json', 'project', 'request.json', 'verification.json']);
  assert.equal(registration.instructions.includes(resultFor('connection').seedSha256), false);
  assert.match(registration.instructions, /oldText/); assert.match(registration.instructions, /exists:false/);
  assert.throws(() => prepareVerification('connection', f.run, 'pro'), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(join(registration.workspace.root, 'seed.txt'), 'utf8'), connectionSeed);
});

test('connection acceptance needs create/delete receipts even when the final seed and claimed result are correct', async t => {
  const f = await fixture(t, 'connection');
  const before = (await f.tool('read_file', { path: 'seed.txt' })).structuredContent;
  assert.equal((await f.tool('write_file', { path: 'seed.txt', oldText: 'status=before', text: 'status=after', expectedSha256: before.sha256 })).isError, false);
  await f.submit(resultFor('connection'));
  const state = f.state(), { code, report } = await cliCheck(f);
  assert.equal(code, 2); assert.equal(report.localVerdict, 'FAIL'); assert.equal(report.checks.files, 'PASS');
  assert.equal(report.checks.result, 'PASS'); assert.equal(report.checks.receipts, 'FAIL'); assertNotLive(report);
  assert.deepEqual(f.state(), state); assert.equal((await f.tool('get_task')).isError, false);
});

test('connection checker rejects wrong receipt sequences without accepting boolean claims as invocation evidence', async t => {
  const f = await fixture(t, 'connection'); await performFixture(f, 'connection');
  let change;
  const proxy = await controllerProxy(f.config, ({ phase, data, res }) => {
    if (phase !== 'after') return false;
    change(data.tasks[0]); replyJson(res, data); return true;
  });
  t.after(() => proxy.close());
  const state = f.state();
  for (change of [
    task => { task.changes = []; },
    task => { task.changes.pop(); },
    task => { task.changes.reverse(); },
    task => { task.changes[1].path = 'other.txt'; },
    task => { task.changes[0].beforeSha256 = '0'.repeat(64); },
    task => { task.changes[1].afterSha256 = '0'.repeat(64); },
    task => { task.changes[2].afterSha256 = '0'.repeat(64); },
  ]) {
    const report = await checkVerification(f.run, { ...f.config, controlPort: proxy.port });
    assert.equal(report.localVerdict, 'FAIL'); assert.equal(report.checks.receipts, 'FAIL');
    assert.equal(report.checks.files, 'PASS'); assert.equal(report.checks.result, 'PASS'); assertNotLive(report);
  }
  assert.equal((await f.check()).localVerdict, 'PASS'); assert.deepEqual(f.state(), state);
  assert.ok(proxy.actions.every(action => action === '/reconcile?id=' + f.task.id));
});

for (const artifact of ['seed', 'temp', 'extra']) test(`connection checker freshly rejects ${artifact} changes without repairing or retiring evidence`, async t => {
  const f = await fixture(t, 'connection'); await performFixture(f, 'connection');
  const path = join(f.run, 'project', artifact === 'seed' ? 'seed.txt' : artifact + '.txt');
  fs.writeFileSync(path, 'PRESERVE_UNEXPECTED_FIXTURE');
  const state = f.state(), { code, report } = await cliCheck(f);
  assert.equal(code, 2); assert.equal(report.localVerdict, 'FAIL'); assert.equal(report.checks.files, 'FAIL');
  assert.equal(report.checks.receipts, 'PASS'); assert.equal(report.checks.result, 'PASS'); assertNotLive(report);
  assert.equal(fs.readFileSync(path, 'utf8'), 'PRESERVE_UNEXPECTED_FIXTURE'); assert.deepEqual(f.state(), state);
  assert.equal(JSON.stringify(report).includes('PRESERVE_UNEXPECTED_FIXTURE'), false);
});

test('connection acceptance still requires the real seed and deleted-temp backups', async t => {
  const f = await fixture(t, 'connection'); await performFixture(f, 'connection');
  const task = JSON.parse(f.state())[0], state = f.state();
  for (const index of [0, 2]) {
    const backup = task.changes[index].backup, bytes = fs.readFileSync(backup);
    fs.writeFileSync(backup, 'PRESERVE_DAMAGED_BACKUP');
    const report = await f.check();
    assert.equal(report.localVerdict, 'FAIL'); assert.equal(report.checks.recovery, 'FAIL');
    assert.equal(report.checks.files, 'PASS'); assert.equal(report.checks.receipts, 'PASS'); assertNotLive(report);
    assert.equal(fs.readFileSync(backup, 'utf8'), 'PRESERVE_DAMAGED_BACKUP'); assert.deepEqual(f.state(), state);
    fs.writeFileSync(backup, bytes); // Restore only disposable test evidence, never production recovery.
  }
  assert.equal((await f.check()).localVerdict, 'PASS');
});

test('connection result rejection and grant mismatch cannot be hidden by correct local bytes', async t => {
  const f = await fixture(t, 'connection'), result = await performConnection(f);
  await f.submit({ ...result, staleReadRejected: false });
  const state = f.state(), { code, report } = await cliCheck(f);
  assert.equal(code, 2); assert.equal(report.localVerdict, 'FAIL'); assert.equal(report.checks.result, 'FAIL');
  assert.equal(report.checks.files, 'PASS'); assert.equal(report.checks.receipts, 'PASS'); assertNotLive(report);
  assert.deepEqual(report.unverifiedClaims, connectionClaims); assert.deepEqual(f.state(), state);
  const proxy = await controllerProxy(f.config, ({ phase, data, res }) => {
    if (phase !== 'after') return false;
    data.tasks[0].workspace.mode = 'read'; replyJson(res, data); return true;
  });
  t.after(() => proxy.close());
  const mismatch = await checkVerification(f.run, { ...f.config, controlPort: proxy.port });
  assert.equal(mismatch.checks.workspaceGrant, 'FAIL');
  for (const secret of [f.base, f.task.token, connectionFinal, connectionSample]) assert.equal(JSON.stringify(report).includes(secret), false);
});

test('connection evidence survives a clean worker restart and explicit collection without redispatch', async t => {
  const f = await fixture(t, 'connection'), result = await performConnection(f);
  const changes = JSON.parse(f.state())[0].changes;
  const restart = async () => {
    await f.worker.close();
    f.worker = await start({ dir: f.dir, port: 0, controlPort: 0, waitMs: 20 });
    f.config.controlPort = f.worker.controlPort;
  };
  await restart();
  assert.equal((await f.tool('get_task')).structuredContent.status, 'running');
  assert.deepEqual(JSON.parse(f.state())[0].changes, changes);
  const pending = await f.check(); assert.equal(pending.localVerdict, 'PENDING');
  assert.equal(pending.checks.files, 'PASS'); assert.equal(pending.checks.receipts, 'PASS');
  await f.submit(result);
  const checked = await cliCheck(f); assert.equal(checked.code, 0); assertNotLive(checked.report);
  assert.equal((await collectTask(f.task.id, f.config)).collected, true);
  await restart();
  const state = f.state(), retired = await cliCheck(f);
  assert.equal(retired.code, 0); assert.equal(retired.report.collection, 'collected'); assertNotLive(retired.report);
  assert.equal((await f.tool('get_task')).isError, true);
  assert.equal((await f.tool('read_file', { path: 'seed.txt' })).isError, true);
  assert.deepEqual(f.state(), state); assert.deepEqual(JSON.parse(state)[0].changes, changes);
  assert.equal(fs.existsSync(join(f.run, 'dispatch.json')), false);
});
