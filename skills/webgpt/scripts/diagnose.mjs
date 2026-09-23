// Local, read-only and task-scoped. This cannot test ChatGPT, repair a tunnel,
// acknowledge a result, recover state or attribute unscoped traffic to a task.
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { configuration } from './client.mjs';
import { parseState, assertNoStateStage } from './runtime.mjs';
import { verifySavedResult } from './results.mjs';
import { AUDIT_LIMIT, auditRecord, readDiagnosticBytes, validAuditTaskId } from './audit.mjs';

export function diagnoseTask(id, config = configuration()) {
  if (!validAuditTaskId(id)) throw Error('invalid task ID');
  const stateFile = join(config.dataDir, 'state.json');
  let tasks;
  try {
    const bytes = readDiagnosticBytes(stateFile, 32 * 1024 * 1024);
    if (bytes === null) throw Error();
    tasks = parseState(bytes, config.dataDir);
  } catch { throw Error('task state unavailable'); }
  const task = tasks.find(value => value.id === id);
  if (!task) throw Error('unknown task');
  let stateStage = 'absent', integrity = 'not_expected';
  try { assertNoStateStage(stateFile); }
  catch (error) { stateStage = error.code === 'STATE_STAGING_CONFLICT' ? 'present' : 'unavailable'; }
  if (task.artifact || task.sha256) {
    try { integrity = verifySavedResult(task, config.dataDir); }
    catch (error) { integrity = error.code === 'ENOENT' ? 'missing' : 'mismatch_or_unreadable'; }
  }
  const records = [], starts = new Set();
  let filesRead = 0, malformedLines = 0, received = 0, completed = 0, failed = 0;
  const pending = new Set();
  const unscoped = { httpErrors: 0, abortedResponses: 0, unassignedToolCalls: 0 };
  for (const suffix of ['.1', '']) {
    let bytes;
    try { bytes = readDiagnosticBytes(join(config.dataDir, 'mcp-audit.jsonl' + suffix), AUDIT_LIMIT); }
    catch { throw Error('diagnostic data unavailable'); }
    if (bytes === null) continue;
    filesRead++;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw Error('diagnostic data unavailable'); }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = auditRecord(JSON.parse(line)); }
      catch { malformedLines++; continue; }
      if (event.phase === 'started') { starts.add(event.runId); continue; }
      if (event.phase === 'http_completed') {
        if (event.statusCode >= 400) unscoped.httpErrors++;
        if (event.aborted) unscoped.abortedResponses++;
      }
      if (!event.phase.startsWith('tool_')) continue;
      if (event.taskId === null) {
        if (event.phase === 'tool_received') unscoped.unassignedToolCalls++;
        continue;
      }
      if (event.taskId !== id) continue;
      const key = event.runId + ':' + event.requestId;
      if (event.phase === 'tool_received') { received++; pending.add(key); }
      else { completed++; if (event.isError) failed++; pending.delete(key); }
      records.push(event);
      if (records.length > 50) records.shift();
    }
  }
  return {
    task: { id, status: task.status, collected: task.collected, integrity },
    stateStage, browserChecked: false,
    audit: { availability: filesRead ? 'observed' : 'not_observed', filesRead, observedRunStarts: starts.size,
      malformedLines, received, completed, failed, receivedWithoutCompletionInWindow: pending.size,
      recent: records, recentTruncated: received + completed > records.length, unscoped },
    interpretation: 'Bounded local observations only; capture may be disabled, failed, partial or rotated. Missing completion is not proof of a hung call. HTTP failures and invalid-token calls are unscoped. HTTP finish does not prove client receipt. Audit is not completion authority or proof of platform cause.',
  };
}

if (process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw Error('usage: diagnose.mjs <task-id>');
    console.log(JSON.stringify(diagnoseTask(process.argv[2])));
  } catch (error) {
    const allowed = new Set(['usage: diagnose.mjs <task-id>', 'invalid task ID', 'unknown task', 'task state unavailable', 'diagnostic data unavailable']);
    console.error('WebGPT diagnose: ' + (allowed.has(error.message) ? error.message : 'diagnosis unavailable'));
    process.exitCode = 1;
  }
}
