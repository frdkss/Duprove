@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0service\menu.ps1" %*
set "serviceExit=%errorlevel%"
if not "%serviceExit%"=="0" if "%~1"=="" pause
endlocal & exit /b %serviceExit%
