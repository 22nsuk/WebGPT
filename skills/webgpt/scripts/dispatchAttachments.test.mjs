import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { registerDispatch, beginDispatch, confirmDispatch, inspectDispatch, inspectDispatchEvidence,
  recoverDispatch, dispatchPrompt, dispatchDiagnostic, textDigest } from './dispatch.mjs';

// Actual private-ledger/CLI operations; UI observations are explicit fixtures,
// not a signed-in browser, file upload or proof of remote bytes/parsing.
const prompt = 'Compare the supplied sources and report limitations.';
const target = { tabId: 'owned-tab', chatUrl: 'https://chatgpt.com/c/owned-chat' };
const required = ['근거 A.pdf', 'source-B.csv'];
const spec = () => ({ taskId: 'attachment-task', mode: 'pro', prompt, target: { ...target },
  connectorRequired: true, requiredAttachments: [...required] });
const ready = () => ({ target: { ...target }, mode: 'pro', connectorSelected: true,
  approvalPending: false, composerSha256: null, lastUserMessageId: 'previous-message' });
const sent = () => ({ ...ready(), lastUserMessageId: 'new-message', userMessage: {
  id: 'new-message', previousId: 'previous-message', role: 'user', bodySha256: textDigest(prompt),
  attachmentNames: [...required],
} });
const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-attachments-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.json');
  writeFileSync(file, JSON.stringify({ ownership: 'keep', token: 'private-fixture-token' }), { mode: 0o600 });
  return { dir, file, bytes: () => readFileSync(file), ledger: () => JSON.parse(readFileSync(file, 'utf8')) };
};
async function started(t) {
  const f = fixture(t);
  await registerDispatch(f.file, spec());
  await beginDispatch(f.file, { prompt, observation: ready() });
  return f;
}

// Run the actual dispatchCli entry function in fresh Node processes. No client,
// controller or browser is substituted, and payloads remain private files.
function cli(args) {
  const source = `import {dispatchCli, dispatchDiagnostic} from ${JSON.stringify(new URL('./dispatch.mjs', import.meta.url).href)};
    try { console.log(JSON.stringify(await dispatchCli(process.argv.slice(2)))); }
    catch (e) { console.error(JSON.stringify(dispatchDiagnostic(e))); process.exitCode = 1; }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, '--', 'dispatch-cli-test', ...args], { windowsHide: true, timeout: 15000 });
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { err += data; });
    child.once('error', reject);
    child.once('close', code => {
      try { resolve({ code, out, err, value: JSON.parse(code === 0 ? out : err) }); }
      catch (error) { reject(error); }
    });
  });
}

test('text-only v1 schema/output and high-level dispatch remain unchanged', async t => {
  const f = fixture(t), input = spec();
  delete input.requiredAttachments;
  const registered = await registerDispatch(f.file, input);
  assert.deepEqual(registered, { state: 'registered', mode: 'pro', connectorRequired: true,
    uiPrepared: false, submissionConfirmed: false, resendBlocked: false, needsInspection: false, reason: null });
  const observation = sent(); delete observation.userMessage.attachmentNames;
  let calls = 0;
  const result = await dispatchPrompt(f.file, prompt, { observeReady: async () => ready(),
    fillAndSend: async () => { calls++; }, observeSent: async () => observation });
  assert.equal(calls, 1);
  assert.equal(result.submissionConfirmed, true);
  assert.equal(Object.hasOwn(result, 'attachmentEvidenceConfirmed'), false);
  assert.equal(f.ledger().dispatch.version, 1);
});

test('v2 persists detached requirements and registration cannot remove or change them', async t => {
  const f = fixture(t), input = spec();
  const first = await registerDispatch(f.file, input), bytes = f.bytes();
  input.requiredAttachments[0] = 'changed.pdf';
  assert.equal(f.ledger().dispatch.version, 2);
  assert.deepEqual(f.ledger().dispatch.requiredAttachments, [...required].sort());
  assert.equal(first.requiredAttachmentCount, 2);
  assert.equal(first.attachmentEvidenceConfirmed, false);
  assert.deepEqual(await registerDispatch(f.file, { ...spec(), requiredAttachments: [...required].reverse() }), first);
  assert.deepEqual(f.bytes(), bytes);
  const removed = spec(); delete removed.requiredAttachments;
  for (const changed of [input, removed, { ...spec(), requiredAttachments: ['other.pdf'] }]) {
    await assert.rejects(registerDispatch(f.file, changed), { code: 'DISPATCH_CONFLICT' });
    assert.deepEqual(f.bytes(), bytes);
  }
  assert.equal(f.ledger().ownership, 'keep');
  assert.equal(f.ledger().token, 'private-fixture-token');
});

const badRequirements = [[], null, 'file.pdf', [''], [' '], [' x.pdf'], ['x.pdf '], ['x\ny.pdf'],
  ['../x.pdf'], ['C:\\x.pdf'], ['.'], ['..'], ['x.pdf', 'x.pdf'], [null], [3], ['\ud800'],
  ['a'.repeat(256)], ['한'.repeat(86)], Array(1), Array.from({ length: 33 }, (_, i) => `${i}.txt`)];
for (const [index, value] of badRequirements.entries()) {
  test(`invalid required attachment declaration ${index + 1} preserves the original ledger`, async t => {
    const f = fixture(t), bytes = f.bytes();
    await assert.rejects(registerDispatch(f.file, { ...spec(), requiredAttachments: value }), { code: 'DISPATCH_INPUT' });
    assert.deepEqual(f.bytes(), bytes);
  });
}

test('local attachment bounds accept 32 unique names and a 255-byte basename', async t => {
  const f = fixture(t), names = Array.from({ length: 31 }, (_, i) => `${i}.txt`);
  names.push('한'.repeat(85));
  const input = { ...spec(), requiredAttachments: names };
  assert.equal((await registerDispatch(f.file, input)).requiredAttachmentCount, 32);
  await beginDispatch(f.file, { prompt, observation: ready() });
  const observation = sent(); observation.userMessage.attachmentNames = [...names].reverse();
  assert.equal((await confirmDispatch(f.file, observation)).attachmentEvidenceConfirmed, true);
});

test('v2 requires split dispatch before any high-level browser callback', async t => {
  const f = fixture(t);
  await registerDispatch(f.file, spec());
  const bytes = f.bytes();
  let callbacks = 0;
  const callback = async () => { callbacks++; throw Error('private browser failure'); };
  await assert.rejects(dispatchPrompt(f.file, prompt, { observeReady: callback, fillAndSend: callback, observeSent: callback }),
    error => {
      const diagnostic = dispatchDiagnostic(error);
      assert.equal(diagnostic.code, 'DISPATCH_ATTACHMENTS');
      assert.equal(diagnostic.reason, 'attachment_workflow_required');
      assert.doesNotMatch(JSON.stringify(diagnostic), /private browser failure|owned-tab|\.pdf/);
      return true;
    });
  assert.equal(callbacks, 0);
  assert.deepEqual(f.bytes(), bytes);
});

const invalidEvidence = {
  'body only': o => { delete o.userMessage.attachmentNames; },
  'no attachments': o => { o.userMessage.attachmentNames = []; },
  'missing attachment': o => { o.userMessage.attachmentNames.pop(); },
  'wrong attachment': o => { o.userMessage.attachmentNames[0] = 'wrong.pdf'; },
  'unexpected extra attachment': o => { o.userMessage.attachmentNames.push('extra.pdf'); },
  'duplicate attachment': o => { o.userMessage.attachmentNames = [required[0], required[0]]; },
  'names not an array': o => { o.userMessage.attachmentNames = required.join(','); },
  'raw path': o => { o.userMessage.attachmentNames[0] = '/private/source.pdf'; },
  'extra raw metadata': o => { o.userMessage.transcript = 'must not persist'; },
  'wrong body': o => { o.userMessage.bodySha256 = textDigest('different body'); },
  'wrong target': o => { o.target.tabId = 'other-tab'; },
  'wrong chat': o => { o.target.chatUrl = 'https://chatgpt.com/c/other-chat'; },
  'wrong mode': o => { o.mode = 'xhigh'; },
  'pending approval': o => { o.approvalPending = true; },
  'missing connector': o => { o.connectorSelected = false; },
  'wrong predecessor': o => { o.userMessage.previousId = 'another-message'; },
};
for (const [name, change] of Object.entries(invalidEvidence)) {
  test(`${name} keeps v2 uncertain and blocks another begin`, async t => {
    const f = await started(t), observation = sent(); change(observation);
    const result = await confirmDispatch(f.file, observation);
    assert.equal(result.state, 'uncertain');
    assert.equal(result.submissionConfirmed, false);
    assert.equal(result.attachmentEvidenceConfirmed, false);
    assert.equal(result.resendBlocked, true);
    assert.equal(result.needsInspection, true);
    assert.equal(Object.hasOwn(f.ledger().dispatch, 'confirmation'), false);
    await assert.rejects(beginDispatch(f.file, { prompt, observation: ready() }), { code: 'DISPATCH_BLOCKED' });
    assert.equal(f.ledger().dispatch.state, 'uncertain');
  });
}

test('matching same-message attachments confirm once; summaries omit private identity', async t => {
  const f = await started(t), observation = sent();
  observation.userMessage.attachmentNames.reverse();
  const result = await confirmDispatch(f.file, observation);
  assert.equal(result.submissionConfirmed, true);
  assert.equal(result.attachmentEvidenceConfirmed, true);
  const bytes = f.bytes();
  observation.userMessage.attachmentNames[0] = 'changed-after-save.pdf';
  assert.deepEqual(await confirmDispatch(f.file, sent()), result);
  assert.deepEqual(f.bytes(), bytes);
  const bodyOnly = sent(); delete bodyOnly.userMessage.attachmentNames;
  await assert.rejects(confirmDispatch(f.file, bodyOnly), { code: 'DISPATCH_BLOCKED' });
  assert.deepEqual(f.bytes(), bytes);
  const evidence = await inspectDispatchEvidence(f.file, 'attachment-task');
  assert.equal(evidence.attachmentEvidenceConfirmed, true);
  assert.doesNotMatch(JSON.stringify(evidence), /source-B|근거|private-fixture-token|owned-tab|chatgpt\.com|new-message/);
});

test('new chat, xhigh and no-connector attachment tasks keep the existing target rules', async t => {
  const f = fixture(t), input = spec();
  input.target.chatUrl = null; input.mode = 'xhigh'; input.connectorRequired = false;
  const before = ready(); before.target.chatUrl = null; before.lastUserMessageId = null;
  before.mode = 'xhigh'; before.connectorSelected = false;
  await registerDispatch(f.file, input);
  await beginDispatch(f.file, { prompt, observation: before });
  const observation = sent(); observation.mode = 'xhigh'; observation.connectorSelected = false;
  observation.userMessage.previousId = null;
  assert.equal((await confirmDispatch(f.file, observation)).attachmentEvidenceConfirmed, true);
});

test('interrupted split CLI persists requirements across fresh processes without resend', async t => {
  const f = fixture(t), payload = join(f.dir, 'payload.json');
  writeFileSync(payload, JSON.stringify(spec()), { mode: 0o600 });
  assert.equal((await cli(['register', f.file, payload])).code, 0);
  writeFileSync(payload, JSON.stringify({ prompt, observation: ready() }));
  const begins = await Promise.all([cli(['begin', f.file, payload]), cli(['begin', f.file, payload])]);
  assert.equal(begins.filter(r => r.code === 0).length, 1);
  assert.ok(begins.filter(r => r.code !== 0).every(r => ['DISPATCH_BLOCKED', 'DISPATCH_LOCKED'].includes(r.value.code)));
  assert.equal((await cli(['recover', f.file])).value.state, 'uncertain');
  const observation = sent(); delete observation.userMessage.attachmentNames;
  writeFileSync(payload, JSON.stringify(observation));
  assert.equal((await cli(['confirm', f.file, payload])).value.submissionConfirmed, false);
  const inspected = await cli(['inspect', f.file]);
  assert.equal(inspected.value.requiredAttachmentCount, 2);
  assert.equal(inspected.value.needsInspection, true);
  writeFileSync(payload, JSON.stringify(sent()));
  const confirmed = await cli(['confirm', f.file, payload]);
  assert.equal(confirmed.value.attachmentEvidenceConfirmed, true);
  assert.doesNotMatch(confirmed.out + inspected.out, /source-B|근거|private-fixture-token|owned-tab/);
  assert.equal((await cli(['recover', f.file])).value.state, 'submitted');
});

for (const mutation of ['missing requirements', 'empty requirements', 'wrong schema', 'missing saved attachment evidence']) {
  test(`invalid persisted v2 record: ${mutation}`, async t => {
    const f = await started(t);
    await confirmDispatch(f.file, sent());
    const saved = f.ledger();
    if (mutation === 'missing requirements') delete saved.dispatch.requiredAttachments;
    if (mutation === 'empty requirements') saved.dispatch.requiredAttachments = [];
    if (mutation === 'wrong schema') saved.dispatch.version = 1;
    if (mutation === 'missing saved attachment evidence') delete saved.dispatch.confirmation.userMessage.attachmentNames;
    writeFileSync(f.file, JSON.stringify(saved));
    const bytes = f.bytes();
    await assert.rejects(inspectDispatch(f.file), { code: 'DISPATCH_LEDGER' });
    await assert.rejects(recoverDispatch(f.file), { code: 'DISPATCH_LEDGER' });
    assert.deepEqual(f.bytes(), bytes);
  });
}

test('legacy v1 records are not silently upgraded or certified for attachments', async t => {
  const f = fixture(t), input = spec(); delete input.requiredAttachments;
  await registerDispatch(f.file, input);
  const bytes = f.bytes();
  await assert.rejects(registerDispatch(f.file, spec()), { code: 'DISPATCH_CONFLICT' });
  assert.deepEqual(f.bytes(), bytes);
  assert.equal(Object.hasOwn(await inspectDispatch(f.file), 'attachmentEvidenceConfirmed'), false);
});
