// Trusted local service launcher, not an MCP tool. It can launch only worker.mjs.
// WinSW must use onfailure=none: this launcher owns the finite retry budget.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from './client.mjs';
import { acquireRuntimeLock, startupExitCode, fault } from './runtime.mjs';

const backoff = [1000, 5000, 15000];
export function restartDelay(code, signal, attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= backoff.length) return null;
  if (code === 1 || (code === null && ['SIGKILL', 'SIGABRT', 'SIGSEGV'].includes(signal))) return backoff[attempt];
  return null; // Clean stop, configuration/data/storage/ownership errors: no restart.
}
function serviceConfig(env) {
  if (!env.WEBGPT_CONFIG || !isAbsolute(env.WEBGPT_CONFIG)) throw fault('CONFIG_INVALID', 'service requires an explicit absolute WEBGPT_CONFIG');
  try {
    const saved = JSON.parse(readFileSync(env.WEBGPT_CONFIG, 'utf8'));
    if (!(env.WEBGPT_DATA_DIR ?? saved?.dataDir)) throw Error('explicit dataDir required');
    return configuration(env);
  } catch { throw fault('CONFIG_INVALID', 'service configuration requires an explicit absolute dataDir and valid ports'); }
}
function ownsStopRequest(file, instanceId) {
  try {
    const info = lstatSync(file);
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size === 36
      && readFileSync(file, 'utf8') === instanceId;
  } catch { return false; }
}
export function requestServiceStop(env = process.env) {
  const config = serviceConfig(env), lock = resolve(config.dataDir, 'service.lock');
  const info = lstatSync(lock), ownerFile = resolve(lock, 'owner.json'), ownerInfo = lstatSync(ownerFile);
  if (!info.isDirectory() || info.isSymbolicLink() || !ownerInfo.isFile() || ownerInfo.isSymbolicLink()
      || ownerInfo.nlink !== 1 || ownerInfo.size > 4096) throw Error('invalid service owner');
  const owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
  if (typeof owner.instanceId !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.instanceId)) throw Error('invalid service owner');
  const file = resolve(lock, 'stop-request');
  try { writeFileSync(file, owner.instanceId, { flag: 'wx', mode: 0o600, flush: true }); }
  catch (error) {
    if (error.code !== 'EEXIST' || !ownsStopRequest(file, owner.instanceId)) throw error;
  }
  return { accepted: true }; // No PID kill, secrets, SCM changes or installation.
}

export async function runService(env = process.env, { spawnWorker = spawn, pause = delay } = {}) {
  const config = serviceConfig(env);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const ownership = acquireRuntimeLock(config.dataDir, { name: 'service' });
  const stopPath = resolve(config.dataDir, 'service.lock', 'stop-request');
  const controller = new AbortController();
  let child, killTimer, stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;controller.abort();
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
  for (const signal of signals) process.on(signal, stop);
  const poll = setInterval(() => {
    // A delayed stop writer for an older instance must not stop its replacement.
    if (ownsStopRequest(stopPath, ownership.instanceId)) stop();
  }, 250);
  try {
    for (let attempt = 0; !stopping; attempt++) {
      child = spawnWorker(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], {
        env: { ...env }, cwd: config.dataDir, shell: false, windowsHide: true,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      let code, signal;
      try { [code, signal] = await once(child, 'exit'); }
      catch (error) { throw fault('CONFIG_INVALID', 'worker could not be launched: ' + (error.code ?? 'UNKNOWN')); }
      clearTimeout(killTimer);child = null;
      if (stopping) return 0;
      const wait = restartDelay(code, signal, attempt);
      if (wait === null) return code ?? 1;
      console.error(JSON.stringify({ event: 'worker_restart_scheduled', attempt: attempt + 1, delayMs: wait }));
      try { await pause(wait, undefined, { signal: controller.signal }); }
      catch (error) { if (!stopping) throw error; }
    }
    return 0;
  } finally {
    // Do not release supervisor ownership while a launched child still runs.
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      stop();
      await once(child, 'exit');
    }
    clearInterval(poll);clearTimeout(killTimer);
    for (const signal of signals) process.off(signal, stop);
    // A stop request is not recovery evidence; remove only our own regular marker.
    if (ownsStopRequest(stopPath, ownership.instanceId)) unlinkSync(stopPath);
    ownership.release();
  }
}
if (process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 || !['run', 'stop'].includes(process.argv[2])) throw fault('CONFIG_INVALID', 'usage: service.mjs run|stop');
    if (process.argv[2] === 'stop') console.log(JSON.stringify(requestServiceStop()));
    else process.exitCode = await runService();
  } catch (error) {
    console.error(JSON.stringify({ event: 'service_failed', code: error.code ?? 'UNEXPECTED' }));
    process.exitCode = startupExitCode(error);
  }
}
