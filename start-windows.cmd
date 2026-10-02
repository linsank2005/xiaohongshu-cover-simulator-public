@echo off
chcp 65001 >nul
setlocal
pushd "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
)
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22.13 or newer, then reopen this file.
  start "" "https://nodejs.org/en/download"
  pause
  popd
  exit /b 1
)
node scripts\launch.mjs
if errorlevel 1 pause
popd
endlocal
