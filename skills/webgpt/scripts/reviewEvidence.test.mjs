import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify, inspect } from 'node:util';
import { saveReviewedResult } from './result-export.mjs';
import { buildReviewEvidence, appendReviewEvidence, reviewEvidenceSummary } from './review-evidence.mjs';
import { registerDispatch, beginDispatch, confirmDispatch, recordDispatchReview, inspectDispatchReview,
  dispatchCli, dispatchDiagnostic, textDigest } from './dispatch.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const secret = 'PRIVATE-review-evidence';
const url = 'https://chatgpt.com/c/owned-review-chat';
const prompt = 'Review the assigned fixture';
const now = '2026-10-08T00:00:00.000Z';
const cli = fileURLToPath(new URL('./client.mjs', import.meta.url));
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-review-evidence-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'export'), ledger = join(root, 'ledger.json');
  saveReviewedResult({ id: 'owned', status: 'completed', integrity: 'verified', content: 'report', sha256: hash('report') }, directory);
  fs.writeFileSync(ledger, JSON.stringify({ token: secret, ownership: 'preserve' }));
  const spec = { taskId: 'owned', observationId: 'observation-1', observedAt: now,
    result: { directory, expectedSha256: hash('report'), coverage: 'full', disposition: 'accepted', evidenceRef: secret + '-result' },
    chat: { url, replyToUserMessageId: 'sent-message', turnId: 'turn-1', generation: 'completed', evidenceRef: secret + '-chat',
      message: { id: 'answer-1', role: 'assistant', text: secret + ' 한글 🧪\r\n', truncated: false, substantive: true } },
    comparison: { status: 'consistent', differencesDisposition: 'not_applicable', evidenceRef: secret + '-comparison' } };
  return { root, ledger, directory, spec };
}
async function dispatched(f, state = 'submitted') {
  const target = { tabId: 'owned-tab', chatUrl: null };
  await registerDispatch(f.ledger, { taskId: 'owned', mode: 'pro', prompt, target });
  if (state === 'registered') return;
  const before = { target, mode: 'pro', connectorSelected: true, approvalPending: false, composerSha256: null, lastUserMessageId: null };
  await beginDispatch(f.ledger, { prompt, observation: before });
  if (state === 'sending') return;
  await confirmDispatch(f.ledger, { ...before, target: { ...target, chatUrl: url }, lastUserMessageId: 'sent-message',
    userMessage: { id: 'sent-message', previousId: null, role: 'user', bodySha256: textDigest(prompt) } });
}
const readLedger = f => JSON.parse(fs.readFileSync(f.ledger, 'utf8'));
const uncompare = spec => { spec.comparison = { status: 'not_compared', differencesDisposition: 'not_applicable', evidenceRef: 'pending-comparison' }; };

test('receipt verifies bytes but labels semantic review and browser completion as caller reports', t => {
  const f = fixture(t), receipt = buildReviewEvidence(f.spec), summary = reviewEvidenceSummary(receipt);
  assert.equal(receipt.result.integrity, 'verified-export'); assert.equal(receipt.result.totalChars, 6);
  assert.equal(receipt.chat.message.observedTextSha256, hash(f.spec.chat.message.text));
  assert.equal(receipt.chat.message.observedChars, f.spec.chat.message.text.length);
  assert.ok(!JSON.stringify(receipt).includes(f.directory));
  assert.ok(!JSON.stringify(receipt).includes(f.spec.chat.message.text));
  assert.equal(summary.reportedReviewComplete, true); assert.equal(summary.observationSource, 'caller_reported');
  assert.equal(summary.liveTaskChecked, false); assert.equal(summary.browserChecked, false); assert.equal(summary.authorizesClosure, false);
  assert.equal(summary.status, undefined); assert.equal(summary.collected, undefined);
  assert.ok(!JSON.stringify(summary).includes(secret)); assert.ok(!JSON.stringify(summary).includes(url));
});

test('completed generation and a verified report do not complete a truncated answer review', t => {
  const f = fixture(t); f.spec.chat.message.truncated = true; uncompare(f.spec);
  const summary = reviewEvidenceSummary(buildReviewEvidence(f.spec));
  assert.equal(summary.reportedChatGeneration, 'completed'); assert.equal(summary.chatContentCoverage, 'partial');
  assert.equal(summary.reportedReviewComplete, false); assert.ok(summary.attention.includes('CHAT_CONTENT_PARTIAL'));
  // A pagination signal is not a supported replacement for message truncation evidence.
  f.spec.chat.hasMore = false;
  assert.throws(() => buildReviewEvidence(f.spec), { code: 'REVIEW_EVIDENCE_INPUT' });
});

test('unobserved, pending, interrupted and non-substantive final answers retain their limitations', t => {
  const f = fixture(t);
  for (const generation of ['unobserved', 'pending', 'interrupted', 'completed']) {
    const spec = clone(f.spec); spec.chat.generation = generation; uncompare(spec);
    if (generation === 'unobserved') { spec.chat.turnId = null; spec.chat.message = null; }
    if (generation === 'completed') spec.chat.message.substantive = false;
    const summary = reviewEvidenceSummary(buildReviewEvidence(spec));
    assert.equal(summary.reportedChatGeneration, generation); assert.equal(summary.reportedReviewComplete, false);
  }
});

test('a fully reviewed rejection and explicitly resolved differences are distinct from success', t => {
  const f = fixture(t); f.spec.result.disposition = 'rejected';
  f.spec.comparison = { status: 'differences', differencesDisposition: 'pending', evidenceRef: 'comparison-details' };
  assert.equal(reviewEvidenceSummary(buildReviewEvidence(f.spec)).reportedReviewComplete, false);
  f.spec.comparison.differencesDisposition = 'resolved';
  const summary = reviewEvidenceSummary(buildReviewEvidence(f.spec));
  assert.equal(summary.reportedReviewComplete, true); assert.equal(summary.reportedResultDisposition, 'rejected');
  assert.equal(summary.reportedComparison, 'differences'); assert.equal(summary.authorizesClosure, false);
  f.spec.chat.message.truncated = true;
  assert.throws(() => buildReviewEvidence(f.spec), { code: 'REVIEW_EVIDENCE_INPUT' });
});

test('contradictory or ambiguous claims fail before reading the export', t => {
  const f = fixture(t), mock = t.mock.method(fs, 'lstatSync', () => assert.fail('invalid evidence read files'));
  const mutations = [s => { s.result.coverage = 'partial'; }, s => { delete s.chat.message.truncated; },
    s => { s.chat.message.truncated = true; }, s => { s.chat.message.role = 'tool'; },
    s => { s.chat.message.text = ' \r\n'; }, s => { s.chat.message = null; },
    s => { s.chat.generation = 'pending'; }, s => { s.chat.generation = 'unobserved'; },
    s => { s.chat.message.text = '\ud800'; }, s => { s.observedAt = 'yesterday'; },
    s => { s.result.integrity = 'verified'; }, s => { s.comparison.differencesDisposition = 'resolved'; },
    s => { s.chat.url += '?private=1'; }];
  for (const mutate of mutations) { const spec = clone(f.spec); mutate(spec); assert.throws(() => buildReviewEvidence(spec), { code: 'REVIEW_EVIDENCE_INPUT' }); }
  mock.mock.restore();
});

test('damaged export cannot produce a verified receipt, even with reported full review', t => {
  const f = fixture(t); fs.writeFileSync(join(f.directory, 'message-001.txt'), 'damaged');
  assert.throws(() => buildReviewEvidence(f.spec), error => {
    assert.equal(error.code, 'REVIEW_EVIDENCE_EXPORT'); assert.equal(error.cause, undefined);
    assert.ok(!inspect(error).includes(f.root)); assert.ok(!JSON.stringify(error).includes(secret)); return true;
  });
});

test('record/inspect reuse the private ledger without changing dispatch or lifecycle state', async t => {
  const f = fixture(t); await dispatched(f); const before = readLedger(f);
  const result = await recordDispatchReview(f.ledger, f.spec), after = readLedger(f);
  assert.equal(result.appended, true); assert.equal(result.observationCount, 1); assert.equal(result.review.reportedReviewComplete, true);
  assert.deepEqual(after.dispatch, before.dispatch); assert.equal(after.token, secret); assert.equal(after.ownership, 'preserve');
  assert.equal(after.reviewEvidence.length, 1); assert.equal(after.reviewEvidence[0].chat.url, url);
  assert.equal(result.controllerChanged, false); assert.ok(!JSON.stringify(result).includes(secret));
  const bytes = fs.readFileSync(f.ledger), retry = await recordDispatchReview(f.ledger, f.spec);
  assert.equal(retry.appended, false); assert.deepEqual(fs.readFileSync(f.ledger), bytes);
  assert.equal((await inspectDispatchReview(f.ledger)).review.reportedReviewComplete, true);
  assert.deepEqual(fs.readFileSync(f.ledger), bytes);
});

test('later incomplete evidence remains incomplete and a duplicate old observation cannot replace it', async t => {
  const f = fixture(t); await dispatched(f); await recordDispatchReview(f.ledger, f.spec);
  const later = clone(f.spec); later.observationId = 'observation-2'; later.observedAt = '2026-10-08T00:01:00.000Z';
  later.chat.message.truncated = true; uncompare(later);
  assert.equal((await recordDispatchReview(f.ledger, later)).review.reportedReviewComplete, false);
  const bytes = fs.readFileSync(f.ledger);
  assert.equal((await recordDispatchReview(f.ledger, f.spec)).review.reportedReviewComplete, false);
  assert.deepEqual(fs.readFileSync(f.ledger), bytes); assert.equal(readLedger(f).reviewEvidence.length, 2);
  later.chat.message.text += 'changed';
  await assert.rejects(recordDispatchReview(f.ledger, later)); assert.deepEqual(fs.readFileSync(f.ledger), bytes);
});

test('wrong task/chat/request and unconfirmed dispatches do not record review evidence', async t => {
  for (const state of ['registered', 'sending', 'submitted']) {
    const f = fixture(t); await dispatched(f, state); const before = fs.readFileSync(f.ledger);
    const candidates = state !== 'submitted' ? [f.spec] : [
      { ...f.spec, taskId: 'other' }, { ...f.spec, chat: { ...f.spec.chat, url: 'https://chatgpt.com/c/other' } },
      { ...f.spec, chat: { ...f.spec.chat, replyToUserMessageId: 'other' } }];
    for (const spec of candidates) {
      await assert.rejects(recordDispatchReview(f.ledger, spec)); assert.deepEqual(fs.readFileSync(f.ledger), before);
    }
  }
  const f = fixture(t), before = fs.readFileSync(f.ledger);
  await assert.rejects(recordDispatchReview(f.ledger, f.spec)); assert.deepEqual(fs.readFileSync(f.ledger), before);
});

test('history overflow, stale observations and changed result pins preserve all prior evidence', t => {
  const f = fixture(t), receipt = buildReviewEvidence(f.spec);
  const history = Array.from({ length: 128 }, (_, i) => ({ ...clone(receipt), observationId: `o-${i}` }));
  assert.equal(appendReviewEvidence(history, history[0]).appended, false);
  assert.throws(() => appendReviewEvidence(history, receipt)); assert.equal(history.length, 128);
  for (const change of [r => { r.result.sha256 = '0'.repeat(64); }, r => { r.chat.url = 'https://chatgpt.com/c/other'; },
    r => { r.observedAt = '2026-10-07T00:00:00.000Z'; }]) {
    const later = clone(receipt); later.observationId = 'new'; change(later);
    assert.throws(() => appendReviewEvidence([receipt], later));
  }
  const expanded = { ...clone(receipt), observationId: 'expanded-year', observedAt: '+010000-01-01T00:00:00.000Z' };
  assert.equal(appendReviewEvidence([receipt], expanded).appended, true);
  assert.throws(() => appendReviewEvidence([expanded], receipt));
});

test('invalid retained history and an existing shared lock cannot be overwritten', async t => {
  const f = fixture(t); await dispatched(f); await recordDispatchReview(f.ledger, f.spec);
  const ledger = readLedger(f); ledger.reviewEvidence[0].chat.message.truncated = true;
  fs.writeFileSync(f.ledger, JSON.stringify(ledger)); const bytes = fs.readFileSync(f.ledger);
  await assert.rejects(inspectDispatchReview(f.ledger), { code: 'DISPATCH_LEDGER' });
  await assert.rejects(recordDispatchReview(f.ledger, f.spec), { code: 'DISPATCH_LEDGER' });
  assert.deepEqual(fs.readFileSync(f.ledger), bytes);
  fs.writeFileSync(f.ledger + '.dispatch.lock', 'other-owner');
  await assert.rejects(recordDispatchReview(f.ledger, f.spec), { code: 'DISPATCH_LOCKED' });
  assert.equal(fs.readFileSync(f.ledger + '.dispatch.lock', 'utf8'), 'other-owner');
});

test('CLI records and inspects compact private-safe summaries without controller configuration', async t => {
  const f = fixture(t); await dispatched(f);
  const payload = join(f.root, 'observation.json'); fs.writeFileSync(payload, JSON.stringify(f.spec));
  const run = args => promisify(execFile)(process.execPath, [cli, 'dispatch', ...args], {
    windowsHide: true, timeout: 10000, env: { ...process.env, WEBGPT_CONFIG: join(f.root, 'absent.json') },
  });
  for (const args of [['record-review', f.ledger, payload], ['inspect-review', f.ledger]]) {
    const { stdout, stderr } = await run(args); assert.equal(stderr, ''); assert.ok(stdout.length < 2000);
    assert.equal(JSON.parse(stdout).review.reportedReviewComplete, true);
    for (const privateValue of [secret, f.root, url, 'sent-message']) assert.ok(!stdout.includes(privateValue));
  }
  for (const args of [['record-review', f.ledger], ['inspect-review', f.ledger, payload]]) {
    await assert.rejects(dispatchCli(args), error => {
      const d = dispatchDiagnostic(error); assert.equal(d.stage, 'cli_arguments'); assert.ok(!JSON.stringify(d).includes(f.root)); return true;
    });
  }
});
