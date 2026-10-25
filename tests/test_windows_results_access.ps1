$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'RUN_ACCESS_CHECK_WITHOUT_ADMINISTRATOR' }
$fixtureDirectory = [IO.Path]::GetFullPath((Join-Path $workspace ('.verification\windows-access-' + [Guid]::NewGuid())))
if (-not $fixtureDirectory.StartsWith(($workspace.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'FIXTURE_OUTSIDE_WORKSPACE' }
[IO.Directory]::CreateDirectory($fixtureDirectory) | Out-Null
$file = Join-Path $fixtureDirectory 'protected.txt'
[IO.File]::WriteAllText($file, 'disposable-access-fixture')
$originalAcl = Get-Acl -LiteralPath $file
$checker = Join-Path $PSScriptRoot 'windows-results-access.cjs'
try {
    & node $checker readable $file
    if ($LASTEXITCODE -ne 0) { throw 'READABLE_FIXTURE_FAILED' }
    $acl = Get-Acl -LiteralPath $file
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Deny)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $file -AclObject $acl
    & node $checker denied $file
    if ($LASTEXITCODE -ne 0) { throw 'DENIED_FIXTURE_FAILED' }
    Set-Acl -LiteralPath $file -AclObject $originalAcl
    & node $checker readable $file
    if ($LASTEXITCODE -ne 0) { throw 'FIXTURE_NOT_RESTORED' }
    $unc = '\\127.0.0.1\Duprove-nonexistent-' + [Guid]::NewGuid() + '\file.txt'
    & node $checker network $unc
    if ($LASTEXITCODE -ne 0) { throw 'MISSING_NETWORK_CHECK_FAILED' }
    $proof = @{ passed = $true; administrator = $false; realAclDenial = $true; aclRestored = $true; missingLoopbackUnc = $true; nativeWindowsAnalyzer = 'not executed because Defender blocked it' }
    [IO.File]::WriteAllText((Join-Path $workspace '.verification\results-windows-access.json'), ($proof | ConvertTo-Json))
    Write-Output 'WINDOWS_RESULTS_ACCESS_OK'
} finally {
    if (Test-Path -LiteralPath $file) { Set-Acl -LiteralPath $file -AclObject $originalAcl }
    # The fully resolved, task-specific directory was checked above.
    Remove-Item -LiteralPath $fixtureDirectory -Recurse -Force
}
