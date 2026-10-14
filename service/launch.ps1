function Start-Duprove {
    param([string]$ProjectRoot, [switch]$WithLog)

    $node = $null
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    $candidates = @()
    if ($command) { $candidates += $command.Source }
    $portable = Join-Path $ProjectRoot '.tools\node'
    if (Test-Path -LiteralPath $portable -PathType Container) {
        $candidates += @(Get-ChildItem -LiteralPath $portable -Filter node.exe -Recurse -File | Select-Object -ExpandProperty FullName)
    }
    foreach ($candidate in $candidates) {
        $version = & $candidate -p 'process.versions.node'
        if ($LASTEXITCODE -eq 0 -and $version -match '^24\.') { $node = $candidate; break }
    }
    if (-not $node) { throw 'Node.js 24 not found. Run service.bat 1 first.' }

    $oldPreference = $ErrorActionPreference
    $oldEncoding = [Console]::OutputEncoding
    try {

        $ErrorActionPreference = 'Continue'
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
        $mode = if ($WithLog) { '--log' } else { '--no-logs' }
        $recentOutput = [Collections.Generic.Queue[string]]::new()
        $runLogPath = $null
        & $node (Join-Path $ProjectRoot 'service\launch.mjs') $mode 2>&1 | ForEach-Object {
            $line = $_.ToString()
            if ($line -match '^\[service\] log-file: (.+)$') { $runLogPath = $Matches[1] }
            $recentOutput.Enqueue($line)
            if ($recentOutput.Count -gt 30) { [void]$recentOutput.Dequeue() }
            Write-Host $line
        }
        if ($LASTEXITCODE -ne 0) {
            $details = $recentOutput -join [Environment]::NewLine
            $failure = [Exception]::new("Duprove failed (exit code $LASTEXITCODE).`n$details")
            if ($runLogPath) { $failure.Data['RunLogPath'] = $runLogPath }
            throw $failure
        }
    } finally {
        $ErrorActionPreference = $oldPreference
        [Console]::OutputEncoding = $oldEncoding
    }
}
