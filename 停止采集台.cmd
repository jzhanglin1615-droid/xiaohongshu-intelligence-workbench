@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\workbench-control.ps1" -Action Stop
if errorlevel 1 pause
