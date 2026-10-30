import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';

const windows = { skip: process.platform !== 'win32' && 'requires native Windows PowerShell argument parsing' };
const quote = value => `'${value.replaceAll("'", "''")}'`;
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\ufeff/, ''));

// Capture registration without touching Task Scheduler. Filesystem validation and
// the native powershell.exe command-line parser remain real.
const scheduler = `
  $schedulerState = @{ Calls = 0; Registrations = 0; ExistingTask = $false }
  function Get-ScheduledTask {
    [CmdletBinding()] param($TaskName, $TaskPath)
    $schedulerState.Calls++
    if ($schedulerState.ExistingTask) { [pscustomobject]@{ TaskName = $TaskName } }
  }
  function New-ScheduledTaskPrincipal {
    param($UserId, $LogonType, $RunLevel)
    [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel }
  }
  function New-ScheduledTaskAction {
    param($Execute, $Argument, $WorkingDirectory)
    [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory }
  }
  function New-ScheduledTaskSettingsSet {
    param($MultipleInstances, [TimeSpan]$ExecutionTimeLimit, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries)
    [pscustomobject]@{ MultipleInstances = $MultipleInstances; ExecutionTimeLimit = $ExecutionTimeLimit.TotalSeconds;
      AllowStartIfOnBatteries = [bool]$AllowStartIfOnBatteries; DontStopIfGoingOnBatteries = [bool]$DontStopIfGoingOnBatteries }
  }
  function New-ScheduledTaskTrigger {
    param([switch]$AtLogOn, $User)
    [pscustomobject]@{ AtLogOn = [bool]$AtLogOn; User = $User }
  }
  function Register-ScheduledTask {
    param($TaskName, $TaskPath, $Action, $Principal, $Settings, $Description, $Trigger)
    $schedulerState.Registrations++
    [pscustomobject]@{ TaskName = $TaskName; TaskPath = $TaskPath; Action = $Action;
      Principal = $Principal; Settings = $Settings; Trigger = $Trigger }
  }
  function Invoke-CapturedAction($Action) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Action.Execute
    # Do not tokenize or re-quote this string: Task Scheduler stores it verbatim.
    $info.Arguments = $Action.Arguments
    $info.WorkingDirectory = $Action.WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $child = New-Object Diagnostics.Process
    $child.StartInfo = $info
    $started = $false
    try {
      $started = $child.Start()
      $stdout = $child.StandardOutput.ReadToEndAsync()
      $stderr = $child.StandardError.ReadToEndAsync()
      if (-not $child.WaitForExit(10000)) { throw 'Captured task action timed out.' }
      [pscustomobject]@{ Code = $child.ExitCode; Stdout = $stdout.Result; Stderr = $stderr.Result }
    } finally {
      if ($started -and -not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
      $child.Dispose()
    }
  }
`;

function fixture(run, { realRunner = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "webgpt task 한글 & ' "));
  const deploy = join(base, 'deploy', 'windows'), scripts = join(base, 'scripts'), data = join(base, 'private data');
  for (const dir of [deploy, scripts, data]) mkdirSync(dir, { recursive: true });
  const register = join(deploy, 'register-worker-task.ps1'), runner = join(deploy, 'run-worker-task.ps1');
  const config = join(base, 'private config.json'), received = join(base, 'received.json');
  const node = realRunner ? process.execPath : join(base, 'node 한글.exe');
  copyFileSync(new URL('../deploy/windows/register-worker-task.ps1', import.meta.url), register);
  writeFileSync(config, '{}');
  if (!realRunner) {
    writeFileSync(node, 'receiver-only fixture');
    writeFileSync(runner, '\ufeff' + `
      param([string]$NodePath, [string]$ConfigPath, [string]$DataPath)
      [IO.File]::WriteAllText(${quote(received)}, (@{ NodePath = $NodePath; ConfigPath = $ConfigPath; DataPath = $DataPath } | ConvertTo-Json -Compress))
    `);
  } else copyFileSync(new URL('../deploy/windows/run-worker-task.ps1', import.meta.url), runner);
  const invoke = source => {
    const script = join(base, 'invoke.ps1');
    // Windows PowerShell 5.1 requires a BOM for Unicode source literals.
    writeFileSync(script, '\ufeff' + `$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n` + scheduler + source);
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout.replace(/^\ufeff/, '').trim());
  };
  const registration = (dataPath, atLogon = false) =>
    `& ${quote(register)} -TaskName Fixture -NodePath ${quote(node)} -ConfigPath ${quote(config)} -DataPath ${quote(dataPath)}${atLogon ? ' -AtLogon' : ''}`;
  try { return run({ base, scripts, data, node, config, received, runner, invoke, registration }); }
  finally { rmSync(base, { recursive: true, force: true }); }
}

const dataPaths = [
  ['no trailing separator', data => data],
  ...[1, 2, 3].map(count => [`${count} trailing backslash(es)`, data => data + '\\'.repeat(count)]),
  ['forward slash separators', data => data.replaceAll('\\', '/') + '/'],
  ['drive root', data => parse(data).root],
];
for (const [name, pathFor] of dataPaths) test(`scheduled task preserves path arguments with ${name}`, windows, () => fixture(({ data, node, config, received, invoke, registration }) => {
  const dataPath = pathFor(data);
  const result = invoke(`
    $registration = ${registration(dataPath)}
    $result = Invoke-CapturedAction $registration.Action
    @{ Registration = $registration; Result = $result; Identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name } | ConvertTo-Json -Depth 6 -Compress
  `);
  assert.equal(result.Result.Code, 0, result.Result.Stdout + result.Result.Stderr);
  assert.deepEqual(readJson(received), { NodePath: node, ConfigPath: config, DataPath: dataPath });
  assert.equal(result.Registration.Action.WorkingDirectory, dataPath);
  assert.deepEqual(result.Registration.Principal, { UserId: result.Identity, LogonType: 'Interactive', RunLevel: 'Limited' });
  assert.deepEqual(result.Registration.Settings, { MultipleInstances: 'IgnoreNew', ExecutionTimeLimit: 0,
    AllowStartIfOnBatteries: true, DontStopIfGoingOnBatteries: true });
  assert.equal(result.Registration.Trigger, null);
}));

test('native action replay exposes an unescaped trailing backslash rather than repairing it', windows, () => fixture(({ data, node, config, runner, received, invoke, registration }) => {
  const result = invoke(`
    $registration = ${registration(data)}
    # An intentionally malformed native string proves this harness does not add argv quoting.
    $registration.Action.Arguments = ${quote(`-NoProfile -NonInteractive -File "${runner}" -NodePath "${node}" -ConfigPath "${config}" -DataPath "${data}\\"`)}
    Invoke-CapturedAction $registration.Action | ConvertTo-Json -Compress
  `);
  assert.equal(result.Code, 0, result.Stdout + result.Stderr);
  assert.equal(readJson(received).DataPath, data + '"');
}));

test('scheduled task starts the real launcher with the original trailing-backslash data path', windows, () => fixture(({ scripts, data, config, received, invoke, registration }) => {
  const dataPath = data + '\\';
  writeFileSync(join(scripts, 'service.mjs'), `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(received)}, JSON.stringify({ config: process.env.WEBGPT_CONFIG,
      data: process.env.WEBGPT_DATA_DIR, cwd: process.cwd(), arguments: process.argv.slice(2) }));
    process.exitCode = 7;
  `);
  const result = invoke(`
    $registration = ${registration(dataPath, true)}
    $result = Invoke-CapturedAction $registration.Action
    @{ Registration = $registration; Result = $result } | ConvertTo-Json -Depth 6 -Compress
  `);
  assert.equal(result.Result.Code, 7, result.Result.Stdout + result.Result.Stderr);
  assert.deepEqual(readJson(received), { config, data: dataPath, cwd: data, arguments: ['run'] });
  assert.deepEqual(result.Registration.Trigger, { AtLogOn: true, User: result.Registration.Principal.UserId });
  const events = readFileSync(join(data, 'service-logs', 'launcher.0.log'), 'utf8')
    .replace(/^\ufeff/, '').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(events.at(-1).event, 'supervisor_exited');
  assert.equal(events.at(-1).exitCode, 7);
}, { realRunner: true }));

test('task argument serialization keeps path preflight and existing-task refusal', windows, () => fixture(({ data, invoke, registration }) => {
  const invalid = ['relative', 'C:relative', '\\rooted', '\\\\server\\share', data + '"', data + '\r', data + '\n'];
  const result = invoke(`
    $errors = @(${invalid.map(path => `try { $null = ${registration(path)}; 'accepted' } catch { $_.Exception.Message }`).join('\n')})
    $preflightCalls = $schedulerState.Calls
    $schedulerState.ExistingTask = $true
    $existing = try { $null = ${registration(data)}; 'accepted' } catch { $_.Exception.Message }
    @{ Errors = $errors; PreflightCalls = $preflightCalls; Existing = $existing; Registrations = $schedulerState.Registrations } | ConvertTo-Json -Compress
  `);
  assert.equal(result.Errors.length, invalid.length);
  for (const message of result.Errors) assert.match(message, /explicit local absolute path is required/);
  assert.equal(result.PreflightCalls, 0);
  assert.match(result.Existing, /Task already exists/);
  assert.equal(result.Registrations, 0);
}));
