$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = $null
if (Test-Path -LiteralPath $vswhere) {
    $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
if (-not $installation) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw 'Install Visual Studio Build Tools with Desktop development with C++ and Windows SDK, then retry option 1.'
    }
    $ErrorActionPreference = 'Continue'
    & winget.exe install --id Microsoft.VisualStudio.2022.BuildTools --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity --override '--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
    if ($LASTEXITCODE -notin @(0, 3010)) { throw "Build Tools installation failed: $LASTEXITCODE" }
    $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $installation) { throw 'MSVC not found after installation. Restart Windows if requested by the installer.' }
}
$sdkLib = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Lib'
$sdkAvailable = @(Get-ChildItem -LiteralPath $sdkLib -Directory -ErrorAction SilentlyContinue | Where-Object {
    (Test-Path -LiteralPath (Join-Path $_.FullName 'um\x64\kernel32.lib')) -and
    (Test-Path -LiteralPath (Join-Path $_.FullName 'ucrt\x64\ucrt.lib'))
}).Count -gt 0
if (-not $sdkAvailable) {
    $installer = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\setup.exe'
    $parameters = 'modify --installPath "{0}" --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended' -f $installation
    $process = Start-Process -FilePath $installer -ArgumentList $parameters -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -notin @(0, 3010)) { throw "Windows SDK installation failed: $($process.ExitCode)" }
}
$env:PATH = (Join-Path $projectRoot '.venv\Scripts') + ';' + $env:PATH
$ErrorActionPreference = 'Continue'
Push-Location -LiteralPath $projectRoot
try {
    & cmake.exe -S native -B build/native
    if ($LASTEXITCODE -ne 0) { throw 'CMake configure failed.' }
    & cmake.exe --build build/native --config Release
    if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
    & ctest.exe --test-dir build/native -C Release --output-on-failure
    if ($LASTEXITCODE -ne 0) { throw 'Native check failed.' }
} finally { Pop-Location }
