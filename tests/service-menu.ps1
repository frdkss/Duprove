$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $projectRoot 'service/menu.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('duprove-menu-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
function Assert-Service($Condition, $Message) { if (-not $Condition) { throw $Message } }
try {
    $fixture = Join-Path $testRoot 'project with spaces'
    [void][IO.Directory]::CreateDirectory($fixture)
    New-ProjectDirectories -ProjectRoot $fixture
    New-ProjectDirectories -ProjectRoot $fixture
    Assert-Service (Test-Path -LiteralPath (Join-Path $fixture 'src/modal')) 'Missing project directory'
    Assert-Service (Test-Path -LiteralPath (Join-Path $fixture 'backend/duprove_backend')) 'Missing backend directory'
    $conflict = Join-Path $testRoot 'conflict'
    [void][IO.Directory]::CreateDirectory($conflict)
    [IO.File]::WriteAllText((Join-Path $conflict 'native'), 'preserve')
    $failed = $false
    try { New-ProjectDirectories -ProjectRoot $conflict } catch { $failed = $true }
    Assert-Service $failed 'A file was accepted as directory'
    Assert-Service ([IO.File]::ReadAllText((Join-Path $conflict 'native')) -eq 'preserve') 'File was changed'

    $profile = Join-Path $testRoot 'profile with spaces.ps1'
    [IO.File]::WriteAllText($profile, '# Existing profile content')
    Install-ServiceProfile -ProjectRoot $projectRoot -ProfilePath $profile
    $first = [IO.File]::ReadAllText($profile)
    Install-ServiceProfile -ProjectRoot $projectRoot -ProfilePath $profile
    Assert-Service ($first -eq [IO.File]::ReadAllText($profile)) 'Profile installation is not idempotent'
    Assert-Service ($first.Contains('# Existing profile content')) 'Existing profile was removed'
    Assert-Service ($first.Contains('Duprove service shortcuts')) 'Managed block missing'
    Assert-Service (@(Get-ChildItem -LiteralPath $testRoot -Filter '*.bak').Count -eq 1) 'Backup missing or repeated'
    [IO.File]::WriteAllText($profile, '# >>> Duprove service shortcuts >>>')
    $failed = $false
    try { Install-ServiceProfile -ProjectRoot $projectRoot -ProfilePath $profile } catch { $failed = $true }
    Assert-Service $failed 'Incomplete managed block was overwritten'
    Write-Host 'SERVICE_MENU_OK'
} finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if ((Split-Path -Parent $resolved) -ne $parent -or (Split-Path -Leaf $resolved) -notlike 'duprove-menu-*') {
        throw 'Unsafe test cleanup path'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
