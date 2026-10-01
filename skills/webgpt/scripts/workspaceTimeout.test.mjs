// Exercise the real workspace mutation/recovery path with only the Windows
// child-process result injected. This is not a native ACL or kernel-hang test.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { grantWorkspace, readWorkspace, changeWorkspace, inspectRecovery } from './workspace.mjs';
import { diagnoseReplacement } from './windows-replacement-diagnostics.mjs';

const privateText = 'PRIVATE_CHILD_OUTPUT';
const timedOut = () => ({ status: null, signal: 'SIGTERM', stdout: privateText, stderr: privateText,
  error: Object.assign(Error(privateText), { code: 'ETIMEDOUT', path: privateText, spawnargs: [privateText] }) });

for (const outcome of ['prepare_without_stage', 'prepare_with_stage', 'replace_before_move', 'replace_after_move']) {
  test(`Windows helper timeout preserves uncertain ${outcome} evidence without retry`, t => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-timeout-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const root = join(dir, 'project'); fs.mkdirSync(root);
    const file = join(root, 'seed.txt'); fs.writeFileSync(file, 'before 한글\n');
    const grant = grantWorkspace({ root, mode: 'edit' }), before = readWorkspace(grant, 'seed.txt');
    const calls = [], action = outcome.startsWith('prepare') ? 'prepare' : 'replace';
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const mock = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
      const request = JSON.parse(options.input), step = args.at(-1);
      calls.push({ command, args, options, request, step });
      if (step === 'prepare' && outcome !== 'prepare_without_stage')
        fs.writeFileSync(request.temporary, '', { flag: 'wx', mode: 0o600 });
      if (step !== action) return { status: 0, signal: null, stdout: '', stderr: '' };
      // A process may finish the native move before timing out on exit. The
      // parent must not turn the resulting bytes into an applied receipt.
      if (outcome === 'replace_after_move') fs.renameSync(request.temporary, request.file);
      return timedOut();
    });
    let failure;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      syncBuiltinESMExports();
      assert.throws(() => changeWorkspace(grant, dir, 'task', {
        path: 'seed.txt', text: 'after 한글\n', expectedSha256: before.sha256,
      }), error => { failure = error; return error.code === 'WINDOWS_REPLACEMENT_FAILED'; });
    } finally {
      mock.mock.restore(); syncBuiltinESMExports();
      Object.defineProperty(process, 'platform', platform);
    }
    assert.deepEqual(calls.map(call => call.step), action === 'prepare' ? ['prepare'] : ['prepare', 'replace']);
    for (const call of calls) {
      assert.equal(call.options.timeout, 30000, 'each helper invocation must have a finite execution budget');
      assert.equal(call.options.windowsHide, true); assert.equal(call.options.maxBuffer, 64 * 1024);
      assert.equal(call.options.shell, undefined, 'never introduce a shell wrapper');
      assert.equal(call.args.includes(file), false, 'paths remain data on stdin');
    }
    assert.equal(failure.recoveryReviewRequired, true); assert.equal(failure.diagnosticSaved, true);
    assert.equal(failure.diagnostic.action, action); assert.equal(failure.diagnostic.processCode, 'ETIMEDOUT');
    assert.equal(failure.diagnostic.diagnosticStatus, 'process_timeout');
    assert.equal(failure.diagnostic.stage, 'unknown'); assert.equal(failure.diagnostic.reason, 'unknown');
    const recovery = join(dir, 'recovery', 'task'), journal = join(recovery, failure.operation + '.json');
    const record = JSON.parse(fs.readFileSync(journal, 'utf8'));
    assert.equal(record.state, 'prepared'); assert.equal(record.beforeSha256, before.sha256);
    assert.equal(fs.readFileSync(record.backup, 'utf8'), before.text);
    assert.equal(fs.existsSync(journal + '.tmp'), false);
    assert.equal(fs.readFileSync(file, 'utf8'), outcome === 'replace_after_move' ? 'after 한글\n' : before.text);
    const stage = calls[0].request.temporary;
    assert.equal(fs.existsSync(stage), ['prepare_with_stage', 'replace_before_move'].includes(outcome));
    if (fs.existsSync(stage)) assert.equal(fs.readFileSync(stage, 'utf8'), action === 'prepare' ? '' : 'after 한글\n');
    const saved = fs.readFileSync(join(recovery, failure.operation + '.diagnostic.txt'), 'utf8');
    assert.deepEqual(JSON.parse(saved), { ...failure.diagnostic, operation: failure.operation });
    for (const secret of [privateText, dir, file]) {
      assert.equal(saved.includes(secret), false); assert.equal(failure.message.includes(secret), false);
    }
    const entries = fs.readdirSync(recovery).sort(), bytes = fs.readFileSync(journal);
    assert.deepEqual(inspectRecovery(dir, 'task'), { receipts: [], unresolved: [journal] });
    assert.deepEqual(fs.readFileSync(journal), bytes, 'inspection must not promote or repair the prepared journal');
    assert.deepEqual(fs.readdirSync(recovery).sort(), entries);
    assert.equal(entries.length, 3, 'only the original, prepared journal and private diagnostic are retained');
    assert.equal(basename(stage), '.webgpt-' + failure.operation + '.tmp');
  });
}

test('timeout classification ignores incomplete or apparently successful helper output', () => {
  for (const action of ['prepare', 'replace']) for (const status of [null, 0, 1]) {
    const result = { ...timedOut(), status, stderr: JSON.stringify({ version: 1, action,
      stage: 'verify_stage_ownership', reason: 'unknown', exceptions: [], chainTruncated: false }) };
    const diagnostic = diagnoseReplacement(action, result);
    assert.equal(diagnostic.diagnosticStatus, 'process_timeout'); assert.equal(diagnostic.processCode, 'ETIMEDOUT');
    assert.equal(diagnostic.stage, 'unknown'); assert.equal(diagnostic.reason, 'unknown');
    assert.deepEqual(diagnostic.exceptions, []); assert.equal(JSON.stringify(diagnostic).includes(privateText), false);
  }
  for (const [result, status, code] of [
    [{ error: { code: 'ENOBUFS' } }, 'output_limit', 'ENOBUFS'],
    [{ error: { code: 'ENOENT' } }, 'process_error', 'ENOENT'],
    [{ error: { code: privateText } }, 'process_error', 'unknown'],
    [{ signal: 'SIGTERM', stderr: privateText }, 'process_interrupted', null],
  ]) {
    const diagnostic = diagnoseReplacement('replace', result);
    assert.equal(diagnostic.diagnosticStatus, status); assert.equal(diagnostic.processCode, code);
  }
});
