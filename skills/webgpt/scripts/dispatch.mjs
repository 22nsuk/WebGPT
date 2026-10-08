// Parent-only browser dispatch bookkeeping. No browser, controller or MCP transport.
// Extend the one private task ledger; completion remains authoritative in the controller.
// Storage and evidence handling: ../references/dispatch-storage.md.
import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { dirname, basename, isAbsolute, join } from 'node:path';
import { readBoundedFile } from './bounded-read.mjs';
import { buildReviewEvidence, appendReviewEvidence, reviewEvidenceSummary } from './review-evidence.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const phases = ['registered', 'prepared', 'sending', 'uncertain', 'submitted'];
const reasons = ['send_unconfirmed', 'observation_unavailable', 'evidence_unconfirmed', 'interrupted'];
const messages = {
  INPUT: 'invalid private dispatch input', OBSERVATION: 'invalid bounded dispatch observation',
  LEDGER: 'invalid dispatch ledger; preserve it for inspection', STORAGE: 'dispatch storage unavailable; inspect private files',
  LOCKED: 'dispatch ledger locked; inspect the owner, never steal by age',
  CONFLICT: 'dispatch ledger changed outside its lock; preserve it for inspection',
  BLOCKED: 'dispatch already attempted; inspect the retained chat and controller, do not resend',
  NOT_READY: 'dispatch UI is not ready or does not match the owned target',
  ATTACHMENTS: 'required attachments need split begin/upload/send/confirm; no browser action was attempted',
  RUNTIME: 'dispatch requires ordinary Node CLI; keep browser operations in authorized browser tools',
  INTERNAL: 'dispatch operation failed; preserve the ledger and inspect before continuing',
};
const defaults = {
  INPUT: ['input', 'invalid_input'], OBSERVATION: ['observation', 'invalid_observation'],
  LEDGER: ['ledger_validate', 'invalid_ledger'], STORAGE: ['ledger_read', 'io_failed'],
  LOCKED: ['lock_acquire', 'lock_exists'], CONFLICT: ['ledger_update', 'ledger_changed'],
  BLOCKED: ['ledger_update', 'resend_blocked'], NOT_READY: ['observation', 'ui_not_ready'],
  ATTACHMENTS: ['input', 'attachment_workflow_required'],
  RUNTIME: ['runtime_preflight', 'node_cli_required'], INTERNAL: ['ledger_update', 'unexpected_failure'],
};
const storageStages = ['payload_read', 'ledger_path', 'lock_acquire', 'ledger_read', 'ledger_write',
  'ledger_publish'];
const cliActions = ['preflight', 'inspect', 'recover', 'register', 'prepare', 'begin', 'confirm', 'record-review', 'inspect-review'];
const cliReasons = ['arguments_invalid', 'ledger_path_invalid', 'payload_path_invalid', 'payload_missing',
  'payload_file_invalid', 'payload_utf8_invalid', 'payload_json_invalid', 'input_shape_invalid', 'input_invalid'];
const diagnosticStages = new Set([...Object.values(defaults).map(([stage]) => stage), ...storageStages,
  'lock_release', 'cli_arguments', 'payload_decode', 'payload_validate']);
const diagnosticReasons = new Set([...Object.values(defaults).map(([, reason]) => reason),
  'not_found', 'permission_denied', 'storage_full', 'native_path_not_utf8', 'lock_owner_changed', 'lock_release_failed',
  'invalid_arguments', 'unknown_action', ...cliActions.flatMap(action => cliReasons.map(reason => action + '_' + reason))]);
const diagnostics = new WeakMap();
class DispatchError extends Error {
  constructor(code, stage = defaults[code][0], reason = defaults[code][1]) {
    super(messages[code]);
    this.code = 'DISPATCH_' + code;
    this.stage = diagnosticStages.has(stage) ? stage : defaults[code][0];
    this.reason = diagnosticReasons.has(reason) ? reason : defaults[code][1];
    diagnostics.set(this, { code: this.code, stage: this.stage, reason: this.reason, message: this.message });
  }
}
const fail = code => { throw new DispatchError(code); };
// Never trust caller-supplied Error fields or copy raw exception/cause/stack into public output.
export function dispatchDiagnostic(error) {
  return { ...(diagnostics.get(error) ?? diagnostics.get(new DispatchError('INTERNAL'))) };
}
const storageError = (error, stage) => new DispatchError('STORAGE', stage,
  ({ ENOENT: 'not_found', EACCES: 'permission_denied', EPERM: 'permission_denied', ENOSPC: 'storage_full' })[error?.code] ?? 'io_failed');

// Call before controller registration. No paths, configuration, controller access or ledger I/O.
export function preflightDispatchRuntime() {
  if (typeof process !== 'object' || process === null || typeof process.versions?.node !== 'string'
      || !Number.isSafeInteger(process.pid) || process.pid < 1
      || typeof Buffer === 'undefined' || typeof Buffer.from !== 'function' || typeof Buffer.byteLength !== 'function'
      || typeof TextDecoder !== 'function' || typeof String.prototype.isWellFormed !== 'function') fail('RUNTIME');
  return { runtime: 'node', ready: true };
}
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const opaque = v => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\x00-\x20\x7f]/.test(v) && v.isWellFormed();
const messageId = v => v === null || opaque(v);
// Share identity rules between stored evidence and new CLI input without relabeling ledger failures.
const validDispatchIdentity = d => typeof d.taskId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(d.taskId)
  && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(d.taskId) && ['pro', 'xhigh'].includes(d.mode);
const keys = (v, required, optional = [], code = 'INPUT') => {
  if (!record(v) || required.some(k => !Object.hasOwn(v, k))
      || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) fail(code);
};
const now = () => new Date().toISOString();

// Compare the visible body, not a connector chip. Only normalize line endings and edge whitespace.
export function textDigest(text) {
  if (typeof text !== 'string' || !text.isWellFormed() || Buffer.byteLength(text) > MAX_BYTES) fail('INPUT');
  const body = text.replace(/\r\n?/g, '\n').trim();
  if (!body || /^@?WebGPT\s+Worker\s*$/i.test(body)) fail('INPUT');
  return hash(body);
}

function target(value, code = 'INPUT') {
  keys(value, ['tabId', 'chatUrl'], [], code);
  if (!opaque(value.tabId)) fail(code);
  if (value.chatUrl !== null) {
    if (typeof value.chatUrl !== 'string' || value.chatUrl.length > 2048) fail(code);
    let url;
    try { url = new URL(value.chatUrl); } catch { fail(code); }
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password || url.search || url.hash
        || !/^\/(?:g\/[a-zA-Z0-9_-]+\/)?c\/[a-zA-Z0-9-]+$/.test(url.pathname)
        || url.href !== value.chatUrl) fail(code);
  }
  return { tabId: value.tabId, chatUrl: value.chatUrl };
}
const sameTarget = (a, b) => a.tabId === b.tabId && a.chatUrl === b.chatUrl;

// Visible basenames, not local paths or byte-integrity claims. These are local
// evidence bounds, not a statement of any browser/provider upload limit.
function attachmentNames(value, code, required = false) {
  if (!Array.isArray(value) || value.length > 32 || (required && !value.length)
      || Array.from(value).some(name => typeof name !== 'string' || !name.isWellFormed() || !name.trim()
        || name !== name.trim() || Buffer.byteLength(name) > 255 || /[\/\\\x00-\x1f\x7f]/.test(name)
        || name === '.' || name === '..') || new Set(value).size !== value.length) fail(code);
  return [...value].sort();
}
const sameAttachments = (a, b) => a.length === b.length && a.every(name => b.includes(name));

// Unknown fields fail rather than allowing a transcript, raw error or arbitrary metadata to escape.
function validateObservation(value, confirmation = false, attachmentsRequired = false) {
  const fields = ['target', 'mode', 'connectorSelected', 'approvalPending', 'composerSha256', 'lastUserMessageId'];
  keys(value, confirmation ? [...fields, 'userMessage'] : fields, [], 'OBSERVATION');
  target(value.target, 'OBSERVATION');
  if (!['pro', 'xhigh'].includes(value.mode) || typeof value.connectorSelected !== 'boolean'
      || typeof value.approvalPending !== 'boolean' || !messageId(value.lastUserMessageId)
      || (value.composerSha256 !== null && !digest(value.composerSha256))) fail('OBSERVATION');
  if (confirmation) {
    const message = value.userMessage;
    keys(message, ['id', 'previousId', 'role', 'bodySha256', ...(attachmentsRequired ? ['attachmentNames'] : [])], [], 'OBSERVATION');
    if (attachmentsRequired) attachmentNames(message.attachmentNames, 'OBSERVATION');
    if (!opaque(message.id) || !messageId(message.previousId) || message.role !== 'user'
        || !digest(message.bodySha256)) fail('OBSERVATION');
  }
  // Detach caller objects: asynchronous browser work must not change the saved baseline by reference.
  return JSON.parse(JSON.stringify(value));
}

function validateDispatch(d) {
  keys(d, ['version', 'taskId', 'mode', 'connectorRequired', 'promptSha256', 'target', 'state', 'registeredAt'],
    ['before', 'preparedAt', 'sendingAt', 'uncertainAt', 'submittedAt', 'confirmation', 'reason', 'requiredAttachments'], 'LEDGER');
  if (![1, 2].includes(d.version) || (d.version === 2) !== Object.hasOwn(d, 'requiredAttachments')
      || !validDispatchIdentity(d) || typeof d.connectorRequired !== 'boolean'
      || !digest(d.promptSha256) || !phases.includes(d.state)) fail('LEDGER');
  if (d.version === 2) attachmentNames(d.requiredAttachments, 'LEDGER', true);
  target(d.target, 'LEDGER');
  for (const key of ['registeredAt', 'preparedAt', 'sendingAt', 'uncertainAt', 'submittedAt']) {
    if (key in d && (typeof d[key] !== 'string' || !Number.isFinite(Date.parse(d[key])))) fail('LEDGER');
  }
  const attempted = ['sending', 'uncertain', 'submitted'].includes(d.state);
  const requiredAtPhase = { before: d.state !== 'registered', preparedAt: d.state !== 'registered',
    sendingAt: attempted, confirmation: d.state === 'submitted', submittedAt: d.state === 'submitted',
    reason: d.state === 'uncertain', uncertainAt: d.state === 'uncertain' };
  if (Object.entries(requiredAtPhase).some(([key, required]) => required !== Object.hasOwn(d, key))) fail('LEDGER');
  if (d.reason !== undefined && !reasons.includes(d.reason)) fail('LEDGER');
  try {
    if (Object.hasOwn(d, 'before')) assertReady(d, validateObservation(d.before));
    if (Object.hasOwn(d, 'confirmation')) assertEvidence(d, validateObservation(d.confirmation, true, d.version === 2));
  } catch { fail('LEDGER'); }
  return d;
}

function safeSummary(d) {
  return { state: d.state, mode: d.mode, connectorRequired: d.connectorRequired,
    uiPrepared: Boolean(d.before), submissionConfirmed: d.state === 'submitted',
    resendBlocked: ['sending', 'uncertain', 'submitted'].includes(d.state),
    needsInspection: ['sending', 'uncertain'].includes(d.state), reason: d.reason ?? null,
    ...(d.version === 2 ? { requiredAttachmentCount: d.requiredAttachments.length,
      attachmentEvidenceConfirmed: d.state === 'submitted' } : {}) };
}

function fileInfo(file) {
  try { return lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function canonicalLedgerPath(file) {
  // The JS resolver can replace symlink bytes even when its output encoding is 'buffer'.
  const bytes = realpathSync.native(file, { encoding: 'buffer' });
  if (!isUtf8(bytes)) throw new DispatchError('LEDGER', 'ledger_path', 'native_path_not_utf8');
  return bytes.toString('utf8');
}
function readBytes(file) {
  return readBoundedFile(file, MAX_BYTES, () => new DispatchError('LEDGER'))?.bytes ?? null;
}
function createPrivateFile(file, bytes, stage) {
  // On Windows, do not even attempt exclusive creation through a known dangling
  // link. O_EXCL still handles a cooperative creator arriving after this check.
  if (fileInfo(file)) throw Object.assign(Error('private dispatch file already exists'), { code: 'EEXIST' });
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let opened;
  try {
    opened = fstatSync(fd, { bigint: true });
    writeFileSync(fd, bytes); fsyncSync(fd);
  } finally { closeSync(fd); }
  // Bind success to the file actually flushed, not just its reusable pathname.
  // Both lock acquisition and ledger replacement must stop on changed evidence.
  const current = lstatSync(file, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n
      || current.dev !== opened.dev || current.ino !== opened.ino
      || current.size !== BigInt(Buffer.byteLength(bytes))) throw new DispatchError('CONFLICT', stage);
  // A failed create/write/flush is not permission to unlink this path. Preserve
  // unknown or partial evidence; only the caller's successful rename consumes it.
}
function parseLedger(bytes) {
  if (bytes === null) return {};
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('LEDGER'); }
  if (!record(value)) fail('LEDGER');
  if (Object.hasOwn(value, 'dispatch')) validateDispatch(value.dispatch);
  return value;
}

async function withLedger(file, work) {
  preflightDispatchRuntime();
  let lock, owner, acquired = false;
  let stage = 'input';
  try {
    if (typeof file !== 'string' || !file.isWellFormed() || !isAbsolute(file) || !file.endsWith('.json')) fail('INPUT');
    // Canonicalize native aliases (including existing filenames) without following a linked ledger.
    // Do not create directories or change ACLs. Every parent must use the same canonical ledger.
    stage = 'ledger_path';
    file = join(canonicalLedgerPath(dirname(file)), basename(file));
    const candidate = fileInfo(file);
    if (candidate) {
      if (!candidate.isFile() || candidate.isSymbolicLink()) fail('LEDGER');
      file = canonicalLedgerPath(file);
    }
    // A publisher may replace the inode during the path lookup above. Validate
    // link count, size and opened identity only after acquiring its shared lock.
    lock = file + '.dispatch.lock';
    owner = JSON.stringify({ pid: process.pid, instanceId: randomUUID() });
    stage = 'lock_acquire';
    try { createPrivateFile(lock, owner, stage); acquired = true; }
    catch (e) { if (e.code === 'EEXIST') fail('LOCKED'); throw e; }
    stage = 'ledger_read';
    let previous = readBytes(file);
    stage = 'ledger_validate';
    const ledger = parseLedger(previous);
    const save = () => {
      stage = 'ledger_validate';
      validateDispatch(ledger.dispatch);
      const bytes = Buffer.from(JSON.stringify(ledger, null, 2) + '\n');
      if (bytes.length > MAX_BYTES) fail('LEDGER');
      stage = 'ledger_read';
      const current = readBytes(file);
      if ((current === null) !== (previous === null) || (current && !current.equals(previous))) fail('CONFLICT');
      const temporary = file + '.tmp-' + randomUUID();
      stage = 'ledger_write';
      createPrivateFile(temporary, bytes, stage);
      stage = 'ledger_publish';
      renameSync(temporary, file);
      previous = bytes;
      stage = 'ledger_update';
    };
    stage = 'ledger_update';
    return await work(ledger, save);
  } catch (error) {
    // No paths, browser messages, prompt fragments, request tokens or raw causes in public errors.
    throw error instanceof DispatchError ? error
      : storageStages.includes(stage) ? storageError(error, stage) : new DispatchError('INTERNAL', stage);
  } finally {
    if (acquired) {
      try {
        const current = readBytes(lock);
        if (current?.toString('utf8') !== owner) throw new DispatchError('LOCKED', 'lock_release', 'lock_owner_changed');
        unlinkSync(lock);
      } catch (error) {
        throw error instanceof DispatchError && error.stage === 'lock_release' ? error
          : new DispatchError('LOCKED', 'lock_release', 'lock_release_failed');
      }
    }
  }
}
const getDispatch = ledger => ledger.dispatch ?? fail('LEDGER');

export async function registerDispatch(file, spec) {
  return withLedger(file, (ledger, save) => {
    keys(spec, ['taskId', 'mode', 'prompt', 'target'], ['connectorRequired', 'requiredAttachments']);
    if (Object.hasOwn(spec, 'connectorRequired') && typeof spec.connectorRequired !== 'boolean') fail('INPUT');
    const required = Object.hasOwn(spec, 'requiredAttachments') ? attachmentNames(spec.requiredAttachments, 'INPUT', true) : null;
    const d = { version: required ? 2 : 1, ...(required ? { requiredAttachments: required } : {}),
      taskId: spec.taskId, mode: spec.mode, connectorRequired: spec.connectorRequired ?? true,
      promptSha256: textDigest(spec.prompt), target: target(spec.target), state: 'registered', registeredAt: now() };
    validateDispatch(d);
    if (Object.hasOwn(ledger, 'dispatch')) {
      const prior = ledger.dispatch;
      if (['version', 'taskId', 'mode', 'connectorRequired', 'promptSha256'].some(k => prior[k] !== d[k])
          || !sameTarget(prior.target, d.target)
          || (required && !sameAttachments(prior.requiredAttachments, required))) fail('CONFLICT');
      return safeSummary(prior); // Registration idempotency never resets a send attempt.
    }
    ledger.dispatch = d;
    save();
    return safeSummary(d);
  });
}

function assertReady(d, before) {
  if (!sameTarget(d.target, before.target) || d.mode !== before.mode || before.approvalPending
      || (d.connectorRequired && !before.connectorSelected)
      || (before.composerSha256 !== null && before.composerSha256 !== d.promptSha256)
      || (d.target.chatUrl === null && before.lastUserMessageId !== null)) fail('NOT_READY');
}
// Assemble readiness once; the requested operation owns its publication barrier.
function prepare(ledger, observation) {
  const d = getDispatch(ledger);
  if (!['registered', 'prepared'].includes(d.state)) fail('BLOCKED');
  const before = validateObservation(observation);
  assertReady(d, before);
  Object.assign(d, { state: 'prepared', before, preparedAt: now() });
  return d;
}
export async function prepareDispatch(file, observation) {
  return withLedger(file, (ledger, save) => {
    const d = prepare(ledger, observation);
    save(); // Explicit preparation remains an independently persisted checkpoint.
    return safeSummary(d);
  });
}
function begin(ledger, save, prompt, observation) {
  const d = getDispatch(ledger);
  if (!['registered', 'prepared'].includes(d.state)) fail('BLOCKED');
  if (textDigest(prompt) !== d.promptSha256) fail('INPUT');
  prepare(ledger, observation);
  // No browser action or externally useful checkpoint separates preparation
  // from begin. Publish their evidence together, not two consecutive snapshots.
  d.state = 'sending';
  d.sendingAt = now();
  save(); // Must succeed before the first browser operation that can submit a message.
  return d;
}
export async function beginDispatch(file, input) {
  return withLedger(file, (ledger, save) => {
    keys(input, ['prompt', 'observation']);
    return safeSummary(begin(ledger, save, input.prompt, input.observation));
  });
}

function assertEvidence(d, observed) {
  const message = observed.userMessage;
  if (observed.target.tabId !== d.target.tabId || observed.target.chatUrl === null
      || (d.target.chatUrl !== null && observed.target.chatUrl !== d.target.chatUrl)
      || observed.mode !== d.mode || observed.approvalPending || (d.connectorRequired && !observed.connectorSelected)
      || observed.composerSha256 !== null || observed.lastUserMessageId !== message.id
      || message.id === d.before.lastUserMessageId || message.previousId !== d.before.lastUserMessageId
      || message.bodySha256 !== d.promptSha256
      || (d.version === 2 && !sameAttachments(d.requiredAttachments, message.attachmentNames))) fail('OBSERVATION');
}
function uncertain(d, save, reason) {
  d.state = 'uncertain';
  d.reason = reason;
  d.uncertainAt = now();
  save();
  return safeSummary(d);
}
function confirm(d, save, observation) {
  if (!['sending', 'uncertain', 'submitted'].includes(d.state)) fail('BLOCKED');
  let observed;
  try { observed = validateObservation(observation, true, d.version === 2); assertEvidence(d, observed); }
  catch {
    if (d.state === 'submitted') fail('BLOCKED');
    return uncertain(d, save, 'evidence_unconfirmed');
  }
  if (d.state === 'submitted') {
    if (d.confirmation.userMessage.id !== observed.userMessage.id) fail('BLOCKED');
    return safeSummary(d);
  }
  Object.assign(d, { state: 'submitted', confirmation: observed, submittedAt: now() });
  delete d.reason;
  delete d.uncertainAt;
  save();
  return safeSummary(d);
}
export async function confirmDispatch(file, observation) {
  return withLedger(file, (ledger, save) => confirm(getDispatch(ledger), save, observation));
}
export async function recoverDispatch(file) {
  return withLedger(file, (ledger, save) => {
    const d = getDispatch(ledger);
    return d.state === 'sending' ? uncertain(d, save, 'interrupted') : safeSummary(d);
  });
}
export async function inspectDispatch(file) {
  return withLedger(file, ledger => safeSummary(getDispatch(ledger)));
}

function reviewTarget(d, receipt) {
  if (d.state !== 'submitted' || receipt.taskId !== d.taskId
      || receipt.chat.url !== d.confirmation.target.chatUrl
      || receipt.chat.replyToUserMessageId !== d.confirmation.userMessage.id) fail('INPUT');
}
function retainedReviews(ledger) {
  if (!Object.hasOwn(ledger, 'reviewEvidence')) return [];
  const entries = ledger.reviewEvidence;
  try {
    if (!Array.isArray(entries) || entries.length === 0) fail('LEDGER');
    appendReviewEvidence(entries, entries.at(-1));
    for (const entry of entries) reviewTarget(getDispatch(ledger), entry);
  } catch { fail('LEDGER'); }
  return entries;
}
const reviewSummary = (entries, appended = false) => ({ observationCount: entries.length, appended,
  review: entries.length ? reviewEvidenceSummary(entries.at(-1)) : null,
  controllerChanged: false, browserChecked: false });

// Same private ledger and lock; this operation never mutates dispatch or controller state.
export async function recordDispatchReview(file, spec) {
  return withLedger(file, (ledger, save) => {
    const d = getDispatch(ledger), entries = retainedReviews(ledger);
    // Reject another task/chat before opening its export. Null initial chat URLs
    // are bound by the actual confirmed user message, not the original new tab.
    if (!record(spec) || !record(spec.chat)) fail('INPUT');
    reviewTarget(d, spec);
    let receipt, update;
    try { receipt = buildReviewEvidence(spec); update = appendReviewEvidence(entries, receipt); }
    catch { fail('INPUT'); }
    if (update.appended) { ledger.reviewEvidence = update.entries; save(); }
    return reviewSummary(update.entries, update.appended);
  });
}
export async function inspectDispatchReview(file) {
  return withLedger(file, ledger => { getDispatch(ledger); return reviewSummary(retainedReviews(ledger)); });
}

// Task-bound, allowlisted evidence for the parent verification workflow. This
// validates recorded observations, not the current browser or result quality.
export async function inspectDispatchEvidence(file, taskId) {
  return withLedger(file, ledger => {
    const d = getDispatch(ledger);
    if (d.taskId !== taskId) fail('INPUT');
    const elapsed = (from, to) => {
      const value = Date.parse(d[to]) - Date.parse(d[from]);
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    return { ...safeSummary(d), timingSource: 'recorded_wall_clock', timingMs: {
      preparation: elapsed('registeredAt', 'preparedAt'),
      readyToSend: elapsed('preparedAt', 'sendingAt'),
      confirmation: elapsed('sendingAt', 'submittedAt'),
    } };
  });
}

// The adapter must use existing authorized browser tools. No browser SDK/private session is supplied.
// fillAndSend replaces/inserts the prepared body once and sends in one supported tool call,
// checking the composer/body, connector and Send readiness within that call; never appending/retrying.
export async function dispatchPrompt(file, prompt, adapter) {
  return withLedger(file, async (ledger, save) => {
    keys(adapter, ['observeReady', 'fillAndSend', 'observeSent']);
    if (Object.values(adapter).some(fn => typeof fn !== 'function')) fail('INPUT');
    const d = getDispatch(ledger);
    if (!['registered', 'prepared'].includes(d.state)) fail('BLOCKED');
    if (textDigest(prompt) !== d.promptSha256) fail('INPUT');
    // Uploads must follow a durable split begin, never this body's auto-send path.
    if (d.version === 2) fail('ATTACHMENTS');
    let before;
    try { before = await adapter.observeReady(); } catch { fail('OBSERVATION'); }
    begin(ledger, save, prompt, before);
    try { await adapter.fillAndSend(prompt); }
    catch { return uncertain(d, save, 'send_unconfirmed'); }
    let observed;
    try { observed = await adapter.observeSent(); }
    catch { return uncertain(d, save, 'observation_unavailable'); }
    return confirm(d, save, observed);
  });
}

// Used by client.mjs; payload/ledger paths stay private and no controller command is changed.
export async function dispatchCli(args) {
  preflightDispatchRuntime();
  try {
    if (!Array.isArray(args) || !args.length || Array.from(args).some(value => typeof value !== 'string'))
      throw new DispatchError('INPUT', 'cli_arguments', 'invalid_arguments');
    const [action, file, payloadFile] = args;
    if (!cliActions.includes(action)) throw new DispatchError('INPUT', 'cli_arguments', 'unknown_action');
    // Only a fixed, validated action can enter a public reason. No supplied values are copied.
    const inputError = (reason, stage) => new DispatchError('INPUT', stage, action + '_' + reason);
    const noPayload = { inspect: inspectDispatch, recover: recoverDispatch, 'inspect-review': inspectDispatchReview };
    const withPayload = { register: registerDispatch, prepare: prepareDispatch, begin: beginDispatch, confirm: confirmDispatch,
      'record-review': recordDispatchReview };
    const count = action === 'preflight' ? 1 : Object.hasOwn(noPayload, action) ? 2 : 3;
    if (args.length !== count) throw inputError('arguments_invalid', 'cli_arguments');
    if (action === 'preflight') return preflightDispatchRuntime();
    if (!file.isWellFormed() || !isAbsolute(file) || !file.endsWith('.json')) throw inputError('ledger_path_invalid', 'cli_arguments');
    if (Object.hasOwn(noPayload, action)) return await noPayload[action](file);
    if (!payloadFile.isWellFormed() || !isAbsolute(payloadFile)) throw inputError('payload_path_invalid', 'cli_arguments');
    let bytes;
    try { bytes = readBytes(payloadFile); }
    catch (error) {
      if (diagnostics.get(error)?.code === 'DISPATCH_LEDGER') throw inputError('payload_file_invalid', 'payload_read');
      throw error instanceof DispatchError ? error : storageError(error, 'payload_read');
    }
    if (bytes === null) throw inputError('payload_missing', 'payload_read');
    let text, payload;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw inputError('payload_utf8_invalid', 'payload_decode'); }
    try { payload = JSON.parse(text); }
    catch { throw inputError('payload_json_invalid', 'payload_decode'); }
    // Reject routing-envelope mistakes before acquiring a ledger lock. The core
    // validators still own UI readiness, persisted state and send safety.
    try {
      if (action === 'register') keys(payload, ['taskId', 'mode', 'prompt', 'target'], ['connectorRequired', 'requiredAttachments']);
      if (action === 'begin') keys(payload, ['prompt', 'observation']);
    } catch { throw inputError('input_shape_invalid', 'payload_validate'); }
    if (action === 'register' && !validDispatchIdentity(payload))
      throw inputError('input_invalid', 'payload_validate');
    // Do not prevalidate confirm observations: decodable but incomplete evidence
    // must still persist uncertain (or refuse downgrading submitted), not bypass it.
    try { return await withPayload[action](file, payload); }
    catch (error) {
      const trusted = diagnostics.get(error);
      if (trusted?.code === 'DISPATCH_INPUT' || trusted?.code === 'DISPATCH_OBSERVATION')
        throw new DispatchError(trusted.code.slice('DISPATCH_'.length), 'payload_validate', action + '_input_invalid');
      throw error;
    }
  } catch (error) {
    throw error instanceof DispatchError ? error : new DispatchError('INPUT');
  }
}
