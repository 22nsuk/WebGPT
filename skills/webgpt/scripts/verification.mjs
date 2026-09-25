// Opt-in parent workflow: prepare an isolated exercise, then inspect actual local
// evidence. Never drive a browser or register/retire work. Only the exact bundled
// arithmetic fixture may be evaluated; this is not a runner for returned code.
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { configuration, reconcileTasks } from './client.mjs';
import { readDiagnosticBytes } from './audit.mjs';
import { inspectDispatchEvidence } from './dispatch.mjs';

export const verificationScenarios = Object.freeze(['text', 'read', 'edit', 'resume']);
const metricNames = ['browserToolCalls', 'returnedBytes', 'parentInterventions', 'sendAttempts',
  'duplicateMessages', 'endToEndMs', 'inputTokens', 'outputTokens'];
const orders = '[{"quantity":2,"unitPrice":10},{"quantity":2,"unitPrice":7}]\n';
const original = 'export const total = rows => rows.reduce((sum, row) => sum + row.unitPrice, 0);\n';
const corrected = original.replace('sum + row.unitPrice', 'sum + row.quantity * row.unitPrice');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const invalid = () => Error('invalid verification input; preserve the private run directory');
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const readJson = (file, limit = 32768) => JSON.parse(decode(readDiagnosticBytes(file, limit) ?? Buffer.alloc(0)));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
function directory(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw invalid();
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
  return realpathSync.native(path);
}
function loadRun(path) {
  const dir = directory(path), run = readJson(join(dir, 'verification.json'));
  if (!exactKeys(run, ['version', 'taskId', 'scenario', 'mode', 'createdAt']) || run.version !== 1
      || !verificationScenarios.includes(run.scenario) || !['pro', 'xhigh'].includes(run.mode)
      || typeof run.taskId !== 'string' || !/^verify-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run.taskId)
      || typeof run.createdAt !== 'string' || !Number.isFinite(Date.parse(run.createdAt))
      || new Date(run.createdAt).toISOString() !== run.createdAt) throw invalid();
  return { dir, run };
}

export function prepareVerification(scenario, path, mode) {
  if (!verificationScenarios.includes(scenario) || !['pro', 'xhigh'].includes(mode)
      || typeof path !== 'string' || !isAbsolute(path)) throw invalid();
  // Never adopt an old run, register automatically, or delete a partial preparation.
  const dir = join(directory(dirname(path)), basename(path));
  mkdirSync(dir, { mode: 0o700 });
  const run = { version: 1, taskId: 'verify-' + randomUUID(), scenario, mode, createdAt: new Date().toISOString() };
  const inputs = { orders }, project = ['read', 'edit'].includes(scenario);
  let instructions = '제공한 orders의 총 수량과 수량을 반영한 합계를 계산해 주세요. ';
  let resultShape = 'total(숫자 합계), units(숫자 총수량)';
  if (project) {
    const root = join(dir, 'project'); mkdirSync(root, { mode: 0o700 });
    for (const [name, text] of [['orders.json', orders], ['total.mjs', original]])
      writeFileSync(join(root, name), text, { flag: 'wx', mode: 0o600 });
    instructions = '배정된 작은 프로젝트의 total.mjs와 orders.json을 직접 읽고 합계 계산을 검토해 주세요. ';
    if (scenario === 'read') {
      instructions += '파일은 수정하지 말고 현재 계산값과 올바른 계산값, 결함 원인을 보고해 주세요. ';
      resultShape = 'actual(현재 계산값), expected(올바른 계산값), finding(quantity_ignored 또는 none)';
    } else {
      instructions += 'total.mjs에서 sum + row.unitPrice를 sum + row.quantity * row.unitPrice로 고치고 나머지 바이트는 보존해 주세요. '
        + '그 뒤 최초 읽기에서 얻은 이전 SHA로 같은 파일에 한 번 쓰기를 시도해 충돌 거부를 확인하고, 거부되면 다시 시도하지 마세요. '
        + 'orders.json과 다른 파일은 변경하지 마세요. ';
      resultShape = 'total(수정 후 숫자 합계), units(숫자 총수량), staleWriteRejected(실제 충돌 거부 확인 여부)';
    }
  }
  instructions += '최종 결과는 코드 펜스 없는 JSON 객체로 제출해 주세요. 필드는 ' + resultShape + ' 입니다. '
    + '배정된 실제 입력·파일과 필요한 도구 결과에서 값을 도출하세요. '
    + '확인이나 작업이 실패하면 성공으로 보고하지 말고 실패 상태와 구체적인 한계를 제출하세요. '
    + '셸·Git·프로세스 실행 권한은 없습니다. 부모가 결과를 따로 검증합니다.';
  const registration = { id: run.taskId, instructions, inputs,
    ...(project ? { workspace: { root: join(dir, 'project'), mode: scenario === 'read' ? 'read' : 'edit' } } : {}) };
  writeJson(join(dir, 'verification.json'), run);
  writeJson(join(dir, 'request.json'), registration);
  writeJson(join(dir, 'measurements.json'), { taskId: run.taskId,
    ...Object.fromEntries(metricNames.map(name => [name, null])) });
  return { version: 1, taskId: run.taskId, scenario, mode, registered: false, browserChecked: false };
}

async function projectChecks(dir, scenario, task) {
  if (!['read', 'edit'].includes(scenario)) return { files: 'NOT_APPLICABLE', arithmetic: 'NOT_APPLICABLE', receipts: task.changes.length ? 'FAIL' : 'PASS' };
  let files = 'FAIL', arithmetic = 'NOT_RUN';
  try {
    const root = directory(join(dir, 'project'));
    const data = readDiagnosticBytes(join(root, 'orders.json'), 4096), source = readDiagnosticBytes(join(root, 'total.mjs'), 4096);
    if (isDeepStrictEqual(readdirSync(root).sort(), ['orders.json', 'total.mjs']) && data?.equals(Buffer.from(orders))
        && source?.equals(Buffer.from(scenario === 'edit' ? corrected : original))) {
      files = 'PASS';
      // Evaluate these already-compared immutable bytes, not a path that can be
      // replaced after the check. No arbitrary module, imports or scripts run.
      const { total } = await import('data:text/javascript;base64,' + source.toString('base64'));
      arithmetic = total(JSON.parse(decode(data))) === (scenario === 'edit' ? 34 : 17) ? 'PASS' : 'FAIL';
    }
  } catch { /* Unreadable fixture evidence is a failed check, not absent evidence. */ }
  const receipts = scenario === 'read' ? task.changes.length === 0
    : task.changes.length === 1 && task.changes[0].action === 'edit' && task.changes[0].path === 'total.mjs'
      && task.changes[0].beforeSha256 === digest(original) && task.changes[0].afterSha256 === digest(corrected);
  return { files, arithmetic, receipts: receipts ? 'PASS' : 'FAIL' };
}
function resultCheck(run, task, config) {
  if (task.status === 'running' || !task.artifact) return 'NOT_RUN';
  if (task.status !== 'completed' || task.integrity !== 'verified') return 'FAIL';
  try {
    // Read the fixed owned result path, not an arbitrary path from the manifest or report.
    const bytes = readDiagnosticBytes(join(config.dataDir, run.taskId + '.result.txt'), 1024 * 1024);
    if (!bytes || digest(bytes) !== task.sha256) return 'FAIL';
    const expected = run.scenario === 'read' ? { actual: 17, expected: 34, finding: 'quantity_ignored' }
      : { total: 34, units: 4, ...(run.scenario === 'edit' ? { staleWriteRejected: true } : {}) };
    return isDeepStrictEqual(JSON.parse(decode(bytes)), expected) ? 'PASS' : 'FAIL';
  } catch { return 'FAIL'; }
}

export async function checkVerification(path, config = configuration()) {
  const { dir, run } = loadRun(path);
  const report = { version: 1, taskId: run.taskId, scenario: run.scenario, requestedMode: run.mode,
    scope: 'controller_and_fixture', browserChecked: false, liveVerdict: 'NOT_EVALUATED',
    localVerdict: 'BLOCKED', collection: 'unknown', checks: {},
    dispatch: { availability: 'not_recorded' },
    unverifiedClaims: run.scenario === 'edit' ? ['staleWriteRejected'] : [],
    measurements: { source: 'parent_reported', availability: 'not_recorded', values: null },
    parentMustVerify: ['actual_browser_mode_connector_and_new_message', 'registered_task_and_grant', 'retained_chat', 'result_quality',
      ...(run.scenario === 'edit' ? ['actual_stale_write_rejection_call'] : []),
      ...(run.scenario === 'resume' ? ['fresh_parent_resume_without_redispatch'] : [])] };
  try {
    const metrics = readJson(join(dir, 'measurements.json'));
    if (!exactKeys(metrics, ['taskId', ...metricNames]) || metrics.taskId !== run.taskId
        || metricNames.some(name => metrics[name] !== null && (!Number.isSafeInteger(metrics[name]) || metrics[name] < 0))) throw invalid();
    report.measurements = { source: 'parent_reported', availability: metricNames.some(name => metrics[name] !== null) ? 'recorded' : 'not_recorded',
      values: Object.fromEntries(metricNames.map(name => [name, metrics[name]])) };
  } catch { report.measurements.availability = 'invalid_or_unavailable'; }
  const ledger = join(dir, 'dispatch.json');
  try {
    // Missing is not success; invalid/mismatched evidence cannot certify this run.
    let present = true;
    try { lstatSync(ledger); } catch (error) { if (error.code !== 'ENOENT') throw error; present = false; }
    if (present) {
      const observed = await inspectDispatchEvidence(ledger, run.taskId);
      report.dispatch = { availability: 'recorded', ...observed };
      if (observed.mode !== run.mode || !observed.connectorRequired) report.dispatch.availability = 'mismatched';
    }
  } catch { report.dispatch.availability = 'invalid_or_unavailable'; }
  let snapshot;
  try { snapshot = await reconcileTasks(config, { ids: [run.taskId] }); }
  catch { report.checks.controller = 'UNAVAILABLE'; return report; }
  const task = snapshot.tasks[0];
  if (!['running', 'completed', 'failed', 'cancelled'].includes(task.status)
      || typeof task.collected !== 'boolean' || typeof task.discarded !== 'boolean'
      || ['changes', 'recoveryRequired', 'journalIssues', 'pendingResults'].some(key => !Array.isArray(task[key]))
      || task.changes.some(change => !object(change))) {
    report.checks.controller = 'UNAVAILABLE'; return report;
  }
  report.collection = task.discarded ? 'discarded' : task.collected ? 'collected' : 'uncollected';
  report.checks = { controller: 'PASS', globalHealth: snapshot.health?.ok === true ? 'PASS' : 'FAIL',
    recovery: task.recoveryRequired?.length || task.journalIssues?.length || task.pendingResults?.length ? 'FAIL' : 'PASS',
    result: resultCheck(run, task, config), ...await projectChecks(dir, run.scenario, task) };
  const values = Object.values(report.checks);
  report.localVerdict = task.status === 'running' ? 'PENDING'
    : values.includes('FAIL') || task.discarded || task.status !== 'completed' ? 'FAIL'
      : values.includes('NOT_RUN') ? 'BLOCKED' : 'PASS';
  return report;
}

if (process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (action === 'prepare' && args.length === 3) console.log(JSON.stringify(prepareVerification(...args)));
    else if (action === 'check' && args.length === 1) {
      const report = await checkVerification(args[0]); console.log(JSON.stringify(report));
      if (report.localVerdict !== 'PASS') process.exitCode = 2;
    } else throw invalid();
  } catch { console.error('WebGPT verification: unavailable or invalid input; inspect private evidence.'); process.exitCode = 1; }
}
