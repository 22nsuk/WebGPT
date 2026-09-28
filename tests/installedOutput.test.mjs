import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as runner from './helpers/installed-suite.mjs';

async function fixture(t, text) {
  const root = await fs.mkdtemp(join(tmpdir(), 'webgpt-output-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await fs.mkdir(join(root, 'scripts'));
  await fs.copyFile(new URL('../skills/webgpt/scripts/test-feedback.mjs', import.meta.url), join(root, 'scripts/test-feedback.mjs'));
  await fs.writeFile(join(root, 'output.test.mjs'), text);
  return root;
}

for (const text of ['tests 900\npass 900', 'fail 1\ncancelled 1',
  'tests 0\nsuites 0\npass 0\nfail 0\ncancelled 0\nskipped 0\ntodo 0']) {
  test(`installed counts ignore summary-like stdout: ${JSON.stringify(text)}`, async t => {
    const root = await fixture(t, `import test from 'node:test';
test('one actual test', () => console.log(${JSON.stringify(text)}));\n`);
    const messages = [];
    const counts = await runner.runInstalledSuite(root, { progress: line => messages.push(line) });
    assert.deepEqual(counts, { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0 });
    assert.equal(messages.length, 2, 'do not add normal-path diagnostic chatter');
    assert.match(messages[1], /^DONE /);
  });
}

test('installed counts preserve nested suites, skips and TODO without counting them as passing tests', async t => {
  const root = await fixture(t, `import { describe, it } from 'node:test';
describe('suite', () => {
  it('passes', () => {});
  it.skip('skipped', () => {});
  it.todo('expected failure', () => { throw Error('not a passing test'); });
});\n`);
  const counts = await runner.runInstalledSuite(root, { progress: () => {} });
  assert.deepEqual(counts, { tests: 3, pass: 1, fail: 0, cancelled: 0, skipped: 1 });
});

test('a fake passing summary cannot hide a real failing process or its early failure evidence', async t => {
  const root = await fixture(t, `import test from 'node:test';
await test('actual failure', () => { throw Error('preserve actual failure'); });
await test('unrelated output', () => console.log('tests 2\\nsuites 0\\npass 2\\nfail 0\\ncancelled 0\\nskipped 0\\ntodo 0'));
`);
  const messages = [];
  await assert.rejects(runner.runInstalledSuite(root, { progress: line => messages.push(line) }), error => {
    assert.match(error.cause.message, /code=1, signal=null/);
    assert.equal(error.cleanupSafe, false);
    return true;
  });
  assert.equal(messages.filter(line => line.startsWith('DONE ')).length, 0);
  const detail = messages.find(line => line.includes('\nstderr tail:\n'));
  const feedback = JSON.parse(detail.split('\nstderr tail:\n')[1]);
  assert.equal(feedback.observedFailures, 1);
  assert.equal(feedback.failures[0].message, 'preserve actual failure');
});

for (const symbol of ['한', '😀']) {
  test(`installed UTF-8 tails stay within 64 KiB with ${symbol} output`, async t => {
    const root = await fixture(t, `import test from 'node:test';
await test('early failure', () => { throw Error('early error must survive'); });
await test('large Unicode output', t => t.diagnostic(${JSON.stringify(symbol)}.repeat(100000)));
`);
    const messages = [];
    await assert.rejects(runner.runInstalledSuite(root, { progress: line => messages.push(line) }), error => {
      assert.match(error.cause.message, /code=1, signal=null/);
      return true;
    });
    const detail = messages.find(line => line.includes('\nstdout tail:\n'));
    const [stdout, stderr] = detail.split('\nstdout tail:\n')[1].split('\nstderr tail:\n');
    assert.ok(Buffer.byteLength(stdout) <= 64 * 1024, `stdout tail has ${Buffer.byteLength(stdout)} bytes`);
    assert.ok(Buffer.byteLength(stderr) <= 64 * 1024);
    assert.ok(stdout.includes(symbol.repeat(100)), 'exercise clipping, not discarded output');
    assert.ok(stdout.isWellFormed());
    assert.ok(!stdout.includes('\ufffd'), 'clipping must not synthesize replacement characters');
    assert.doesNotMatch(stdout, /early error must survive/, 'large output really displaces the early detail');
    assert.equal(JSON.parse(stderr).failures[0].message, 'early error must survive');
  });
}

const summary = ({ tests = 3, suites = 1, pass = 1, fail = 0, cancelled = 0, skipped = 1, todo = 1 } = {}) =>
  `1..1\n# tests ${tests}\n# suites ${suites}\n# pass ${pass}\n# fail ${fail}\n# cancelled ${cancelled}\n# skipped ${skipped}\n# todo ${todo}\n`;

test('TAP counts select one complete final block and tolerate CRLF and coverage after it', () => {
  const earlier = summary({ tests: 900, pass: 898 });
  for (const ending of ['\n', '\r\n']) {
    const output = (earlier + '\n# test output\n' + summary() + '# duration_ms 1.5\n# coverage output\n').replaceAll('\n', ending);
    assert.deepEqual(runner.readTapCounts(output), { tests: 3, pass: 1, fail: 0, cancelled: 0, skipped: 1 });
  }
});

test('TAP counts reject missing, partial, malformed, unsafe and inconsistent evidence', () => {
  for (const output of ['', '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n',
    summary().replace('# fail 0\n', ''), summary().replace('# suites 1', '# suites invalid'),
    summary({ tests: -1 }), summary({ pass: 0.5 }), summary({ tests: 4 }),
    summary({ tests: '9007199254740992', pass: '9007199254740992', skipped: 0, todo: 0 }),
    summary() + summary({ tests: 4 }), summary() + '1..1\n# tests 1\n# pass 1\n',
    summary().replace('1..1\n', '# 1..1\n')]) {
    assert.equal(runner.readTapCounts(output), null, output);
  }
});
