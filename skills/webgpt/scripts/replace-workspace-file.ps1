param([Parameter(Mandatory=$true)][ValidateSet('prepare','replace')][string]$Action)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
    # Paths are data on stdin, never interpolated PowerShell source or arguments.
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $file = [string]$request.file
    $temporary = [string]$request.temporary
    $sections = [Security.AccessControl.AccessControlSections]'Owner,Group,Access'
    $original = [IO.File]::GetAccessControl($file, $sections)
    $owner = $original.GetOwner([Security.Principal.SecurityIdentifier])
    $group = $original.GetGroup([Security.Principal.SecurityIdentifier])

    if ($Action -eq 'prepare') {
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
    $staged = [IO.File]::GetAccessControl($temporary, $sections)
    if ($staged.GetOwner([Security.Principal.SecurityIdentifier]) -ne $owner -or
        $staged.GetGroup([Security.Principal.SecurityIdentifier]) -ne $group) {
        throw 'could not preserve file ownership'
    }
    if ($Action -eq 'replace') {
        # Starting PowerShell takes time. Recheck the revision inside the helper
        # as well, immediately before the native replacement.
        $source = [IO.File]::OpenRead($file)
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            if ($source.Length -gt 1048576) { throw 'file revision conflict' }
            $digest = [BitConverter]::ToString($sha.ComputeHash($source)).Replace('-', '').ToLowerInvariant()
            if ($digest -ne $request.expectedSha256) { throw 'file revision conflict' }
        } finally { $source.Dispose(); $sha.Dispose() }
        # false is essential: never ignore ACL/metadata merge errors.
        # Do not delete the stage on failure; native failure can leave partial moves.
        [IO.File]::Replace($temporary, $file, [NullString]::Value, $false)
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
