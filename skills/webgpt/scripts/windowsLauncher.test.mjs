import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const windows = { skip: process.platform !== 'win32' && 'requires Windows PowerShell and native process handles', timeout: 20000 };
const quote = value => `'${value.replaceAll("'", "''")}'`;
async function until(predicate, description, { retryBusy = false, timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastBusy;
  for (;;) {
    try { if (predicate()) return; }
    catch (error) {
      // Only live log reads opt in: a sharing violation may outlive one poll.
      if (!retryBusy || error.code !== 'EBUSY') throw error;
      lastBusy = error;
    }
    if (Date.now() >= deadline)
      throw Error(typeof description === 'function' ? description() : description, { cause: lastBusy });
    await delay(25);
  }
}
function launch(script) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const done = once(child, 'close').then(([code]) => code);
  return { child, done, output: () => output };
}
async function fixture(run) {
  const base = mkdtempSync(join(tmpdir(), 'webgpt launcher 한글 '));
  const deploy = join(base, 'deploy', 'windows'), scripts = join(base, 'scripts'), data = join(base, 'data');
  for (const dir of [deploy, scripts, data]) mkdirSync(dir, { recursive: true });
  const runner = join(deploy, 'run-worker-task.ps1'), config = join(base, 'config.json');
  copyFileSync(new URL('../deploy/windows/run-worker-task.ps1', import.meta.url), runner);
  writeFileSync(config, '{}');
  writeFileSync(join(scripts, 'service.mjs'), `
    import { existsSync, writeFileSync } from 'node:fs';
    writeFileSync('child.pid', String(process.pid));
    const timer = setInterval(() => {
      if (existsSync('release')) { clearInterval(timer); process.exitCode = 7; }
    }, 20);
  `);
  const children = [];
  const startScript = source => {
    const script = join(base, `invoke-${children.length}.ps1`);
    // Windows PowerShell 5.1 needs a BOM for literal Unicode fixture paths.
    writeFileSync(script, '\ufeff' + source);
    const instance = launch(script); children.push(instance); return instance;
  };
  const start = (failure = '') => startScript(`
      $ErrorActionPreference = 'Stop'
      function Add-Content {
        [CmdletBinding()]
        param([Parameter(ValueFromPipeline)]$Value, [string]$LiteralPath, [string]$Encoding)
        process {
          if (${quote(failure)} -eq 'all' -or ($Value | ConvertFrom-Json).event -eq ${quote(failure)}) {
            throw [IO.IOException]::new('Injected launcher log failure')
          }
          Microsoft.PowerShell.Management\\Add-Content -LiteralPath $LiteralPath -Value $Value -Encoding $Encoding
        }
      }
      & ${quote(runner)} -NodePath ${quote(process.execPath)} -ConfigPath ${quote(config)} -DataPath ${quote(data)}
      exit $LASTEXITCODE
    `);
  try { await run({ base, scripts, data, start, startScript }); }
  finally {
    // Release the fixture child before removing any paths, even after an assertion fails.
    writeFileSync(join(data, 'release'), '');
    for (const instance of children) {
      await Promise.race([instance.done, delay(3000)]);
      if (instance.child.exitCode === null && instance.child.signalCode === null) {
        instance.child.kill(); await instance.done;
      }
    }
    rmSync(base, { recursive: true, force: true });
  }
}

for (const failure of ['', 'all', 'supervisor_exited']) {
  test(`Windows launcher retains supervision and exit code with ${failure || 'normal'} logging`, windows, () => fixture(async ({ data, start }) => {
    const instance = start(failure);
    await until(() => existsSync(join(data, 'child.pid')), instance.output());
    if (failure === 'all') await until(() => instance.output().includes('supervision continues'), 'missing log failure diagnostic');
    else await until(() => readFileSync(join(data, 'service-logs', 'launcher.0.log'), 'utf8').includes('supervisor_launched'),
      () => 'missing launch event; ' + instance.output(), { retryBusy: true });
    assert.equal(instance.child.exitCode, null, instance.output());
    // The live launcher must retain its exclusive guard even when its log sink fails.
    const duplicate = start(failure);
    assert.notEqual(await duplicate.done, 0);
    assert.equal(existsSync(join(data, 'service-logs', 'launcher.1.log')), false);
    writeFileSync(join(data, 'release'), '');
    assert.equal(await instance.done, 7, instance.output());
    const childPid = Number(readFileSync(join(data, 'child.pid'), 'utf8'));
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    // A subsequent launcher acquires the released guard and rotates the old log.
    const next = start();
    assert.equal(await next.done, 7, next.output());
    assert.equal(existsSync(join(data, 'service-logs', 'launcher.1.log')), true);
  }));
}

test('launcher log polling survives a real Windows sharing violation after release', windows, () => fixture(async ({ base, data, startScript }) => {
  const log = join(data, 'locked.log'), held = join(base, 'held'), release = join(data, 'release');
  writeFileSync(log, 'supervisor_launched');
  const locker = startScript(`
    $ErrorActionPreference = 'Stop'
    $handle = [IO.File]::Open(${quote(log)}, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
      [IO.File]::WriteAllText(${quote(held)}, 'held')
      $deadline = [DateTime]::UtcNow.AddSeconds(10)
      while (-not [IO.File]::Exists(${quote(release)}) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 10 }
    } finally { $handle.Dispose() }
  `);
  await until(() => existsSync(held), 'lock was not acquired');
  let busy = 0;
  await until(() => {
    try { return readFileSync(log, 'utf8').includes('supervisor_launched'); }
    catch (error) {
      if (error.code === 'EBUSY') { busy++; writeFileSync(release, ''); }
      throw error;
    }
  }, () => 'missing launch event; ' + locker.output(), { retryBusy: true });
  assert.ok(busy > 0, 'the read encountered the native sharing violation');
  assert.equal(await locker.done, 0, locker.output());
}));

test('launcher log polling fails at its deadline with the last busy error and diagnostics', async () => {
  const busy = Object.assign(Error('locked fixture log'), { code: 'EBUSY' });
  await assert.rejects(until(() => { throw busy; }, () => 'missing launch event; fixture output',
    { retryBusy: true, timeoutMs: 1 }), error => {
    assert.equal(error.cause, busy);
    assert.match(error.message, /missing launch event; fixture output/);
    return true;
  });
});

for (const code of ['EACCES', 'EIO', 'ENOENT']) test(`launcher log polling does not retry ${code}`, async () => {
  const failure = Object.assign(Error('fixture read failure'), { code });
  let calls = 0;
  await assert.rejects(until(() => { calls++; throw failure; }, 'must fail', { retryBusy: true }), error => error === failure);
  assert.equal(calls, 1);
});

test('Windows launcher reports start failure even when its error log also fails', windows, () => fixture(async ({ base, data, start, startScript }) => {
  // Fail the launch after the normal path/log preflight.
  const runner = join(base, 'deploy', 'windows', 'run-worker-task.ps1');
  const failed = startScript(`
    function Start-Process { throw [IO.IOException]::new('Injected spawn failure') }
    function Add-Content { throw [IO.IOException]::new('Injected error log failure') }
    & ${quote(runner)} -NodePath ${quote(process.execPath)} -ConfigPath ${quote(join(base, 'config.json'))} -DataPath ${quote(data)}
    exit $LASTEXITCODE
  `);
  assert.equal(await failed.done, 1, failed.output());
  assert.match(failed.output(), /launcher log write failed/);
  assert.equal(existsSync(join(data, 'child.pid')), false);
  writeFileSync(join(data, 'release'), '');
  assert.equal(await start().done, 7);
}));

for (const code of [0, 78]) test(`Windows launcher preserves immediate child exit ${code}`, windows, () => fixture(async ({ scripts, data, start }) => {
  writeFileSync(join(scripts, 'service.mjs'), `process.exit(${code});`);
  const instance = start();
  assert.equal(await instance.done, code, instance.output());
  const events = readFileSync(join(data, 'service-logs', 'launcher.0.log'), 'utf8')
    .replace(/^\ufeff/, '').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(events.at(-1).event, 'supervisor_exited');
  assert.equal(events.at(-1).exitCode, code);
}));

test('Windows initial-log failure releases its guard without starting a supervisor', windows, () => fixture(async ({ base, data, start, startScript }) => {
  const runner = join(base, 'deploy', 'windows', 'run-worker-task.ps1');
  // Keep the PowerShell host alive after catching the script error. Process exit
  // must not mask a guard left open by the failed invocation.
  const failed = startScript(`
    $ErrorActionPreference = 'Stop'
    function Set-Content { throw [IO.IOException]::new('Injected initial log failure') }
    try {
      & ${quote(runner)} -NodePath ${quote(process.execPath)} -ConfigPath ${quote(join(base, 'config.json'))} -DataPath ${quote(data)}
      throw 'Expected initial log failure'
    } catch {
      if ($_.Exception.Message -ne 'Injected initial log failure') { throw }
    }
    $handle = [IO.File]::Open(${quote(join(data, 'service-logs', 'launcher.guard'))}, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $handle.Dispose()
    exit 0
  `);
  assert.equal(await failed.done, 0, failed.output());
  assert.equal(existsSync(join(data, 'child.pid')), false);
  writeFileSync(join(data, 'release'), '');
  assert.equal(await start().done, 7);
}));
