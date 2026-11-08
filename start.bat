@echo off
rem FX MIC Patcher launcher.
rem The app is plain HTML, so v2.html opens on its own by double-clicking it.
rem This serves it over localhost instead, which is the only way the
rem microphone preview source can work: getUserMedia needs a secure context.
title FX MIC Patcher
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 goto nonode

rem serve.mjs opens the browser itself once the port is actually bound
node serve.mjs
goto end

:nonode
echo.
echo   Node was not found on PATH, so the local server cannot start.
echo   Opening v2.html directly instead.
echo.
echo   Everything works this way except "src: microphone", which needs
echo   a secure context. Install Node and run this again for the mic.
echo.
start "" "%~dp0v2.html"
timeout /t 6 >nul

:end
