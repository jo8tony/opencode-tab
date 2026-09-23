# -*- mode: python ; coding: utf-8 -*-

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules


ROOT = Path(SPEC).resolve().parent.parent
STATIC_DIR = ROOT / "llm_api_proxy_recorder" / "web" / "static"

datas = [(str(STATIC_DIR), "llm_api_proxy_recorder/web/static")]
hiddenimports = collect_submodules("uvicorn")
binaries = []

if sys.platform == "win32":
    import winpty

    winpty_runtime_dir = Path(winpty.__file__).resolve().parent
    for runtime_name in ("OpenConsole.exe", "winpty-agent.exe"):
        runtime_path = winpty_runtime_dir / runtime_name
        if not runtime_path.is_file():
            raise SystemExit(f"pywinpty runtime helper missing: {runtime_path}")
        binaries.append((str(runtime_path), "winpty"))

a = Analysis(
    [str(ROOT / "llm_api_proxy_recorder" / "__main__.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="llm-api-proxy-recorder-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
