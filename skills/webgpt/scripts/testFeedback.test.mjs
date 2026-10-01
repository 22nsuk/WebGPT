import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import reporter from './test-feedback.mjs';

async function report(events) {
  let output = '';
  for await (const chunk of reporter(events)) output += chunk;
  return output;
}
const failure = (name = 'owned failure') => ({ type: 'test:complete', data: {
  name, file: '/fixture/a.test.mjs', line: 7, column: 3,
  details: { passed: false, error: { failureType: 'testCodeFailure', cause: {
    code: 'ERR_ASSERTION', message: 'expected 1, got 2', stack: 'at assertion:8:4',
  } } },
} });

test('feedback keeps actual assertion and location without inventing exit/revision evidence', async () => {
  const event = failure();
  // Node also reports the same outcome later in declaration order. Do not
  // double count it, and do not deduplicate distinct completions by test name.
  const mirror = { ...event, type: 'test:fail' };
  const output = await report([event, mirror]), value = JSON.parse(output);
  assert.equal(JSON.parse(await report([event, mirror, event, mirror])).observedFailures, 2);
  assert.equal(output.split('\n').length, 2, 'normal exhaustion retains one JSONL record');
  assert.equal(value.version, 1);
  assert.deepEqual(Object.keys(value).sort(), ['version', 'evidence', 'node', 'platform', 'arch',
    'observedFailures', 'omittedFailures', 'failures', 'processExitCode', 'revision'].sort());
  assert.equal(value.observedFailures, 1);
  assert.equal(value.omittedFailures, 0);
  assert.equal(value.processExitCode, null); assert.equal(value.revision, null);
  assert.deepEqual(value.failures[0], { name: 'owned failure', file: '/fixture/a.test.mjs',
    line: 7, column: 3, failureType: 'testCodeFailure', code: 'ERR_ASSERTION',
    message: 'expected 1, got 2', stack: 'at assertion:8:4', truncated: false });
});

test('passing, TODO and skipped events are silent; unrelated output is not copied', async () => {
  const marked = [];
  for (const field of ['todo', 'skip']) for (const value of [true, '', 'reason']) {
    const event = failure(); event.data[field] = value; marked.push(event);
  }
  const notFailures = [true, undefined, null, 0, 'false'].map(passed => ({
    type: 'test:complete', data: { ...failure().data, details: { ...failure().data.details, passed } },
  }));
  assert.equal(await report([{ type: 'test:pass', data: {} }, ...notFailures, ...marked,
    { type: 'test:stdout', data: { message: 'private output'.repeat(100000) } }]), '');
  const ordinary = failure('unmarked failure');
  Object.assign(ordinary.data, { todo: false, skip: false });
  // Ignored events must not consume the 12-entry budget or inflate counters.
  const value = JSON.parse(await report([...marked, ...marked, ...marked, ordinary]));
  assert.equal(value.observedFailures, 1); assert.equal(value.omittedFailures, 0);
  assert.deepEqual(value.failures.map(item => item.name), ['unmarked failure']);
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
  const missing = failure(); delete missing.data.details.error;
  const value = JSON.parse(await report([event, missing]));
  assert.equal(value.failures[0].message, 'timed out');
  assert.equal(value.failures[0].failureType, 'testTimeoutFailure');
  assert.equal(value.failures[1].message, null);
});

test('feedback emits the first failure before requesting another source event', async () => {
  const advanced = Promise.withResolvers(), release = Promise.withResolvers();
  async function* waiting() {
    yield failure();
    advanced.resolve();
    await release.promise;
  }
  const output = reporter(waiting()), first = output.next();
  try {
    // Compare generator progress, not elapsed wall time or scheduler speed.
    const observed = await Promise.race([
      first.then(chunk => ({ chunk })), advanced.promise.then(() => ({ advanced: true })),
    ]);
    assert.equal(observed.advanced, undefined, 'failure evidence must not wait for a later test');
    assert.match(observed.chunk.value, /expected 1, got 2/);
    assert.throws(() => JSON.parse(observed.chunk.value), SyntaxError, 'an unfinished stream is not a complete report');
    release.resolve();
    let complete = observed.chunk.value;
    for await (const chunk of output) complete += chunk;
    const value = JSON.parse(complete);
    assert.equal(value.observedFailures, 1); assert.equal(value.failures.length, 1);
    assert.equal(value.processExitCode, null);
  } finally {
    release.resolve(); await first; await output.return();
  }
});

test('event-stream failure preserves early evidence without completing the report', async () => {
  const stopped = Error('stream stopped');
  async function* broken() { yield failure(); throw stopped; }
  let partial = '';
  await assert.rejects(async () => {
    for await (const chunk of reporter(broken())) partial += chunk;
  }, error => error === stopped);
  assert.match(partial, /expected 1, got 2/);
  assert.throws(() => JSON.parse(partial), SyntaxError);
  assert.doesNotMatch(partial, /observedFailures|processExitCode/);
});

test('real Node reporters preserve failing exit status, normal output and compact feedback', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-test-feedback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'fixture.mjs');
  // Reuse the real failing and successful child runs; empty reasons still mark
  // Node outcomes, whereas explicit false must preserve an ordinary failure.
  const markedTests = "test('todo option', {todo:''}, () => {throw Error('marked failure');});\n"
    + "test('todo context', t => {t.todo('');throw Error('marked failure');});\n"
    + "test('skip option', {skip:''}, () => {throw Error('marked failure');});\n"
    + "test('skip context', t => {t.skip('');throw Error('marked failure');});\n";
  writeFileSync(file, "import test from 'node:test'; import assert from 'node:assert/strict';\n"
    + markedTests + "test('pass',()=>{});test('real assertion',{todo:false,skip:false},()=>assert.equal(1,2));\n");
  const reporterUrl = new URL('./test-feedback.mjs', import.meta.url).href;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const args = ['--test', '--test-reporter=tap', `--test-reporter=${reporterUrl}`,
    '--test-reporter-destination=stdout', '--test-reporter-destination=stderr', file];
  await assert.rejects(promisify(execFile)(process.execPath, args, { timeout: 15000, env }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /not ok .*real assertion/);
    const value = JSON.parse(error.stderr);
    assert.equal(value.observedFailures, 2); assert.equal(value.failures.length, 2);
    // Completion events include the file's failed-child summary as well as
    // the assertion. Neither is a second declaration-order test:fail event.
    assert.equal(value.failures[1].failureType, 'subtestsFailed');
    assert.equal(realpathSync(value.failures[1].file), realpathSync(file));
    assert.equal(value.failures[0].name, 'real assertion');
    // Node reports the resolved source path (e.g. macOS /var -> /private/var).
    assert.equal(value.failures[0].file, realpathSync(file));
    assert.equal(value.failures[0].code, 'ERR_ASSERTION');
    assert.match(value.failures[0].message, /1 !== 2/);
    return true;
  });
  writeFileSync(file, "import test from 'node:test'; test('pass',()=>{});\n" + markedTests);
  const result = await promisify(execFile)(process.execPath, args, { timeout: 15000, env });
  assert.equal(result.stderr, ''); assert.match(result.stdout, /ok 1 - pass/);
  assert.match(result.stdout, /# fail 0\r?\n/);
  assert.match(result.stdout, /# skipped 2\r?\n/); assert.match(result.stdout, /# todo 2\r?\n/);
});


test('completion feedback retains hook, cancelled-child, timeout and file-level failures', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-completion-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'fixture.mjs');
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const args = ['--test', '--test-reporter=tap', `--test-reporter=${new URL('./test-feedback.mjs', import.meta.url).href}`,
    '--test-reporter-destination=stdout', '--test-reporter-destination=stderr', file];
  const cases = [
    ["import {describe,it,before,after} from 'node:test';\n"
      + "describe('before suite',()=>{before(()=>{throw Error('before boundary');});it('not run',()=>{});});\n"
      + "describe('after suite',()=>{after(()=>{throw Error('after boundary');});it('passed child',()=>{});});\n",
      ['hookFailed'], ['before boundary', 'after boundary']],
    ["import test from 'node:test'; test('parent',t=>{t.test('cancelled child',()=>new Promise(()=>{}));});\n",
      ['cancelledByParent', 'subtestsFailed'], []],
    ["import test from 'node:test'; import {setTimeout} from 'node:timers/promises';\n"
      + "test('deadline',{timeout:20},()=>setTimeout(100));\n", ['testTimeoutFailure'], []],
    ["throw Error('file startup boundary');\n", ['testCodeFailure'], []],
    ["process.exit(2);\n", ['testCodeFailure'], []],
  ];
  for (const [source, types, messages] of cases) {
    writeFileSync(file, source);
    await assert.rejects(promisify(execFile)(process.execPath, args, { timeout: 15000, env }), error => {
      assert.equal(error.code, 1);
      const value = JSON.parse(error.stderr);
      assert.ok(value.failures.length > 0, source);
      assert.equal(value.observedFailures, value.failures.length, 'no duplicate declaration-order events');
      for (const type of types) assert.ok(value.failures.some(item => item.failureType === type), JSON.stringify(value));
      for (const message of messages) assert.ok(value.failures.some(item => item.message.includes(message)), JSON.stringify(value));
      assert.equal(value.processExitCode, null); assert.equal(value.revision, null);
      assert.ok(Buffer.byteLength(error.stderr) <= 32 * 1024);
      return true;
    });
  }
});
