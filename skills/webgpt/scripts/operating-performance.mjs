#!/usr/bin/env node
// Standalone synthetic evidence: never open an installed runtime or workspace.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { isCliEntry } from './cli-entry.mjs';
import * as runtime from './runtime.mjs';
import { inspectRecovery } from './workspace.mjs';

const self = fileURLToPath(import.meta.url);
const defaults = { tasks: [100, 1000, 10000], journals: [1, 8],
  'backup-bytes': [4096, 262144], iterations: 3, warmups: 1, repetitions: 2 };
const help = `node skills/webgpt/scripts/operating-performance.mjs [options]
--tasks 100,1000,10000 --journals 1,8 --backup-bytes 4096,262144
--iterations 3 --warmups 1 --repetitions 2
Lists must strictly increase. Limits: tasks 100000; journals 128; backup bytes
10485760; iterations 100; warmups 20; repetitions 10; 32 fixture cases.
Conservative projected fixture bytes must be <=240 MiB. Fixtures are processed
one at a time in a unique temporary directory, removed even on failure.
Output is bounded JSON; timing is descriptive, not a pass/fail threshold.`;

function parameters(args) {
  const result = structuredClone(defaults), seen = new Set();
  const limits = { tasks: 100000, journals: 128, 'backup-bytes': 10485760,
    iterations: 100, warmups: 20, repetitions: 10 };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2), value = args[i + 1];
    if (args[i] !== '--' + key || !Object.hasOwn(limits, key) || seen.has(key) || value === undefined)
      throw Error('unknown, duplicate or missing option: ' + args[i]);
    seen.add(key);
    const list = Array.isArray(defaults[key]);
    const parts = list ? value.split(',') : [value];
    if (parts.length > 16 || parts.some(x => !/^(0|[1-9][0-9]*)$/.test(x)))
      throw Error('invalid integer list: ' + key);
    const numbers = parts.map(Number);
    if (numbers.some((n, j) => !Number.isSafeInteger(n) || n < (key === 'warmups' ? 0 : 1)
        || n > limits[key] || (j && n <= numbers[j - 1])))
      throw Error('out of range or non-increasing: ' + key);
    result[key] = list ? numbers : numbers[0];
  }
  const cases = result.tasks.length + result.journals.length * result['backup-bytes'].length;
  const projectedBytes = Math.max(...result.tasks) * 1024
    + Math.max(...result.journals) * (Math.max(...result['backup-bytes']) + 4096);
  if (cases > 32 || projectedBytes > 240 * 1024 ** 2) throw Error('fixture budget exceeded');
  return { ...result, projectedBytes };
}

function child(c) {
  const expected = c.kind === 'state' ? fs.readFileSync(c.path) : null;
  const run = c.method === 'baseline'
    ? () => { const actual = runtime.readStateBytes(c.path);
      return actual === null ? expected === null : expected !== null && actual.equals(expected); }
    : c.method === 'stream' ? () => runtime.stateBytesEqual(c.path, expected)
      : () => inspectRecovery(c.path, 'owned');
  const check = result => {
    if (c.kind === 'state') assert.equal(result, true);
    else {
      assert.equal(result.unresolved.length, 0);
      assert.equal(result.receipts.length, c.count);
    }
  };
  for (let i = 0; i < c.warmups; i++) check(run());
  let bytes = 0, readCalls = 0;
  const originals = { readSync: fs.readSync, readFileSync: fs.readFileSync };
  let insideWholeRead = false;
  if (c.instrumented) {
    fs.readSync = (...args) => {
      const n = originals.readSync(...args);
      if (!insideWholeRead) { bytes += n; readCalls++; }
      return n;
    };
    fs.readFileSync = (...args) => {
      insideWholeRead = true;
      try { const b = originals.readFileSync(...args); bytes += b.length; readCalls++; return b; }
      finally { insideWholeRead = false; }
    };
    syncBuiltinESMExports();
  }
  const before = process.memoryUsage(), start = process.hrtime.bigint();
  let elapsedMs, after;
  try {
    for (let i = 0; i < c.iterations; i++) check(run());
    elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    after = process.memoryUsage();
  } finally {
    if (c.instrumented) { Object.assign(fs, originals); syncBuiltinESMExports(); }
  }
  if (c.instrumented) assert.equal(bytes, c.bytes * c.iterations, 'full fresh read on every operation');
  return { instrumented: c.instrumented, elapsedMs: c.instrumented ? null : elapsedMs,
    bytes: c.instrumented ? bytes : null, readCalls: c.instrumented ? readCalls : null,
    before, after, maxRSSKiB: process.resourceUsage().maxRSS };
}

function benchmark(p) {
  assert.equal(typeof runtime.stateBytesEqual, 'function', 'runtime.stateBytesEqual integration required');
  const root = fs.mkdtempSync(join(tmpdir(), 'webgpt-performance-'));
  const rows = [];
  let fixtureBytes = 0;
  try {
    const cases = [
      ...p.tasks.map(count => ({ kind: 'state', count })),
      ...p.journals.flatMap(count => p['backup-bytes'].map(size => ({ kind: 'recovery', count, size })))
    ];
    for (const fixture of cases) {
      const dir = join(root, 'case');
      fs.mkdirSync(dir);
      let path, bytes;
      if (fixture.kind === 'state') {
        path = join(dir, 'state.json');
        const tasks = Array.from({ length: fixture.count }, (_, i) => ({
          id: `task_${i}`, token: `token_${i}`, status: 'running', collected: false,
          instructions: 'Deterministic cumulative-operation inventory ' + 'x'.repeat(256),
          inputs: { ordinal: String(i) }, nextCheck: 0, changes: []
        }));
        const content = Buffer.from(JSON.stringify(tasks));
        runtime.parseState(content, dir);
        fs.writeFileSync(path, content);
        bytes = content.length;
      } else {
        path = dir; bytes = 0;
        const recovery = join(dir, 'recovery', 'owned');
        fs.mkdirSync(recovery, { recursive: true });
        const content = Buffer.alloc(fixture.size, 97);
        const digest = createHash('sha256').update(content).digest('hex');
        for (let i = 0; i < fixture.count; i++) {
          const operation = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
          const backup = join(recovery, operation + '.before.txt');
          const journal = Buffer.from(JSON.stringify({ state: 'applied', operation,
            path: `file_${i}.txt`, action: 'edit', backup, beforeSha256: digest, afterSha256: digest }));
          fs.writeFileSync(backup, content);
          fs.writeFileSync(join(recovery, operation + '.json'), journal);
          bytes += content.length + journal.length;
        }
      }
      fixtureBytes += bytes;
      assert.ok(bytes <= p.projectedBytes);
      const methods = fixture.kind === 'state' ? ['baseline', 'stream'] : ['recovery'];
      for (let repetition = 0; repetition < p.repetitions; repetition++) {
        const order = repetition % 2 ? [...methods].reverse() : methods;
        for (const instrumented of [false, true]) for (const method of order) {
          const c = { ...fixture, method, path, bytes, repetition, instrumented,
            iterations: p.iterations, warmups: p.warmups };
          const result = spawnSync(process.execPath, [self, '--child'], {
            env: { ...process.env, WEBGPT_PERFORMANCE_CHILD: JSON.stringify(c) },
            encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024
          });
          if (result.error) throw result.error;
          if (result.status !== 0) throw Error(result.stderr || 'benchmark child failed');
          rows.push({ ...fixture, method, repetition, fixtureBytes: bytes, ...JSON.parse(result.stdout) });
        }
      }
      fs.rmSync(dir, { recursive: true });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  return { schema: 1, runtime: { node: process.version, platform: process.platform,
    arch: process.arch }, parameters: p, fixtureBytes, cleanedUp: true,
    definitions: {
      bytes: 'Returned file bytes in measured iterations only; every operation must read the full fixture.',
      readCalls: 'readSync calls (including EOF) plus readFileSync calls; a native whole-file read counts as one API call, not OS syscalls.',
      memory: 'before/after process.memoryUsage bytes after warmup; endpoints are not peaks. Expected state Buffer remains resident in both methods. No forced GC.',
      maxRSSKiB: 'process.resourceUsage maxRSS: lifetime process high-water RSS in KiB, including imports/setup/warmups.',
      timing: 'Fresh child per row; uninstrumented loop includes result assertions. Instrumented rows have no reported timing.',
      cache: 'Filesystem cache is uncontrolled; order alternates by repetition, not a cold-cache claim.',
      recovery: 'Unchanged inspectRecovery validates journals and hashes every original backup on every iteration.'
    }, rows };
}

if (isCliEntry(import.meta)) {
  try {
    if (process.argv[2] === '--child' && process.env.WEBGPT_PERFORMANCE_CHILD) {
      console.log(JSON.stringify(child(JSON.parse(process.env.WEBGPT_PERFORMANCE_CHILD))));
    } else if (process.argv.length === 3 && process.argv[2] === '--help') console.log(help);
    else console.log(JSON.stringify(benchmark(parameters(process.argv.slice(2)))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
