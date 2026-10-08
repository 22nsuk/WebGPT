// Parent observations are evidence bookkeeping, never controller or browser authority.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readSavedResult } from './result-export-read.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const invalid = () => Object.assign(Error('invalid private review evidence; preserve prior observations'), { code: 'REVIEW_EVIDENCE_INPUT' });
const requireValue = value => { if (!value) throw invalid(); };
const text = (value, max = 512) => typeof value === 'string' && value.isWellFormed()
  && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value, fields) => requireValue(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)));
function chatUrl(value) {
  requireValue(text(value, 2048));
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  requireValue(url.origin === 'https://chatgpt.com' && !url.username && !url.password && !url.search && !url.hash
    && /^\/(?:g\/[a-zA-Z0-9_-]+\/)?c\/[a-zA-Z0-9-]+$/.test(url.pathname) && url.href === value);
}

function validateReceipt(value) {
  object(value, ['kind', 'version', 'taskId', 'observationId', 'observedAt', 'result', 'chat', 'comparison']);
  requireValue(value.kind === 'webgpt-review-evidence' && value.version === 1
    && typeof value.taskId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.taskId)
    && text(value.observationId, 128) && typeof value.observedAt === 'string'
    && Number.isFinite(Date.parse(value.observedAt)) && new Date(value.observedAt).toISOString() === value.observedAt);
  const r = value.result;
  object(r, ['sha256', 'totalChars', 'integrity', 'reportedCoverage', 'reportedDisposition', 'evidenceRef']);
  requireValue(digest(r.sha256) && Number.isSafeInteger(r.totalChars) && r.totalChars >= 0 && r.totalChars <= 1024 * 1024
    && r.integrity === 'verified-export' && ['not_read', 'partial', 'full'].includes(r.reportedCoverage)
    && ['pending', 'accepted', 'rejected', 'partial'].includes(r.reportedDisposition) && text(r.evidenceRef));
  requireValue(r.reportedDisposition !== 'accepted' || r.reportedCoverage === 'full');
  requireValue(r.reportedCoverage !== 'not_read' || r.reportedDisposition === 'pending');
  const c = value.chat;
  object(c, ['url', 'replyToUserMessageId', 'turnId', 'generation', 'evidenceRef', 'message']);
  chatUrl(c.url);
  requireValue(text(c.replyToUserMessageId) && (c.turnId === null || text(c.turnId)) && text(c.evidenceRef)
    && ['unobserved', 'pending', 'completed', 'interrupted'].includes(c.generation));
  const m = c.message;
  if (m !== null) {
    object(m, ['id', 'observedTextSha256', 'observedChars', 'truncated', 'reportedSubstantive']);
    requireValue(text(m.id) && digest(m.observedTextSha256) && Number.isSafeInteger(m.observedChars) && m.observedChars >= 0 && m.observedChars <= 65536
      && typeof m.truncated === 'boolean' && typeof m.reportedSubstantive === 'boolean' && c.turnId !== null);
    requireValue(m.observedChars !== 0 || m.reportedSubstantive === false);
  }
  requireValue(c.generation !== 'unobserved' || (m === null && c.turnId === null));
  requireValue(c.generation !== 'completed' || c.turnId !== null);
  object(value.comparison, ['reportedStatus', 'differencesDisposition', 'evidenceRef']);
  requireValue(['not_compared', 'consistent', 'differences'].includes(value.comparison.reportedStatus)
    && text(value.comparison.evidenceRef));
  requireValue(value.comparison.reportedStatus === 'differences'
    ? ['pending', 'resolved'].includes(value.comparison.differencesDisposition)
    : value.comparison.differencesDisposition === 'not_applicable');
  // A prefix may expose differences, but cannot establish whole-answer consistency.
  if (value.comparison.reportedStatus !== 'not_compared') requireValue(m !== null && r.reportedCoverage !== 'not_read');
  if (value.comparison.reportedStatus === 'consistent' || value.comparison.differencesDisposition === 'resolved') requireValue(r.reportedCoverage === 'full'
    && c.generation === 'completed' && m !== null && !m.truncated && m.reportedSubstantive);
  return value;
}

export function reviewEvidenceSummary(receipt) {
  validateReceipt(receipt);
  const r = receipt.result, c = receipt.chat, m = c.message;
  const chatCoverage = m === null || m.observedChars === 0 ? 'unobserved' : m.truncated ? 'partial' : 'full';
  const attention = [];
  if (r.reportedCoverage !== 'full') attention.push('RESULT_REVIEW_INCOMPLETE');
  if (r.reportedDisposition === 'pending') attention.push('RESULT_DISPOSITION_PENDING');
  if (c.generation !== 'completed') attention.push('CHAT_GENERATION_' + c.generation.toUpperCase());
  if (chatCoverage !== 'full') attention.push('CHAT_CONTENT_' + chatCoverage.toUpperCase());
  if (!m?.reportedSubstantive) attention.push('CHAT_SUBSTANTIVE_UNCONFIRMED');
  if (receipt.comparison.reportedStatus !== 'consistent' && receipt.comparison.differencesDisposition !== 'resolved') attention.push(receipt.comparison.reportedStatus === 'differences'
    ? 'RESULT_CHAT_DIFFERENCES' : 'RESULT_CHAT_NOT_COMPARED');
  return { resultIntegrity: 'verified-export', reportedResultCoverage: r.reportedCoverage,
    reportedResultDisposition: r.reportedDisposition, reportedChatGeneration: c.generation,
    chatContentCoverage: chatCoverage, reportedComparison: receipt.comparison.reportedStatus,
    reportedDifferencesDisposition: receipt.comparison.differencesDisposition,
    reportedReviewComplete: attention.length === 0, attention,
    observationSource: 'caller_reported', liveTaskChecked: false, browserChecked: false,
    authorizesClosure: false };
}

// Verify the saved package now, but do not equate reading bytes with a parent's review.
// Raw answer text and private paths are excluded from the stored receipt and summary.
export function buildReviewEvidence(spec) {
  object(spec, ['taskId', 'observationId', 'observedAt', 'result', 'chat', 'comparison']);
  object(spec.result, ['directory', 'expectedSha256', 'coverage', 'disposition', 'evidenceRef']);
  object(spec.chat, ['url', 'replyToUserMessageId', 'turnId', 'generation', 'evidenceRef', 'message']);
  let message = null;
  if (spec.chat.message !== null) {
    const m = spec.chat.message;
    object(m, ['id', 'role', 'text', 'truncated', 'substantive']);
    requireValue(m.role === 'assistant' && typeof m.text === 'string' && m.text.isWellFormed() && m.text.length <= 65536);
    message = { id: m.id, observedTextSha256: hash(m.text), observedChars: m.text.length, truncated: m.truncated, reportedSubstantive: m.substantive };
    requireValue(m.text.trim().length > 0 || !m.substantive);
  }
  object(spec.comparison, ['status', 'differencesDisposition', 'evidenceRef']);
  const receipt = { kind: 'webgpt-review-evidence', version: 1, taskId: spec.taskId,
    observationId: spec.observationId, observedAt: spec.observedAt,
    result: { sha256: spec.result.expectedSha256, totalChars: 0, integrity: 'verified-export',
      reportedCoverage: spec.result.coverage, reportedDisposition: spec.result.disposition, evidenceRef: spec.result.evidenceRef },
    chat: { url: spec.chat.url, replyToUserMessageId: spec.chat.replyToUserMessageId, turnId: spec.chat.turnId,
      generation: spec.chat.generation, evidenceRef: spec.chat.evidenceRef, message },
    comparison: { reportedStatus: spec.comparison.status, differencesDisposition: spec.comparison.differencesDisposition,
      evidenceRef: spec.comparison.evidenceRef } };
  validateReceipt(receipt); // Shape/contradiction failures precede export filesystem access.
  let page;
  try { page = readSavedResult(spec.result.directory, { taskId: spec.taskId, expectedSha256: spec.result.expectedSha256 }); }
  catch { throw Object.assign(Error('review evidence requires the complete pinned export'), { code: 'REVIEW_EVIDENCE_EXPORT' }); }
  receipt.result.totalChars = page.totalChars;
  return receipt;
}

// Bounded append-only observations; retries cannot overwrite an observation or hide a regression.
export function appendReviewEvidence(previous, receipt) {
  validateReceipt(receipt);
  const entries = previous === undefined ? [] : previous;
  requireValue(Array.isArray(entries) && entries.length <= 128);
  for (const entry of entries) validateReceipt(entry);
  requireValue(new Set(entries.map(entry => entry.observationId)).size === entries.length);
  requireValue(entries.every((entry, i) => i === 0 || Date.parse(entry.observedAt) >= Date.parse(entries[i - 1].observedAt)));
  requireValue(entries.every(entry => entry.taskId === receipt.taskId && entry.result.sha256 === receipt.result.sha256
    && entry.result.totalChars === receipt.result.totalChars
    && entry.chat.url === receipt.chat.url && entry.chat.replyToUserMessageId === receipt.chat.replyToUserMessageId));
  const duplicate = entries.find(entry => entry.observationId === receipt.observationId);
  if (duplicate) { requireValue(isDeepStrictEqual(duplicate, receipt)); return { entries, appended: false }; }
  requireValue(entries.length < 128 && (!entries.length || Date.parse(receipt.observedAt) >= Date.parse(entries.at(-1).observedAt)));
  return { entries: [...entries, receipt], appended: true };
}
