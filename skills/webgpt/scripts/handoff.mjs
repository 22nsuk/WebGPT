// Optional parent-side inventory and feedback, never task authority or execution.
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { lstatSync } from 'node:fs';
import { buildArtifactInput } from './artifact-input.mjs';
import { readBoundedFile } from './bounded-read.mjs';

const stages = ['design', 'implementation', 'validation'];
const roles = ['brief', 'source', 'reference', 'acceptance', 'evidence', 'package'];
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
  && value.isWellFormed() && !value.includes('\0');
const label = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value);
const invalid = () => Object.assign(Error('Invalid handoff specification; see references/worker-handoff.md.'), { code: 'HANDOFF_INVALID' });
function requireValue(ok) { if (!ok) throw invalid(); }
function object(value, keys) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key)));
}
function list(value, max) { requireValue(Array.isArray(value) && value.length <= max); }
function unique(values) { requireValue(new Set(values).size === values.length); }

/** Reads only explicitly selected files. No dependency discovery, copying, command
 * execution, upload, registration, acceptance or changes to controller state.
 * File identities are sequential observations, not an atomic project snapshot.
 */
export function buildHandoff(spec) {
  object(spec, ['assignment', 'assignee', 'files', 'checks']);
  object(spec.assignment, ['id', 'revision']);
  requireValue(label(spec.assignment.id) && label(spec.assignment.revision) && text(spec.assignee));
  list(spec.files, 64); requireValue(spec.files.length > 0);
  list(spec.checks ?? [], 32);
  // Validate the entire shape before any selected source is read.
  for (const file of spec.files) {
    object(file, ['label', 'role', 'source', 'unavailableReason', 'requiredFor', 'delivery', 'expectedSha256']);
    requireValue(label(file.label) && roles.includes(file.role) && text(file.delivery));
    list(file.requiredFor, 3); unique(file.requiredFor);
    requireValue(file.requiredFor.every(stage => stages.includes(stage)));
    if (Object.hasOwn(file, 'source')) {
      requireValue(text(file.source) && isAbsolute(file.source) && file.unavailableReason === undefined);
    } else requireValue(text(file.unavailableReason));
    requireValue(file.expectedSha256 === undefined || sha(file.expectedSha256));
  }
  unique(spec.files.map(file => file.label));
  const briefs = spec.files.filter(file => file.role === 'brief');
  requireValue(briefs.length === 1 && briefs[0].source !== undefined);
  const names = new Set(spec.files.map(file => file.label));
  for (const check of spec.checks ?? []) {
    object(check, ['id', 'requirement', 'command', 'environment', 'status', 'exitCode', 'signal', 'reason', 'testedFiles', 'evidenceLabels']);
    requireValue(label(check.id) && text(check.requirement) && text(check.command) && text(check.environment));
    requireValue(['PASS', 'FAIL', 'NOT_RUN', 'UNVERIFIED'].includes(check.status));
    requireValue(check.exitCode === null || Number.isSafeInteger(check.exitCode) && check.exitCode >= 0);
    requireValue(check.signal === null || text(check.signal));
    list(check.testedFiles, 64); list(check.evidenceLabels, 16);
    unique(check.testedFiles.map(file => file?.label)); unique(check.evidenceLabels);
    for (const file of check.testedFiles) {
      object(file, ['label', 'sha256']); requireValue(names.has(file.label) && sha(file.sha256));
    }
    requireValue(check.evidenceLabels.every(name => names.has(name)
      && spec.files.find(file => file.label === name).role === 'evidence'));
    requireValue(check.reason === undefined || text(check.reason));
    if (check.status === 'PASS') requireValue(check.exitCode === 0 && check.signal === null);
    if (check.status === 'NOT_RUN') requireValue(check.exitCode === null && check.signal === null && text(check.reason));
    if (check.status === 'UNVERIFIED' || check.status === 'FAIL') requireValue(text(check.reason));
    if (check.status === 'PASS' || check.status === 'FAIL') requireValue(check.testedFiles.length > 0 && check.evidenceLabels.length > 0);
  }
  unique((spec.checks ?? []).map(check => check.id));
  let total = 0;
  const files = spec.files.map(file => {
    let observed = null, status = 'unavailable';
    if (file.source !== undefined) {
      // Reuse the existing bounded, identity-checked whole-file reader; don't
      // turn permission errors, unsupported files or concurrent changes into absence.
      if (lstatSync(file.source, { throwIfNoEntry: false }) === undefined) {
        status = 'missing';
      } else {
        observed = buildArtifactInput({ source: file.source, label: file.label }).source;
        status = file.expectedSha256 !== undefined && file.expectedSha256 !== observed.sha256 ? 'mismatch' : 'observed';
      }
      total += observed?.sizeBytes ?? 0;
      requireValue(total <= 512 * 1024 * 1024);
    }
    return { label: file.label, role: file.role, requiredFor: [...file.requiredFor],
      delivery: file.delivery, status, sizeBytes: observed?.sizeBytes ?? null, sha256: observed?.sha256 ?? null,
      expectedSha256: file.expectedSha256 ?? null, reason: file.unavailableReason ?? null };
  });
  const brief = files.find(file => file.role === 'brief');
  requireValue(brief.status === 'observed');
  const identity = { ...spec.assignment, briefSha256: brief.sha256,
    files: files.map(({ label, role, requiredFor, status, sizeBytes, sha256 }) =>
      ({ label, role, requiredFor: [...requiredFor].sort(), status, sizeBytes, sha256 }))
      .filter(file => !['evidence', 'package'].includes(file.role)).sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0) };
  const checks = (spec.checks ?? []).map(check => {
    const stale = [], unknown = [];
    for (const tested of check.testedFiles) {
      const current = files.find(file => file.label === tested.label);
      if (current.sha256 === null) unknown.push(tested.label);
      else if (tested.sha256 !== current.sha256 || current.status !== 'observed') stale.push(tested.label);
    }
    const missingEvidence = check.evidenceLabels.filter(name => files.find(file => file.label === name).status !== 'observed');
    const { status, ...details } = check;
    return { ...details, reportedStatus: status,
      testedFiles: check.testedFiles.map(file => ({ ...file })), evidenceLabels: [...check.evidenceLabels],
      applicability: stale.length ? 'stale' : unknown.length || missingEvidence.length || !check.testedFiles.length ? 'unknown' : 'current',
      staleFiles: stale, unknownFiles: unknown, missingEvidence };
  });
  const output = { kind: 'webgpt-handoff', version: 1,
    assignment: { ...spec.assignment, briefSha256: brief.sha256,
      inputIdentitySha256: createHash('sha256').update(JSON.stringify(identity)).digest('hex') },
    assignee: spec.assignee, contentsIncluded: false, deliveryVerified: false,
    dependencyDiscovery: 'not_performed', files,
    inputGaps: Object.fromEntries(stages.map(stage => [stage, files.filter(file =>
      file.requiredFor.includes(stage) && file.status !== 'observed').map(file => file.label)])),
    checkEvidence: 'caller_reported', checks, acceptance: 'not_assessed', grantsExecution: false };
  requireValue(Buffer.byteLength(JSON.stringify(output)) <= 128 * 1024);
  return output;
}

export function handoffCli(args) {
  requireValue(args.length === 1 && text(args[0]) && isAbsolute(args[0]));
  const input = readBoundedFile(args[0], 64 * 1024, invalid);
  requireValue(input !== null);
  let spec;
  try { spec = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.bytes)); }
  catch { throw invalid(); }
  return buildHandoff(spec);
}
