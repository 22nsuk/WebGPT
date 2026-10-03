import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildHandoff } from './handoff.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'webgpt-handoff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (label, role, content, requiredFor = []) => {
    const source = join(dir, label + ' 한글 # %.txt');
    fs.writeFileSync(source, content);
    return { label, role, source, requiredFor, delivery: 'named input: ' + label };
  };
  const spec = { assignment: { id: 'task-21', revision: 'rev2' }, assignee: 'pro',
    files: [file('brief', 'brief', 'rev2\r\n🧪\r\n', ['implementation']),
      file('code', 'source', 'original', ['implementation', 'validation']),
      file('test-log', 'evidence', 'one real failure')], checks: [] };
  const check = { id: 'boundary', requirement: 'missing evidence remains unknown',
    command: 'approved test command', environment: 'CPU fixture', status: 'FAIL',
    exitCode: 1, signal: null, reason: 'expected UNKNOWN; actual FAIL',
    testedFiles: [{ label: 'code', sha256: hash('original') }], evidenceLabels: ['test-log'] };
  const run = args => spawnSync(process.execPath,
    [fileURLToPath(new URL('./client.mjs', import.meta.url)), 'handoff', ...args],
    { encoding: 'utf8', timeout: 10000, windowsHide: true,
      env: { ...process.env, WEBGPT_CONFIG: join(dir, 'invalid-config'), WEBGPT_DATA_DIR: join(dir, 'no-runtime') } });
  return { dir, spec, check, file, run };
}

test('assignment identity follows exact brief/input bytes, not assignee or feedback', t => {
  const { spec } = fixture(t), first = buildHandoff(spec);
  assert.equal(first.assignment.briefSha256, hash('rev2\r\n🧪\r\n'));
  spec.assignee = 'xhigh'; spec.files.reverse();
  assert.deepEqual(buildHandoff(spec).assignment, first.assignment);
  fs.writeFileSync(spec.files.find(f => f.role === 'evidence').source, 'new log');
  assert.deepEqual(buildHandoff(spec).assignment, first.assignment);
  fs.writeFileSync(spec.files.find(f => f.role === 'brief').source, 'rev2\n🧪\n');
  assert.notEqual(buildHandoff(spec).assignment.inputIdentitySha256, first.assignment.inputIdentitySha256);
});

test('declared missing dependencies distinguish design, implementation and validation gaps', t => {
  const { spec, dir } = fixture(t);
  spec.files.push({ label: 'runtime', role: 'source', source: join(dir, 'missing'),
    requiredFor: ['validation'], delivery: 'not delivered' },
  { label: 'accepted-spec', role: 'acceptance', unavailableReason: 'acceptance pending',
    requiredFor: ['implementation'], delivery: 'not delivered' });
  const result = buildHandoff(spec);
  assert.deepEqual(result.inputGaps, { design: [], implementation: ['accepted-spec'], validation: ['runtime'] });
  assert.equal(result.files.find(f => f.label === 'runtime').status, 'missing');
  assert.equal(result.files.find(f => f.label === 'accepted-spec').status, 'unavailable');
  assert.equal(result.acceptance, 'not_assessed');
  assert.equal(result.dependencyDiscovery, 'not_performed');
});

test('mismatched required input remains a gap and a missing or mismatched brief rejects', t => {
  const { spec } = fixture(t);
  spec.files[1].expectedSha256 = hash('different');
  assert.deepEqual(buildHandoff(spec).inputGaps.implementation, ['code']);
  spec.files[0].expectedSha256 = hash('old brief');
  assert.throws(() => buildHandoff(spec), { code: 'HANDOFF_INVALID' });
  delete spec.files[0].expectedSha256;
  fs.unlinkSync(spec.files[0].source);
  assert.throws(() => buildHandoff(spec), { code: 'HANDOFF_INVALID' });
});

test('feedback retains before-fix failures and marks old PASS stale after a real edit', t => {
  const { spec, check } = fixture(t);
  spec.checks.push(check);
  assert.equal(buildHandoff(spec).checks[0].applicability, 'current');
  check.status = 'PASS'; check.exitCode = 0;
  fs.writeFileSync(spec.files[1].source, 'corrected');
  const result = buildHandoff(spec).checks[0];
  assert.equal(result.reportedStatus, 'PASS');
  assert.equal(result.applicability, 'stale');
  assert.deepEqual(result.staleFiles, ['code']);
  assert.equal(result.testedFiles[0].sha256, hash('original'));
});

test('missing log or tested source makes applicability unknown without inventing failure', t => {
  const { spec, check } = fixture(t);
  spec.checks.push(check); fs.unlinkSync(spec.files[2].source);
  let result = buildHandoff(spec).checks[0];
  assert.equal(result.applicability, 'unknown'); assert.deepEqual(result.missingEvidence, ['test-log']);
  fs.unlinkSync(spec.files[1].source); result = buildHandoff(spec).checks[0];
  assert.equal(result.reportedStatus, 'FAIL'); assert.deepEqual(result.unknownFiles, ['code']);
});

test('editing the next attempt specification cannot rewrite an already built feedback packet', t => {
  const { spec, check } = fixture(t);
  spec.checks.push(check);
  const packet = buildHandoff(spec), saved = JSON.stringify(packet);
  check.testedFiles[0].sha256 = hash('next attempt');
  check.testedFiles.push({ label: 'brief', sha256: hash('next brief') });
  check.evidenceLabels.push('next-log');
  spec.files[0].requiredFor.push('validation'); spec.assignment.revision = 'rev3';
  assert.equal(JSON.stringify(packet), saved);
});

test('NOT_RUN survives independently of authored tests, package hashes and successful checks', t => {
  const { spec, check, file } = fixture(t);
  spec.files.push(file('archive', 'package', 'opaque package bytes'));
  spec.checks.push({ ...check, status: 'NOT_RUN', exitCode: null, reason: 'GPU not authorized', testedFiles: [], evidenceLabels: [] });
  const result = buildHandoff(spec);
  assert.equal(result.checks[0].reportedStatus, 'NOT_RUN');
  assert.equal(result.checks[0].applicability, 'unknown');
  assert.equal(result.deliveryVerified, false); assert.equal(result.grantsExecution, false);
  assert.equal(result.contentsIncluded, false);
  assert.equal(result.checkEvidence, 'caller_reported');
  assert.equal(result.files.at(-1).sha256, hash('opaque package bytes'));
});

test('invalid or contradictory check evidence rejects rather than manufacturing PASS', t => {
  const { spec, check } = fixture(t);
  for (const change of [ { status: 'PASS' }, { status: 'PASS', exitCode: 0, signal: 'SIGTERM' },
    { status: 'PASS', exitCode: 0, testedFiles: [] }, { evidenceLabels: ['code'] },
    { testedFiles: [{ label: 'typo', sha256: hash('original') }] },
    { status: 'NOT_RUN' }, { testedFiles: [check.testedFiles[0], check.testedFiles[0]] } ]) {
    assert.throws(() => buildHandoff({ ...spec, checks: [{ ...check, ...change }] }), { code: 'HANDOFF_INVALID' });
  }
});

test('duplicate labels, unknown fields, malformed paths and oversized specifications reject', t => {
  const { spec } = fixture(t);
  for (const change of [ { files: [...spec.files, spec.files[0]] }, { shell: 'do not run' },
    { files: [{ ...spec.files[0], source: 'relative' }] },
    { files: [{ ...spec.files[0], source: spec.files[0].source + '\ud800' }] },
    { files: Array(65).fill(spec.files[0]) } ]) {
    assert.throws(() => buildHandoff({ ...spec, ...change }), { code: 'HANDOFF_INVALID' });
  }
});

test('unsupported file types are not reclassified as missing inputs', t => {
  const { spec, dir } = fixture(t);
  spec.files[1].source = dir;
  assert.throws(() => buildHandoff(spec), { code: 'UNSUPPORTED_SOURCE' });
});

test('a source disappearing after its initial observation aborts rather than becoming a missing dependency', t => {
  const { spec } = fixture(t), original = fs.openSync;
  t.mock.method(fs, 'openSync', (source, ...args) => {
    if (source === spec.files[1].source) throw Object.assign(Error('removed during capture'), { code: 'ENOENT' });
    return original(source, ...args);
  });
  assert.throws(() => buildHandoff(spec), { code: 'ENOENT' });
});

test('CLI reads a private spec without configuration, execution, delivery or runtime writes', t => {
  const { spec, check, dir, run } = fixture(t);
  const sentinel = join(dir, 'must-not-exist');
  check.command = `node -e "require('fs').writeFileSync(process.argv[1], 'bad')" "${sentinel}"`;
  spec.checks = [check];
  const source = join(dir, 'spec.json');
  fs.writeFileSync(join(dir, 'invalid-config'), '{'); fs.writeFileSync(source, '\ufeff' + JSON.stringify(spec));
  const child = run([source]);
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.kind, 'webgpt-handoff'); assert.equal(result.checks[0].command, check.command);
  assert.equal(fs.existsSync(sentinel), false); assert.equal(fs.existsSync(join(dir, 'no-runtime')), false);
  // Only caller-supplied free text (the command) may contain a path. Sources are omitted.
  assert.ok(!JSON.stringify(result.files).includes(dir));
});

test('CLI errors keep private paths/content out of diagnostics and produce no packet', t => {
  const { dir, run } = fixture(t), source = join(dir, 'PRIVATE.json');
  for (const bytes of [Buffer.from('{PRIVATE'), Buffer.from([0xff]), Buffer.alloc(65537, 32)]) {
    fs.writeFileSync(source, bytes);
    const child = run([source]);
    assert.equal(child.error, undefined); assert.equal(child.status, 1); assert.equal(child.stdout, '');
    assert.match(child.stderr, /HANDOFF_FAILED/); assert.ok(!child.stderr.includes('PRIVATE'));
  }
  assert.equal(run([]).status, 1);
});
