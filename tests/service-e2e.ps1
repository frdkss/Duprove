$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$parent = Join-Path $projectRoot '.verification'
[void][IO.Directory]::CreateDirectory($parent)
$fixture = Join-Path $parent ('service e2e & ' + [guid]::NewGuid().ToString('N'))
$utf8 = [Text.UTF8Encoding]::new($false)
function Write-Fixture($Relative, $Content) {
    $path = Join-Path $fixture $Relative
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $path))
    [IO.File]::WriteAllText($path, $Content, $utf8)
}
function Assert-Runner($Condition, $Message) { if (-not $Condition) { throw $Message } }
try {
    [void][IO.Directory]::CreateDirectory((Join-Path $fixture 'service'))
    Copy-Item -LiteralPath (Join-Path $projectRoot 'service.bat') -Destination $fixture
    foreach ($name in @('menu.ps1', 'launch.ps1', 'launch.mjs', 'bootstrap.ps1', 'profile.ps1', 'shortcuts.ps1')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot "service/$name") -Destination (Join-Path $fixture 'service')
    }
    Write-Fixture 'package.json' '{"name":"duprove-runner-fixture","version":"0.0.0","main":"main.cjs"}'
    Write-Fixture 'main.cjs' 'const { app, BrowserWindow } = require("electron"); app.whenReady().then(() => { const window = new BrowserWindow({width:320,height:200}); window.loadURL("data:text/html,Runner visibility test"); window.webContents.once("did-finish-load", () => { const visible = window.isVisible(); console.log("FIXTURE_WINDOW_VISIBLE=" + visible); app.exit(visible ? 0 : 1); }); });'
    Write-Fixture 'service/build-desktop.mjs' 'console.log("SYNTHETIC_BUILD_OK");'
    Write-Fixture 'node_modules/electron/package.json' '{"name":"electron","version":"0.0.0"}'
    Write-Fixture 'node_modules/electron/path.txt' (Join-Path $projectRoot 'node_modules/electron/dist/electron.exe')
    Write-Fixture 'node_modules/typescript/bin/tsc' ''
    Write-Fixture 'node_modules/vite/bin/vite.js' ''
    $batch = Join-Path $fixture 'service.bat'
    Push-Location -LiteralPath $parent
    try {
        & $batch 2
        Assert-Runner ($LASTEXITCODE -eq 0) 'Batch logged launch failed'
        $logs = @(Get-ChildItem -LiteralPath (Join-Path $fixture 'service/logs') -Filter 'run-*.log')
        Assert-Runner ($logs.Count -eq 1) 'Expected exactly one run log'
        $log = [IO.File]::ReadAllText($logs[0].FullName)
        Assert-Runner ($log.Contains('SYNTHETIC_BUILD_OK')) 'Child output missing from log'
        Assert-Runner ($log.Contains('FIXTURE_WINDOW_VISIBLE=true')) 'Electron window was hidden'
        $before = @(Get-ChildItem -LiteralPath (Join-Path $fixture 'service/logs')).Count
        & $batch 3
        Assert-Runner ($LASTEXITCODE -eq 0) 'Batch no-log launch failed'
        Assert-Runner (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'service/logs')).Count -eq $before) 'No-log launch wrote a service log'
        Write-Fixture 'service/build-desktop.mjs' 'process.exit(7);'
        $failedOutput = & $batch 3 2>&1
        Assert-Runner ($LASTEXITCODE -ne 0) 'Batch hid the failed build exit status'
        Assert-Runner (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'service/logs')).Count -eq $before) 'No-log failure wrote a service log'
    } finally { Pop-Location }
    Write-Host 'SERVICE_E2E_OK'
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    if ((Split-Path -Parent $resolved) -ne [IO.Path]::GetFullPath($parent) -or (Split-Path -Leaf $resolved) -notlike 'service e2e & *') {
        throw 'Unsafe test cleanup path'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
