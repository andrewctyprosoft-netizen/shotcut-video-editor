@echo off
rem ShotCut launcher for Windows. Double-click to start, or drop a .shotcut project onto this file.
rem The first run downloads everything ShotCut needs into the "runtime" folder here (about 1.5 GB, internet needed once):
rem a portable Node.js, the Electron runtime, FFmpeg, Python with faster-whisper, and the Whisper speech model.
rem Nothing is installed system-wide. The setup itself is setup\launch.mjs.
setlocal
cd /d "%~dp0"
title ShotCut
set "NODE_VERSION=24.22.1"

if exist "runtime\node\node.exe" goto start
echo First run: setting ShotCut up. This downloads about 1.5 GB and takes a few minutes.
powershell -NoProfile -ExecutionPolicy Bypass -File "setup\get-node.ps1" -Version %NODE_VERSION% -Runtime "%~dp0runtime"
if errorlevel 1 goto failed

:start
"runtime\node\node.exe" "setup\launch.mjs" %*
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
pause
exit /b 1
