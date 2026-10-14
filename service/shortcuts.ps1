$duproveServiceScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'service.bat'
$duproveServiceCommand = {
    & $duproveServiceScript @args
    $global:LASTEXITCODE = $LASTEXITCODE
}.GetNewClosure()
Set-Item -Path Function:global:Start-DuproveService -Value $duproveServiceCommand
foreach ($duproveShortcut in @('srv', 'srvs', 'service', 'service.bat')) {
    Set-Alias -Name $duproveShortcut -Value Start-DuproveService -Scope Global -Force
}
Remove-Variable duproveServiceScript, duproveServiceCommand, duproveShortcut
