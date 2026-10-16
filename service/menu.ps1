param([ValidateSet('menu', '1', '2', '3', '99', '999')][string]$Action = 'menu')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bootstrap.ps1')
. (Join-Path $PSScriptRoot 'launch.ps1')
. (Join-Path $PSScriptRoot 'profile.ps1')

function New-ProjectDirectories {
    param([string]$ProjectRoot)
    $paths = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'directories.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($relative in $paths) {
        $target = $ProjectRoot
        foreach ($part in $relative.Split('/')) {
            if ($part -in @('', '.', '..') -or $part -match '[\\:|"<>?*\x00-\x1f]' -or $part -match '[. ]$') {
                throw "Недопустимый путь в directories.json: $relative"
            }
            $target = Join-Path $target $part
            if (Test-Path -LiteralPath $target) {
                $item = Get-Item -LiteralPath $target -Force
                if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                    throw "Вместо обычной папки существует файл или ссылка: $target"
                }
            } else { [void][IO.Directory]::CreateDirectory($target) }
        }
    }
}

function Write-ServiceLog {
    param([System.Management.Automation.ErrorRecord]$Record, [string]$Choice = '99')

    $logName = 'service-{0}-{1}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'), ([guid]::NewGuid().ToString('N'))
    foreach ($directory in @((Join-Path $PSScriptRoot 'logs'), (Join-Path ([IO.Path]::GetTempPath()) 'DuproveService'))) {
        try {
            [void][IO.Directory]::CreateDirectory($directory)
            $path = Join-Path $directory $logName
            @("Дата: $(Get-Date -Format o)", "Пункт меню: $Choice", ($Record | Format-List * -Force | Out-String), $Record.ScriptStackTrace) |
                Set-Content -LiteralPath $path -Encoding UTF8
            return $path
        } catch { continue }
    }
    return $null
}

function Show-ServiceMenu {
    param([string]$Status = '', [string]$LogPath = '', [string]$Detail = '')

    Clear-Host
    Write-Host '=DUPROVESERVICE='
    Write-Host '------------------------'
    Write-Host '1. Проверить и установить зависимости'
    Write-Host '2. Запуск с логом'
    Write-Host '3. Запуск без логов'
    Write-Host '99. Создать недостающие папки'
    Write-Host '999. Инициализировать шпаргалку'
    Write-Host ''
    Write-Host '0. Выход'
    Write-Host ''

    try {
        $raw = $Host.UI.RawUI
        $extra = 1
        if ($Status) { $extra++ }
        if ($LogPath -or $Detail) {
            $text = if ($LogPath) { "Запись в логе: $LogPath" } else { $Detail }
            $extra += [int][Math]::Ceiling($text.Length / [double]$raw.WindowSize.Width)
        }
        $position = $raw.CursorPosition
        $position.Y = [Math]::Max($position.Y, $raw.WindowPosition.Y + $raw.WindowSize.Height - $extra)
        $position.X = 0
        $raw.CursorPosition = $position
    } catch { }
    switch ($Status) {
        'running' { Write-Host 'Выполняется' -ForegroundColor Cyan }
        'success' { Write-Host 'Успех!' -ForegroundColor Green }
        'error' {
            if ($Host.UI.SupportsVirtualTerminal) {
                $esc = [char]27
                Write-Host "${esc}[38;2;255;165;0mОшибка!${esc}[0m"
            } else {
                Write-Host 'Ошибка!' -ForegroundColor DarkYellow
            }
        }
    }
    if ($LogPath) {
        if ($Host.UI.SupportsVirtualTerminal) {
            $esc = [char]27
            $uri = ([uri]$LogPath).AbsoluteUri
            Write-Host "Запись в логе: ${esc}]8;;${uri}${esc}\${LogPath}${esc}]8;;${esc}\"
        } else {
            Write-Host "Запись в логе: $LogPath"
        }
    } elseif ($Detail) {
        Write-Host $Detail
    }
    Write-Host 'Выберите пункт меню: ' -NoNewline
}

function Start-ServiceMenu {
    try { $Host.UI.RawUI.WindowTitle = 'DUPROVESERVICE' } catch { }
    $projectRoot = Split-Path -Parent $PSScriptRoot
    $status = ''
    $logPath = ''
    $detail = ''
    while ($true) {
        Show-ServiceMenu -Status $status -LogPath $logPath -Detail $detail
        $choice = Read-ServiceChoice
        if ($null -eq $choice) { return }
        $status = ''
        $logPath = ''
        $detail = ''
        switch ($choice.Trim()) {
            '0' { return }
            'close' { return }
            'exit' { return }
            { $_ -in @('1', '2', '3', '99', '999') } {
                Show-ServiceMenu -Status 'running'
                try {
                    if ($choice.Trim() -eq '999') {
                        Install-ServiceProfile -ProjectRoot $projectRoot -ProfilePath $PROFILE

                        . $PROFILE
                        Write-Host 'Команды srv, srvs, service, service.bat добавлены в профиль PowerShell.'
                        Write-Host 'В уже открытом родительском PowerShell выполните: . $PROFILE'
                        [void](Read-Host 'Профиль загружен. Enter — вернуться в меню')
                    } else {
                        Invoke-ServiceAction -Choice $choice.Trim() -ProjectRoot $projectRoot
                    }
                    $status = 'success'
                    if ($choice.Trim() -eq '1') { $detail = 'Отчёт: service\logs\dependencies.json' }
                    if ($choice.Trim() -eq '2') { $detail = 'Приложение закрыто. Лог: service\logs\run-*.log' }
                    if ($choice.Trim() -eq '3') { $detail = 'Приложение закрыто.' }
                } catch {
                    $failure = $_
                    $status = 'error'
                    if ($choice.Trim() -eq '3') {
                        $detail = $failure.Exception.Message
                    } else {
                        $logPath = $failure.Exception.Data['RunLogPath']
                        if (-not $logPath) { $logPath = Write-ServiceLog -Record $failure -Choice $choice.Trim() }
                        if (-not $logPath) { $detail = "Не удалось записать лог: $($failure.Exception.Message)" }
                    }
                }
            }
            default { $detail = 'Нет такого пункта. Введите 1, 2, 3, 99, 999 или 0.' }
        }
    }
}

function Read-ServiceChoice {
    if ([Console]::IsInputRedirected) { return [Console]::ReadLine() }
    return Read-Host
}

function Invoke-ServiceAction {
    param([string]$Choice, [string]$ProjectRoot)
    switch ($Choice) {
        '2' { Start-Duprove -ProjectRoot $ProjectRoot -WithLog }
        '3' { Start-Duprove -ProjectRoot $ProjectRoot }
        '99' { New-ProjectDirectories -ProjectRoot $ProjectRoot }
        '1' {
            $logs = Join-Path $ProjectRoot 'service\logs'
            [void][IO.Directory]::CreateDirectory($logs)
            $transcript = Join-Path $logs ('install-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
            $started = $false
            try {
                Start-Transcript -LiteralPath $transcript | Out-Null
                $started = $true
                New-ProjectDirectories -ProjectRoot $ProjectRoot
                Install-ServiceDependencies -ProjectRoot $ProjectRoot
            } finally { if ($started) { Stop-Transcript | Out-Null } }
        }
        default { throw "Unsupported service action: $Choice" }
    }
}


if ($MyInvocation.InvocationName -ne '.') {
    try {
        switch ($Action) {
            'menu' { Start-ServiceMenu }
            '999' {
                Install-ServiceProfile -ProjectRoot (Split-Path -Parent $PSScriptRoot) -ProfilePath $PROFILE
                . $PROFILE
                Write-Host 'Команды srv, srvs, service, service.bat добавлены в профиль PowerShell.'
                Write-Host 'В уже открытом родительском PowerShell выполните: . $PROFILE'
            }
            default { Invoke-ServiceAction -Choice $Action -ProjectRoot (Split-Path -Parent $PSScriptRoot) }
        }
        exit 0
    } catch {
        $logPath = $null
        if ($Action -ne '3') {
            $logPath = $_.Exception.Data['RunLogPath']
            if (-not $logPath) { $logPath = Write-ServiceLog -Record $_ -Choice $Action }
        }
        Write-Host "Ошибка: $($_.Exception.Message)" -ForegroundColor DarkYellow
        if ($logPath) { Write-Host "Запись в логе: $logPath" }
        exit 1
    }
}
