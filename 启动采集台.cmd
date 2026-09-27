@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\workbench-control.ps1" -Action Start -OpenBrowser
if errorlevel 1 (
  echo.
  echo 启动失败。请查看 state\service-control\logs 和 receipts。
  pause
)
