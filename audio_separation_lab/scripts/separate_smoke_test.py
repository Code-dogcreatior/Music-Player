#!/usr/bin/env python
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


LAB_DIR = Path(__file__).resolve().parents[1]
OUTPUT_DIR = LAB_DIR / "outputs"
LOG_DIR = LAB_DIR / "logs"
TMP_DIR = LAB_DIR / ".tmp"
CONVERTED_INPUT_DIR = TMP_DIR / "converted_input"


def run(cmd: list[str], log_path: Path, show_progress: bool = False) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    with log_path.open("w", encoding="utf-8") as log_file:
        if show_progress:
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=env,
                bufsize=1,
            )
            assert process.stdout is not None
            for line in process.stdout:
                print(line, end="", flush=True)
                log_file.write(line)
                log_file.flush()
            process.wait()
        else:
            process = subprocess.run(
                cmd,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                text=True,
                check=False,
                env=env,
            )
    if process.returncode != 0:
        raise SystemExit(f"Command failed, see log: {log_path}")


def require_module(module: str, install_hint: str) -> None:
    check = subprocess.run(
        [sys.executable, "-c", f"import {module}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if check.returncode != 0:
        raise SystemExit(f"Missing Python module `{module}`. {install_hint}")


def ffmpeg_path() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found

    for candidate in (
        Path("/opt/miniconda3/bin/ffmpeg"),
        Path("/opt/homebrew/bin/ffmpeg"),
        Path("/usr/local/bin/ffmpeg"),
    ):
        if candidate.exists():
            return str(candidate)

    raise SystemExit("`ffmpeg` is required to normalize test audio to WAV.")


def select_device(requested: str) -> str:
    if requested != "auto":
        return requested

    check = (
        "import torch; "
        "print('cuda' if torch.cuda.is_available() else "
        "'mps' if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available() else 'cpu')"
    )
    result = subprocess.run(
        [sys.executable, "-c", check],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    return result.stdout.strip() or "cpu"


def prepare_wav(audio_path: Path, duration: float | None = None, show_progress: bool = False) -> Path:
    if CONVERTED_INPUT_DIR.exists():
        shutil.rmtree(CONVERTED_INPUT_DIR)
    CONVERTED_INPUT_DIR.mkdir(parents=True, exist_ok=True)

    wav_path = CONVERTED_INPUT_DIR / f"{audio_path.stem}.wav"
    if audio_path.suffix.lower() == ".wav":
        shutil.copy2(audio_path, wav_path)
        return wav_path

    run(
        [
            ffmpeg_path(),
            "-y",
            "-i",
            str(audio_path),
            "-ar",
            "44100",
            "-ac",
            "2",
            *([] if duration is None else ["-t", str(duration)]),
            str(wav_path),
        ],
        LOG_DIR / "ffmpeg-convert.log",
        show_progress=show_progress,
    )
    return wav_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", type=Path, help="Audio file to separate")
    parser.add_argument(
        "--method",
        choices=("demucs",),
        default="demucs",
        help="Which separator to run",
    )
    parser.add_argument(
        "--show-progress",
        action="store_true",
        help="Print tool output while also writing logs",
    )
    parser.add_argument(
        "--device",
        choices=("auto", "cpu", "cuda", "mps"),
        default="auto",
        help="Torch device to use",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=None,
        help="Only process the first N seconds for faster smoke tests",
    )
    args = parser.parse_args()

    audio_path = args.audio.expanduser().resolve()
    if not audio_path.exists():
        raise SystemExit(f"Audio file does not exist: {audio_path}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    device = select_device(args.device)
    print(f"Using device: {device}")
    wav_path = prepare_wav(audio_path, duration=args.duration, show_progress=args.show_progress)

    require_module("demucs", "Install with: pip install -r audio_separation_lab/requirements.txt")
    run(
        [
            sys.executable,
            "-m",
            "demucs",
            "-n",
            "htdemucs",
            "--device",
            device,
            "--two-stems",
            "vocals",
            "--out",
            str(OUTPUT_DIR / "demucs"),
            str(wav_path),
        ],
        LOG_DIR / "demucs.log",
        show_progress=args.show_progress,
    )

    print(f"Done. Outputs: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
