import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = new URL('./operating-performance.mjs', import.meta.url);
const run = args => spawnSync(process.execPath, [fileURLToPath(script), ...args],
  { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });

test('performance CLI rejects invalid parameters before fixtures', () => {
  for (const args of [['--wat', '1'], ['--tasks'], ['--tasks', '2,1'],
    ['--iterations', '0'], ['--warmups', '-1'], ['--tasks', '1.5'],
    ['--tasks', '1', '--tasks', '2'], ['--journals', '128', '--backup-bytes', '10485760']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.length > 0);
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND/);
  }
});

test('small real benchmark reports full reads and separate measurements', () => {
  const result = run(['--tasks', '2,4', '--journals', '1,2', '--backup-bytes', '32',
    '--iterations', '2', '--warmups', '0', '--repetitions', '2']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.cleanedUp, true);
  assert.equal(report.rows.length, 24);
  for (const row of report.rows) {
    assert.ok(row.before.rss > 0 && row.after.rss > 0 && row.maxRSSKiB > 0);
    for (const key of ['heapUsed', 'external', 'arrayBuffers']) {
      assert.ok(Number.isFinite(row.before[key]) && Number.isFinite(row.after[key]));
    }
    if (row.instrumented) {
      assert.equal(row.bytes, row.fixtureBytes * 2);
      assert.ok(row.readCalls > 0);
      assert.equal(row.elapsedMs, null);
    } else {
      assert.equal(row.bytes, null);
      assert.ok(row.elapsedMs >= 0);
    }
  }
  const order = report.rows.filter(r => r.kind === 'state' && r.count === 2 && !r.instrumented);
  assert.deepEqual(order.map(r => r.method), ['baseline', 'stream', 'stream', 'baseline']);
});
