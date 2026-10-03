import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createAuditWriter } from './audit.mjs';
import { readFixture, observeFileRead } from './test-fixtures/file-read.mjs';

// audit.test.mjs owns rotation, permissions, sink failures and real-worker
// outcomes. This matrix covers only precision at the writer's identity boundary.
for (const field of ['dev', 'ino']) for (const changed of [false, true]) {
  test(`audit writer compares full-width ${field} (${changed ? 'replacement' : 'unchanged'})`, t => {
    const dir = readFixture(t), file = join(dir, 'mcp-audit.jsonl');
    const held = file + '.held', replacement = file + '.replacement';
    const original = Buffer.from('original diagnostic evidence\n'), other = Buffer.from('unrelated file evidence\n');
    fs.writeFileSync(file, original, { mode: 0o600 });
    fs.writeFileSync(replacement, other, { mode: 0o600 });
    const base = 2n ** 60n;
    assert.equal(Number(base), Number(base + 1n), 'the different identities must alias as Numbers');
    let swaps = 0, warnings = 0, writes = 0;
    const lstat = fs.lstatSync, fstat = fs.fstatSync;
    const metadata = (info, options, different) => {
      const convert = value => options?.bigint ? value : Number(value);
      // Keep the other identity constant so it cannot mask precision loss.
      return Object.assign(info, { dev: convert(7n), ino: convert(9n),
        [field]: convert(base + (different ? 1n : 0n)) });
    };
    const pathStat = t.mock.method(fs, 'lstatSync', (path, options) => {
      const info = lstat(path, options);
      return path === file ? metadata(info, options, swaps !== 0) : info;
    });
    const descriptorStat = t.mock.method(fs, 'fstatSync', (fd, options) =>
      metadata(fstat(fd, options), options, changed));
    const trace = observeFileRead(t, file, { beforeOpen() {
      if (changed && swaps === 0) {
        fs.renameSync(file, held); fs.renameSync(replacement, file); swaps++;
      }
    } });
    const nativeWrite = fs.writeFileSync;
    const sink = t.mock.method(fs, 'writeFileSync', (...args) => { writes++; return nativeWrite(...args); });
    syncBuiltinESMExports();
    try {
      const write = createAuditWriter(dir, true, { warn: () => { warnings++; throw Error('private warning sink'); } });
      assert.doesNotThrow(() => write({ phase: 'started' }));
      assert.doesNotThrow(() => write({ phase: 'started' }));
    } finally {
      // Drop automatic restoration before unwinding stacked native-I/O mocks.
      t.mock.reset(); sink.mock.restore(); trace.restore();
      descriptorStat.mock.restore(); pathStat.mock.restore(); syncBuiltinESMExports();
    }
    assert.equal(swaps, changed ? 1 : 0);
    assert.equal(writes, changed ? 0 : 2, 'a replacement must receive no diagnostic bytes');
    assert.equal(warnings, changed ? 1 : 0, 'capture disables once; valid large identities keep working');
    assert.deepEqual(trace.evidence, { opens: changed ? 1 : 2, closes: changed ? 1 : 2, bytes: 0, reads: 0 });
    if (changed) {
      assert.deepEqual(fs.readFileSync(file), other);
      assert.deepEqual(fs.readFileSync(held), original);
    } else {
      const saved = fs.readFileSync(file);
      assert.deepEqual(saved.subarray(0, original.length), original);
      const records = saved.subarray(original.length).toString('utf8').trim().split('\n').map(JSON.parse);
      assert.equal(records.length, 2);
      assert.ok(records.every(record => record.phase === 'started' && record.version === 1));
      assert.equal(records[0].runId, records[1].runId);
      assert.deepEqual(fs.readFileSync(replacement), other);
    }
    assert.equal(fs.existsSync(file + '.1'), false);
  });
}
