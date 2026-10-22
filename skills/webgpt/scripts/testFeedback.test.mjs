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
    { type: 'test:watch:drained', data: undefined }, { type: 'test:watch:restarted', data: undefined },
    { type: 'test:stdout', data: { message: 'private output'.repeat(100000) } }]), '');
  const ordinary = failure('unmarked failure');
  Object.assign(ordinary.data, { todo: false, skip: false });
  // Ignored events must not consume the 12-entry budget or inflate counters.
  const value = JSON.parse(await report([...marked, ...marked, ...marked, ordinary]));
  assert.equal(value.observedFailures, 1); assert.equal(value.omittedFailures, 0);
  assert.deepEqual(value.failures.map(item => item.name), ['unmarked failure']);
});

test('hook failures retain standalone events and count completion mirrors once', async () => {
  for (const type of ['test', 'suite', undefined]) {
    const event = failure('hook');
    event.data.details.error.failureType = 'hookFailed';
    if (type !== undefined) event.data.details.type = type;
    const mirror = { ...event, type: 'test:fail' };
    const value = JSON.parse(await report([event, mirror]));
    assert.equal(value.observedFailures, 1);
    assert.equal(value.failures[0].failureType, 'hookFailed');
  }
  const standalone = failure('root after');
  standalone.type = 'test:fail';
  standalone.data.details.error.failureType = 'hookFailed';
  delete standalone.data.details.passed;
  assert.equal(JSON.parse(await report([standalone])).failures[0].name, 'root after');
});

test('feedback bounds entries and bytes with explicit omission/truncation, including Unicode escaping', async () => {
  const causes = Array.from({ length: 3 }, () => ({
    name: '\0'.repeat(10000), code: '\0'.repeat(10000), message: '\0'.repeat(10000),
  }));
  causes[0].cause = causes[1]; causes[1].cause = causes[2];
  const events = Array.from({ length: 1000 }, () => {
    const event = failure('\0'.repeat(10000));
    event.data.file = '\0'.repeat(10000);
    event.data.details.error.failureType = '\0'.repeat(10000);
    event.data.details.error.cause.code = '\0'.repeat(10000);
    event.data.details.error.cause.message = '🧪한국어\0'.repeat(10000);
    event.data.details.error.cause.stack = '\0'.repeat(10000);
    event.data.details.error.cause.cause = causes[0];
    return event;
  });
  const output = await report(events), value = JSON.parse(output);
  assert.ok(Buffer.byteLength(output) <= 32 * 1024);
  assert.ok(value.failures.length > 0 && value.failures.length <= 12);
  assert.ok(value.failures[0].message.includes('🧪한국어'), 'retain Unicode failure evidence');
  assert.deepEqual(value.failures[0].causes, Array.from({ length: 3 }, () => ({
    name: '\0'.repeat(64), code: '\0'.repeat(128), message: '\0'.repeat(256),
  })));
  assert.equal(value.observedFailures, 1000);
  assert.equal(value.omittedFailures, 1000 - value.failures.length);
  assert.ok(value.failures.every(item => item.truncated));
  assert.ok(output.isWellFormed());
  // Even the first event's maximum-size, JSON-escaped fields must fit together.
  events[0].data.details.error.cause.message = '\0'.repeat(10000);
  const worst = await report([events[0]]), retained = JSON.parse(worst).failures;
  assert.ok(Buffer.byteLength(worst) <= 32 * 1024);
  assert.equal(retained.length, 1, 'cause detail must not crowd out the first failure');
  assert.equal(retained[0].message, '\0'.repeat(1024));
});

test('wrapper-only and missing error metadata stay explicit', async () => {
  const event = failure(); event.data.details.error = { failureType: 'testTimeoutFailure', message: 'timed out' };
  const missing = failure(); delete missing.data.details.error;
  const value = JSON.parse(await report([event, missing]));
  assert.equal(value.failures[0].message, 'timed out');
  assert.equal(value.failures[0].failureType, 'testTimeoutFailure');
  assert.equal(value.failures[1].message, null);
});

test('feedback preserves only allowlisted cause fields in immediate-to-deepest order', async () => {
  const event = failure(), error = event.data.details.error.cause;
  error.cause = {
    name: 'TypeError', message: 'fetch failed', stack: 'private inner stack', request: 'private request',
    toJSON() { throw Error('must not serialize the original cause'); },
    cause: { name: 'Error', code: 'ECONNRESET', message: 'socket closed' },
  };
  const output = await report([event]), item = JSON.parse(output).failures[0];
  assert.equal(item.code, 'ERR_ASSERTION'); assert.equal(item.message, 'expected 1, got 2');
  assert.deepEqual(item.causes, [
    { name: 'TypeError', code: null, message: 'fetch failed' },
    { name: 'Error', code: 'ECONNRESET', message: 'socket closed' },
  ]);
  assert.equal(item.truncated, false); assert.equal(Object.hasOwn(item, 'causeOmitted'), false);
  assert.doesNotMatch(output, /private inner stack|private request|toJSON/);
  error.cause = { message: '🧪한국어'.repeat(100) };
  const clipped = JSON.parse(await report([event])).failures[0];
  assert.equal(clipped.causes[0].message.length, 256);
  assert.ok(clipped.causes[0].message.isWellFormed());
  assert.equal(clipped.truncated, true, 'cause-only clipping must mark the failure');
});

test('feedback marks depth, cycle and unsupported cause omissions without following them', async () => {
  const event = failure(), error = event.data.details.error.cause;
  const causes = Array.from({ length: 4 }, (_, index) => ({ name: 'Error', message: `cause ${index}` }));
  for (let index = 0; index < causes.length - 1; index++) causes[index].cause = causes[index + 1];
  error.cause = causes[0];
  const deep = JSON.parse(await report([event])).failures[0];
  assert.deepEqual(deep.causes.map(cause => cause.message), ['cause 0', 'cause 1', 'cause 2']);
  assert.equal(deep.causeOmitted, 'depth'); assert.equal(deep.truncated, true);
  for (const indirect of [false, true]) {
    error.cause = indirect ? { name: 'Error', message: 'inner', cause: error } : error;
    const cyclic = JSON.parse(await report([event])).failures[0];
    assert.equal(cyclic.causes.length, indirect ? 1 : 0);
    assert.equal(cyclic.causeOmitted, 'cycle'); assert.equal(cyclic.truncated, true);
  }
  for (const cause of [false, 0, 'private primitive', 1n, Symbol('private symbol'), () => {}]) {
    error.cause = cause;
    const output = await report([event]), item = JSON.parse(output).failures[0];
    assert.deepEqual(item.causes, []); assert.equal(item.causeOmitted, 'unsupported');
    assert.equal(item.truncated, true); assert.doesNotMatch(output, /private primitive|private symbol/);
  }
});

test('feedback emits the first failure before requesting another source event', async () => {
  const advanced = Promise.withResolvers(), release = Promise.withResolvers();
  const event = failure();
  event.data.details.error.cause.cause = { name: 'Error', code: 'ECONNRESET', message: 'early cause' };
  async function* waiting() {
    yield event;
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
    assert.match(observed.chunk.value, /ECONNRESET/);
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
  const requestAssertionUrl = new URL('./test-fixtures/request-error.mjs', import.meta.url).href;
  writeFileSync(file, "import test from 'node:test'; import assert from 'node:assert/strict';\n"
    + `import { rejectsRequest } from ${JSON.stringify(requestAssertionUrl)};\n`
    + markedTests + "test('pass',()=>{});test('real assertion',{todo:false,skip:false},()=>assert.equal(1,2));\n"
    + "test('fetch cause',()=>{throw new TypeError('fetch failed',{cause:Object.assign(Error('socket closed'),"
    + "{code:'ECONNRESET',stack:'private inner stack',request:'private request'})});});\n"
    // An already aborted fetch supplies a real DOMException rejection without
    // a network dependency or a race against an elapsed-time timeout.
    + "const timeoutRequest=()=>{const controller=new AbortController();"
    + "controller.abort(new DOMException('controlled request timeout','TimeoutError'));"
    + "return fetch('data:text/plain,unused',{signal:controller.signal});};\n"
    + "test('request object mismatch',()=>rejectsRequest(timeoutRequest(),{code:'EIO',statusCode:503}));\n"
    + "test('request false predicate',()=>rejectsRequest(Promise.reject(new TypeError('fetch failed',"
    + "{cause:Object.assign(Error('socket closed'),{code:'ECONNRESET'})})),()=>false));\n"
    + "test('request throwing assertion',()=>rejectsRequest(timeoutRequest(),error=>{assert.equal(error.code,'EIO');return true;}));\n"
    + "test('request validator shape error',()=>rejectsRequest(Promise.reject(new TypeError('fetch failed',"
    + "{cause:Object.assign(Error('socket closed'),{code:'ECONNRESET'})})),error=>error.details.issues.includes('expected issue')));\n");
  const reporterUrl = new URL('./test-feedback.mjs', import.meta.url).href;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const args = ['--test', '--test-reporter=tap', `--test-reporter=${reporterUrl}`,
    '--test-reporter-destination=stdout', '--test-reporter-destination=stderr', file];
  await assert.rejects(promisify(execFile)(process.execPath, args, { timeout: 15000, env }), error => {
    assert.equal(error.code, 1);
    assert.equal(error.signal, null); assert.equal(error.killed, false);
    assert.match(error.stdout, /not ok .*real assertion/);
    const value = JSON.parse(error.stderr);
    assert.equal(value.observedFailures, 7); assert.equal(value.failures.length, 7);
    // Completion events include the file's failed-child summary as well as
    // the assertion. Neither is a second declaration-order test:fail event.
    assert.equal(value.failures.at(-1).failureType, 'subtestsFailed');
    assert.equal(realpathSync(value.failures.at(-1).file), realpathSync(file));
    assert.equal(value.failures[0].name, 'real assertion');
    // Node reports the resolved source path (e.g. macOS /var -> /private/var).
    assert.equal(value.failures[0].file, realpathSync(file));
    assert.equal(value.failures[0].code, 'ERR_ASSERTION');
    assert.match(value.failures[0].message, /1 !== 2/);
    const nested = value.failures[1];
    assert.equal(nested.name, 'fetch cause'); assert.equal(nested.code, null);
    assert.equal(nested.message, 'fetch failed');
    assert.deepEqual(nested.causes, [{ name: 'Error', code: 'ECONNRESET', message: 'socket closed' }]);
    assert.equal(nested.truncated, false);
    for (const name of ['request object mismatch', 'request throwing assertion']) {
      const item = value.failures.find(item => item.name === name);
      assert.equal(item.code, 'ERR_ASSERTION');
      assert.deepEqual(item.causes, [{ name: 'TimeoutError', code: '23', message: 'controlled request timeout' }]);
      assert.equal(item.truncated, false);
    }
    const predicate = value.failures.find(item => item.name === 'request false predicate');
    assert.equal(predicate.code, 'ERR_ASSERTION');
    const shape = value.failures.find(item => item.name === 'request validator shape error');
    assert.equal(shape.code, null); assert.match(shape.message, /issues/);
    for (const item of [predicate, shape]) {
      assert.deepEqual(item.causes, [
        { name: 'TypeError', code: null, message: 'fetch failed' },
        { name: 'Error', code: 'ECONNRESET', message: 'socket closed' },
      ]);
    }
    assert.ok(Buffer.byteLength(error.stderr) <= 32 * 1024);
    assert.doesNotMatch(error.stderr, /private inner stack|private request/);
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
    ["import test,{after} from 'node:test'; test('passing child',()=>{});\n"
      + "after(()=>{throw Error('root after boundary');});\n", ['hookFailed'], ['root after boundary']],
    ...['beforeEach', 'afterEach'].map(hook => [
      `import test,{${hook}} from 'node:test'; ${hook}(()=>{throw Error('${hook} boundary');}); test('child',()=>{});\n`,
      ['hookFailed'], [`${hook} boundary`],
    ]),
    // Newer Node versions wait for outstanding subtests after a successful
    // parent body. Fail the parent after the child starts to force cancellation.
    ["import test from 'node:test'; test('parent',async t=>{\n"
      + "let started; const ready=new Promise(resolve=>{started=resolve;});\n"
      + "t.test('cancelled child',()=>{started();return new Promise(()=>{});});\n"
      + "await ready; throw Error('parent cancellation boundary');});\n",
      ['cancelledByParent', 'subtestsFailed'], ['parent cancellation boundary']],
    ["import test from 'node:test'; import {setTimeout} from 'node:timers/promises';\n"
      + "test('deadline',{timeout:20},()=>setTimeout(100));\n", ['testTimeoutFailure'], []],
    ["throw Error('file startup boundary');\n", ['testCodeFailure'], []],
    ["process.exit(2);\n", ['testCodeFailure'], []],
  ];
  for (const [source, types, messages] of cases) {
    writeFileSync(file, source);
    await assert.rejects(promisify(execFile)(process.execPath, args, { timeout: 15000, env }), error => {
      assert.equal(error.code, 1, JSON.stringify({ source, signal: error.signal, killed: error.killed,
        stdout: error.stdout?.slice(-8192), stderr: error.stderr?.slice(-8192) }));
      assert.equal(error.killed, false, 'the fixture must finish without the execFile watchdog');
      assert.equal(error.signal, null);
      const value = JSON.parse(error.stderr);
      assert.ok(value.failures.length > 0, source);
      assert.equal(value.observedFailures, value.failures.length, 'no duplicate declaration-order events');
      for (const type of types) assert.ok(value.failures.some(item => item.failureType === type), JSON.stringify(value));
      for (const message of messages) assert.equal(value.failures.filter(item => item.message.includes(message)).length, 1, JSON.stringify(value));
      assert.equal(value.processExitCode, null); assert.equal(value.revision, null);
      assert.ok(Buffer.byteLength(error.stderr) <= 32 * 1024);
      return true;
    });
  }
});
