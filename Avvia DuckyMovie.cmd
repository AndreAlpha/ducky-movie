@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if exist "release\0.6.1\win-unpacked\DuckyMovie.exe" (
  start "" "release\0.6.1\win-unpacked\DuckyMovie.exe"
  exit /b 0
)
if exist "release\0.6.0\win-unpacked\DuckyMovie.exe" (
  start "" "release\0.6.0\win-unpacked\DuckyMovie.exe"
  exit /b 0
)
if exist "release\0.5.0\win-unpacked\DuckyMovie.exe" (
  start "" "release\0.5.0\win-unpacked\DuckyMovie.exe"
  exit /b 0
)
if exist "release\0.4.0\win-unpacked\DuckyMovie.exe" (
  start "" "release\0.4.0\win-unpacked\DuckyMovie.exe"
  exit /b 0
)
if exist "release\win-unpacked\DuckyMovie.exe" (
  start "" "release\win-unpacked\DuckyMovie.exe"
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  echo Installa Node.js da https://nodejs.org e riapri questo file.
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  call npm ci
  if errorlevel 1 goto failed
)
call npm start
if errorlevel 1 goto failed
exit /b 0
:failed
echo.
echo Avvio non riuscito. Leggi il messaggio sopra per i dettagli.
pause
exit /b 1
