@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-rippr-admin-powershell.ps1"

endlocal
