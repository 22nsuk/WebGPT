// Trusted local service launcher, not an MCP tool. It can launch only worker.mjs.
// WinSW must use onfailure=none: this launcher owns the finite retry budget.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { resolve, isAbsolute, dirname } from 'node:path';
import { isCliEntry } from './cli-entry.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from './client.mjs';
import { acquireRuntimeLock, startupExitCode, fault } from './runtime.mjs';
import { validatedEntryPath } from './installation.mjs';
import { listenServiceControl, readServiceControl, sendServiceStop } from './service-control.mjs';

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
export async function requestServiceStop(env = process.env) {
  const config = serviceConfig(env);
  return sendServiceStop(readServiceControl(config.dataDir));
}

export async function runService(env = process.env, { spawnWorker = spawn, pause = delay, record = report, entryPath } = {}) {
  const entryRoot = dirname(validatedEntryPath(import.meta.url, entryPath));
  const config = serviceConfig(env);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  // Bind a kernel-owned loopback port first, but reject connections until the
  // private owner record is published and the in-memory instance is activated.
  const channel = await listenServiceControl(config.dataDir);
  let ownership;
  try { ownership = acquireRuntimeLock(config.dataDir, { name: 'service', serviceControl: channel.descriptor }); }
  catch (error) { await channel.close(); throw error; }
  const log = (event, details = {}) => record({ time: new Date().toISOString(), event,
    supervisorPid: process.pid, parentPid: process.ppid, instanceId: ownership.instanceId, ...details });
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
  channel.activate(ownership.instanceId, () => stop('stop_request'));
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
    clearTimeout(killTimer);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    await channel.close(); // No listener may retain this instance after lock release.
    ownership.release();
    log('service_exited', { exitCode: result, stopReason });
  }
}
if (isCliEntry(import.meta)) {
  try {
    if (process.argv.length !== 3 || !['run', 'stop'].includes(process.argv[2])) throw fault('CONFIG_INVALID', 'usage: service.mjs run|stop');
    if (process.argv[2] === 'stop') console.log(JSON.stringify(await requestServiceStop()));
    else process.exitCode = await runService(process.env, { entryPath: resolve(process.argv[1]) });
  } catch (error) {
    report({ time: new Date().toISOString(), event: 'service_failed', supervisorPid: process.pid,
      parentPid: process.ppid, code: error.code ?? 'UNEXPECTED', exitCode: startupExitCode(error) });
    process.exitCode = startupExitCode(error);
  }
}
