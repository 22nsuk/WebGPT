// Trusted local service launcher, not an MCP tool. It can launch only worker.mjs.
// WinSW must use onfailure=none: this launcher owns the finite retry budget.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from './client.mjs';
import { acquireRuntimeLock, startupExitCode, fault } from './runtime.mjs';
import { validatedEntryPath } from './installation.mjs';
import { readBytesUpTo } from './bounded-read.mjs';

const backoff = [1000, 5000, 15000];
const report = entry => console.error(JSON.stringify(entry));
export function restartDelay(code, signal, attempt, platform = process.platform) {
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= backoff.length) return null;
  // Windows Stop-Process/TerminateProcess can surface unsigned DWORD -1, not a
  // POSIX signal. This observed exit is retryable; arbitrary NTSTATUS codes are not.
  if (code === 1 || (platform === 'win32' && code === 0xffffffff)
      || (code === null && ['SIGKILL', 'SIGABRT', 'SIGSEGV'].includes(signal))) return backoff[attempt];
  return null; // Clean stop, configuration/data/storage/ownership errors: no restart.
}
function serviceConfig(env) {
  if (!env.WEBGPT_CONFIG || !isAbsolute(env.WEBGPT_CONFIG)) throw fault('CONFIG_INVALID', 'service requires an explicit absolute WEBGPT_CONFIG');
  try {
    // Validate the explicit directory against the same strictly decoded snapshot.
    return configuration(env, { requireExplicitDataDir: true });
  } catch { throw fault('CONFIG_INVALID', 'service configuration requires an explicit absolute dataDir and valid ports'); }
}
function ownsStopRequest(file, instanceId, { strict = false } = {}) {
  try {
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 36) return false;
    // Verify the opened object, not a second path-based read. NONBLOCK avoids
    // parking the supervisor if a FIFO replaces the inspected regular file.
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.size !== 36
          || opened.dev !== info.dev || opened.ino !== info.ino) return false;
      // Also inspect the current entry on platforms without O_NOFOLLOW.
      const current = lstatSync(file);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
          || current.dev !== opened.dev || current.ino !== opened.ino) return false;
      return readBytesUpTo(fd, 37).equals(Buffer.from(instanceId));
    } finally { closeSync(fd); }
  } catch (error) {
    // A poll cannot authorize a stop from unreadable evidence. An explicit
    // requester must receive the actual I/O failure, not a fabricated EEXIST.
    if (strict) throw error;
    return false;
  }
}
export function requestServiceStop(env = process.env) {
  const config = serviceConfig(env), lock = resolve(config.dataDir, 'service.lock');
  const info = lstatSync(lock), ownerFile = resolve(lock, 'owner.json'), ownerInfo = lstatSync(ownerFile);
  if (!info.isDirectory() || info.isSymbolicLink() || !ownerInfo.isFile() || ownerInfo.isSymbolicLink()
      || ownerInfo.nlink !== 1 || ownerInfo.size > 4096) throw Error('invalid service owner');
  const owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
  if (typeof owner.instanceId !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.instanceId)) throw Error('invalid service owner');
  const file = resolve(lock, 'stop-request');
  try {
    // Refuse known entries before a creation-capable open, including dangling
    // links. Keep exclusive creation for an entry arriving after this check.
    if (lstatSync(file, { throwIfNoEntry: false }))
      throw Object.assign(Error('service stop marker already exists'), { code: 'EEXIST' });
    writeFileSync(file, owner.instanceId, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (constants.O_NOFOLLOW ?? 0), mode: 0o600, flush: true });
  } catch (error) {
    if (error.code !== 'EEXIST' || !ownsStopRequest(file, owner.instanceId, { strict: true })) throw error;
  }
  return { accepted: true }; // No PID kill, secrets, SCM changes or installation.
}

export async function runService(env = process.env, { spawnWorker = spawn, pause = delay, record = report, entryPath } = {}) {
  const entryRoot = dirname(validatedEntryPath(import.meta.url, entryPath));
  const config = serviceConfig(env);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const ownership = acquireRuntimeLock(config.dataDir, { name: 'service' });
  const log = (event, details = {}) => record({ time: new Date().toISOString(), event,
    supervisorPid: process.pid, parentPid: process.ppid, instanceId: ownership.instanceId, ...details });
  const stopPath = resolve(config.dataDir, 'service.lock', 'stop-request');
  const controller = new AbortController();
  let child, killTimer, stopping = false;
  let stopReason = null, result = 1;
  const stop = (reason = 'cleanup') => {
    if (stopping) return;
    stopping = true;stopReason = reason;controller.abort();
    if (child && child.exitCode === null && child.signalCode === null) {
      // IPC reaches only the process this supervisor owns, never another worker
      // that might be using the configured HTTP port.
      const owned = child;
      try { if (owned.connected) owned.send({ type: 'shutdown' }, () => {}); } catch {}
      killTimer = setTimeout(() => {
        if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGKILL');
      }, 10000);
    }
  };
  const signals = ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])];
  const handlers = signals.map(signal => [signal, () => stop(signal)]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const poll = setInterval(() => {
    // A delayed stop writer for an older instance must not stop its replacement.
    if (ownsStopRequest(stopPath, ownership.instanceId)) stop('stop_request');
  }, 250);
  try {
    log('service_started', { restartBudget: backoff.length });
    for (let attempt = 0; !stopping; attempt++) {
      // Preserve the installation spelling through each restart, while allowing
      // only this supervisor's actual sibling worker as the executable module.
      const workerEntry = validatedEntryPath(new URL('./worker.mjs', import.meta.url), resolve(entryRoot, 'worker.mjs'));
      child = spawnWorker(process.execPath, [workerEntry], {
        env: { ...env }, cwd: config.dataDir, shell: false, windowsHide: true,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      log('worker_started', { workerPid: child.pid ?? null, attempt });
      let code, signal;
      try { [code, signal] = await once(child, 'exit'); }
      catch (error) { throw fault('CONFIG_INVALID', 'worker could not be launched: ' + (error.code ?? 'UNKNOWN')); }
      log('worker_exited', { workerPid: child.pid ?? null, exitCode: code, signal, attempt, stopReason });
      clearTimeout(killTimer);child = null;
      // Stop intent suppresses restarts; it must not turn a failed drain or
      // signal termination into success for the launcher and its final log.
      if (stopping) return result = code ?? 1;
      const wait = restartDelay(code, signal, attempt);
      if (wait === null) {
        log('worker_restart_refused', { exitCode: code, signal, attempt,
          reason: attempt >= backoff.length && restartDelay(code, signal, 0) !== null ? 'budget_exhausted' : 'exit_policy' });
        return result = code ?? 1;
      }
      log('worker_restart_scheduled', { attempt: attempt + 1, delayMs: wait });
      try { await pause(wait, undefined, { signal: controller.signal }); }
      catch (error) { if (!stopping) throw error; }
    }
    return result = 0;
  } catch (error) {
    result = startupExitCode(error);
    log('service_failed', { code: error.code ?? 'UNEXPECTED', exitCode: result });
    throw error;
  } finally {
    // Do not release supervisor ownership while a launched child still runs.
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      stop();
      await once(child, 'exit');
    }
    clearInterval(poll);clearTimeout(killTimer);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    // A stop request is not recovery evidence; remove only our own regular marker.
    if (ownsStopRequest(stopPath, ownership.instanceId)) unlinkSync(stopPath);
    ownership.release();
    log('service_exited', { exitCode: result, stopReason });
  }
}
if (process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 || !['run', 'stop'].includes(process.argv[2])) throw fault('CONFIG_INVALID', 'usage: service.mjs run|stop');
    if (process.argv[2] === 'stop') console.log(JSON.stringify(requestServiceStop()));
    else process.exitCode = await runService(process.env, { entryPath: resolve(process.argv[1]) });
  } catch (error) {
    report({ time: new Date().toISOString(), event: 'service_failed', supervisorPid: process.pid,
      parentPid: process.ppid, code: error.code ?? 'UNEXPECTED', exitCode: startupExitCode(error) });
    process.exitCode = startupExitCode(error);
  }
}
