param(
    [Parameter(Mandatory = $true)][string]$InstallDirectory,
    [string]$Report = (Join-Path (Get-Location) 'duprove-startup-report.json')
)

# Read-only diagnostics of the installed application. No exclusions, elevation,
# quarantine changes, alternate binaries or network submissions.
$ErrorActionPreference = 'Stop'
$directory = [IO.Path]::GetFullPath($InstallDirectory)
$binary = Join-Path $directory 'resources\analyzer\duprove-analyzer.exe'
$result = [ordered]@{
    checkedAt = [DateTime]::UtcNow.ToString('o')
    installDirectory = $directory
    analyzer = $binary
    exists = [IO.File]::Exists($binary)
    status = 'error'
    os = $null
    signature = $null
    sha256 = $null
    exitCode = $null
    nativeErrorCode = $null
    stdout = ''
    stderr = ''
    error = $null
    defender = $null
    detections = @()
}
try {
    $os = Get-CimInstance Win32_OperatingSystem
    $result.os = @{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; architecture = $os.OSArchitecture }
} catch { $result.os = @{ error = $_.Exception.Message } }
try {
    $state = Get-MpComputerStatus
    $result.defender = @{ engine = $state.AMEngineVersion; signatures = $state.AntivirusSignatureVersion; realTimeEnabled = $state.RealTimeProtectionEnabled }
    $result.detections = @(Get-MpThreatDetection | Where-Object {
        ($_.Resources -join ' ') -match [regex]::Escape($binary)
    } | Sort-Object InitialDetectionTime -Descending | Select-Object -First 5 InitialDetectionTime,ActionSuccess,ThreatID,Resources)
} catch { $result.defender = @{ error = $_.Exception.Message } }
$process = $null
try {
    if (-not $result.exists) { throw 'ANALYZER_NOT_FOUND' }
    $result.sha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
    $result.signature = [string](Get-AuthenticodeSignature -LiteralPath $binary).Status
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $binary
    $info.Arguments = '--drives'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(15000)) {
        $process.Kill()
        $process.WaitForExit()
        throw 'ANALYZER_TIMEOUT'
    }
    $result.exitCode = $process.ExitCode
    $result.stdout = $stdout.GetAwaiter().GetResult()
    $result.stderr = $stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw 'ANALYZER_EXIT_FAILED' }
    $drives = ConvertFrom-Json -InputObject $result.stdout
    if (-not $result.stdout.TrimStart().StartsWith('[')) { throw 'ANALYZER_INVALID_DRIVES' }
    $result.status = if ($null -ne $drives -and @($drives).Count -gt 0) { 'drives-found' } else { 'no-drives' }
} catch {
    $exception = $_.Exception
    $result.error = $exception.Message
    while ($null -ne $exception) {
        if ($exception -is [ComponentModel.Win32Exception]) { $result.nativeErrorCode = $exception.NativeErrorCode; break }
        $exception = $exception.InnerException
    }
} finally {
    if ($null -ne $process) { $process.Dispose() }
    $reportPath = [IO.Path]::GetFullPath($Report)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($reportPath)) | Out-Null
    [IO.File]::WriteAllText($reportPath, ($result | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Write-Output "Status: $($result.status); exitCode: $($result.exitCode); nativeErrorCode: $($result.nativeErrorCode)"
    Write-Output "Report: $reportPath"
}
if ($result.status -eq 'error') { exit 1 }
