// Result bytes and state are separate commits. Preserve an interrupted candidate;
// only an explicit identical submission may finish publishing it. Never auto-ack.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fault } from './runtime.mjs';
import { readBytesUpTo } from './bounded-read.mjs';

const MAX_BYTES = 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function paths(dir, id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) throw Error('invalid result task ID');
  const artifact = resolve(dir, id + '.result.txt');
  return [artifact, artifact + '.tmp'];
}
function regular(info) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES)
    throw fault('RESULT_INVALID', 'saved result must be a regular single-link file <=1 MiB');
}
function readCandidate(file) {
  let info;
  try { info = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  regular(info);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    regular(fstatSync(fd));
    const bytes = readBytesUpTo(fd, MAX_BYTES + 1);
    if (bytes.length > MAX_BYTES) throw fault('RESULT_INVALID', 'saved result exceeds 1 MiB');
    return { bytes, sha256: digest(bytes) };
  } finally { closeSync(fd); }
}

export function verifySavedResult(event, dir) {
  const [artifact] = paths(dir, event.id);
  if (typeof event.artifact !== 'string' || resolve(event.artifact) !== artifact)
    throw Error('unexpected saved result path');
  const saved = readCandidate(artifact);
  if (!saved) throw Object.assign(Error('ENOENT: saved result is missing'), { code: 'ENOENT' });
  if (saved.sha256 !== event.sha256) throw fault('RESULT_INVALID', 'saved result integrity mismatch');
  return 'verified';
}

function flushCandidate(file, bytes) {
  // A previous attempt might have written every byte but failed during flush.
  // Reusing those bytes must still satisfy the same flush-before-state ordering.
  const fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    regular(fstatSync(fd));
    if (!readBytesUpTo(fd, MAX_BYTES + 1).equals(bytes)) throw fault('RESULT_CONFLICT', 'result changed before publication; preserve evidence');
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function storeResult(dir, id, text) {
  if (typeof text !== 'string' || !text.isWellFormed() || Buffer.byteLength(text) > MAX_BYTES)
    throw Error('result must be well-formed text <=1 MiB');
  const [artifact, temporary] = paths(dir, id), bytes = Buffer.from(text);
  const saved = readCandidate(artifact), staged = readCandidate(temporary);
  // A previous attempt may have published bytes but failed to commit state.
  // Do not replace either those bytes or a partially written temporary file.
  for (const candidate of [saved, staged]) {
    if (candidate && !candidate.bytes.equals(bytes))
      throw fault('RESULT_CONFLICT', 'uncommitted result differs; preserve evidence and inspect before resubmitting');
  }
  if (saved || staged) flushCandidate(saved ? artifact : temporary, bytes);
  if (!saved) {
    if (!staged) writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temporary, artifact);
  }
  return { artifact, sha256: digest(bytes) };
}

function pendingPaths(task, dir) {
  const [artifact, temporary] = paths(dir, task.id);
  return task.status === 'running' || !task.artifact ? [artifact, temporary] : [temporary];
}

// Presence is enough to block new work, not to verify or publish a result.
// lstat detects dangling links too. Only ENOENT proves absence; unreadable
// metadata remains blocking. Detailed inspection and publication still read bytes.
export function hasPendingResults(task, dir) {
  return pendingPaths(task, dir).some(file => {
    try { lstatSync(file); return true; }
    catch (error) { return error.code !== 'ENOENT'; }
  });
}

// These hashes describe observed bytes, not a committed result or verified work.
// Include candidates left by cancellation too; never read a path supplied by state.
export function inspectPendingResults(task, dir) {
  const results = [];
  for (const file of pendingPaths(task, dir)) {
    try {
      const saved = readCandidate(file);
      if (saved) results.push({ artifact: file, sha256: saved.sha256, bytes: saved.bytes.length, integrity: 'uncommitted' });
    } catch (error) { results.push({ artifact: file, integrity: 'unreadable', code: error.code ?? 'RESULT_INVALID' }); }
  }
  return results;
}
