import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { runInstalledSuite, cleanupInstallation } from './helpers/installed-suite.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'webgpt installed # 한국어 % '));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const write = async (name, text) => {
    const path = join(root, name);
    await fs.mkdir(join(path, '..'), { recursive: true }); await fs.writeFile(path, text);
  };
  // Use the copied skill's real reporter, including URL-sensitive installation paths.
  await write('scripts/test-feedback.mjs', await fs.readFile(new URL('../skills/webgpt/scripts/test-feedback.mjs', import.meta.url)));
  return { root, write };
}

test('installed runner executes nested files with two active slots and visible progress', async t => {
  const f = await fixture(t), trace = join(f.root, 'trace.jsonl'), messages = [];
  for (const name of ['a', 'b', 'nested/c']) await f.write(name + '.test.mjs', `
    import test from 'node:test'; import {appendFileSync,readFileSync} from 'node:fs';
    import {setTimeout} from 'node:timers/promises';
    test(${JSON.stringify(name)}, async () => {
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify({name:${JSON.stringify(name)}, event:'start'})+'\\n');
      if (${JSON.stringify(name)} !== 'nested/c') {
        const deadline=Date.now()+10000;
        while(readFileSync(${JSON.stringify(trace)},'utf8').trim().split('\\n').map(JSON.parse).filter(e=>e.event==='start').length<2) {
          if(Date.now()>deadline) throw Error('second file did not start');
          await setTimeout(10);
        }
      }
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify({name:${JSON.stringify(name)}, event:'end'})+'\\n');
    });
  `);
  const counts = await runInstalledSuite(f.root, { progress: line => messages.push(line) });
  assert.deepEqual(counts, { tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0 });
  const events = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  let active = 0, peak = 0;
  for (const event of events) { active += event.event === 'start' ? 1 : -1; peak = Math.max(peak, active); assert.ok(active <= 2); }
  assert.equal(peak, 2); assert.equal(active, 0);
  assert.ok(messages[0].startsWith('START ')); assert.ok(messages[1].startsWith('START '));
  assert.equal(messages.filter(line => line.startsWith('DONE ')).length, 3);
  assert.equal(messages.length, 6, 'healthy runs emit only existing START/DONE progress');
});

test('unexpected progress failure waits for the other slot and preserves its failure evidence', async t => {
  const f = await fixture(t), marker = join(f.root, 'finished'), reporterError = Error('progress sink failed');
  await f.write('a.test.mjs', `
    import test from 'node:test'; import {writeFileSync} from 'node:fs';
    import {setTimeout} from 'node:timers/promises';
    test('finishes with failure',async()=>{ await setTimeout(100); writeFileSync(${JSON.stringify(marker)},'done'); throw Error('retained assertion'); });
  `);
  await f.write('b.test.mjs', `throw Error('must not launch after start reporter fails');`);
  await assert.rejects(runInstalledSuite(f.root, { progress: message => {
    if (message === 'START b.test.mjs') throw reporterError;
  } }), error => {
    assert.equal(existsSync(marker), true, 'do not settle while another slot still owns work');
    assert.equal(error.cleanupSafe, false);
    assert.ok(error.errors.includes(reporterError));
    assert.ok(error.errors.some(item => item.message.includes('a.test.mjs')));
    return true;
  });
});

test('installed runner preserves ordinary failures while settling all files and bounding output', async t => {
  const f = await fixture(t), messages = [];
  await f.write('a.test.mjs', `import test from 'node:test'; test('fails', () => { throw Error('original assertion'); });`);
  await f.write('b.test.mjs', `import test from 'node:test'; test('large output', () => { process.stdout.write('x'.repeat(1100000)+'\\n'); });`);
  await f.write('nested/c.test.mjs', `import test from 'node:test'; test('still runs', () => {});`);
  await assert.rejects(runInstalledSuite(f.root, { progress: line => messages.push(line) }), error => {
    assert.equal(error.errors.length, 1); assert.match(error.cause.message, /a.test.mjs/); return true;
  });
  assert.equal(messages.filter(line => line.startsWith('DONE ')).length, 2);
  assert.ok(messages.some(line => line.includes('original assertion')));
  assert.ok(messages.every(line => line.length < 140000));
});

test('installed file timeout kills its fixture descendants and leaves unrelated processes alive', async t => {
  const f = await fixture(t), grandchildPid = join(f.root, 'grandchild.pid'), heartbeat = join(f.root, 'heartbeat'), messages = [];
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true });
  const unrelatedClosed = once(unrelated, 'close');
  t.after(async () => { unrelated.kill(); await unrelatedClosed; });
  await f.write('hang.test.mjs', `
    import test from 'node:test'; import {spawn} from 'node:child_process';
    test('hangs with descendant', async () => {
      spawn(process.execPath, ['-e', ${JSON.stringify(`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(grandchildPid)},String(process.pid));let n=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(++n)),10)`)}],
        {cwd:process.cwd(),windowsHide:true,stdio:'inherit'});
      await new Promise(()=>{});
    });
  `);
  let failure;
  try { await runInstalledSuite(f.root, { timeoutMs: 5000, progress: line => messages.push(line) }); }
  catch (error) { failure = error; }
  assert.ok(failure); assert.equal(failure.cause.code, 'TEST_FILE_TIMEOUT');
  assert.equal(failure.cleanupSafe, true);
  assert.ok(existsSync(grandchildPid), messages.join('\n'));
  const finalHeartbeat = readFileSync(heartbeat, 'utf8');
  await delay(100);
  assert.equal(readFileSync(heartbeat, 'utf8'), finalHeartbeat, 'descendant must stop executing, including on POSIX');
  if (process.platform === 'win32') {
    const pid = Number(readFileSync(grandchildPid, 'utf8'));
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
      await delay(10);
    }
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  await assert.rejects(cleanupInstallation(f.root, failure), error => error === failure);
  assert.equal(existsSync(f.root), false);
});

test('unconfirmed teardown retains the install and its primary failure', async t => {
  const f = await fixture(t), primary = Object.assign(Error('deadline'), { cleanupSafe: false });
  await assert.rejects(cleanupInstallation(f.root, primary), error => {
    assert.equal(error.cause, primary); assert.match(error.message, /retained installation/); return true;
  });
  assert.equal(existsSync(f.root), true);
});

for (const primary of [undefined, Error('original test failure')]) test(`cleanup failure ${primary ? 'preserves the original cause' : 'fails a successful run'}`, async t => {
  const failure = Object.assign(Error('injected busy directory'), { code: 'EBUSY' });
  const mock = t.mock.method(fs, 'rm', async () => { throw failure; });
  try {
    await assert.rejects(cleanupInstallation('unused-test-path', primary), error => {
      if (primary) { assert.equal(error.cause, primary); assert.deepEqual(error.errors, [primary, failure]); }
      else assert.equal(error, failure);
      return true;
    });
  } finally { mock.mock.restore(); }
});


test('installed feedback retains an early assertion after later output displaces its TAP detail', async t => {
  const f = await fixture(t), messages = [];
  await f.write('early.test.mjs', `import test from 'node:test';
import assert from 'node:assert/strict';
await test('early 한국어 🧪 assertion', () => assert.equal('actual 한국어 🧪', 'expected 한국어 🧪'));
await test('later noisy pass', t => t.diagnostic('x'.repeat(1100000)));
`);
  await f.write('later.test.mjs', `import test from 'node:test'; test('independent file still runs', () => {});`);
  await assert.rejects(runInstalledSuite(f.root, { progress: line => messages.push(line) }), error => {
    assert.equal(error.errors.length, 1);
    assert.match(error.cause.message, /early\.test\.mjs; code=1, signal=null/);
    assert.equal(error.cleanupSafe, false, 'feedback must not change descendant-cleanup authority');
    return true;
  });
  assert.equal(messages.filter(line => line.startsWith('DONE ')).length, 1);
  const detail = messages.find(line => line.includes('\nstdout tail:\n'));
  const [stdout, stderr] = detail.split('\nstdout tail:\n')[1].split('\nstderr tail:\n');
  assert.doesNotMatch(stdout, /early 한국어|actual 한국어|expected 한국어/, 'the ordinary tail really lost the assertion');
  assert.match(stdout, /# fail 1/);
  assert.ok(stderr.includes('node-test-failure-events'), 'missing compact installed failure evidence');
  const feedback = JSON.parse(stderr), failure = feedback.failures.find(item => item.name === 'early 한국어 🧪 assertion');
  assert.equal(feedback.processExitCode, null); assert.equal(feedback.revision, null);
  // Windows test events can retain a short temp-path alias. Resolve both spellings
  // so the check still requires this exact source file, not merely its basename.
  assert.equal(await fs.realpath(failure.file), await fs.realpath(join(f.root, 'early.test.mjs')));
  assert.equal(failure.line, 3); assert.equal(failure.code, 'ERR_ASSERTION');
  assert.match(failure.message, /actual 한국어 🧪/); assert.match(failure.message, /expected 한국어 🧪/);
  assert.ok(failure.stack.includes('early.test.mjs'));
  assert.equal(failure.truncated, false);
  assert.ok(Buffer.byteLength(stderr) <= 32 * 1024);
  assert.ok(messages.every(line => line.length < 140000));
});

test('installed feedback keeps its failure and byte bounds rather than echoing all output', async t => {
  const f = await fixture(t), messages = [];
  await f.write('many.test.mjs', `import test from 'node:test';
for (let i=0;i<20;i++) await test('failure '+i, () => { throw Error('한🧪'.repeat(2000)); });
await test('later noise', () => new Promise(resolve => process.stdout.write('z'.repeat(1100000)+'\\n', resolve)));
`);
  await assert.rejects(runInstalledSuite(f.root, { progress: line => messages.push(line) }), /1 installed test file\(s\) failed/);
  const detail = messages.find(line => line.includes('\nstdout tail:\n'));
  const stderr = detail.split('\nstderr tail:\n')[1];
  assert.ok(stderr.includes('node-test-failure-events'), 'missing bounded installed failure evidence');
  const feedback = JSON.parse(stderr);
  assert.equal(feedback.observedFailures, 20);
  assert.ok(feedback.failures.length > 0 && feedback.failures.length <= 12);
  assert.equal(feedback.omittedFailures, 20 - feedback.failures.length);
  assert.ok(feedback.failures.every(item => item.truncated));
  assert.ok(feedback.failures.every(item => !item.message.includes('\ufffd')));
  assert.ok(Buffer.byteLength(stderr) <= 32 * 1024);
  assert.ok(messages.every(line => line.length < 140000));
});

for (const missing of [true, false]) test(`installed runner fails closed when its own reporter is ${missing ? 'missing' : 'broken'}`, async t => {
  const f = await fixture(t), marker = join(f.root, 'test-ran'), messages = [];
  await f.write('must-not-run.test.mjs', `import test from 'node:test'; import {writeFileSync} from 'node:fs';
test('must not start without the installed reporter', () => writeFileSync(${JSON.stringify(marker)}, 'ran'));
`);
  if (missing) await fs.rm(join(f.root, 'scripts', 'test-feedback.mjs'));
  else await f.write('scripts/test-feedback.mjs', "throw Error('broken installed reporter');\n");
  await assert.rejects(runInstalledSuite(f.root, { progress: line => messages.push(line) }), error => {
    assert.equal(error.cleanupSafe, false);
    // Reporter startup failures need not use the assertion-failure exit code.
    assert.match(error.cause.message, /code=[1-9]\d*, signal=null$/);
    return true;
  });
  assert.equal(existsSync(marker), false, 'no fallback to a repository reporter or TAP-only run');
  assert.equal(messages.filter(line => line.startsWith('DONE ')).length, 0);
  assert.ok(messages.some(line => line.includes(missing ? 'test-feedback.mjs' : 'broken installed reporter')));
  assert.ok(messages.every(line => line.length < 140000));
});
