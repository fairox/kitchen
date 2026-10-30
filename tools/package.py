#!/usr/bin/env python3
"""
Build a ready-to-run zip of the configurator for Windows, macOS and Linux.

  python3 tools/package.py            -> dist/kitchen-configurator-<date>-<commit>.zip

The zip holds one folder with the web app, the local server, the Archicad
builder and double-click launchers. Windows .bat files get CRLF line endings
and the macOS/Linux launchers keep their executable bit.
"""
import os
import subprocess
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FOLDER = "kitchen-configurator"
SKIP = {".gitignore", ".gitattributes"}
EXECUTABLE = {"Start Kitchen Configurator.command", "Build in Archicad.command", "start.sh", "serve.py",
              "archicad/build_kitchen.py", "archicad/launch_configurator.py", "archicad/check_tapir.py",
              "archicad/KitchenBuild.py"}


def files():
    try:
        out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
        names = [n for n in out.decode("utf-8").split("\0") if n]
    except (OSError, subprocess.CalledProcessError):
        names = []
        for d, dirs, fs in os.walk(ROOT):
            dirs[:] = [x for x in dirs if not x.startswith(".") and x not in ("dist", "__pycache__", "node_modules")]
            names += [os.path.relpath(os.path.join(d, f), ROOT).replace(os.sep, "/") for f in fs]
    return sorted(n for n in names if n not in SKIP and not n.startswith("dist/")
                  and os.path.basename(n) != "last_build.json" and os.path.isfile(os.path.join(ROOT, n)))


def version():
    try:
        sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, check=True).stdout.decode().strip()
    except (OSError, subprocess.CalledProcessError):
        sha = "local"
    return f"{time.strftime('%Y%m%d')}-{sha}"


def main():
    bundled = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "bundle_tapir_script.py"), "--check"], capture_output=True, text=True)
    if bundled.returncode:
        sys.exit(bundled.stderr.strip() or bundled.stdout.strip())
    names = files()
    required = {"index.html", "serve.py", "generator.js", "archicad/build_kitchen.py", "archicad/launch_configurator.py", "archicad/KitchenBuild.py", "vendor/three.r128.min.js",
                "Start Kitchen Configurator.bat", "Start Kitchen Configurator.command", "START-HERE.txt"}
    missing = required - set(names)
    if missing:
        sys.exit(f"Missing from the package (commit them first?): {', '.join(sorted(missing))}")
    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
    out = os.path.join(ROOT, "dist", f"{FOLDER}-{version()}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for n in names:
            with open(os.path.join(ROOT, n), "rb") as f:
                data = f.read()
            if n.endswith(".bat"):
                data = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
            info = zipfile.ZipInfo(f"{FOLDER}/{n}", date_time=time.localtime()[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3  # unix, so the mode bits below are honoured
            info.external_attr = ((0o755 if n in EXECUTABLE else 0o644) | 0o100000) << 16
            z.writestr(info, data)
    print(f"Wrote {os.path.relpath(out, ROOT)} ({os.path.getsize(out) / 1024:.0f} KB, {len(names)} files)")


if __name__ == "__main__":
    main()
