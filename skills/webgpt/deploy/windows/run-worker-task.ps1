# Local Task Scheduler entry point. Never expose this script through MCP.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$NodePath,
    [Parameter(Mandatory)][string]$ConfigPath,
    [Parameter(Mandatory)][string]$DataPath
)
$ErrorActionPreference = 'Stop'
$servicePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../scripts/service.mjs'))
# Require reviewed, explicit local paths. No command strings or environment defaults.
foreach ($path in @($NodePath, $ConfigPath, $DataPath, $servicePath)) {
    if ($path -notmatch '^[A-Za-z]:[\\/]' -or $path -match '["\r\n]') { throw 'An explicit local absolute path is required.' }
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point paths are not supported.' }
}
$env:WEBGPT_CONFIG = $ConfigPath
$env:WEBGPT_DATA_DIR = $DataPath
$logDir = Join-Path $DataPath 'service-logs'
if (!(Test-Path -LiteralPath $logDir)) { $null = New-Item -ItemType Directory -Path $logDir }
if ((Get-Item -LiteralPath $logDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe log directory.' }
$guardPath = Join-Path $logDir 'launcher.guard'
if (Test-Path -LiteralPath $guardPath) {
    $guardItem = Get-Item -LiteralPath $guardPath -Force
    if ($guardItem.PSIsContainer -or ($guardItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $guardItem.LinkType) {
        throw 'Unsafe launcher guard.'
    }
}
# The OS releases this exclusive handle even on forced exit. The file is retained;
# its presence is not liveness evidence. A second launcher cannot rotate live logs.
$guard = [IO.File]::Open($guardPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    # A fixed eight-session ring. Only this task owns these files. Lock checks in the
    # supervisor still reject any other launcher; Scheduler uses IgnoreNew.
    foreach ($stem in @('stdout', 'stderr', 'launcher')) {
        foreach ($index in 0..7) {
            $file = Join-Path $logDir "$stem.$index.log"
            if (Test-Path -LiteralPath $file) {
                $item = Get-Item -LiteralPath $file -Force
                if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType) {
                    throw 'Unsafe log file; preserve for inspection.'
                }
            }
        }
        $oldest = Join-Path $logDir "$stem.7.log"
        if (Test-Path -LiteralPath $oldest) { Remove-Item -LiteralPath $oldest }
        foreach ($index in 6..0) {
            $source = Join-Path $logDir "$stem.$index.log"
            if (Test-Path -LiteralPath $source) { Move-Item -LiteralPath $source -Destination (Join-Path $logDir "$stem.$($index + 1).log") }
        }
    }
    $launcherLog = Join-Path $logDir 'launcher.0.log'
    @{ time = [DateTime]::UtcNow.ToString('o'); event = 'task_launcher_started'; launcherPid = $PID } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $launcherLog -Encoding UTF8
    $exitCode = 1
    $child = $null
    # Once the supervisor exists, diagnostics must not release its launcher guard or
    # abandon supervision. A broken log sink is reported only to the fallback stream.
    function Write-LauncherEvent([hashtable]$Event) {
        try {
            $Event | ConvertTo-Json -Compress | Add-Content -LiteralPath $launcherLog -Encoding UTF8
        } catch {
            try { [Console]::Error.WriteLine('WebGPT launcher log write failed; supervision continues.') } catch { }
        }
    }
    try {
        $child = Start-Process -FilePath $NodePath -ArgumentList @(('"{0}"' -f $servicePath), 'run') `
            -WorkingDirectory $DataPath -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $logDir 'stdout.0.log') `
            -RedirectStandardError (Join-Path $logDir 'stderr.0.log')
        # Retain the native handle before waiting; Windows PowerShell's returned
        # Process object can otherwise lose ExitCode after a short-lived child exits.
        $null = $child.Handle
        Write-LauncherEvent @{ time = [DateTime]::UtcNow.ToString('o'); event = 'supervisor_launched'; supervisorPid = $child.Id; launcherPid = $PID }
        $child.WaitForExit()
        $exitCode = $child.ExitCode
        if ($null -eq $exitCode) { throw 'Supervisor exit code unavailable.' }
        Write-LauncherEvent @{ time = [DateTime]::UtcNow.ToString('o'); event = 'supervisor_exited'; supervisorPid = $child.Id; exitCode = $exitCode }
    } catch {
        # Exception text may contain private paths. Keep only a fixed failure category.
        $exitCode = 1
        Write-LauncherEvent @{ time = [DateTime]::UtcNow.ToString('o'); event = 'task_launcher_failed' }
    } finally {
        # Also retain ownership on a non-logging exception after Start-Process.
        # The existing service stop protocol remains available while we wait.
        if ($null -ne $child) {
            $child.WaitForExit()
            $child.Dispose()
        }
    }
} finally {
    $guard.Dispose()
}
exit $exitCode
