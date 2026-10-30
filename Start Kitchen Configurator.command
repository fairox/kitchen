#!/bin/bash
# Kitchen Configurator - macOS launcher. Double-click to start.
# First time: right-click > Open if macOS warns about an unidentified developer.
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
  exec python3 serve.py --open
fi
echo
echo "  Python 3 was not found."
echo "  Install it from https://www.python.org/downloads/ (or run: xcode-select --install),"
echo "  then double-click this file again."
echo
read -r -p "Press Enter to close."
