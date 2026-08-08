#!/usr/bin/env python
from __future__ import annotations

import argparse
import platform
import shutil
import subprocess
import sys
from pathlib import Path


LAB_DIR = Path(__file__).resolve().parents[1]
REQUIREMENTS = LAB_DIR / "requirements.txt"


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def has_nvidia_gpu() -> bool:
    nvidia_smi = shutil.which("nvidia-smi")
    if not nvidia_smi:
        return False
    result = subprocess.run(
        [nvidia_smi, "-L"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.returncode == 0


def is_apple_silicon() -> bool:
    return platform.system().lower() == "darwin" and platform.machine().lower() == "arm64"


def macos_major_version() -> int:
    version = platform.mac_ver()[0]
    if not version:
        return 0
    return int(version.split(".", maxsplit=1)[0])


def torch_install_command(torch_build: str) -> list[str]:
    base = [sys.executable, "-m", "pip", "install", "-U", "torch", "torchaudio", "torchcodec"]
    system = platform.system().lower()

    if torch_build == "nightly":
        return base + [
            "--pre",
            "--force-reinstall",
            "--index-url",
            "https://download.pytorch.org/whl/nightly/cpu",
        ]

    if system in {"linux", "windows"} and has_nvidia_gpu():
        return base + ["--index-url", "https://download.pytorch.org/whl/cu126"]

    return base


def verify_torch(expect_mps: bool) -> bool:
    verify = (
        "import torch; "
        "print('torch', torch.__version__); "
        "print('cuda', torch.cuda.is_available()); "
        "print('mps_built', getattr(torch.backends, 'mps', None) is not None and torch.backends.mps.is_built()); "
        "print('mps_available', getattr(torch.backends, 'mps', None) is not None and torch.backends.mps.is_available()); "
        "raise SystemExit(0 if (not "
        + repr(expect_mps)
        + " or (getattr(torch.backends, 'mps', None) is not None and torch.backends.mps.is_available())) else 1)"
    )
    result = subprocess.run([sys.executable, "-c", verify], check=False)
    return result.returncode == 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--torch-build",
        choices=("auto", "stable", "nightly"),
        default="auto",
        help="PyTorch build to install. auto uses nightly on Apple Silicon macOS 15+ to avoid new macOS/MPS detection gaps.",
    )
    parser.add_argument(
        "--require-mps",
        action="store_true",
        help="Fail installation verification if MPS is not available.",
    )
    return parser.parse_args()


def resolve_torch_build(torch_build: str) -> str:
    if torch_build != "auto":
        return torch_build
    if is_apple_silicon() and macos_major_version() >= 15:
        return "nightly"
    return "stable"


def main() -> None:
    args = parse_args()
    torch_build = resolve_torch_build(args.torch_build)
    expect_mps = args.require_mps or is_apple_silicon()

    run([sys.executable, "-m", "pip", "install", "-U", "pip"])
    run(torch_install_command(torch_build))
    run([sys.executable, "-m", "pip", "install", "-r", str(REQUIREMENTS)])

    if not verify_torch(expect_mps):
        raise SystemExit(
            "PyTorch installed, but MPS is still unavailable. "
            "On Apple Silicon, try rerunning with --torch-build nightly after removing older torch wheels."
        )


if __name__ == "__main__":
    main()
