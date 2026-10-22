@echo off
rem ShotCut launcher. Double-click to start, or drop a .shotcut project onto this file to open it.
rem First run installs the app's components (needs Node.js and an internet connection once).
setlocal
cd /d "%~dp0"
title ShotCut

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\vite\bin\vite.js" (
  echo First run: installing ShotCut's components. This takes a minute...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto failed
)

rem Electron 45 downloads its program on first use, not during npm install (lesson L-node-ts-013).
if not exist "node_modules\electron\dist\electron.exe" (
  echo Downloading the Electron runtime, about 100 MB...
  call node node_modules\electron\install.js
  if errorlevel 1 goto failed
)

rem Rebuild the interface so the app always matches the source (about a second).
call node node_modules\vite\bin\vite.js build --logLevel error
if errorlevel 1 goto failed

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo Note: FFmpeg was not found on PATH. Import, export and preview copies need it.
  echo Install FFmpeg 7.1 or newer, or set its path in ShotCut ^> Settings.
  timeout /t 10
)

start "" /D "%~dp0." "node_modules\electron\dist\electron.exe" . %*
exit /b 0

:failed
echo.
echo ShotCut could not start. See the messages above.
pause
exit /b 1
