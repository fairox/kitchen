"""Kitchen Configurator window for Archicad's Tapir palette.

Same layout as the Tapir ScriptWindow / Parkform builder: header, body, and a footer
with the status line, "Keep on top" and the action buttons. The palette starts scripts
with `uv run --script <file> --port N` and no console, so everything happens in this
window. Only tkinter/ttk and the standard library are used.

The build file comes from the web app (Send to Archicad > Download build file) and is
picked up from Downloads automatically; the browser never connects to Archicad.
"""
import argparse
import contextlib
import json
import math
import os
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

try:
    B  # noqa: B018 - bundled into KitchenBuild.py: the library above is this very module
except NameError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import build_kitchen as B  # noqa: E402

SCRIPT_NAME = "Kitchen Configurator: Build Kitchen"
APP_ROOT = Path(__file__).resolve().parent.parent  # the package folder (index.html, serve.py) when run from it
WEB_APP = os.environ.get("KITCHEN_WEB_APP", "")  # a hosted copy of the web app, if you have one
STATUS_COLORS = {"info": "#555555", "ok": "#1b7f3b", "warning": "#a15c00", "error": "#c62828"}
POLL_MS = 3000


def build_files():
    cands = []
    for d in (Path.home() / "Downloads", Path.cwd()):
        if d.exists():
            cands += list(d.glob("*" + B.BUILD_SUFFIX))
    return sorted(cands, key=lambda p: p.stat().st_mtime, reverse=True)


def age_text(path):
    s = time.time() - path.stat().st_mtime
    return "just now" if s < 90 else f"{int(s // 60)} min ago" if s < 5400 else f"{int(s // 3600)} h ago" if s < 172800 else f"{int(s // 86400)} days ago"


# ----------------------------------------------------------------------------- local web app

def running_server(first=8000):
    for port in range(first, first + 20):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=1.0) as r:
                if json.loads(r.read().decode()).get("bridge"):
                    return port
        except (urllib.error.URLError, OSError, ValueError):
            continue
    return None


def start_server(first=8000):
    serve = APP_ROOT / "serve.py"
    kwargs = {"cwd": str(APP_ROOT), "stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen([sys.executable, str(serve), "--port", str(first)], **kwargs)
    for _ in range(40):
        time.sleep(0.25)
        port = running_server(first)
        if port:
            return port
    raise B.ArchicadError("The configurator's local server did not start.")


def web_app_url(site=None):
    """URL of the web app (local package first), with a fixed site in the hash when given."""
    if (APP_ROOT / "index.html").exists() and (APP_ROOT / "serve.py").exists():
        base = f"http://localhost:{running_server() or start_server()}/"
    elif WEB_APP:
        base = WEB_APP
    else:
        raise B.ArchicadError("The web app was not found next to this script. Run it from the Kitchen Configurator package folder.")
    if site:
        import base64
        base += "#" + urllib.parse.quote(base64.b64encode(json.dumps(site).encode()).decode())
    return base


def zone_site(ac):
    """The selected Zone as a fixed site for the web app: (site, text) or (None, reason)."""
    selected = {e["elementId"]["guid"] for e in ac.tapir("GetSelectedElements").get("elements", [])}
    zones = [e["elementId"]["guid"] for e in ac.tapir("GetElementsByType", {"elementType": "Zone"}).get("elements", []) if "elementId" in e]
    picked = [g for g in zones if g in selected]
    if len(picked) != 1:
        return None, "no Zone is selected" if not picked else f"{len(picked)} Zones are selected"
    bb = (ac.tapir("Get3DBoundingBoxes", {"elements": [{"elementId": {"guid": picked[0]}}]}).get("boundingBoxes3D") or [{}])[0].get("boundingBox3D")
    if not bb:
        return None, "the selected Zone has no geometry"
    stories = ac.tapir("GetStories").get("stories", [])
    floor = min(stories, key=lambda s: abs(s.get("level", 0) - bb["zMin"])).get("index", 0) if stories else 0
    site = {"roomW": round((bb["xMax"] - bb["xMin"]) * 1000), "roomD": round((bb["yMax"] - bb["yMin"]) * 1000),
            "wallH": min(max(round((bb["zMax"] - bb["zMin"]) * 1000), 2200), 5000),
            "originX": round(bb["xMin"] * 1000), "originY": round(bb["yMin"] * 1000), "acFloor": floor,
            "acWalls": False, "openEnds": False, "openings": [], "siteFixed": True, "siteSource": "Archicad zone"}
    return site, f"{site['roomW']} x {site['roomD']} mm at ({bb['xMin']:.3f}, {bb['yMin']:.3f}) m, story {floor}"


# ----------------------------------------------------------------------------- window

class KitchenWindow:
    def __init__(self, port=None):
        import tkinter as tk
        from tkinter import font as tkfont, ttk
        self.tk, self.ttk = tk, ttk
        self.port = port
        self.status_info, self.model, self.settings, self.file, self.file_mtime = None, None, None, None, 0
        if sys.platform == "win32":
            try:
                import ctypes
                ctypes.windll.shcore.SetProcessDpiAwareness(1)
            except (AttributeError, OSError):
                pass
        self.root = tk.Tk()
        self.root.title(SCRIPT_NAME)
        self.root.minsize(660, 760)
        self.root.geometry("700x880")
        style = ttk.Style(self.root)
        pref = {"win32": "vista", "darwin": "aqua"}.get(sys.platform, "clam")
        if pref in style.theme_names():
            style.theme_use(pref)
        fam = tkfont.nametofont("TkDefaultFont").actual("family")
        style.configure("Title.TLabel", font=(fam, 14, "bold"))
        style.configure("Description.TLabel", foreground="#555555")
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(2, weight=1)
        header = ttk.Frame(self.root, padding=(14, 12, 14, 8))
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(0, weight=1)
        ttk.Label(header, text=SCRIPT_NAME, style="Title.TLabel").grid(row=0, column=0, sticky="w")
        desc = ttk.Label(header, style="Description.TLabel", justify="left", text=(
            "Builds a kitchen from the Kitchen Configurator web app in this Archicad project. In the web app press "
            "Send to Archicad and download the build file; it is picked up here from Downloads. Every element is "
            "verified by read-back; Replace removes only this script's own verified previous build, and keeps "
            "anything you have edited since."))
        desc.grid(row=1, column=0, sticky="ew", pady=(4, 0))
        header.bind("<Configure>", lambda e: desc.configure(wraplength=max(200, e.width - 28)))
        ttk.Separator(self.root).grid(row=1, column=0, sticky="new")
        self.body = ttk.Frame(self.root, padding=(14, 10))
        self.body.grid(row=2, column=0, sticky="nsew")
        self.body.columnconfigure(0, weight=1)
        self.body.rowconfigure(2, weight=1)
        self._build_body()
        ttk.Separator(self.root).grid(row=3, column=0, sticky="ew")
        footer = ttk.Frame(self.root, padding=(14, 8))
        footer.grid(row=4, column=0, sticky="ew")
        footer.columnconfigure(0, weight=1)
        self.status = ttk.Label(footer, text="", foreground=STATUS_COLORS["info"], wraplength=600, justify="left")
        self.status.grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 6))
        self.keep_on_top = tk.BooleanVar(value=True)
        ttk.Checkbutton(footer, text="Keep on top", variable=self.keep_on_top, command=self._topmost).grid(row=1, column=0, sticky="w")
        bar = ttk.Frame(footer)
        bar.grid(row=1, column=1, sticky="e")
        self.buttons = []
        for text, cmd, primary in (("Open web app", self.open_web_app, False), ("Open build file…", self.choose_file, False),
                                   ("Test placement", self.test, False), ("Build in Archicad", self.build, True)):
            b = ttk.Button(bar, text=text, command=self.guarded(cmd), default="active" if primary else "normal")
            b.pack(side="left", padx=(6, 0))
            self.buttons.append(b)
        self.test_button, self.build_button = self.buttons[2], self.buttons[3]
        for b in (self.test_button, self.build_button):
            b.state(["disabled"])
        self.root.bind("<Return>", lambda _e: self.build_button.invoke())
        self._topmost()

    # ---------- layout ----------
    def _build_body(self):
        tk, ttk = self.tk, self.ttk
        ac = ttk.LabelFrame(self.body, text="Archicad", padding=(10, 6))
        ac.grid(row=0, column=0, sticky="ew")
        ac.columnconfigure(1, weight=1)
        ttk.Label(ac, text="Project:").grid(row=0, column=0, sticky="w")
        self.instance = tk.StringVar()
        self.instance_box = ttk.Combobox(ac, textvariable=self.instance, state="readonly")
        self.instance_box.grid(row=0, column=1, sticky="ew", padx=(6, 0))
        self.instance_box.bind("<<ComboboxSelected>>", lambda _e: self.guarded(self.pick_instance)())
        ttk.Button(ac, text="Refresh", command=self.guarded(self.refresh)).grid(row=0, column=2, padx=(6, 0))
        self.project_label = ttk.Label(ac, text="–", foreground="#555555")
        self.project_label.grid(row=1, column=1, columnspan=2, sticky="w", padx=(6, 0), pady=(2, 0))

        bf = ttk.LabelFrame(self.body, text="Build file from the web app", padding=(10, 6))
        bf.grid(row=1, column=0, sticky="ew", pady=(8, 8))
        bf.columnconfigure(1, weight=1)
        self.file_rows = {}
        for i, k in enumerate(("File", "Design", "Room", "Elements", "Checks")):
            ttk.Label(bf, text=k + ":").grid(row=i, column=0, sticky="nw")
            self.file_rows[k] = ttk.Label(bf, text="–", wraplength=480, justify="left")
            self.file_rows[k].grid(row=i, column=1, sticky="w", padx=(6, 0))

        self.tree = ttk.Treeview(self.body, columns=("kind", "count", "layers"), show="headings", height=6)
        for c, h, w, a in (("kind", "Element", 190, "w"), ("count", "Count", 60, "e"), ("layers", "Archicad layer(s)", 330, "w")):
            self.tree.heading(c, text=h, anchor=a)
            self.tree.column(c, width=w, anchor=a, stretch=c == "layers")
        self.tree.grid(row=2, column=0, sticky="nsew")

        pl = ttk.LabelFrame(self.body, text="Placement", padding=(10, 6))
        pl.grid(row=3, column=0, sticky="ew", pady=(8, 0))
        self.story, self.mode = tk.StringVar(), tk.StringVar()
        self.x, self.y, self.z, self.rot = (tk.StringVar(value="0") for _ in range(4))
        self.walls = tk.BooleanVar(value=True)
        ttk.Label(pl, text="Story:").grid(row=0, column=0, sticky="w")
        self.story_box = ttk.Combobox(pl, textvariable=self.story, state="readonly", width=26)
        self.story_box.grid(row=0, column=1, columnspan=3, sticky="w", padx=(6, 0), pady=2)
        ttk.Button(pl, text="From selected Zone", command=self.guarded(self.from_zone)).grid(row=0, column=4, columnspan=2, sticky="w", padx=(12, 0))
        for i, (lab, var) in enumerate((("Origin X", self.x), ("Y", self.y), ("Z", self.z))):
            ttk.Label(pl, text=lab + ":").grid(row=1, column=i * 2, sticky="w", padx=(0 if i == 0 else 12, 0))
            ttk.Entry(pl, textvariable=var, width=11).grid(row=1, column=i * 2 + 1, sticky="w", padx=(6, 0), pady=2)
        ttk.Label(pl, text="Rotation °:").grid(row=2, column=0, sticky="w")
        ttk.Entry(pl, textvariable=self.rot, width=11).grid(row=2, column=1, sticky="w", padx=(6, 0), pady=2)
        ttk.Label(pl, text="(metres; the room's inside corner goes to the origin)", foreground="#777777").grid(row=2, column=2, columnspan=4, sticky="w", padx=(12, 0))
        ttk.Label(pl, text="Mode:").grid(row=3, column=0, sticky="w")
        self.mode_box = ttk.Combobox(pl, textvariable=self.mode, state="readonly", width=62)
        self.mode_box.grid(row=3, column=1, columnspan=5, sticky="w", padx=(6, 0), pady=2)
        ttk.Checkbutton(pl, text="Build the room walls, doors, windows and threshold beams", variable=self.walls).grid(row=4, column=1, columnspan=5, sticky="w", padx=(6, 0), pady=(2, 0))
        self.note = ttk.Label(pl, text="", foreground=STATUS_COLORS["warning"], wraplength=580, justify="left")
        self.note.grid(row=5, column=0, columnspan=6, sticky="w", pady=(4, 0))

    # ---------- helpers ----------
    def _topmost(self):
        self.root.attributes("-topmost", self.keep_on_top.get())

    def set_status(self, text, kind="info"):
        self.status.configure(text=text, foreground=STATUS_COLORS.get(kind, STATUS_COLORS["info"]))
        self.root.update_idletasks()

    @contextlib.contextmanager
    def busy(self, text):
        was = [b.instate(["disabled"]) for b in self.buttons]
        for b in self.buttons:
            b.state(["disabled"])
        self.root.configure(cursor="watch")
        self.set_status(text)
        self.root.update()
        try:
            yield
        finally:
            for b, d in zip(self.buttons, was):
                if b.winfo_exists():
                    b.state(["disabled"] if d else ["!disabled"])
            self.root.configure(cursor="")

    def guarded(self, action):
        def run():
            try:
                action()
            except (B.ArchicadError, ValueError, OSError) as e:
                self.set_status(str(e), "error")
                print(f"Error: {e}")
            except Exception as e:  # noqa: BLE001 - the window must stay usable
                traceback.print_exc()
                self.set_status(f"Unexpected error: {type(e).__name__}: {e}", "error")
        return run

    def _num(self, var, what):
        try:
            v = float(var.get().replace(",", "."))
        except ValueError:
            raise ValueError(f"{what} must be a number.")
        if not math.isfinite(v):
            raise ValueError(f"{what} must be a number.")
        return v

    def _story_index(self):
        v = self.story.get()
        return int(v.split(":")[0]) if v else None

    def _ready(self):
        ok = bool(self.model and self.status_info and self.status_info.get("writable"))
        for b in (self.test_button, self.build_button):
            b.state(["!disabled"] if ok else ["disabled"])

    # ---------- Archicad ----------
    def refresh(self):
        self.status_info = None
        self.connect()
        if self.model:
            self._show_model()

    def connect(self):
        if self.port is None:
            with self.busy("Looking for Archicad…"):
                inst = B.instances()
            if not inst:
                self.instance_box.configure(values=[])
                self.instance.set("")
                self.project_label.configure(text="–")
                raise B.ArchicadError("No Archicad with Tapir answers on ports 19723-19744. Open a project in Archicad (close any open dialog) and press Refresh.")
            self.instances = inst
            labels = [f"{'Untitled project' if i.get('isUntitled') else (i.get('projectName') or '?')} · Archicad {i.get('archicad')} · port {i['port']}" for i in inst]
            self.instance_box.configure(values=labels)
            if len(inst) > 1:
                self.set_status("Several Archicad projects are open: choose the one to build into.", "warning")
                return
            self.port = inst[0]["port"]
        with self.busy("Reading the project…"):
            st = B.status(self.port)
        if not st.get("connected"):
            self.port = None
            raise B.ArchicadError(st.get("error") or "Archicad is not reachable.")
        self.status_info = st
        pj = st.get("project") or {}
        name = "Untitled project" if pj.get("isUntitled") else (pj.get("projectName") or "?")
        label = f"{name} · Archicad {st['archicadVersion'].split(' ')[0]} · port {st['port']}"
        if label not in self.instance_box.cget("values"):
            self.instance_box.configure(values=list(self.instance_box.cget("values")) + [label])
        self.instance.set(label)
        self.project_label.configure(text=f"Archicad {st['archicadVersion']} · Tapir {st['tapir']}"
                                     + (f" · project token {pj['token']}" if pj.get("token") else " · no kitchen built here yet"))
        self.story_box.configure(values=[f"{s['index']}: {s['name'] or '(unnamed)'} ({s['level']:.3f} m)" for s in st["stories"]])
        if not st.get("writable"):
            self.set_status(st.get("message") or "This Tapir version cannot build.", "error")
        elif st.get("missing"):
            self.set_status("Tapir lacks: " + ", ".join(st["missing"]) + " - update the add-on for a complete build.", "warning")
        self._refresh_modes()
        self._ready()

    def pick_instance(self):
        v = self.instance.get()
        if "port " in v:
            self.port = int(v.rsplit("port ", 1)[1])
            self.status_info = None
            self.connect()
            if self.model:
                self._show_model()

    def _refresh_modes(self):
        pj = (self.status_info or {}).get("project") or {}
        prev = B.previous_build(pj) if pj.get("token") else None
        opts = ([f"Replace previous build {prev['runId']} ({prev['count']} elements, {prev.get('layout') or 'kitchen'})"] if prev else []) + ["Append a new build"]
        self.mode_box.configure(values=opts)
        want = (self.settings or {}).get("mode", "replace")
        self.mode.set(opts[0] if (prev and want == "replace") else opts[-1])

    def from_zone(self):
        if not self.status_info:
            raise B.ArchicadError("Connect to Archicad first.")
        site, text = zone_site(B.Archicad(self.port))
        if not site:
            raise ValueError(f"Select the kitchen's Zone in Archicad first ({text}).")
        self.x.set(f"{site['originX'] / 1000:g}")
        self.y.set(f"{site['originY'] / 1000:g}")
        self.z.set("0")
        self.rot.set("0")
        s = next((s for s in self.status_info["stories"] if s["index"] == site["acFloor"]), None)
        if s:
            self.story.set(f"{s['index']}: {s['name'] or '(unnamed)'} ({s['level']:.3f} m)")
        self.walls.set(False)
        msg = f"Placed at the selected Zone: {text}. Its walls already exist, so the room walls are not built."
        if self.model:
            p = self.model["params"]
            if abs(p.get("roomW", 0) - site["roomW"]) > 20 or abs(p.get("roomD", 0) - site["roomD"]) > 20:
                msg += (f" Note: the zone is {site['roomW']} x {site['roomD']} mm but the design is for "
                        f"{p.get('roomW', 0):.0f} x {p.get('roomD', 0):.0f} mm - press Open web app to design for this zone.")
                self.set_status(msg, "warning")
                return
        self.set_status(msg, "ok")

    def open_web_app(self):
        site = None
        if self.status_info:
            try:
                site, _ = zone_site(B.Archicad(self.port))
            except B.ArchicadError:
                site = None
        with self.busy("Opening the web app…"):
            url = web_app_url(site)
        webbrowser.open(url)
        self.set_status(("Opened the web app with the selected Zone as the fixed room. " if site else "Opened the web app. ")
                        + "Design the kitchen, press Send to Archicad > Download build file; it appears here automatically.", "ok")

    # ---------- build file ----------
    def choose_file(self):
        from tkinter import filedialog
        f = filedialog.askopenfilename(parent=self.root, title="Kitchen build file", initialdir=str(Path.home() / "Downloads"),
                                       filetypes=[("Kitchen build", "*" + B.BUILD_SUFFIX), ("JSON", "*.json")])
        if f:
            self.load_file(Path(f))

    def load_file(self, path):
        self.model, self.settings = B.load_file(path)
        self.file, self.file_mtime = path, path.stat().st_mtime
        self._show_model()

    def _show_model(self):
        m, s = self.model, self.settings
        p = m["params"]
        self.file_rows["File"].configure(text=f"{self.file.name}  ({age_text(self.file)})")
        self.file_rows["Design"].configure(text=f"{s.get('name') or p.get('layout')} · {p.get('layout')} layout")
        self.file_rows["Room"].configure(text=f"{p.get('roomW', 0):.0f} x {p.get('roomD', 0):.0f} mm, {p.get('wallH', 0):.0f} mm high")
        segs = sum(len(w["segments"]) for w in m["walls"])
        self.file_rows["Elements"].configure(text=f"{len(m['boxes'])} morph boxes, {segs} wall segments, {len(m['openings'])} openings, {len(m['beams'])} beams")
        warn = [c for c in m["checks"] if c["level"] in ("error", "warn")]
        self.file_rows["Checks"].configure(text=("none" if not warn else f"{len(warn)}: " + " · ".join(c["msg"] for c in warn[:3]) + (" …" if len(warn) > 3 else "")),
                                           foreground=STATUS_COLORS["error" if any(c["level"] == "error" for c in warn) else "warning" if warn else "ok"])
        self.tree.delete(*self.tree.get_children())
        for kind, n, layers in B.summarize(m):
            self.tree.insert("", "end", values=(kind, n, layers))
        o = s["origin"]
        self.x.set(f"{o[0]:g}"); self.y.set(f"{o[1]:g}"); self.z.set(f"{o[2]:g}"); self.rot.set(f"{s['rotationDeg']:g}")  # noqa: E702
        self.walls.set(bool(s["walls"]) and bool(m["walls"]))
        if self.status_info:
            stories = self.status_info["stories"]
            st = next((x for x in stories if x["index"] == s.get("story")), None) or (stories[0] if stories else None)
            if st:
                self.story.set(f"{st['index']}: {st['name'] or '(unnamed)'} ({st['level']:.3f} m)")
            self._refresh_modes()
        notes = []
        if p.get("acWalls") is False:
            notes.append("This design's room comes from an Archicad zone: its walls already exist, so they are not rebuilt.")
        self.note.configure(text="\n".join(notes))
        self._ready()
        self.set_status(f"Ready: {len(m['boxes'])} boxes from {self.file.name}. Check the placement, then Build in Archicad.", "ok")

    def _poll(self):
        """Pick up a newer build file from Downloads as soon as the web app saves it."""
        try:
            files = build_files()
            # only a file that arrived after the loaded one replaces it (a file opened by hand stays)
            if files and (self.file is None or files[0].stat().st_mtime > self.file_mtime + 0.5):
                self.load_file(files[0])
                self.set_status(f"Picked up {files[0].name} from Downloads. Check the placement, then Build in Archicad.", "ok")
        except Exception as e:  # noqa: BLE001 - a half-written file is retried on the next poll
            if self.file is None:
                self.set_status(f"Could not read the newest build file yet: {e}", "warning")
        self.root.after(POLL_MS, self._poll)

    # ---------- build ----------
    def _options(self):
        story = self._story_index()
        if story is None:
            raise ValueError("Choose a story.")
        return {"port": self.port, "story": story, "mode": "replace" if self.mode.get().startswith("Replace") else "append",
                "origin": [self._num(self.x, "Origin X"), self._num(self.y, "Origin Y"), self._num(self.z, "Origin Z")],
                "rotationDeg": self._num(self.rot, "Rotation"), "walls": bool(self.walls.get())}

    def test(self):
        if not self.model or not self.status_info:
            return
        opts = self._options()
        lines = []
        with self.busy("Placing one element of each kind, reading it back and removing it…"):
            r = B.test_placement(self.model, log=lines.append, port=self.port, options=opts)
        print("\n".join(lines))
        bad = [line.strip() for line in lines if "MISMATCH" in line]
        self.set_status(f"Test placement {'passed' if r['ok'] else 'FAILED'}: {r['tested']} sample elements checked and removed."
                        + (" " + " | ".join(bad[:3]) if bad else ""), "ok" if r["ok"] else "error")

    def build(self):
        from tkinter import messagebox
        if not self.model or not self.status_info:
            return
        opts = self._options()
        pj = self.status_info.get("project") or {}
        target = "Untitled project" if pj.get("isUntitled") else (pj.get("projectName") or "?")
        m = self.model
        n = len(m["boxes"]) + (sum(len(w["segments"]) for w in m["walls"]) + len(m["openings"]) + len(m["beams"]) if opts["walls"] else 0)
        msg = (f"Build about {n} elements of the {m['params'].get('layout')} kitchen into {target} (port {self.port}), "
               f"story {self.story.get()}, origin ({opts['origin'][0]:g}, {opts['origin'][1]:g}, {opts['origin'][2]:g}) m, "
               f"rotation {opts['rotationDeg']:g}°?\n\n"
               + ("Replace: the previous kitchen build is removed only after the new one is verified; elements you edited are kept."
                  if opts["mode"] == "replace" else "Append: existing elements are not touched."))
        if not messagebox.askokcancel(SCRIPT_NAME, msg, parent=self.root):
            return
        lines = []
        with self.busy(f"Building about {n} elements and verifying each by read-back…"):
            r = B.build(m, opts, log=lines.append)
        print("\n".join(lines))
        text = (f"{'Built and verified' if r['ok'] else 'Built with problems'} · run {r['runId']} · {r['created']}/{r['planned']} created · {r['verification']}"
                + (f" · replaced {r['replaced']['runId']}: {r['replaced'].get('summary') or r['replaced'].get('why')}" if r.get("replaced") else ""))
        if r.get("verificationFailures"):
            text += " · e.g. " + "; ".join(f"{f['key']}: {', '.join(f['why'])}" for f in r["verificationFailures"][:2])
        self.status_info = None
        self.connect()
        self.set_status(text + f"\nJournal: {Path(r['journal']).name} in {Path(r['journal']).parent}", "ok" if r["ok"] else "warning")

    # ---------- start ----------
    def start(self):
        try:
            self.connect()
        finally:
            files = build_files()
            if files:
                try:
                    self.load_file(files[0])
                except (ValueError, OSError) as e:
                    self.set_status(f"The newest build file could not be read: {e}", "warning")
            elif self.status_info:
                self.set_status("No build file in Downloads yet: press Open web app, design the kitchen and use "
                                "Send to Archicad > Download build file. It is picked up here automatically.", "info")
            self.root.after(POLL_MS, self._poll)

    def run(self):
        self.root.protocol("WM_DELETE_WINDOW", self.root.destroy)
        self.root.bind("<Escape>", lambda _e: self.root.destroy())
        self.root.after(50, self.guarded(self.start))
        self.root.mainloop()


def gui_main(argv=None):
    """Entry point for the Tapir palette and double-click: the window, unless a console command is given."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:  # noqa: BLE001
            pass
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--port", type=int)
    ap.add_argument("--host", help="passed by the Tapir palette; only 127.0.0.1 / localhost is accepted")
    ap.add_argument("--token", help=argparse.SUPPRESS)  # the palette passes repository tokens; never used or printed
    ap.add_argument("--journal")
    ap.add_argument("--gui", action="store_true")
    a, rest = ap.parse_known_args(argv if argv is not None else sys.argv[1:])
    if a.host and a.host.split("://")[-1].split(":")[0] not in ("127.0.0.1", "localhost", "[::1]", "::1"):
        raise SystemExit("This script talks only to Archicad on this computer (127.0.0.1).")
    if a.journal:
        B.JOURNAL = Path(a.journal)
    console = [x for x in rest if x not in ("--cli",)]
    if a.gui or not console:
        try:
            import tkinter  # noqa: F401
        except ImportError:
            print("tkinter is not available; use the command line: --status, --builds, or a build file.")
            return 1
        KitchenWindow(a.port).run()
        return 0
    return B.main(console + (["--port", str(a.port)] if a.port else []) + (["--journal", a.journal] if a.journal else []))


if __name__ == "__main__":
    sys.exit(gui_main())
