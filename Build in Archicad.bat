@echo off
rem Opens the "Kitchen Configurator: Build Kitchen" window for the open Archicad project (Tapir add-on required).
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 ( start "" pyw -3 archicad\KitchenBuild.py & goto :eof )
where pythonw >nul 2>nul
if %errorlevel%==0 ( start "" pythonw archicad\KitchenBuild.py & goto :eof )
echo Python 3 was not found - install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH").
pause
