// Opt-in parent workflow: prepare an isolated exercise, then inspect actual local
// evidence. Never drive a browser or register/retire work. Only the exact bundled
// arithmetic fixture may be evaluated; this is not a runner for returned code.
import { isUtf8 } from 'node:buffer';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isCliEntry } from './cli-entry.mjs';
import { isDeepStrictEqual } from 'node:util';
import { configuration, request } from './client.mjs';
import { readVerifiedResult } from './results.mjs';
import { readDiagnosticBytes } from './audit.mjs';
import { inspectDispatchEvidence } from './dispatch.mjs';
import { grantWorkspace } from './workspace.mjs';

export const verificationScenarios = Object.freeze(['text', 'read', 'edit', 'resume', 'connection']);
const metricNames = ['browserToolCalls', 'returnedBytes', 'parentInterventions', 'sendAttempts',
  'duplicateMessages', 'endToEndMs', 'inputTokens', 'outputTokens'];
const orders = '[{"quantity":2,"unitPrice":10},{"quantity":2,"unitPrice":7}]\n';
const original = 'export const total = rows => rows.reduce((sum, row) => sum + row.unitPrice, 0);\n';
const corrected = original.replace('sum + row.unitPrice', 'sum + row.quantity * row.unitPrice');
const connectionSeed = 'status=before\n한글 🧪\nkeep=this line\n';
const connectionFinal = connectionSeed.replace('status=before', 'status=after');
const connectionTemporary = '임시 연결 검증\n';
const connectionSample = '연결 검증 입력\n한글 🧪\n';
const connectionClaims = ['pinnedReadVerified', 'staleReadRejected', 'staleWriteRejected', 'temporaryLifecycleVerified'];
const projectMode = scenario => scenario === 'read' ? 'read' : ['edit', 'connection'].includes(scenario) ? 'edit' : null;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const invalid = () => Error('invalid verification input; preserve the private run directory');
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const readJson = (file, limit = 32768) => JSON.parse(decode(readDiagnosticBytes(file, limit) ?? Buffer.alloc(0)));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
function directory(path) {
  if (typeof path !== 'string' || !path.isWellFormed() || !isAbsolute(path)) throw invalid();
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
  const bytes = realpathSync.native(path, { encoding: 'buffer' });
  if (!isUtf8(bytes)) throw invalid();
  return bytes.toString('utf8');
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
      || typeof path !== 'string' || !path.isWellFormed() || !isAbsolute(path)) throw invalid();
  // Never adopt an old run, register automatically, or delete a partial preparation.
  const dir = join(directory(dirname(path)), basename(path));
  mkdirSync(dir, { mode: 0o700 });
  const run = { version: 1, taskId: 'verify-' + randomUUID(), scenario, mode, createdAt: new Date().toISOString() };
  const inputs = scenario === 'connection' ? { sample: connectionSample } : { orders }, modeForProject = projectMode(scenario);
  let instructions = '제공한 orders의 총 수량과 수량을 반영한 합계를 계산해 주세요. ';
  let resultShape = 'total(숫자 합계), units(숫자 총수량)';
  if (scenario === 'connection') {
    const root = join(dir, 'project'); mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, 'seed.txt'), connectionSeed, { flag: 'wx', mode: 0o600 });
    instructions = 'get_task으로 배정을 확인하고 read_input으로 sample을 읽으세요. 배정된 프로젝트의 파일 목록과 seed.txt 전체를 읽고 최초 SHA를 보존하세요. '
      + 'write_file의 oldText="status=before", text="status=after"와 최초 expectedSha256으로 한 구간만 수정하고 나머지 바이트를 보존하세요. '
      + '수정 후 전체 SHA로 고정 읽기를 확인한 뒤, 최초 SHA를 사용한 read_file과 write_file을 각각 한 번 시도해 revision conflict 거부를 확인하세요. '
      + '오래된 쓰기는 같은 oldText/text를 사용하세요. 거부 후 다시 시도하거나 우회하지 말고 seed.txt가 그대로인지 확인하세요. '
      + '그 다음 temp.txt를 정확히 "임시 연결 검증\\n"(실제 줄바꿈)으로 expectedSha256=null을 사용해 생성하고, 직접 읽은 전체 SHA로 삭제하세요. '
      + 'temp.txt의 exists:false, 최종 목록에 seed.txt만 남음, seed.txt의 최종 내용과 전체 SHA를 확인하세요. '
      + '순서는 seed 수정 → temp 생성 → temp 삭제이며 다른 파일은 만들거나 수정하지 마세요. '
      + '예상한 거부가 아닌 실패나 예기치 않은 쓰기 성공이 발생하면 즉시 변경을 멈추고 남은 증거를 보존하여 failed로 제출하세요. ';
    resultShape = 'sample(실제로 읽은 입력 문자열), seedSha256(최종 전체 SHA), pinnedReadVerified, staleReadRejected, staleWriteRejected, temporaryLifecycleVerified(각 실제 확인 여부를 JSON boolean으로 표시)';
  } else if (modeForProject) {
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
    ...(modeForProject ? { workspace: { root: join(dir, 'project'), mode: modeForProject } } : {}) };
  writeJson(join(dir, 'verification.json'), run);
  writeJson(join(dir, 'request.json'), registration);
  writeJson(join(dir, 'measurements.json'), { taskId: run.taskId,
    ...Object.fromEntries(metricNames.map(name => [name, null])) });
  return { version: 1, taskId: run.taskId, scenario, mode, registered: false, browserChecked: false };
}

// Compare owner-recorded metadata with the fixed local fixture, never open a
// controller-supplied root. Missing metadata on older workers is not no grant.
function workspaceCheck(dir, scenario, task) {
  if (!Object.hasOwn(task, 'workspace')) return 'UNAVAILABLE';
  try {
    const mode = projectMode(scenario);
    const expected = mode ? grantWorkspace({ root: directory(join(dir, 'project')), mode }) : null;
    return isDeepStrictEqual(task.workspace, expected) ? 'PASS' : 'FAIL';
  } catch { return 'FAIL'; }
}

// A missing temp file alone does not prove create/delete. Require the three
// owner-recorded revisions as well; reconciliation owns journal/backup integrity.
function connectionChecks(dir, task) {
  let files = 'FAIL';
  try {
    const root = directory(join(dir, 'project'));
    const bytes = readDiagnosticBytes(join(root, 'seed.txt'), 4096);
    if (isDeepStrictEqual(readdirSync(root), ['seed.txt']) && bytes?.equals(Buffer.from(connectionFinal))) files = 'PASS';
  } catch { /* Missing/unreadable bytes and unexpected entries remain failed evidence. */ }
  const receipts = task.changes.map(({ action, path, beforeSha256, afterSha256 }) => [action, path, beforeSha256, afterSha256]);
  const expected = [
    ['edit', 'seed.txt', digest(connectionSeed), digest(connectionFinal)],
    ['create', 'temp.txt', null, digest(connectionTemporary)],
    ['delete', 'temp.txt', digest(connectionTemporary), null],
  ];
  return { files, arithmetic: 'NOT_APPLICABLE', receipts: isDeepStrictEqual(receipts, expected) ? 'PASS' : 'FAIL' };
}

async function projectChecks(dir, scenario, task) {
  if (scenario === 'connection') return connectionChecks(dir, task);
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
  if (task.status !== 'completed') return 'FAIL';
  try {
    // Verify the owned path/link/size/SHA and parse that same snapshot once.
    // The shared reader preserves BOMs; keep this checker's one-leading-BOM JSON policy.
    const text = readVerifiedResult(task, config.dataDir).replace(/^\uFEFF/, '');
    const expected = run.scenario === 'connection' ? { sample: connectionSample, seedSha256: digest(connectionFinal),
      ...Object.fromEntries(connectionClaims.map(name => [name, true])) } : run.scenario === 'read' ? { actual: 17, expected: 34, finding: 'quantity_ignored' }
      : { total: 34, units: 4, ...(run.scenario === 'edit' ? { staleWriteRejected: true } : {}) };
    return isDeepStrictEqual(JSON.parse(text), expected) ? 'PASS' : 'FAIL';
  } catch { return 'FAIL'; }
}

export async function checkVerification(path, config = configuration()) {
  const { dir, run } = loadRun(path);
  const report = { version: 2, taskId: run.taskId, scenario: run.scenario, requestedMode: run.mode,
    scope: 'controller_and_fixture', browserChecked: false, liveVerdict: 'NOT_EVALUATED',
    localVerdict: 'BLOCKED', taskStatus: null, collection: 'unknown', checks: {},
    dispatch: { availability: 'not_recorded' },
    unverifiedClaims: run.scenario === 'connection' ? [...connectionClaims] : run.scenario === 'edit' ? ['staleWriteRejected'] : [],
    measurements: { source: 'parent_reported', availability: 'not_recorded', values: null },
    parentMustVerify: ['actual_browser_mode_connector_and_new_message', 'registered_task_and_grant', 'retained_chat', 'result_quality',
      ...(['edit', 'connection'].includes(run.scenario) ? ['actual_stale_write_rejection_call'] : []),
      ...(run.scenario === 'connection' ? ['actual_task_and_input_read_calls', 'actual_pinned_and_stale_read_calls', 'actual_temporary_file_read_and_absence_calls'] : []),
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
  try { snapshot = await request('reconcile', { ids: [run.taskId] }, config); }
  catch { report.checks.controller = 'UNAVAILABLE'; return report; }
  const task = snapshot.tasks[0];
  if (!['running', 'completed', 'failed', 'cancelled'].includes(task.status)
      || typeof task.collected !== 'boolean' || typeof task.discarded !== 'boolean'
      || ['changes', 'recoveryRequired', 'journalIssues', 'pendingResults'].some(key => !Array.isArray(task[key]))
      || task.changes.some(change => !object(change))) {
    report.checks.controller = 'UNAVAILABLE'; return report;
  }
  report.taskStatus = task.status;
  report.collection = task.discarded ? 'discarded' : task.collected ? 'collected' : 'uncollected';
  report.checks = { controller: 'PASS', controllerState: snapshot.health?.stateVerified === true ? 'PASS' : 'UNAVAILABLE',
    globalHealth: typeof snapshot.health?.ok === 'boolean' ? snapshot.health.ok ? 'PASS' : 'FAIL' : 'UNAVAILABLE',
    workspaceGrant: workspaceCheck(dir, run.scenario, task),
    recovery: task.recoveryRequired?.length || task.journalIssues?.length || task.pendingResults?.length ? 'FAIL' : 'PASS',
    result: resultCheck(run, task, config), ...await projectChecks(dir, run.scenario, task) };
  // Aggregate only this task's acceptance checks. Global readiness, dispatch and
  // reported metrics are independent observations, not fixture-quality verdicts.
  const values = ['workspaceGrant', 'recovery', 'result', 'files', 'arithmetic', 'receipts'].map(key => report.checks[key]);
  report.localVerdict = report.checks.controllerState !== 'PASS' || values.includes('UNAVAILABLE') ? 'BLOCKED'
    : task.status === 'running' ? 'PENDING'
    : values.includes('FAIL') || task.discarded || task.status !== 'completed' ? 'FAIL'
      : values.every(value => ['PASS', 'NOT_APPLICABLE'].includes(value)) ? 'PASS' : 'BLOCKED';
  return report;
}

if (isCliEntry(import.meta)) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (action === 'prepare' && args.length === 3) console.log(JSON.stringify(prepareVerification(...args)));
    else if (action === 'check' && args.length === 1) {
      const report = await checkVerification(args[0]); console.log(JSON.stringify(report));
      if (report.localVerdict !== 'PASS') process.exitCode = 2;
    } else throw invalid();
  } catch { console.error('WebGPT verification: unavailable or invalid input; inspect private evidence.'); process.exitCode = 1; }
}
