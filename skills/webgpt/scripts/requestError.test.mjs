import test from 'node:test';
import assert from 'node:assert/strict';
import { rejectsRequest } from './test-fixtures/request-error.mjs';

async function rejection(promise) {
  let failure;
  await assert.rejects(promise, error => { failure = error; return true; });
  return failure;
}

test('request assertions retain native matching and observe each request and predicate once', async () => {
  const original = Object.assign(Error('expected request failure'), { code: 'EIO', statusCode: 503 });
  let requests = 0, matches = 0;
  const request = () => { requests++; return Promise.reject(original); };
  for (const expected of [{ code: 'EIO', statusCode: 503 }, /expected request failure/, error => {
    matches++; assert.equal(error, original); return true;
  }]) {
    assert.equal(await rejectsRequest(request(), expected), undefined);
  }
  assert.equal(requests, 3); assert.equal(matches, 1);
  assert.equal(Object.hasOwn(original, 'cause'), false);
});

test('object and false-predicate mismatches retain native failure fields and numeric timeout metadata', async () => {
  const original = new DOMException('controlled request timeout', 'TimeoutError');
  for (const expected of [{ code: 'EIO', statusCode: 503 }, () => false]) {
    const failure = await rejection(rejectsRequest(Promise.reject(original), expected, 'request expectation'));
    assert.ok(failure instanceof assert.AssertionError);
    assert.equal(failure.code, 'ERR_ASSERTION'); assert.equal(failure.operator, 'rejects');
    assert.equal(failure.actual, original); assert.equal(failure.expected, expected);
    assert.match(failure.message, /request expectation/);
    assert.notEqual(failure.cause, original);
    assert.deepEqual({ name: failure.cause.name, code: failure.cause.code, message: failure.cause.message },
      { name: 'TimeoutError', code: '23', message: 'controlled request timeout' });
  }
  assert.equal(Object.hasOwn(original, 'cause'), false, 'never mutate the request error');
});

test('an assertion thrown inside the validator keeps its identity, comparison and stack', async () => {
  const original = new DOMException('controlled request timeout', 'TimeoutError');
  let thrown, comparison, matches = 0;
  const failure = await rejection(rejectsRequest(Promise.reject(original), error => {
    matches++; assert.equal(error, original);
    try { assert.equal(error.code, 'EIO'); } catch (assertion) {
      thrown = assertion;
      comparison = { actual: assertion.actual, expected: assertion.expected,
        operator: assertion.operator, stack: assertion.stack };
      throw assertion;
    }
  }));
  assert.equal(matches, 1); assert.equal(failure, thrown);
  assert.deepEqual({ actual: failure.actual, expected: failure.expected,
    operator: failure.operator, stack: failure.stack }, comparison);
  assert.equal(failure.cause.name, 'TimeoutError'); assert.equal(failure.cause.code, '23');
});

test('a validator shape error retains the rejected request and its inner transport cause', async () => {
  const transport = Object.assign(Error('socket closed'), { code: 'ECONNRESET' });
  const original = new TypeError('fetch failed', { cause: transport });
  let thrown;
  const failure = await rejection(rejectsRequest(Promise.reject(original), error => {
    try { return error.details.issues.includes('expected issue'); } catch (validation) {
      thrown = validation; throw validation;
    }
  }));
  assert.ok(failure instanceof TypeError); assert.equal(failure, thrown);
  assert.match(failure.message, /issues/);
  assert.deepEqual(failure.cause, { name: 'TypeError', code: null, message: 'fetch failed',
    cause: { name: 'Error', code: 'ECONNRESET', message: 'socket closed' } });
  assert.equal(original.cause, transport);
});

test('missing rejections, explicit causes and primitive validator failures keep their native outcomes', async () => {
  const missing = await rejection(rejectsRequest(Promise.resolve(), { code: 'EIO' }));
  assert.equal(missing.code, 'ERR_ASSERTION'); assert.match(missing.message, /Missing expected rejection/);
  assert.equal(Object.hasOwn(missing, 'cause'), false);

  const original = Error('request rejected'), existing = Error('existing diagnostic');
  const diagnosed = new assert.AssertionError({ actual: 1, expected: 2, operator: 'strictEqual' });
  Object.defineProperty(diagnosed, 'cause', { value: existing });
  const validation = TypeError('validator failed');
  for (const thrown of [diagnosed, validation, 'primitive validator failure']) {
    const failure = await rejection(rejectsRequest(Promise.reject(original), () => { throw thrown; }));
    assert.equal(failure, thrown);
  }
  assert.equal(diagnosed.cause, existing);
  assert.deepEqual(validation.cause, { name: 'Error', code: null, message: 'request rejected' });
  const assertionReason = new assert.AssertionError({ actual: 1, expected: 2, operator: 'strictEqual' });
  assert.equal(await rejection(rejectsRequest(Promise.reject(assertionReason), error => { throw error; })), assertionReason);
  assert.equal(Object.hasOwn(assertionReason, 'cause'), false, 'do not turn a rethrown reason into its own cause');
});

test('unavailable diagnostic metadata and frozen validator errors cannot replace the native failure', async () => {
  const frozen = Object.freeze(TypeError('frozen validator failure'));
  assert.equal(await rejection(rejectsRequest(Promise.reject(Error('request rejected')), () => { throw frozen; })), frozen);
  assert.equal(Object.hasOwn(frozen, 'cause'), false);

  const unreadable = Error('request rejected'), validation = TypeError('preserve this validator failure');
  let attempted = false;
  Object.defineProperty(unreadable, 'code', { get() {
    attempted = true; throw Error('unreadable request metadata');
  } });
  assert.equal(await rejection(rejectsRequest(Promise.reject(unreadable), () => { throw validation; })), validation);
  assert.equal(attempted, true, 'exercise the failed metadata read');
  assert.equal(Object.hasOwn(validation, 'cause'), false);
});

test('request snapshots bound allowed strings while retaining evidence for reporter clipping and depth', async () => {
  const deepest = { name: 'Error', message: 'beyond the reporter depth' };
  const original = {
    name: '\0'.repeat(10000), code: '\0'.repeat(10000), message: '🧪한국어'.repeat(10000),
    stack: 'private inner stack', request: 'private request',
    toJSON() { throw Error('do not serialize the request error'); },
    cause: { name: 'TypeError', message: 'fetch failed',
      cause: { name: 'Error', code: 'ECONNRESET', message: 'socket closed', cause: deepest } },
  };
  Object.defineProperty(original, 'responseBody', { get() { throw Error('do not read arbitrary properties'); } });
  const failure = await rejection(rejectsRequest(Promise.reject(original), { code: 'EIO' }));
  const snapshot = failure.cause;
  // One overflow unit lets the reporter, which owns the final limits, mark clipping.
  assert.equal(snapshot.name.length, 65); assert.equal(snapshot.code.length, 129);
  assert.equal(snapshot.message.length, 257);
  assert.equal(snapshot.cause.message, 'fetch failed');
  assert.equal(snapshot.cause.cause.code, 'ECONNRESET');
  assert.deepEqual(snapshot.cause.cause.cause, {}, 'retain a bounded depth-omission marker');
  assert.notEqual(snapshot, original); assert.notEqual(snapshot.cause, original.cause);
  assert.doesNotMatch(JSON.stringify(snapshot), /private inner stack|private request|responseBody|toJSON/);
  assert.equal(original.name.length, 10000); assert.equal(original.cause.cause.cause, deepest);
});

test('snapshot cycles and unsupported values remain bounded without copying primitive payloads', async () => {
  const original = Error('cyclic request error'); original.cause = original;
  const cyclic = (await rejection(rejectsRequest(Promise.reject(original), { code: 'EIO' }))).cause;
  assert.notEqual(cyclic, original); assert.equal(cyclic.cause, cyclic);
  assert.equal(original.cause, original);
  const unsupported = { name: 'Error', message: 'request failed', cause: 'private primitive cause',
    code: { toString() { throw Error('do not coerce arbitrary codes'); } } };
  const snapshot = (await rejection(rejectsRequest(Promise.reject(unsupported), { message: 'different' }))).cause;
  assert.equal(snapshot.code, null); assert.equal(snapshot.cause, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /private primitive cause|toString/);
});
