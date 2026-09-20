import { readFileSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Shared by the worker and controller client; never store configuration in the skill.
export function configuration(env = process.env) {
  const file = env.WEBGPT_CONFIG ?? join(homedir(), '.config', 'webgpt', 'config.json');
  if (env.WEBGPT_CONFIG && !isAbsolute(file)) throw Error('WEBGPT_CONFIG must be absolute');
  if (env.WEBGPT_CONFIG && !existsSync(file)) throw Error('WEBGPT_CONFIG file does not exist');
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw Error('invalid WebGPT configuration');
  const config = {
    dataDir: env.WEBGPT_DATA_DIR ?? saved.dataDir ?? join(homedir(), '.local', 'share', 'webgpt'),
    mcpPort: saved.mcpPort ?? 43137,
    controlPort: saved.controlPort ?? 43139,
    publicMcp: saved.publicMcp ?? false,
  };
  if (typeof config.dataDir !== 'string' || !isAbsolute(config.dataDir)) throw Error('dataDir must be absolute');
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
        || (result.recoveryRequired !== undefined && !Array.isArray(result.recoveryRequired)))
      throw Error('worker does not support task-scoped waits; update the idle worker and client together');
    if (result.events.some(event => !ids.includes(event?.id)) || result.backupDue.some(id => !ids.includes(id))
        || result.recoveryRequired?.some(event => !ids.includes(event?.id)))
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
    if (result.events.length || result.backupDue.length || result.recoveryRequired?.length || result.settled || result.interrupted) return result;
  }
}

export function verifyResult(event, config) {
  taskIds([event.id]);
  const id = event.id;
  const expectedPath = resolve(config.dataDir, id + '.result.txt');
  if (typeof event.artifact !== 'string' || resolve(event.artifact) !== expectedPath)
    throw Error('unexpected saved result path');
  const stat = lstatSync(expectedPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024)
    throw Error('saved result must be a regular single-link file <=1 MiB');
  const bytes = readFileSync(expectedPath);
  if (bytes.length > 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== event.sha256)
    throw Error('saved result integrity mismatch');
  return 'verified';
}

// Verify saved bytes before acknowledgment; this is not a code-quality verdict.
export async function collectTask(id, config = configuration(), { signal } = {}) {
  taskIds([id]);
  const result = await request('wait', { ids: [id] }, config, { signal });
  const event = result.events.find(event => event.id === id);
  if (!event) throw Error('task has no uncollected result');
  verifyResult(event, config);
  await request('ack', { id }, config, { signal });
  return { ...event, integrity: 'verified', collected: true };
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
    const attention = recovery ? 'inspect_recovery' : integrity !== 'verified' && integrity !== 'not_expected'
      ? 'inspect_result' : task.collected ? 'already_collected_or_cancelled'
      : task.status === 'running' ? 'inspect_retained_chat' : 'collect_saved_result';
    return { ...task, integrity, attention };
  }) };
}

if (process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [action, ...args] = process.argv.slice(2);
    let result;
    const isTaskId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
    const readPayload = file => JSON.parse(readFileSync(file, 'utf8'));
    if (action === 'reconcile' || action === 'ready' || action === 'shutdown') {
      if (args.length) throw Error('unexpected controller arguments');
      result = action === 'reconcile' ? await reconcileTasks() : await request(action, action === 'shutdown' ? {} : undefined);
    } else if (action === 'wait' && args.length) {
      if (args[0] === '--file' && args.length !== 2) throw Error('usage: client.mjs wait --file <json-file>');
      const saved = args[0] === '--file' ? readPayload(args[1])
        : args.length === 1 && !isTaskId(args[0]) ? readPayload(args[0]) : null;
      result = await waitForTasks(saved ? saved.ids ?? [saved.id] : args);
    } else if (action === 'collect') {
      if (args.length !== 1) throw Error('usage: client.mjs collect <task-id>');
      result = await collectTask(args[0]);
    } else if (['ack', 'checked', 'cancel'].includes(action)) {
      if (args[0] === '--file' ? args.length !== 2 : args.length !== 1)
        throw Error(`usage: client.mjs ${action} <task-id|json-file> or --file <json-file>`);
      // Never let an unrelated same-named file redirect a task action to another task.
      const payload = args[0] === '--file' ? readPayload(args[1])
        : isTaskId(args[0]) ? { id: args[0] } : readPayload(args[0]);
      result = await request(action, payload);
    } else {
      if (args.length > 1) throw Error('unexpected controller arguments');
      const payload = args[0] ? JSON.parse(readFileSync(args[0], 'utf8')) : undefined;
      result = await request(action, payload);
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    if (error.details?.issues) console.log(JSON.stringify(error.details));
    console.error('WebGPT: ' + error.message);
    process.exitCode = 1;
  }
}
