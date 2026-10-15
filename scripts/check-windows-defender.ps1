param(
    [string]$Path = (Join-Path $PSScriptRoot '..\build\native\bin\duprove-analyzer.exe'),
    [string]$Report,
    [switch]$UpdateSignatures
)

# A diagnostic custom scan. This does not change Defender preferences or add
# exclusions. DisableRemediation applies only to this scan and ignores exclusions.
$ErrorActionPreference = 'Stop'
$result = [ordered]@{
    checkedAt = [DateTime]::UtcNow.ToString('o')
    status = 'error'
    file = [IO.Path]::GetFullPath($Path)
    sha256 = $null
    scanExitCode = $null
    scanHresult = $null
    defender = $null
    output = ''
    error = $null
}
if (-not $Report) {
    $Report = Join-Path $PSScriptRoot ('..\.verification\defender\' + [IO.Path]::GetFileName($Path) + '.json')
}
try {
    $file = Get-Item -LiteralPath $result.file
    if ($file.PSIsContainer -or $file.Length -eq 0) { throw 'DEFENDER_INPUT_MUST_BE_A_NONEMPTY_FILE' }
    $result.sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $platformRoot = Join-Path $env:ProgramData 'Microsoft\Windows Defender\Platform'
    $platform = Get-ChildItem -LiteralPath $platformRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+(-.*)?$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'MpCmdRun.exe')) } |
        Sort-Object { [version]($_.Name -replace '-.*$', '') } -Descending | Select-Object -First 1
    $scanner = if ($platform) { Join-Path $platform.FullName 'MpCmdRun.exe' }
        else { Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe' }
    if (-not (Test-Path -LiteralPath $scanner)) { throw 'DEFENDER_SCANNER_UNAVAILABLE' }
    if ($UpdateSignatures) {
        & $scanner -SignatureUpdate
        if ($LASTEXITCODE -ne 0) { throw "DEFENDER_SIGNATURE_UPDATE_FAILED: $LASTEXITCODE" }
    }
    $state = Get-MpComputerStatus
    $result.defender = [ordered]@{
        scanner = $scanner
        productVersion = $state.AMProductVersion
        engineVersion = $state.AMEngineVersion
        signatureVersion = $state.AntivirusSignatureVersion
        signatureUpdatedAt = $state.AntivirusSignatureLastUpdated.ToUniversalTime().ToString('o')
        antivirusEnabled = [bool]$state.AntivirusEnabled
        realTimeProtectionEnabled = [bool]$state.RealTimeProtectionEnabled
    }
    if (-not $state.AMServiceEnabled -or -not $state.AntivirusEnabled) { throw 'DEFENDER_UNAVAILABLE' }
    if ($state.AntivirusSignatureLastUpdated -lt (Get-Date).AddDays(-7)) { throw 'DEFENDER_SIGNATURES_STALE: run with -UpdateSignatures' }
    # ReturnHR avoids relying on localized console text or treating successful
    # remediation as a clean package. Any nonzero result blocks the package.
    $scanOutput = & $scanner -Scan -ScanType 3 -File $file.FullName -DisableRemediation -ReturnHR 2>&1
    $code = $LASTEXITCODE
    $result.scanExitCode = $code
    $unsignedCode = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$code), 0)
    $result.scanHresult = ('0x{0:X8}' -f $unsignedCode)
    $result.output = ($scanOutput | Out-String).Trim()
    Write-Output $result.output
    if ($code -ne 0) {
        $result.status = 'blocked'
    } elseif ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $result.sha256) {
        throw 'DEFENDER_INPUT_CHANGED_DURING_SCAN'
    } else {
        $result.status = 'clean'
    }
} catch {
    $result.error = $_.Exception.Message
    Write-Output $result.error
} finally {
    $reportPath = [IO.Path]::GetFullPath($Report)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($reportPath)) | Out-Null
    [IO.File]::WriteAllText($reportPath, ($result | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    Write-Output "Defender result: $($result.status); report: $reportPath"
}
if ($result.status -ne 'clean') { exit 1 }
exit 0
