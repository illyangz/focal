@echo off
rem Double-click this file to launch Studio on Windows.
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org ^(LTS^), then run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run - installing dependencies ^(one-time, ~1 min^)...
  call npm install
)

call npm start
