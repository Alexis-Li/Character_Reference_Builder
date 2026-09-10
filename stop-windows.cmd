@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-windows.ps1" %*
set "exitCode=%ERRORLEVEL%"
pause
exit /b %exitCode%
