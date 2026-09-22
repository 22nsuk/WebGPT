# Explicit opt-in registration; does not start/stop Worker or change accounts/ACLs.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_-]{1,80}$')][string]$TaskName,
    [Parameter(Mandatory)][string]$NodePath,
    [Parameter(Mandatory)][string]$ConfigPath,
    [Parameter(Mandatory)][string]$DataPath,
    [switch]$AtLogon
)
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'run-worker-task.ps1'
$powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
foreach ($path in @($NodePath, $ConfigPath, $DataPath, $runner, $powershell)) {
    if ($path -notmatch '^[A-Za-z]:[\\/]' -or $path -match '["\r\n]') { throw 'An explicit local absolute path is required.' }
    $null = Get-Item -LiteralPath $path -Force
}
# Never update an existing task or take over an unrelated restart owner.
if (Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue) { throw 'Task already exists; inspect it before making changes.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -NodePath "{1}" -ConfigPath "{2}" -DataPath "{3}"' -f $runner, $NodePath, $ConfigPath, $DataPath
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $DataPath
# No outer restart policy: service.mjs owns the one lifetime budget. No default
# 72-hour deadline, battery stop, idle stop, wakeup, or elevated run level.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$parameters = @{ TaskName = $TaskName; TaskPath = '\'; Action = $action; Principal = $principal; Settings = $settings;
    Description = 'WebGPT current-user supervisor. Three bounded child retries; no task retries. Stop through service.mjs stop.' }
if ($AtLogon) { $parameters.Trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity }
Register-ScheduledTask @parameters
