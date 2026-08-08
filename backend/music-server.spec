# -*- mode: python ; coding: utf-8 -*-
import os
import sys
from glob import glob

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules


PROJECT_ROOT = os.path.abspath(".")
FRONTEND_DIST = os.path.join(PROJECT_ROOT, "frontend", "dist")
ASSETS_DIR = os.path.join(PROJECT_ROOT, "assets")
APP_ICON = os.path.join(ASSETS_DIR, "icon.ico")
APP_ICON_MAC = os.path.join(ASSETS_DIR, "icon.icns")


hiddenimports = [
    "_sqlite3",
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.websockets",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    # Namespace subpackage + jsonl data for importlib.resources.files()
    "fake_useragent.data",
    # PySide6 + QtWebEngine：collect_all 已带，但显式列出更稳，避免 hook 漏导
    "PySide6.QtCore",
    "PySide6.QtGui",
    "PySide6.QtWidgets",
    "PySide6.QtNetwork",
    "PySide6.QtWebChannel",
    "PySide6.QtWebEngineCore",
    "PySide6.QtWebEngineWidgets",
]
# rich 14.x 会通过 importlib 动态加载 rich._unicode_data.unicodeXX-X-X，
# PyInstaller 静态分析可能漏掉，导致运行时报 No module named ...unicode17-0-0。
hiddenimports += collect_submodules("rich._unicode_data")

datas = []
datas += collect_data_files("emoji")
datas += collect_data_files("fake_useragent")
datas += collect_data_files("rich")
if os.path.isdir(FRONTEND_DIST):
    datas.append((FRONTEND_DIST, "frontend/dist"))
if os.path.isdir(ASSETS_DIR):
    datas.append((ASSETS_DIR, "assets"))
binaries = []

# PySide6/QtWebEngine 必须用 collect_all 一次带齐：
# QtWebEngineProcess.exe、resources/、translations/qtwebengine_locales/ 缺一就白屏
_pyside_datas, _pyside_binaries, _pyside_hidden = collect_all("PySide6")
datas += _pyside_datas
binaries += _pyside_binaries
hiddenimports += _pyside_hidden
python_dll_dir = os.path.join(sys.prefix, "DLLs")
library_bin_dir = os.path.join(sys.prefix, "Library", "bin")
if os.path.isdir(python_dll_dir):
    for pattern in ("_sqlite3.pyd", "_ssl.pyd", "_socket.pyd", "_ctypes.pyd"):
        for file_path in glob(os.path.join(python_dll_dir, pattern)):
            binaries.append((file_path, "."))
if os.path.isdir(library_bin_dir):
    # Conda/Anaconda ships libffi as ffi-8.dll / ffi-7.dll (not libffi-*.dll).
    for pattern in (
        "libssl*.dll",
        "libcrypto*.dll",
        "libffi*.dll",
        "ffi*.dll",
        "sqlite3.dll",
    ):
        for file_path in glob(os.path.join(library_bin_dir, pattern)):
            binaries.append((file_path, "."))


a = Analysis(
    ["desktop_app.py"],
    pathex=[PROJECT_ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "matplotlib",
        "matplotlib.pyplot",
        "matplotlib.backends",
        "matplotlib.backends.backend_tkagg",
        "matplotlib.backends.backend_qt5agg",
        "matplotlib.backends.backend_qtagg",
        # 防止与 PySide6 冲突：Anaconda 默认带 PyQt5，PyInstaller 不允许多套 Qt 绑定共存
        "PyQt5",
        "PyQt6",
        "PySide2",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="music-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    icon=(
        APP_ICON_MAC
        if (sys.platform == "darwin" and os.path.isfile(APP_ICON_MAC))
        else (APP_ICON if os.path.isfile(APP_ICON) else None)
    ),
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="music-server",
)
