import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import reporter from './test-feedback.mjs';

async function report(events) {
  let output = '';
  for await (const chunk of reporter(events)) output += chunk;
  return output;
}
const failure = (name = 'owned failure') => ({ type: 'test:fail', data: {
  name, file: '/fixture/a.test.mjs', line: 7, column: 3,
  details: { error: { failureType: 'testCodeFailure', cause: {
    code: 'ERR_ASSERTION', message: 'expected 1, got 2', stack: 'at assertion:8:4',
  } } },
} });

test('feedback keeps actual assertion and location without inventing exit/revision evidence', async () => {
  const value = JSON.parse(await report([failure()]));
  assert.equal(value.observedFailures, 1);
  assert.equal(value.omittedFailures, 0);
  assert.equal(value.processExitCode, null); assert.equal(value.revision, null);
  assert.deepEqual(value.failures[0], { name: 'owned failure', file: '/fixture/a.test.mjs',
    line: 7, column: 3, failureType: 'testCodeFailure', code: 'ERR_ASSERTION',
    message: 'expected 1, got 2', stack: 'at assertion:8:4', truncated: false });
});

test('passing, TODO and skipped events are silent; unrelated output is not copied', async () => {
  const todo = failure(); todo.data.todo = true;
  const skip = failure(); skip.data.skip = 'platform';
  assert.equal(await report([{ type: 'test:pass', data: {} }, todo, skip,
    { type: 'test:stdout', data: { message: 'private output'.repeat(100000) } }]), '');
});

test('feedback bounds entries and bytes with explicit omission/truncation, including Unicode escaping', async () => {
  const events = Array.from({ length: 1000 }, () => {
    const event = failure('\0'.repeat(10000));
    event.data.details.error.cause.message = '🧪한국어\0'.repeat(10000);
    event.data.details.error.cause.stack = '\0'.repeat(10000);
    return event;
  });
  const output = await report(events), value = JSON.parse(output);
  assert.ok(Buffer.byteLength(output) <= 32 * 1024);
  assert.ok(value.failures.length > 0 && value.failures.length <= 12);
  assert.equal(value.observedFailures, 1000);
  assert.equal(value.omittedFailures, 1000 - value.failures.length);
  assert.ok(value.failures.every(item => item.truncated));
  assert.ok(output.isWellFormed());
});

test('wrapper-only and missing error metadata stay explicit', async () => {
  const event = failure(); event.data.details.error = { failureType: 'testTimeoutFailure', message: 'timed out' };
  const missing = failure(); delete missing.data.details;
  const value = JSON.parse(await report([event, missing]));
  assert.equal(value.failures[0].message, 'timed out');
  assert.equal(value.failures[0].failureType, 'testTimeoutFailure');
  assert.equal(value.failures[1].message, null);
});

test('event-stream failure remains a failure rather than a complete report', async () => {
  async function* broken() { yield failure(); throw Error('stream stopped'); }
  await assert.rejects(report(broken()), /stream stopped/);
});

test('real Node reporters preserve failing exit status, normal output and compact feedback', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-test-feedback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'fixture.mjs');
  writeFileSync(file, "import test from 'node:test'; import assert from 'node:assert/strict';\n"
    + "test('pass',()=>{});test('real assertion',()=>assert.equal(1,2));\n");
  const path = fileURLToPath(new URL('./test-feedback.mjs', import.meta.url));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const args = ['--test', '--test-reporter=tap', `--test-reporter=${path}`,
    '--test-reporter-destination=stdout', '--test-reporter-destination=stderr', file];
  await assert.rejects(promisify(execFile)(process.execPath, args, { timeout: 15000, env }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /not ok .*real assertion/);
    const value = JSON.parse(error.stderr);
    assert.equal(value.failures[0].name, 'real assertion');
    assert.equal(value.failures[0].file, file);
    assert.equal(value.failures[0].code, 'ERR_ASSERTION');
    assert.match(value.failures[0].message, /1 !== 2/);
    return true;
  });
  writeFileSync(file, "import test from 'node:test'; test('pass',()=>{});\n");
  const result = await promisify(execFile)(process.execPath, args, { timeout: 15000, env });
  assert.equal(result.stderr, ''); assert.match(result.stdout, /ok 1 - pass/);
});
