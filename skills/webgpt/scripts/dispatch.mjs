// Parent-only browser dispatch bookkeeping. No browser, controller or MCP transport.
// Extend the one private task ledger; completion remains authoritative in the controller.
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { dirname, basename, isAbsolute, join } from 'node:path';

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
};
class DispatchError extends Error {
  constructor(code) { super(messages[code]); this.code = 'DISPATCH_' + code; }
}
const fail = code => { throw new DispatchError(code); };
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const opaque = v => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\x00-\x20\x7f]/.test(v) && v.isWellFormed();
const messageId = v => v === null || opaque(v);
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

// Unknown fields fail rather than allowing a transcript, raw error or arbitrary metadata to escape.
function validateObservation(value, confirmation = false) {
  const fields = ['target', 'mode', 'connectorSelected', 'approvalPending', 'composerSha256', 'lastUserMessageId'];
  keys(value, confirmation ? [...fields, 'userMessage'] : fields, [], 'OBSERVATION');
  target(value.target, 'OBSERVATION');
  if (!['pro', 'xhigh'].includes(value.mode) || typeof value.connectorSelected !== 'boolean'
      || typeof value.approvalPending !== 'boolean' || !messageId(value.lastUserMessageId)
      || (value.composerSha256 !== null && !digest(value.composerSha256))) fail('OBSERVATION');
  if (confirmation) {
    const message = value.userMessage;
    keys(message, ['id', 'previousId', 'role', 'bodySha256'], [], 'OBSERVATION');
    if (!opaque(message.id) || !messageId(message.previousId) || message.role !== 'user'
        || !digest(message.bodySha256)) fail('OBSERVATION');
  }
  // Detach caller objects: asynchronous browser work must not change the saved baseline by reference.
  return JSON.parse(JSON.stringify(value));
}

function validateDispatch(d) {
  keys(d, ['version', 'taskId', 'mode', 'connectorRequired', 'promptSha256', 'target', 'state', 'registeredAt'],
    ['before', 'preparedAt', 'sendingAt', 'uncertainAt', 'submittedAt', 'confirmation', 'reason'], 'LEDGER');
  if (d.version !== 1 || typeof d.taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(d.taskId)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(d.taskId)
      || !['pro', 'xhigh'].includes(d.mode) || typeof d.connectorRequired !== 'boolean'
      || !digest(d.promptSha256) || !phases.includes(d.state)) fail('LEDGER');
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
    if (Object.hasOwn(d, 'confirmation')) assertEvidence(d, validateObservation(d.confirmation, true));
  } catch { fail('LEDGER'); }
  return d;
}

function safeSummary(d) {
  return { state: d.state, mode: d.mode, connectorRequired: d.connectorRequired,
    uiPrepared: Boolean(d.before), submissionConfirmed: d.state === 'submitted',
    resendBlocked: ['sending', 'uncertain', 'submitted'].includes(d.state),
    needsInspection: ['sending', 'uncertain'].includes(d.state), reason: d.reason ?? null };
}

function regularFile(file) {
  let info;
  try { info = lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES) fail('LEDGER');
  return info;
}
const readBytes = file => regularFile(file) ? readFileSync(file) : null;
function parseLedger(bytes) {
  if (bytes === null) return {};
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('LEDGER'); }
  if (!record(value)) fail('LEDGER');
  if (Object.hasOwn(value, 'dispatch')) validateDispatch(value.dispatch);
  return value;
}

async function withLedger(file, work) {
  let lock, owner, acquired = false;
  try {
    if (typeof file !== 'string' || !isAbsolute(file) || !file.endsWith('.json')) fail('INPUT');
    // Canonicalize native aliases (including existing filenames) without following a linked ledger.
    // Do not create directories or change ACLs. Every parent must use the same canonical ledger.
    file = join(realpathSync(dirname(file)), basename(file));
    if (regularFile(file)) file = realpathSync(file);
    lock = file + '.dispatch.lock';
    owner = JSON.stringify({ pid: process.pid, instanceId: randomUUID() });
    try { writeFileSync(lock, owner, { flag: 'wx', mode: 0o600, flush: true }); acquired = true; }
    catch (e) { if (e.code === 'EEXIST') fail('LOCKED'); throw e; }
    let previous = readBytes(file);
    const ledger = parseLedger(previous);
    const save = () => {
      validateDispatch(ledger.dispatch);
      const bytes = Buffer.from(JSON.stringify(ledger, null, 2) + '\n');
      if (bytes.length > MAX_BYTES) fail('LEDGER');
      const current = readBytes(file);
      if ((current === null) !== (previous === null) || (current && !current.equals(previous))) fail('CONFLICT');
      const temporary = file + '.tmp-' + randomUUID();
      try {
        writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
        renameSync(temporary, file);
        previous = bytes;
      } finally { try { unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    };
    return await work(ledger, save);
  } catch (error) {
    // No paths, browser messages, prompt fragments, request tokens or raw causes in public errors.
    throw error instanceof DispatchError ? error : new DispatchError('STORAGE');
  } finally {
    if (acquired) {
      try {
        const current = readBytes(lock);
        if (current?.toString('utf8') !== owner) fail('LOCKED');
        unlinkSync(lock);
      } catch { throw new DispatchError('LOCKED'); }
    }
  }
}
const getDispatch = ledger => ledger.dispatch ?? fail('LEDGER');

export async function registerDispatch(file, spec) {
  return withLedger(file, (ledger, save) => {
    keys(spec, ['taskId', 'mode', 'prompt', 'target'], ['connectorRequired']);
    if (Object.hasOwn(spec, 'connectorRequired') && typeof spec.connectorRequired !== 'boolean') fail('INPUT');
    const d = { version: 1, taskId: spec.taskId, mode: spec.mode, connectorRequired: spec.connectorRequired ?? true,
      promptSha256: textDigest(spec.prompt), target: target(spec.target), state: 'registered', registeredAt: now() };
    validateDispatch(d);
    if (Object.hasOwn(ledger, 'dispatch')) {
      const prior = ledger.dispatch;
      if (['taskId', 'mode', 'connectorRequired', 'promptSha256'].some(k => prior[k] !== d[k]) || !sameTarget(prior.target, d.target)) fail('CONFLICT');
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
function prepare(ledger, save, observation) {
  const d = getDispatch(ledger);
  if (!['registered', 'prepared'].includes(d.state)) fail('BLOCKED');
  const before = validateObservation(observation);
  assertReady(d, before);
  Object.assign(d, { state: 'prepared', before, preparedAt: now() });
  save();
  return d;
}
export async function prepareDispatch(file, observation) {
  return withLedger(file, (ledger, save) => safeSummary(prepare(ledger, save, observation)));
}
function begin(ledger, save, prompt, observation) {
  const d = getDispatch(ledger);
  if (!['registered', 'prepared'].includes(d.state)) fail('BLOCKED');
  if (textDigest(prompt) !== d.promptSha256) fail('INPUT');
  prepare(ledger, save, observation);
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
      || message.bodySha256 !== d.promptSha256) fail('OBSERVATION');
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
  try { observed = validateObservation(observation, true); assertEvidence(d, observed); }
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
  try {
    const [action, file, payloadFile] = args;
    const noPayload = { inspect: inspectDispatch, recover: recoverDispatch };
    const withPayload = { register: registerDispatch, prepare: prepareDispatch, begin: beginDispatch, confirm: confirmDispatch };
    if (args.length === 2 && Object.hasOwn(noPayload, action)) return await noPayload[action](file);
    if (args.length !== 3 || !Object.hasOwn(withPayload, action) || !isAbsolute(payloadFile)) fail('INPUT');
    const bytes = readBytes(payloadFile);
    if (bytes === null) fail('INPUT');
    let payload;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('INPUT'); }
    return await withPayload[action](file, payload);
  } catch (error) {
    throw error instanceof DispatchError ? error : new DispatchError('INPUT');
  }
}
