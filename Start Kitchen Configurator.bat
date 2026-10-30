@echo off
rem Kitchen Configurator - Windows launcher. Double-click to start.
title Kitchen Configurator
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 serve.py --open
  goto end
)
where python >nul 2>nul
if %errorlevel%==0 (
  python serve.py --open
  goto end
)
echo.
echo   Python 3 was not found.
echo   Install it from https://www.python.org/downloads/
echo   and tick "Add python.exe to PATH" in the installer, then run this file again.
echo.
:end
pause
