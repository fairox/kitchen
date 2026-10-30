#!/bin/sh
# Kitchen Configurator - Linux launcher.
cd "$(dirname "$0")" || exit 1
command -v python3 >/dev/null 2>&1 || { echo "Python 3 is required (e.g. sudo apt install python3)."; exit 1; }
exec python3 serve.py --open "$@"
