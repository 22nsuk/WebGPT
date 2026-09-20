// Local runtime ownership and persisted-state validation. No delegated process control.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';

export const fault = (code, message) => Object.assign(Error(message), { code, retryable: false });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stat = path => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

function readOwner(lock) {
  const directory = stat(lock), file = stat(resolve(lock, 'owner.json'));
  if (!directory?.isDirectory() || directory.isSymbolicLink() || !file?.isFile()
      || file.isSymbolicLink() || file.nlink !== 1 || file.size > 4096)
    throw fault('LOCK_UNCERTAIN', 'runtime lock owner is missing or invalid; preserve it for inspection');
  let owner;
  try { owner = JSON.parse(readFileSync(resolve(lock, 'owner.json'), 'utf8')); } catch {
    throw fault('LOCK_UNCERTAIN', 'runtime lock owner is unreadable; preserve it for inspection');
  }
  if (!record(owner) || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.host !== 'string' || !owner.host)
    throw fault('LOCK_UNCERTAIN', 'runtime lock owner is invalid; preserve it for inspection');
  return owner;
}

// A zero signal only checks existence. Access denied, PID reuse, other hosts and
// unrecognised errors must never be interpreted as a dead worker. No TTL stealing.
export function processState(pid) {
  try { process.kill(pid, 0); return 'alive'; } catch (e) {
    return e.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

export function acquireRuntimeLock(dir, { host = hostname(), probe = processState, name = 'worker' } = {}) {
  if (!['worker', 'service'].includes(name)) throw Error('invalid runtime lock kind');
  const lock = resolve(dir, name + '.lock'), guard = resolve(dir, name + '.recovery.lock');
  const owner = { pid: process.pid, host, instanceId: randomUUID() };
  const create = () => {
    mkdirSync(lock, { mode: 0o700 });
    try { writeFileSync(resolve(lock, 'owner.json'), JSON.stringify(owner), { mode: 0o600, flag: 'wx', flush: true }); }
    catch (e) {
      // We created this directory; another conforming starter cannot own it yet.
      try { unlinkSync(resolve(lock, 'owner.json')); } catch {}
      try { rmdirSync(lock); } catch {}
      throw e;
    }
  };
  // Serialize every acquisition, including a fresh starter arriving after the
  // stale directory was archived. Interrupted guards always require inspection.
  try { mkdirSync(guard, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') throw fault('LOCK_UNCERTAIN', 'runtime lock recovery is in progress or interrupted; inspect the recovery guard');
    throw error;
  }
  try {
    try { create(); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (stat(lock)) {
        const previous = readOwner(lock);
        if (previous.host !== host) throw fault('LOCK_UNCERTAIN', 'runtime lock belongs to another host; automatic recovery refused');
        const state = probe(previous.pid);
        if (state !== 'dead') throw fault(state === 'alive' ? 'LOCK_HELD' : 'LOCK_UNCERTAIN',
          'WebGPT data directory locked; owner is alive or cannot be verified');
        // Only a proven dead owner is moved, never deleted. With the guard held,
        // no other conforming starter can replace it before or after this rename.
        renameSync(lock, resolve(dir, name + '.lock.stale-' + randomUUID()));
      }
      try { create(); } catch (error) {
        if (error.code === 'EEXIST') throw fault('LOCK_HELD', 'another worker acquired the recovered runtime lock');
        throw error;
      }
    }
  } finally { rmdirSync(guard); }
  let released = false;
  return { instanceId: owner.instanceId, release() {
    if (released) return;
    const current = readOwner(lock);
    if (current.instanceId !== owner.instanceId || current.pid !== owner.pid || current.host !== owner.host)
      throw fault('LOCK_UNCERTAIN', 'runtime lock ownership changed; refusing to release it');
    if (readdirSync(lock).some(name => name !== 'owner.json'))
      throw fault('LOCK_UNCERTAIN', 'runtime lock contains unexpected evidence; refusing to release it');
    unlinkSync(resolve(lock, 'owner.json'));
    rmdirSync(lock);
    released = true;
  } };
}

export function readStateBytes(path) {
  const info = stat(path);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw fault('STATE_INVALID', 'state.json must be a regular single-link file; preserve evidence');
  return readFileSync(path);
}

const initializedBytes = Buffer.from('WebGPT state initialized v1\n');
export function readStateMarker(path) {
  const bytes = readStateBytes(path);
  if (bytes === null) return false;
  if (!bytes.equals(initializedBytes))
    throw fault('STATE_INVALID', 'invalid state initialization marker; preserve evidence, do not reset');
  return true;
}

export function createStateMarker(path) {
  // This precedes the first state commit. A crash in between must require
  // inspection instead of reopening the directory as a never-used runtime.
  writeFileSync(path, initializedBytes, { mode: 0o600, flag: 'wx', flush: true });
}

export function parseState(bytes, dir) {
  let tasks;
  try { tasks = bytes === null ? [] : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw fault('STATE_INVALID', 'invalid state.json JSON or UTF-8; preserve evidence, do not reset'); }
  const invalid = () => { throw fault('STATE_INVALID', 'invalid state.json structure; preserve evidence, do not reset'); };
  if (!Array.isArray(tasks)) invalid();
  const ids = new Set(), tokens = new Set();
  for (const task of tasks) {
    if (!record(task)) invalid();
    if (!task.collected && ['terminal', 'mode', 'openKey'].some(key => Object.hasOwn(task, key)))
      throw fault('STATE_INVALID', 'incompatible terminal/open state; use its matching worker to retire active sessions first');
    if (typeof task.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(task.id)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(task.id) || ids.has(task.id.toLowerCase())
        || !['running', 'completed', 'failed', 'cancelled'].includes(task.status)
        || typeof task.collected !== 'boolean' || typeof task.instructions !== 'string'
        || !record(task.inputs) || Object.values(task.inputs).some(value => typeof value !== 'string')
        || (task.changes !== undefined && (!Array.isArray(task.changes) || task.changes.some(value => !record(value))))
        || (task.recoveryRequired !== undefined && (!Array.isArray(task.recoveryRequired)
          || task.recoveryRequired.some(value => typeof value !== 'string')))) invalid();
    ids.add(task.id.toLowerCase());
    if (!task.collected) {
      if (typeof task.token !== 'string' || !task.token || tokens.has(task.token)) invalid();
      tokens.add(task.token);
    }
    if (task.status === 'running' && (task.collected || !Number.isFinite(task.nextCheck))) invalid();
    if (task.status !== 'running' && !task.collected
        && (task.artifact !== resolve(dir, task.id + '.result.txt') || !/^[a-f0-9]{64}$/.test(task.sha256 ?? '')
          || typeof task.summary !== 'string')) invalid();
    if (task.workspace != null && (!record(task.workspace) || typeof task.workspace.root !== 'string' || !isAbsolute(task.workspace.root)
        || !['read', 'edit'].includes(task.workspace.mode) || !Number.isFinite(task.workspace.device)
        || !Number.isFinite(task.workspace.inode))) invalid();
  }
  return tasks;
}

// Only unexpected process failures are candidates for a bounded supervisor retry.
export function startupExitCode(error) {
  if (error.code === 'STATE_INVALID') return 65;
  if (['LOCK_HELD', 'LOCK_UNCERTAIN', 'EADDRINUSE'].includes(error.code)) return 73;
  if (error.code === 'CONFIG_INVALID') return 78;
  if (['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'ENOENT', 'EISDIR', 'ENOTDIR', 'STORAGE_UNAVAILABLE'].includes(error.code)) return 74;
  return 1;
}
