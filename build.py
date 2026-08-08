from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


ROOT = Path(__file__).resolve().parent
BACKEND_DIR = ROOT / "backend"
FRONTEND_DIR = ROOT / "frontend"
FRONTEND_PACKAGE = FRONTEND_DIR / "package.json"
REQUIREMENTS_FILE = BACKEND_DIR / "requirements.txt"
SPEC_FILE = BACKEND_DIR / "music-server.spec"
PACKAGED_OUTPUT_DIR = ROOT / "dist" / "music-server"
PACKAGED_RUNTIME_DATA_NAMES = (
    "已下载音乐",
    "music_player.sqlite3",
    "music_player.sqlite3-wal",
    "music_player.sqlite3-shm",
)


def run(command: list[str], cwd: Path | None = None) -> None:
    location = f" (cwd={cwd})" if cwd else ""
    print(f"\n>> {' '.join(command)}{location}")
    subprocess.run(command, cwd=str(cwd) if cwd else None, check=True)


def find_npm() -> str:
    for candidate in ("npm.cmd", "npm"):
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    raise FileNotFoundError("npm not found in PATH")


def build_frontend(npm_executable: str) -> None:
    if not FRONTEND_PACKAGE.exists():
        raise FileNotFoundError("frontend/package.json not found")

    node_modules = FRONTEND_DIR / "node_modules"
    if not node_modules.exists():
        run([npm_executable, "install", "--no-audit", "--no-fund"], cwd=FRONTEND_DIR)

    run([npm_executable, "run", "build"], cwd=FRONTEND_DIR)


def build_backend(clean: bool) -> None:
    run([sys.executable, "-m", "pip", "install", "-r", str(REQUIREMENTS_FILE)])

    pyinstaller_cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm"]
    if clean:
        pyinstaller_cmd.append("--clean")
    pyinstaller_cmd.append(str(SPEC_FILE))
    run(pyinstaller_cmd, cwd=ROOT)


@contextmanager
def preserve_packaged_runtime_data(output_dir: Path = PACKAGED_OUTPUT_DIR) -> Iterator[None]:
    """在 PyInstaller 重建输出目录时保留打包版产生的用户数据。"""
    backup_dir = Path(tempfile.mkdtemp(prefix=".music-player-runtime-backup-", dir=ROOT))
    moved_items: list[tuple[Path, Path]] = []
    try:
        for name in PACKAGED_RUNTIME_DATA_NAMES:
            source = output_dir / name
            if not source.exists():
                continue
            backup = backup_dir / name
            shutil.move(str(source), str(backup))
            moved_items.append((backup, source))

        if moved_items:
            print(f"Preserving packaged user data: {', '.join(source.name for _, source in moved_items)}")
        yield
    finally:
        for backup, destination in moved_items:
            if not backup.exists():
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                raise FileExistsError(
                    f"Cannot restore packaged user data because the build created: {destination}"
                )
            shutil.move(str(backup), str(destination))

        if backup_dir.exists() and not any(backup_dir.iterdir()):
            backup_dir.rmdir()
        if moved_items:
            print("Packaged songs and runtime database restored.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the music player package.")
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Run PyInstaller with --clean for a full rebuild.",
    )
    parser.add_argument(
        "--skip-frontend",
        action="store_true",
        help="Skip frontend build and use existing frontend/dist.",
    )
    args = parser.parse_args()

    npm_executable = find_npm()
    print(f"Project root: {ROOT}")
    print(f"Python: {sys.executable}")
    print(f"Node env: {npm_executable}")

    if not args.skip_frontend:
        build_frontend(npm_executable)
    with preserve_packaged_runtime_data():
        build_backend(args.clean)

    output_dir = PACKAGED_OUTPUT_DIR
    print(f"\nDone. Output folder: {output_dir}")
    print("Run the packaged app/binary in dist/music-server (or app bundle on macOS).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
