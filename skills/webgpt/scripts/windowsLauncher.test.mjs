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
async function until(predicate, description) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, description);
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
  const base = mkdtempSync(join(tmpdir(), 'webgpt launcher '));
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
  const start = (failure = '') => {
    const script = join(base, `invoke-${children.length}.ps1`);
    writeFileSync(script, `
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
    const instance = launch(script); children.push(instance); return instance;
  };
  try { await run({ base, scripts, data, start }); }
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
    else await until(() => readFileSync(join(data, 'service-logs', 'launcher.0.log'), 'utf8').includes('supervisor_launched'), 'missing launch event');
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

test('Windows launcher reports start failure even when its error log also fails', windows, () => fixture(async ({ base, data, start }) => {
  // Fail the launch after the normal path/log preflight.
  const script = join(base, 'fail-spawn.ps1');
  const runner = join(base, 'deploy', 'windows', 'run-worker-task.ps1');
  writeFileSync(script, `
    function Start-Process { throw [IO.IOException]::new('Injected spawn failure') }
    function Add-Content { throw [IO.IOException]::new('Injected error log failure') }
    & ${quote(runner)} -NodePath ${quote(process.execPath)} -ConfigPath ${quote(join(base, 'config.json'))} -DataPath ${quote(data)}
    exit $LASTEXITCODE
  `);
  const failed = launch(script);
  assert.equal(await failed.done, 1, failed.output());
  assert.match(failed.output(), /launcher log write failed/);
  assert.equal(existsSync(join(data, 'child.pid')), false);
  writeFileSync(join(data, 'release'), '');
  assert.equal(await start().done, 7);
}));
