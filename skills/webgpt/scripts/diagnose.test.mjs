// Offline diagnostic recovery uses disposable state and loopback-only integration fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { diagnoseTask } from './diagnose.mjs';
import { AUDIT_LIMIT, readDiagnosticBytes } from './audit.mjs';
import { createStateMarker, readStateMarker } from './runtime.mjs';
import { start } from './worker.mjs';
import { request } from './client.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const logName = 'mcp-audit.jsonl';
function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'webgpt-diagnose-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = join(dir, 'state.json'), marker = join(dir, 'state.initialized');
  const task = { id: 'owned', token: 'fixture-private-token', instructions: 'fixture-private-prompt', inputs: {},
    status: 'running', collected: false, nextCheck: 1 };
  const save = () => fs.writeFileSync(state, JSON.stringify([task]), { mode: 0o600 });
  save(); createStateMarker(marker);
  return { dir, state, marker, task, save, config: { dataDir: dir } };
}
function event(taskId = 'owned') {
  return { version: 1, phase: 'tool_received', runId: randomUUID(), timestamp: '2026-09-24T00:00:00.000Z',
    requestId: randomUUID(), transportId: randomUUID(), tool: 'get_task', taskId };
}
function log(file, events) { fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 }); }
function link(t, kind, target, file) {
  try { if (kind === 'symlink') fs.symlinkSync(target, file, 'file'); else fs.linkSync(target, file); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('fixture link creation unavailable'); return false; }
    throw error;
  }
  return true;
}
function noPrivateData(report, f) {
  const json = JSON.stringify(report);
  for (const secret of [f.dir, f.task.token, f.task.instructions, 'fixture-private-evidence', 'fixture-private-error'])
    assert.equal(json.includes(secret), false, 'report must retain only bounded diagnostic metadata');
}

for (const broken of ['previous', 'current']) for (const kind of ['directory', 'utf8', 'oversized', 'symlink', 'hardlink']) {
  test(`unavailable ${broken} ${kind} audit segment does not hide valid state or the other segment`, t => {
    const f = fixture(t), previous = join(f.dir, logName + '.1'), current = join(f.dir, logName);
    const bad = broken === 'previous' ? previous : current, good = broken === 'previous' ? current : previous;
    const observed = event(); log(good, [observed, event('unrelated')]);
    const target = join(f.dir, 'fixture-evidence'); fs.writeFileSync(target, 'fixture-private-evidence');
    if (kind === 'directory') fs.mkdirSync(bad);
    else if (kind === 'utf8') fs.writeFileSync(bad, Buffer.from([0xff]));
    else if (kind === 'oversized') fs.writeFileSync(bad, Buffer.alloc(AUDIT_LIMIT + 1));
    else if (!link(t, kind, target, bad)) return;
    const state = fs.readFileSync(f.state), goodBytes = fs.readFileSync(good);
    const report = diagnoseTask('owned', f.config);
    assert.equal(report.task.status, 'running'); assert.equal(report.stateMarker, 'valid');
    assert.equal(report.audit.availability, 'partial'); assert.equal(report.audit.filesRead, 1);
    assert.deepEqual(report.audit.segments, [
      { segment: 'previous', status: broken === 'previous' ? 'unavailable' : 'read' },
      { segment: 'current', status: broken === 'current' ? 'unavailable' : 'read' },
    ]);
    assert.deepEqual(report.audit.recent, [observed]); assert.equal(report.audit.received, 1);
    assert.equal(report.browserChecked, false); noPrivateData(report, f);
    assert.deepEqual(fs.readFileSync(f.state), state); assert.deepEqual(fs.readFileSync(good), goodBytes);
    assert.equal(fs.readFileSync(target, 'utf8'), 'fixture-private-evidence');
    assert.ok(fs.lstatSync(bad));
    if (kind === 'utf8') assert.deepEqual(fs.readFileSync(bad), Buffer.from([0xff]));
    if (kind === 'oversized') assert.equal(fs.statSync(bad).size, AUDIT_LIMIT + 1);
    // The low-level reader remains fail-closed for unsafe files. UTF-8 is a decoder check.
    if (kind !== 'utf8') assert.throws(() => readDiagnosticBytes(bad, AUDIT_LIMIT), /unavailable/);
  });
}

test('missing audit segments differ from unreadable segments and an empty readable segment', t => {
  const f = fixture(t);
  assert.equal(diagnoseTask('owned', f.config).audit.availability, 'not_observed');
  for (const suffix of ['.1', '']) fs.mkdirSync(join(f.dir, logName + suffix));
  let report = diagnoseTask('owned', f.config);
  assert.equal(report.audit.availability, 'unavailable'); assert.equal(report.audit.filesRead, 0);
  assert.ok(report.audit.segments.every(s => s.status === 'unavailable'));
  fs.rmdirSync(join(f.dir, logName + '.1'));
  report = diagnoseTask('owned', f.config);
  assert.equal(report.audit.availability, 'unavailable'); assert.equal(report.audit.segments[0].status, 'missing');
  fs.rmdirSync(join(f.dir, logName)); fs.writeFileSync(join(f.dir, logName), '');
  report = diagnoseTask('owned', f.config);
  assert.equal(report.audit.availability, 'observed'); assert.equal(report.audit.filesRead, 1);
});

test('malformed lines mark audit coverage partial while retaining safe records and the output cap', t => {
  const f = fixture(t), events = Array.from({ length: 55 }, () => event());
  log(join(f.dir, logName), events);
  fs.appendFileSync(join(f.dir, logName), '{fixture-private-evidence\n');
  const report = diagnoseTask('owned', f.config);
  assert.equal(report.audit.availability, 'partial'); assert.equal(report.audit.malformedLines, 1);
  assert.equal(report.audit.received, 55); assert.deepEqual(report.audit.recent, events.slice(-50));
  assert.equal(report.audit.recentTruncated, true); noPrivateData(report, f);
});

for (const kind of ['absent', 'empty', 'invalid', 'oversized', 'directory']) {
  test(`initialization marker ${kind} is reported without repairing state`, t => {
    const f = fixture(t), original = fs.readFileSync(f.state);
    fs.unlinkSync(f.marker);
    if (kind === 'directory') fs.mkdirSync(f.marker);
    else if (kind !== 'absent') fs.writeFileSync(f.marker, kind === 'oversized' ? Buffer.alloc(4097)
      : kind === 'empty' ? '' : 'fixture-private-evidence');
    const report = diagnoseTask('owned', f.config);
    assert.equal(report.stateMarker, kind === 'absent' ? 'absent' : 'invalid_or_unreadable');
    assert.equal(report.task.status, 'running'); assert.deepEqual(fs.readFileSync(f.state), original);
    assert.equal(fs.existsSync(f.marker), kind !== 'absent'); noPrivateData(report, f);
    if (kind === 'absent') assert.equal(readStateMarker(f.marker), false, 'legacy states are still supported');
    else assert.throws(() => readStateMarker(f.marker), { code: 'STATE_INVALID' });
  });
}

for (const kind of ['symlink', 'hardlink']) test(`linked marker (${kind}) is reported but never followed`, t => {
  const f = fixture(t), target = join(f.dir, 'marker-original'), original = fs.readFileSync(f.marker);
  fs.renameSync(f.marker, target);
  if (!link(t, kind, target, f.marker)) return;
  assert.equal(diagnoseTask('owned', f.config).stateMarker, 'invalid_or_unreadable');
  assert.deepEqual(fs.readFileSync(target), original);
});

test('actual marker read caps catch concurrent growth without hiding the task', t => {
  const f = fixture(t), read = fs.readSync;
  let grew = false;
  t.mock.method(fs, 'readSync', (fd, ...args) => {
    if (!grew && fs.fstatSync(fd).ino === fs.statSync(f.marker).ino) {
      grew = true; fs.appendFileSync(f.marker, Buffer.alloc(4097));
    }
    return read(fd, ...args);
  });
  syncBuiltinESMExports();
  try { assert.equal(diagnoseTask('owned', f.config).stateMarker, 'invalid_or_unreadable'); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(grew, true);
});

test('pending result candidates remain uncommitted, task-scoped and visible after cancellation', t => {
  const f = fixture(t), final = join(f.dir, 'owned.result.txt'), staged = final + '.tmp';
  const bytes = Buffer.from('fixture-private-evidence 한국어');
  for (const file of [final, staged, join(f.dir, 'unrelated.result.txt.tmp')]) fs.writeFileSync(file, bytes);
  for (const cancelled of [false, true]) {
    if (cancelled) { f.task.status = 'cancelled'; f.task.collected = true; f.save(); }
    const state = fs.readFileSync(f.state), report = diagnoseTask('owned', f.config);
    assert.equal(report.task.integrity, 'not_expected'); assert.equal(report.task.status, f.task.status);
    assert.deepEqual(report.pendingResults, ['artifact', 'temporary'].map(kind => ({
      kind, integrity: 'uncommitted', bytes: bytes.length, sha256: hash(bytes),
    })));
    noPrivateData(report, f); assert.deepEqual(fs.readFileSync(f.state), state);
    for (const file of [final, staged]) assert.deepEqual(fs.readFileSync(file), bytes);
  }
});

test('verified collected results are distinct from a remaining uncommitted temporary result', t => {
  const f = fixture(t), final = join(f.dir, 'owned.result.txt');
  const bytes = Buffer.from('fixture-private-evidence'); fs.writeFileSync(final, bytes);
  fs.writeFileSync(final + '.tmp', bytes);
  Object.assign(f.task, { status: 'failed', collected: true, artifact: final, sha256: hash(bytes), summary: 'saved' }); f.save();
  const report = diagnoseTask('owned', f.config);
  assert.equal(report.task.integrity, 'verified'); assert.equal(report.task.status, 'failed');
  assert.deepEqual(report.pendingResults, [{ kind: 'temporary', integrity: 'uncommitted', bytes: bytes.length, sha256: hash(bytes) }]);
  noPrivateData(report, f);
});

for (const kind of ['directory', 'oversized', 'symlink', 'hardlink']) test(`unsafe pending result ${kind} has no content/path/error in the report`, t => {
  const f = fixture(t), file = join(f.dir, 'owned.result.txt.tmp'), target = join(f.dir, 'unrelated');
  fs.writeFileSync(target, 'fixture-private-evidence');
  if (kind === 'directory') fs.mkdirSync(file);
  else if (kind === 'oversized') fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
  else if (!link(t, kind, target, file)) return;
  const report = diagnoseTask('owned', f.config);
  assert.deepEqual(report.pendingResults, [{ kind: 'temporary', integrity: 'unreadable' }]);
  assert.equal(report.task.status, 'running'); noPrivateData(report, f);
  assert.equal(fs.readFileSync(target, 'utf8'), 'fixture-private-evidence'); assert.ok(fs.lstatSync(file));
});

test('read errors retain classifications instead of copying native errors into diagnostics', t => {
  const f = fixture(t), current = join(f.dir, logName), stage = join(f.dir, 'owned.result.txt.tmp');
  const original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if ([current, stage, f.marker].includes(file)) throw Object.assign(Error('fixture-private-error ' + file), { code: 'EACCES' });
    return original(file, ...args);
  }); syncBuiltinESMExports();
  try {
    const report = diagnoseTask('owned', f.config);
    assert.equal(report.stateMarker, 'invalid_or_unreadable'); assert.equal(report.audit.availability, 'unavailable');
    assert.deepEqual(report.pendingResults, [{ kind: 'temporary', integrity: 'unreadable' }]); noPrivateData(report, f);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('real controller recovery warnings also appear in offline diagnosis with audit disabled', async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'webgpt-diagnose-integration-'));
  const service = await start({ dir, port: 0, controlPort: 0, audit: false });
  t.after(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const config = { dataDir: dir, controlPort: service.controlPort };
  const registered = await request('register', { id: 'owned', instructions: 'fixture', inputs: {} }, config);
  const stage = join(dir, 'owned.result.txt.tmp'); fs.writeFileSync(stage, 'saved partial result');
  await assert.rejects(request('ready', undefined, config), error => error.details.issues.includes('RESULT_RECOVERY_REQUIRED'));
  assert.equal(diagnoseTask('owned', config).pendingResults[0].integrity, 'uncommitted');
  fs.writeFileSync(join(dir, 'state.initialized'), 'damaged marker');
  await assert.rejects(request('ready', undefined, config), error => error.details.issues.includes('STATE_INVALID'));
  const report = diagnoseTask('owned', config);
  assert.equal(report.stateMarker, 'invalid_or_unreadable'); assert.equal(report.pendingResults.length, 1);
  assert.equal(report.task.status, 'running'); assert.equal(report.audit.availability, 'not_observed');
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'state.json')))[0].token, registered.token);
});

test('CLI emits a partial report but still fails on invalid authoritative state', async t => {
  const f = fixture(t), configFile = join(f.dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(f.config)); fs.mkdirSync(join(f.dir, logName));
  const execute = promisify(execFile), cli = fileURLToPath(new URL('./diagnose.mjs', import.meta.url));
  const options = { env: { ...process.env, WEBGPT_CONFIG: configFile, WEBGPT_DATA_DIR: f.dir }, timeout: 5000 };
  const { stdout, stderr } = await execute(process.execPath, [cli, 'owned'], options);
  assert.equal(stderr, ''); assert.equal(JSON.parse(stdout).audit.availability, 'unavailable');
  noPrivateData(JSON.parse(stdout), f);
  fs.writeFileSync(f.state, '{fixture-private-evidence');
  await assert.rejects(execute(process.execPath, [cli, 'owned'], options), error => {
    assert.equal(error.code, 1); assert.equal(error.stdout, '');
    assert.equal(error.stderr.trim(), 'WebGPT diagnose: task state unavailable'); return true;
  });
});
