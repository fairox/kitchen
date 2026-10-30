@echo off
rem Opens the kitchen configurator for the Zone selected in Archicad (Tapir add-on required).
title Kitchen Configurator - from Archicad
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 ( py -3 archicad\launch_configurator.py & goto end )
where python >nul 2>nul
if %errorlevel%==0 ( python archicad\launch_configurator.py & goto end )
echo Python 3 was not found - install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH").
:end
timeout /t 8
