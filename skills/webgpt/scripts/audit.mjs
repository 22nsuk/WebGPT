// Selective adaptation of Nhahan/WebGPT's metadata-only MCP audit. No payloads,
// raw errors, paths, tokens, client request IDs or browser data enter this format.
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fault } from './runtime.mjs';

export const AUDIT_LIMIT = 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const tools = new Set(['list_files', 'read_file', 'write_file', 'delete_file', 'get_task', 'read_input', 'submit_result', 'unknown']);
const phases = new Set(['started', 'http_received', 'http_completed', 'tool_received', 'tool_completed']);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
export const validAuditTaskId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
const unavailable = () => Error('diagnostic data unavailable');
const stat = file => { try { return lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function regular(info, limit, privateFile = false) {
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit
      || (privateFile && process.platform !== 'win32' && (info.mode & 0o077))) throw unavailable();
}

export function auditFromEnvironment(env = process.env) {
  const value = env.WEBGPT_MCP_AUDIT;
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  throw fault('CONFIG_INVALID', 'WEBGPT_MCP_AUDIT must be 0 or 1');
}

// Used for both writing and reading: unknown fields are dropped, never echoed.
export function auditRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
      || !phases.has(value.phase) || typeof value.runId !== 'string' || !UUID.test(value.runId)
      || typeof value.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.timestamp)
      || !Number.isFinite(Date.parse(value.timestamp)) || new Date(value.timestamp).toISOString() !== value.timestamp)
    throw unavailable();
  const safe = { version: 1, runId: value.runId, timestamp: value.timestamp, phase: value.phase };
  if (value.phase === 'started') return safe;
  if (typeof value.requestId !== 'string' || !UUID.test(value.requestId)) throw unavailable();
  safe.requestId = value.requestId;
  if (value.phase.startsWith('tool_')) {
    if (!tools.has(value.tool) || (value.taskId !== null && !validAuditTaskId(value.taskId))
        || typeof value.transportId !== 'string' || !UUID.test(value.transportId)) throw unavailable();
    Object.assign(safe, { tool: value.tool, taskId: value.taskId, transportId: value.transportId });
    if (value.phase === 'tool_completed') {
      if (typeof value.isError !== 'boolean') throw unavailable();
      safe.isError = value.isError;
    }
  } else {
    if (!['GET', 'HEAD', 'POST', 'OTHER'].includes(value.method)) throw unavailable();
    safe.method = value.method;
    if (value.phase === 'http_completed') {
      if ((value.statusCode !== null && (!Number.isInteger(value.statusCode) || value.statusCode < 100 || value.statusCode > 599))
          || typeof value.aborted !== 'boolean') throw unavailable();
      Object.assign(safe, { statusCode: value.statusCode, aborted: value.aborted });
    }
  }
  if (value.phase.endsWith('_completed')) {
    if (!nonnegative(value.durationMs)) throw unavailable();
    safe.durationMs = value.durationMs;
  }
  return safe;
}

// One writer under the existing worker runtime lock. Rotation intentionally keeps
// at most two segments; these are diagnostics, not durable recovery journals.
export function createAuditWriter(dir, enabled = false, { warn = () => console.error('WebGPT MCP audit unavailable; capture disabled for this run.') } = {}) {
  if (typeof enabled !== 'boolean') throw fault('CONFIG_INVALID', 'audit must be boolean');
  if (!enabled) return () => {};
  const file = join(dir, 'mcp-audit.jsonl'), previous = file + '.1', runId = randomUUID();
  let disabled = false;
  return event => {
    if (disabled) return;
    try {
      const line = Buffer.from(JSON.stringify(auditRecord({ ...event, version: 1, runId, timestamp: new Date().toISOString() })) + '\n');
      if (line.length > 4096) throw unavailable();
      let info = stat(file);
      // Inspect first, including dangling Windows symlinks: an exclusive open
      // alone is not sufficient there. Never chmod or follow an existing link.
      if (info) regular(info, AUDIT_LIMIT, true);
      if (info && info.size + line.length > AUDIT_LIMIT) {
        const older = stat(previous);
        if (older) regular(older, AUDIT_LIMIT, true);
        renameSync(file, previous);
        info = null;
      }
      const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW
        | (info ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
      try {
        const opened = fstatSync(fd);
        regular(opened, AUDIT_LIMIT - line.length, true);
        if (info && (opened.dev !== info.dev || opened.ino !== info.ino)) throw unavailable();
        writeFileSync(fd, line);
      } finally { closeSync(fd); }
    } catch {
      disabled = true;
      // Even a diagnostic sink failure must not change the task outcome.
      try { warn(); } catch {}
    }
  };
}

// The cap is enforced by actual reads, including one sentinel byte, not just stat.
export function readDiagnosticBytes(file, limit) {
  const info = stat(file);
  if (!info) return null;
  regular(info, limit);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    regular(opened, limit);
    if (opened.dev !== info.dev || opened.ino !== info.ino) throw unavailable();
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > limit) throw unavailable();
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}
