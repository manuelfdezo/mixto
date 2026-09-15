@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\preparar.ps1" -Actualizar
if errorlevel 1 pause
