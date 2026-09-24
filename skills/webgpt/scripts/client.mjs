import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifySavedResult } from './results.mjs';
import { setTimeout as delay } from 'node:timers/promises';

// Decode user-authored local JSON without silently replacing invalid wire bytes.
// TextDecoder accepts one leading UTF-8 BOM; BOMs inside strings stay unchanged.
function readJsonFile(file) {
  const bytes = readFileSync(file); // Keep filesystem failures and their error codes.
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw Error('invalid JSON or UTF-8 input file'); }
}

// Shared by the worker and controller client; never store configuration in the skill.
export function configurationFile(env = process.env) {
  const file = env.WEBGPT_CONFIG ?? join(homedir(), '.config', 'webgpt', 'config.json');
  if (typeof file !== 'string' || !file.isWellFormed() || !isAbsolute(file)) throw Error('WEBGPT_CONFIG must be absolute');
  return file;
}

export function configuration(env = process.env, { requireExplicitDataDir = false } = {}) {
  const file = configurationFile(env);
  let saved;
  try { saved = readJsonFile(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (env.WEBGPT_CONFIG) throw Error('WEBGPT_CONFIG file does not exist');
    saved = {}; // Only an absent implicit configuration may use defaults.
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw Error('invalid WebGPT configuration');
  if (requireExplicitDataDir && !(env.WEBGPT_DATA_DIR ?? saved.dataDir)) throw Error('explicit dataDir required');
  const config = {
    dataDir: env.WEBGPT_DATA_DIR ?? saved.dataDir ?? join(homedir(), '.local', 'share', 'webgpt'),
    mcpPort: saved.mcpPort ?? 43137,
    controlPort: saved.controlPort ?? 43139,
    publicMcp: saved.publicMcp ?? false,
  };
  if (typeof config.dataDir !== 'string' || !config.dataDir.isWellFormed() || !isAbsolute(config.dataDir)) throw Error('dataDir must be absolute');
  if (typeof config.publicMcp !== 'boolean') throw Error('publicMcp must be boolean');
  for (const key of ['mcpPort', 'controlPort']) {
    if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > 65535) throw Error('invalid ' + key);
  }
  if (config.mcpPort === config.controlPort) throw Error('MCP and controller ports must differ');
  return config;
}

// Task IDs select work on the authenticated controller; they do not grant MCP access.
function taskIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)))
    throw Error('nonempty task IDs required');
  return [...new Set(ids)];
}

export async function request(action, payload, config = configuration(), { signal, timeoutMs = action === 'wait' ? 60000 : 5000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw Error('invalid controller timeout');
  const read = ['wait', 'status', 'tasks', 'ready', 'reconcile'].includes(action);
  if (!read && !['register', 'ack', 'checked', 'cancel', 'shutdown'].includes(action)) throw Error('unknown controller action');
  let ids;
  if (read && payload !== undefined) {
    if (action !== 'wait' || !payload || Array.isArray(payload) || Object.keys(payload).some(key => key !== 'ids'))
      throw Error('invalid controller payload');
    ids = taskIds(payload.ids);
  } else if (!read && (!payload || typeof payload !== 'object' || Array.isArray(payload))) {
    throw Error('invalid controller payload');
  }
  signal?.throwIfAborted();
  const key = readFileSync(join(config.dataDir, 'controller.key'), 'utf8');
  const query = ids ? '?' + new URLSearchParams(ids.map(id => ['id', id])) : '';
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch('http://127.0.0.1:' + config.controlPort + '/' + action + query, {
    method: read ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: read ? undefined : JSON.stringify(payload),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(Error(result?.error ?? 'controller request failed: ' + response.status), {
    statusCode: response.status, code: result?.code, details: result,
    retryable: response.status === 503 && result?.code === 'SHUTTING_DOWN' && result?.retryable === true,
  });
  if (ids) {
    if (!result || !Array.isArray(result.events) || !Array.isArray(result.backupDue) || typeof result.settled !== 'boolean'
        || (result.recoveryRequired !== undefined && !Array.isArray(result.recoveryRequired))
        || (result.resultRecoveryRequired !== undefined && !Array.isArray(result.resultRecoveryRequired)))
      throw Error('worker does not support task-scoped waits; update the idle worker and client together');
    if (result.events.some(event => !ids.includes(event?.id)) || result.backupDue.some(id => !ids.includes(id))
        || result.recoveryRequired?.some(event => !ids.includes(event?.id))
        || result.resultRecoveryRequired?.some(event => !ids.includes(event?.id)))
      throw Error('worker returned state outside the requested task scope');
  }
  return result;
}

// Adapted from upstream: keep empty HTTP renewals inside one active client process.
// Cancellation stops this wait only; task cancellation remains an explicit action.
export function retryableControllerError(error) {
  if (error.statusCode !== undefined) return error.retryable === true;
  // Only fetch transport errors, not filesystem/config errors or malformed JSON.
  return error.name === 'TimeoutError' || ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(error.cause?.code);
}

export async function waitForTasks(ids, config = configuration(), { signal, retryDelays = [250, 1000, 3000] } = {}) {
  ids = taskIds(ids);
  if (!Array.isArray(retryDelays) || retryDelays.length > 3
      || retryDelays.some(value => !Number.isSafeInteger(value) || value < 0 || value > 10000))
    throw Error('invalid bounded wait retry policy');
  let retries = 0;
  for (;;) {
    signal?.throwIfAborted();
    let result;
    try { result = await request('wait', { ids }, config, { signal }); }
    catch (error) {
      signal?.throwIfAborted();
      if (!retryableControllerError(error) || retries >= retryDelays.length) throw error;
      const base = retryDelays[retries++];
      await delay(base + Math.floor(Math.random() * Math.min(base / 4, 250)), undefined, { signal });
      continue;
    }
    // Successful empty long polls are renewals, not failures. They do not reset
    // this invocation's retry budget, so a flapping worker cannot loop forever.
    if (result.events.length || result.backupDue.length || result.recoveryRequired?.length || result.resultRecoveryRequired?.length || result.settled || result.interrupted) return result;
  }
}

export function verifyResult(event, config) {
  return verifySavedResult(event, config.dataDir);
}

// Verify saved bytes before acknowledgment; this is not a code-quality verdict.
export async function collectTask(id, config = configuration(), { signal, resume = false } = {}) {
  taskIds([id]);
  if (typeof resume !== 'boolean') throw Error('invalid collection resume option');
  if (resume) return resumeCollection(id, config, { signal });
  const result = await request('wait', { ids: [id] }, config, { signal });
  const event = result.events.find(event => event.id === id);
  if (!event) throw Error('task has no uncollected result');
  verifyResult(event, config);
  await request('ack', { id }, config, { signal });
  return { ...event, integrity: 'verified', collected: true };
}

// Resume only from controller state, never from filenames or parent bookkeeping.
// A retained result is verified again even when its queue event was already retired.
async function resumeCollection(id, config, { signal }) {
  const inspect = async () => {
    const snapshot = await reconcileTasks(config, { signal });
    if (snapshot.health?.issues?.includes('STATE_INVALID'))
      throw Object.assign(Error('controller state is invalid; preserve evidence and inspect'), { code: 'STATE_INVALID' });
    const task = snapshot.tasks.find(task => task.id === id);
    if (!task) throw Error('unknown task');
    if (task.status === 'running')
      throw Object.assign(Error('task has no uncollected result: task is still running'), { code: 'TASK_RUNNING' });
    if (task.artifact || task.sha256) verifyResult(task, config);
    else if (task.status !== 'cancelled' || !task.collected)
      throw Error('task has no saved result');
    return { ...task, health: snapshot.health, browserChecked: false };
  };
  const finish = task => ({ ...task, disposition: task.discarded ? 'discarded'
    : !task.artifact ? 'cancelled_without_result' : 'already_collected' });
  const before = await inspect();
  if (before.collected) return finish(before);
  if (['inspect_recovery', 'inspect_uncommitted_result'].includes(before.attention))
    throw Object.assign(Error('saved result requires recovery inspection before collection'), {
      code: 'COLLECTION_RECOVERY_REQUIRED', attention: before.attention, reconciliation: before,
    });
  let ackError;
  try { await request('ack', { id }, config, { signal }); }
  catch (error) {
    // A lost transport response may follow a committed acknowledgment. Observe
    // once; never retry the write here. Other failures keep their existing contract.
    if (!retryableControllerError(error) || signal?.aborted) throw error;
    ackError = error;
  }
  let after;
  try { after = await inspect(); }
  catch (error) {
    throw Object.assign(Error('collection outcome requires reconciliation; resume after inspecting controller state', { cause: error }), {
      code: 'COLLECTION_UNCONFIRMED', acknowledgment: ackError ? 'unknown' : 'accepted',
    });
  }
  if (!after.collected) {
    throw Object.assign(Error('controller did not confirm collection; preserve evidence and reconcile', { cause: ackError }), {
      code: 'COLLECTION_UNCONFIRMED', acknowledgment: ackError ? 'unknown' : 'accepted',
    });
  }
  if (after.status !== before.status || after.artifact !== before.artifact || after.sha256 !== before.sha256)
    throw Object.assign(Error('saved result changed during collection; preserve evidence and reconcile'), {
      code: 'COLLECTION_UNCONFIRMED', acknowledgment: ackError ? 'unknown' : 'accepted',
    });
  const result = finish(after);
  return { ...result, disposition: after.discarded ? 'discarded' : 'collected' };
}

// Read-only reconciliation. Never acknowledges, cancels, re-registers or opens a chat.
export async function reconcileTasks(config = configuration(), { signal } = {}) {
  const snapshot = await request('reconcile', undefined, config, { signal });
  if (!snapshot || !Array.isArray(snapshot.tasks)) throw Error('worker does not support reconciliation');
  return { health: snapshot.health, browserChecked: false, tasks: snapshot.tasks.map(task => {
    let integrity = 'not_expected';
    if (task.artifact || task.sha256) {
      try { integrity = verifyResult(task, config); }
      catch (error) { integrity = error.code === 'ENOENT' ? 'missing' : 'mismatch_or_unreadable'; }
    }
    const recovery = task.recoveryRequired?.length || task.journalIssues?.length;
    const attention = recovery ? 'inspect_recovery' : task.pendingResults?.length ? 'inspect_uncommitted_result' : integrity !== 'verified' && integrity !== 'not_expected'
      ? 'inspect_result' : task.collected ? 'already_collected_or_cancelled'
      : task.status === 'running' ? 'inspect_retained_chat' : 'collect_saved_result';
    return { ...task, integrity, attention };
  }) };
}

if (process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [action, ...args] = process.argv.slice(2);
  try {
    let result;
    const isTaskId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
    if (action === 'dispatch') {
      const { dispatchCli } = await import('./dispatch.mjs');
      result = await dispatchCli(args);
    } else if (action === 'reconcile' || action === 'ready' || action === 'shutdown') {
      if (args.length) throw Error('unexpected controller arguments');
      result = action === 'reconcile' ? await reconcileTasks() : await request(action, action === 'shutdown' ? {} : undefined);
    } else if (action === 'wait' && args.length) {
      if (args[0] === '--file' && args.length !== 2) throw Error('usage: client.mjs wait --file <json-file>');
      const saved = args[0] === '--file' ? readJsonFile(args[1])
        : args.length === 1 && !isTaskId(args[0]) ? readJsonFile(args[0]) : null;
      result = await waitForTasks(saved ? saved.ids ?? [saved.id] : args);
    } else if (action === 'collect') {
      const resume = args[0] === '--resume';
      if (args.length !== (resume ? 2 : 1)) throw Error('usage: client.mjs collect [--resume] <task-id>');
      result = await collectTask(args[resume ? 1 : 0], configuration(), { resume });
    } else if (['ack', 'checked', 'cancel'].includes(action)) {
      if (args[0] === '--file' ? args.length !== 2 : args.length !== 1)
        throw Error(`usage: client.mjs ${action} <task-id|json-file> or --file <json-file>`);
      // Never let an unrelated same-named file redirect a task action to another task.
      const payload = args[0] === '--file' ? readJsonFile(args[1])
        : isTaskId(args[0]) ? { id: args[0] } : readJsonFile(args[0]);
      result = await request(action, payload);
    } else {
      if (args.length > 1) throw Error('unexpected controller arguments');
      const payload = args[0] ? readJsonFile(args[0]) : undefined;
      result = await request(action, payload);
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    if (action === 'dispatch') {
      const { dispatchDiagnostic } = await import('./dispatch.mjs');
      console.error('WebGPT: ' + JSON.stringify(dispatchDiagnostic(error)));
    } else if (action === 'collect' && args[0] === '--resume'
        && ['COLLECTION_UNCONFIRMED', 'COLLECTION_RECOVERY_REQUIRED'].includes(error.code)) {
      // Only new resume diagnostics are structured; never serialize raw causes or paths.
      console.error('WebGPT: ' + JSON.stringify({ code: error.code, message: error.message,
        ...(['accepted', 'unknown'].includes(error.acknowledgment) ? { acknowledgment: error.acknowledgment } : {}),
        ...(['inspect_recovery', 'inspect_uncommitted_result'].includes(error.attention) ? { attention: error.attention } : {}),
      }));
    } else {
      if (error.details?.issues) console.log(JSON.stringify(error.details));
      console.error('WebGPT: ' + error.message);
    }
    process.exitCode = 1;
  }
}
