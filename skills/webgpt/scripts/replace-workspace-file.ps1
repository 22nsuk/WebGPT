param([Parameter(Mandatory=$true)][ValidateSet('prepare','replace')][string]$Action)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$stage = 'read_request'
$reason = 'exception'

try {
    # Paths are data on stdin, never interpolated PowerShell source or arguments.
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $file = [string]$request.file
    $temporary = [string]$request.temporary
    $stage = 'read_source_acl'
    $sections = [Security.AccessControl.AccessControlSections]'Owner,Group,Access'
    $original = [IO.File]::GetAccessControl($file, $sections)
    $owner = $original.GetOwner([Security.Principal.SecurityIdentifier])
    $group = $original.GetGroup([Security.Principal.SecurityIdentifier])

    if ($Action -eq 'prepare') {
        $stage = 'create_private_stage'
        # Supply the protected descriptor at creation: setting it after writing
        # would briefly expose bytes through the parent directory's inherited ACL.
        $private = [Security.AccessControl.FileSecurity]::new()
        $private.SetAccessRuleProtection($true, $false)
        $private.SetOwner($owner)
        $private.SetGroup($group)
        $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $private.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'Allow'))
        $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew,
            [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None,
            4096, [IO.FileOptions]::None, $private)
        $stream.Dispose()
    }

    # ReplaceFile preserves the DACL, but does not promise to preserve owner/group.
    # Reject unsupported ownership changes before touching the original file.
    $stage = 'verify_stage_ownership'
    $staged = [IO.File]::GetAccessControl($temporary, $sections)
    if ($staged.GetOwner([Security.Principal.SecurityIdentifier]) -ne $owner -or
        $staged.GetGroup([Security.Principal.SecurityIdentifier]) -ne $group) {
        $reason = 'ownership_mismatch'
        throw 'could not preserve file ownership'
    }
    if ($Action -eq 'replace') {
        $stage = 'verify_source_revision'
        # Starting PowerShell takes time. Recheck the revision inside the helper
        # as well, immediately before the native replacement.
        $source = [IO.File]::OpenRead($file)
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            if ($source.Length -gt 1048576) { $reason = 'revision_conflict'; throw 'file revision conflict' }
            $digest = [BitConverter]::ToString($sha.ComputeHash($source)).Replace('-', '').ToLowerInvariant()
            if ($digest -ne $request.expectedSha256) { $reason = 'revision_conflict'; throw 'file revision conflict' }
        } finally { $source.Dispose(); $sha.Dispose() }
        # false is essential: never ignore ACL/metadata merge errors.
        # Do not delete the stage on failure; native failure can leave partial moves.
        $stage = 'native_replace'
        [IO.File]::Replace($temporary, $file, [NullString]::Value, $false)
    }
} catch {
    $failure = $_.Exception
    try {
        # Match the Node validator. Do not serialize ErrorRecord, Message, Data,
        # ScriptStackTrace, paths or arbitrary/custom exception type names.
        $allowed = @('System.Exception', 'System.IO.IOException',
            'System.IO.FileNotFoundException', 'System.IO.DirectoryNotFoundException', 'System.IO.PathTooLongException',
            'System.UnauthorizedAccessException', 'System.ArgumentException', 'System.ArgumentNullException',
            'System.NotSupportedException', 'System.Security.SecurityException', 'System.ComponentModel.Win32Exception',
            'System.Management.Automation.MethodInvocationException', 'System.Management.Automation.RuntimeException')
        $exceptions = [Collections.Generic.List[object]]::new()
        $exception = $failure
        while ($null -ne $exception -and $exceptions.Count -lt 4) {
            $type = $exception.GetType().FullName
            if ($allowed -notcontains $type) { $type = 'unknown' }
            $native = $null
            if ($type -eq 'System.ComponentModel.Win32Exception' -and $exception.NativeErrorCode -ge 0) {
                $native = [int]$exception.NativeErrorCode
            }
            $exceptions.Add([ordered]@{type=$type; hresult=[int]$exception.HResult; nativeErrorCode=$native})
            $exception = $exception.InnerException
        }
        $diagnostic = [ordered]@{version=1; action=$Action; stage=$stage; reason=$reason;
            exceptions=@($exceptions.ToArray()); chainTruncated=($null -ne $exception)}
        [Console]::Error.WriteLine(($diagnostic | ConvertTo-Json -Depth 6 -Compress))
    } catch {
        # Action/stage contain only fixed literals. Even diagnostic construction
        # failure must not print the original error or change the failing exit.
        try {
            [Console]::Error.WriteLine(('{"version":1,"action":"' + $Action + '","stage":"' + $stage +
                '","reason":"unknown","exceptions":[],"chainTruncated":false}'))
        } catch {}
    }
    exit 1
}
