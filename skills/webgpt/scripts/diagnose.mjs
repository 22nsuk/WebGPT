// Local, read-only and task-scoped. This cannot test ChatGPT, repair a tunnel,
// acknowledge a result, recover state or attribute unscoped traffic to a task.
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { configuration } from './client.mjs';
import { parseState, parseStateMarker, assertNoStateStage } from './runtime.mjs';
import { verifySavedResult, inspectPendingResults } from './results.mjs';
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
  let stateMarker;
  try { stateMarker = parseStateMarker(readDiagnosticBytes(join(config.dataDir, 'state.initialized'), 4096)) ? 'valid' : 'absent'; }
  catch { stateMarker = 'invalid_or_unreadable'; }
  // Candidate paths come only from the existing task-scoped inspector. Project
  // results are not completion authority, and their paths/raw errors stay private.
  const pendingResults = inspectPendingResults(task, config.dataDir).map(candidate => ({
    kind: candidate.artifact.endsWith('.tmp') ? 'temporary' : 'artifact',
    integrity: candidate.integrity,
    ...(candidate.integrity === 'uncommitted' ? { bytes: candidate.bytes, sha256: candidate.sha256 } : {}),
  }));
  const records = [], starts = new Set(), segments = [];
  let filesRead = 0, malformedLines = 0, received = 0, completed = 0, failed = 0;
  const pending = new Set();
  const unscoped = { httpErrors: 0, abortedResponses: 0, unassignedToolCalls: 0 };
  for (const [segment, suffix] of [['previous', '.1'], ['current', '']]) {
    let text;
    try {
      const bytes = readDiagnosticBytes(join(config.dataDir, 'mcp-audit.jsonl' + suffix), AUDIT_LIMIT);
      if (bytes === null) { segments.push({ segment, status: 'missing' }); continue; }
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // Reject this segment, not the verified inventory or another valid segment.
      // Report degraded coverage explicitly; never substitute empty/sanitized bytes.
      segments.push({ segment, status: 'unavailable' }); continue;
    }
    segments.push({ segment, status: 'read' }); filesRead++;
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
  const degraded = segments.some(segment => segment.status === 'unavailable') || malformedLines > 0;
  const availability = filesRead ? (degraded ? 'partial' : 'observed') : (degraded ? 'unavailable' : 'not_observed');
  return {
    task: { id, status: task.status, collected: task.collected, integrity },
    stateStage, stateMarker, pendingResults, browserChecked: false,
    audit: { availability, segments, filesRead, observedRunStarts: starts.size,
      malformedLines, received, completed, failed, receivedWithoutCompletionInWindow: pending.size,
      recent: records, recentTruncated: received + completed > records.length, unscoped },
    interpretation: 'Bounded local observations only, not readiness. An absent marker may be legacy state. Pending results are uncommitted evidence, not task completion. Audit counters cover readable records only; capture may be disabled, failed, partial or rotated. Missing completion is not proof of a hung call. HTTP failures and invalid-token calls are unscoped. HTTP finish does not prove client receipt. Audit is not completion authority or proof of platform cause.',
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
