param([Parameter(Mandatory=$true)][string]$Transaction)
$ErrorActionPreference = 'Stop'
$job = Get-Content -LiteralPath $Transaction -Raw | ConvertFrom-Json
$directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Transaction))
$target = [IO.Path]::GetFullPath($job.target)
if ($job.schema -ne 1 -or $job.token -notmatch '^[a-f0-9]{48}$' -or $job.executable -ne 'Duprove.exe') { throw 'UPDATE_TRANSACTION_INVALID' }
if ($target -eq [IO.Path]::GetPathRoot($target) -or $directory.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'UPDATE_TARGET_INVALID' }
if ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'UPDATE_TARGET_INVALID' }
if ((Get-Content -LiteralPath (Join-Path $target '.duprove-managed') -Raw).Trim() -ne 'Duprove NSIS per-user v1') { throw 'UPDATE_INSTALLATION_UNSUPPORTED' }
if ((Get-FileHash -LiteralPath $job.package -Algorithm SHA512).Hash.ToLowerInvariant() -ne $job.sha512) { throw 'UPDATE_HASH_INVALID' }
$backup = Join-Path $directory 'previous'
if (Test-Path -LiteralPath $backup) { throw 'UPDATE_RECOVERY_REQUIRED' }
$lock = [IO.File]::Open((Join-Path $directory 'install.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$installed = $false
$child = $null
$phase = 'backup'
try {
    # Do not traverse junctions or symlinks while making the recovery copy.
    $pending = [Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($target)
    while ($pending.Count) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'UPDATE_LINK_INVALID' }
            if ($item.PSIsContainer) { $pending.Enqueue($item.FullName) }
        }
    }
    Copy-Item -LiteralPath $target -Destination $backup -Recurse
    $phase = 'wait-parent'
    [IO.File]::WriteAllText((Join-Path $directory 'armed'), $job.token)
    $parent = Get-Process -Id $job.parentPid -ErrorAction SilentlyContinue
    if ($parent -and -not $parent.WaitForExit(60000)) { throw 'UPDATE_PARENT_BUSY' }
    # /D must be last; NSIS takes the remaining argument as an unquoted directory.
    if ($target.Contains('"') -or $target.Contains("`n") -or $target.Contains("`r")) { throw 'UPDATE_TARGET_INVALID' }
    $installed = $true
    $phase = 'installer'
    $installer = Start-Process -FilePath $job.package -ArgumentList @('/S', '--updated', '/currentuser', "/D=$target") -WindowStyle Hidden -PassThru
    $installer.WaitForExit()
    if ($installer.ExitCode -ne 0) { throw 'UPDATE_INSTALL_FAILED' }
    $phase = 'startup'
    $child = Start-Process -FilePath (Join-Path $target 'Duprove.exe') -ArgumentList '--duprove-updated' -WindowStyle Hidden -PassThru
    for ($i = 0; $i -lt 1200; $i++) {
        $ready = Join-Path $directory 'ready'
        if ((Test-Path -LiteralPath $ready) -and (Get-Content -LiteralPath $ready -Raw) -eq $job.token) {
            [IO.File]::WriteAllText((Join-Path $directory 'result.json'), '{"schema":1,"status":"installed"}')
            # Checked absolute path is an updater-owned child of directory.
            Remove-Item -LiteralPath $backup -Recurse -Force
            $installed = $false
            exit 0
        }
        if ($child.HasExited) { throw 'UPDATE_START_FAILED' }
        Start-Sleep -Milliseconds 100
    }
    throw 'UPDATE_START_TIMEOUT'
} catch {
    if ($installed) {
        if ($child -and -not $child.HasExited) { Stop-Process -Id $child.Id -Force; $child.WaitForExit() }
        # Restore application files only. UserData is outside target and never modified here.
        # Validate backup before the only recursive removal of target.
        if ((Get-Content -LiteralPath (Join-Path $backup '.duprove-managed') -Raw).Trim() -ne 'Duprove NSIS per-user v1') { throw 'UPDATE_BACKUP_INVALID' }
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        Copy-Item -LiteralPath $backup -Destination $target -Recurse
        [IO.File]::WriteAllText((Join-Path $directory 'result.json'), '{"schema":1,"status":"rolled-back"}')
        Remove-Item -LiteralPath $backup -Recurse -Force
        Start-Process -FilePath (Join-Path $target 'Duprove.exe') -WindowStyle Hidden
    } else {
        [IO.File]::WriteAllText((Join-Path $directory 'result.json'), (@{ schema=1; status='failed'; phase=$phase; systemError=$_.Exception.HResult } | ConvertTo-Json -Compress))
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
    }
    exit 1
} finally { $lock.Dispose() }
