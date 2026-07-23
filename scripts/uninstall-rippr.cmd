@echo off
setlocal
set "RIPPR_UNINSTALLER=%~dp0uninstall-rippr.ps1"
cd /d "%TEMP%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%RIPPR_UNINSTALLER%" %*
set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
