# Creates and formats only a new, disposable VHDX owned by this test.
# Run elevated (the GitHub-hosted Windows runner already is).
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    throw 'WINDOWS_VOLUME_TEST_REQUIRES_ADMINISTRATOR'
}
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$binary = Join-Path $repo 'build/native/bin/duprove-analyzer.exe'
if ($env:DUPROVE_ANALYZER) { $binary = [IO.Path]::GetFullPath($env:DUPROVE_ANALYZER) }
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'ANALYZER_NOT_FOUND' }
$fixtures = [IO.Path]::GetFullPath((Join-Path $repo '.verification'))
$base = [IO.Path]::GetFullPath((Join-Path $fixtures ('volume-' + [Guid]::NewGuid().ToString('N'))))
if (-not $base.StartsWith($fixtures + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'UNSAFE_FIXTURE_PATH'
}
$null = New-Item -ItemType Directory -Path $base
$image = Join-Path $base 'test.vhdx'
$parent = Join-Path $base 'selected'
$mount = Join-Path $parent 'mounted volume'
$mountPath = $mount + '\'
$null = New-Item -ItemType Directory -Path $mount
$attached = $false
$accessAdded = $false
$utf8 = [Text.UTF8Encoding]::new($false)
function Get-TestDisk {
    $images = @(Get-DiskImage -ImagePath $image)
    if ($images.Count -ne 1 -or $images[0].ImagePath -ne $image -or -not $images[0].Attached) {
        throw 'TEST_IMAGE_IDENTITY_MISMATCH'
    }
    $disks = @($images[0] | Get-Disk)
    if ($disks.Count -ne 1 -or $disks[0].IsBoot -or $disks[0].IsSystem -or $disks[0].Size -ne 128MB) {
        throw 'REFUSING_NON_TEST_DISK'
    }
    return $disks[0]
}
function Invoke-Scan([string[]]$roots) {
    $job = Join-Path $base 'job.json'
    $value = @{ roots = @($roots); database = (Join-Path $base 'work/index.sqlite'); load = 2 } | ConvertTo-Json
    [IO.File]::WriteAllText($job, $value, $utf8)
    $output = @('' | & $binary --job $job)
    if ($LASTEXITCODE -ne 0 -or $output.Count -eq 0) { throw 'VOLUME_SCAN_FAILED' }
    $event = $output[-1] | ConvertFrom-Json
    if ($event.type -ne 'result' -or -not $event.report.complete) { throw 'VOLUME_SCAN_INCOMPLETE' }
    return $event.report
}
try {
    # Diskpart creates a new image; it never selects/formats a physical disk.
    $create = Join-Path $base 'create.txt'
    [IO.File]::WriteAllText($create, "create vdisk file=`"$image`" maximum=128 type=expandable`r`nexit`r`n", [Text.Encoding]::ASCII)
    $null = & diskpart /s $create
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $image -PathType Leaf)) { throw 'VHD_CREATE_FAILED' }
    $null = Mount-DiskImage -ImagePath $image -StorageType VHDX -NoDriveLetter
    $attached = $true
    $disk = Get-TestDisk
    if ($disk.PartitionStyle -ne 'RAW') { throw 'TEST_DISK_NOT_NEW' }
    $null = Initialize-Disk -InputObject $disk -PartitionStyle GPT
    $disk = Get-TestDisk
    $partition = New-Partition -DiskNumber $disk.Number -UseMaximumSize -AssignDriveLetter:$false
    $null = Set-Partition -DiskNumber $disk.Number -PartitionNumber $partition.PartitionNumber -NoDefaultDriveLetter $true
    $null = Format-Volume -Partition $partition -FileSystem NTFS -NewFileSystemLabel 'DuproveTest' -Confirm:$false
    $null = Add-PartitionAccessPath -DiskNumber $disk.Number -PartitionNumber $partition.PartitionNumber -AccessPath $mountPath
    $accessAdded = $true
    $updated = Get-Partition -DiskNumber (Get-TestDisk).Number -PartitionNumber $partition.PartitionNumber
    if ($updated.DriveLetter -and [int][char]$updated.DriveLetter -ne 0) { throw 'TEST_VOLUME_HAS_DRIVE_LETTER' }
    [IO.File]::WriteAllText((Join-Path $parent 'one.txt'), 'identical test bytes', $utf8)
    [IO.File]::WriteAllText((Join-Path $mount 'two.bin'), 'identical test bytes', $utf8)
    $drives = & $binary --drives | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not @($drives | Where-Object { $_.path.TrimEnd('\') -eq $mount }).Count) {
        throw 'DIRECTORY_MOUNT_NOT_DISCOVERED'
    }
    $report = Invoke-Scan @($parent)
    if ($report.statistics.total.files -ne 1) { throw 'UNSELECTED_VOLUME_CROSSED' }
    $report = Invoke-Scan @($parent, $mount)
    if ($report.statistics.total.files -ne 2 -or $report.statistics.total.duplicates -ne 1 -or
        $report.duplicates[0].disks.'0' -ne 1 -or $report.duplicates[0].disks.'1' -ne 1) {
        throw 'SELECTED_VOLUME_COMPARISON_FAILED'
    }
} finally {
    # Never recurse into a mount or delete an image which is still attached.
    if ($accessAdded) {
        $null = Remove-PartitionAccessPath -DiskNumber (Get-TestDisk).Number -PartitionNumber $partition.PartitionNumber -AccessPath $mountPath
    }
    if ($attached) { $null = Dismount-DiskImage -ImagePath $image }
    if (Test-Path -LiteralPath $image) {
        if ((Get-DiskImage -ImagePath $image).Attached) { throw 'TEST_IMAGE_STILL_ATTACHED' }
    }
    $resolved = [IO.Path]::GetFullPath($base)
    if (-not $resolved.StartsWith($fixtures + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'UNSAFE_CLEANUP_PATH'
    }
    if ((Get-Item -LiteralPath $mount).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'REFUSING_CLEANUP_WITH_MOUNT_PRESENT'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Output 'WINDOWS_VOLUME_MOUNT_OK: real volume without drive letter, selection boundary and cross-volume duplicates'
