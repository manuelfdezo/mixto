@echo off
cd /d "%~dp0"
node "%~dp0scripts\stop.mjs"
if errorlevel 1 pause
