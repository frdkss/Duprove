Set-StrictMode -Version Latest

function Install-ServiceDependencies {
    param([string]$ProjectRoot)

    $oldPreference = $ErrorActionPreference
    $oldEncoding = [Console]::OutputEncoding
    $oldPythonEncoding = $env:PYTHONIOENCODING
    try {
        $ErrorActionPreference = 'Stop'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $toolsDirectory = Join-Path $ProjectRoot '.tools'
        [void][IO.Directory]::CreateDirectory($toolsDirectory)
        $uvCommand = Get-Command uv.exe -ErrorAction SilentlyContinue
        $uv = if ($uvCommand) { $uvCommand.Source } else { Join-Path $toolsDirectory 'uv\uv.exe' }
        if (-not (Test-Path -LiteralPath $uv)) {
            $lock = Get-Content -LiteralPath (Join-Path $ProjectRoot 'service\tools.lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            $archive = Join-Path $toolsDirectory 'uv.zip'
            Write-Host 'Скачивание uv...'
            Invoke-WebRequest -UseBasicParsing -Uri $lock.uv.url -OutFile $archive -TimeoutSec 180
            if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.uv.sha256) {
                throw 'SHA256 архива uv не совпадает.'
            }
            Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $toolsDirectory 'uv') -Force
        }
        $ErrorActionPreference = 'Continue'
        $python = & $uv python find 3.14 2>$null
        if ($LASTEXITCODE -ne 0) {
            & $uv python install 3.14
            if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить Python 3.14.' }
            $python = & $uv python find 3.14
            if ($LASTEXITCODE -ne 0) { throw 'Python 3.14 не найден после установки.' }
        }
        $logDirectory = Join-Path $ProjectRoot 'service\logs'
        [void][IO.Directory]::CreateDirectory($logDirectory)
        $details = Join-Path $logDirectory ('install-{0}-details.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
        Write-Host "Подробный лог: $details"
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
        $env:PYTHONIOENCODING = 'utf-8'

        & $python -u -c 'import subprocess, sys; sys.exit(subprocess.call(sys.argv[1:], stderr=subprocess.STDOUT))' $python -u (Join-Path $ProjectRoot 'service\setup.py') --uv $uv | Tee-Object -FilePath $details
        if ($LASTEXITCODE -ne 0) {
            throw "Установка завершилась с ошибками. Отчёт: $(Join-Path $ProjectRoot 'service\logs\dependencies.json')"
        }
    } finally {
        $ErrorActionPreference = $oldPreference
        [Console]::OutputEncoding = $oldEncoding
        $env:PYTHONIOENCODING = $oldPythonEncoding
    }
}
