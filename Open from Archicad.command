#!/bin/bash
# Opens the kitchen configurator for the Zone selected in Archicad (Tapir add-on required).
cd "$(dirname "$0")" || exit 1
command -v python3 >/dev/null 2>&1 || { echo "Python 3 is required: https://www.python.org/downloads/"; read -r -p "Press Enter."; exit 1; }
python3 archicad/launch_configurator.py
sleep 6
