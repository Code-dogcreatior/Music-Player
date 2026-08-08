"""Load optional local configuration without adding a runtime dependency.

The real ``.env`` file is intentionally ignored by Git. In a packaged build it
can live next to ``music-server.exe``; in source checkouts it lives at the
repository root.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from uuid import uuid4


def _env_candidates() -> list[Path]:
    candidates: list[Path] = []
    configured = os.getenv("MUSIC_PLAYER_ENV_FILE", "").strip()
    if configured:
        candidates.append(Path(configured).expanduser())

    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent / ".env")
    else:
        candidates.append(Path(__file__).resolve().parents[1] / ".env")

    candidates.append(Path.cwd() / ".env")
    return list(dict.fromkeys(path.resolve() for path in candidates))


def get_app_env_path() -> Path:
    candidates = _env_candidates()
    return next((path for path in candidates if path.is_file()), candidates[0])


def read_app_env(path: Path | None = None) -> dict[str, str]:
    env_path = (path or get_app_env_path()).resolve()
    if not env_path.is_file():
        return {}

    values: dict[str, str] = {}
    for raw_line in env_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not key or not key.replace("_", "").isalnum():
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        values[key] = value
    return values


def load_app_env(*, override: bool = False) -> Path | None:
    """Load the first available .env file into the current process."""
    for path in _env_candidates():
        if not path.is_file():
            continue
        for key, value in read_app_env(path).items():
            if override or key not in os.environ:
                os.environ[key] = value
        return path
    return None


def write_app_env(updates: dict[str, str], path: Path | None = None) -> Path:
    """Update selected values while preserving comments and unrelated settings."""
    env_path = (path or get_app_env_path()).resolve()
    env_path.parent.mkdir(parents=True, exist_ok=True)
    normalized = {key.strip(): str(value).strip() for key, value in updates.items() if key.strip()}
    for key, value in normalized.items():
        if not key.replace("_", "").isalnum():
            raise ValueError(f"无效的环境变量名：{key}")
        if "\n" in value or "\r" in value:
            raise ValueError(f"环境变量 {key} 不能包含换行")

    lines = env_path.read_text(encoding="utf-8-sig").splitlines() if env_path.is_file() else []
    written: set[str] = set()
    output: list[str] = []
    for raw_line in lines:
        candidate = raw_line.strip()
        exported = candidate.startswith("export ")
        assignment = candidate[7:].lstrip() if exported else candidate
        key, separator, _ = assignment.partition("=")
        key = key.strip()
        if separator and key in normalized:
            prefix = "export " if exported else ""
            output.append(f"{prefix}{key}={normalized[key]}")
            written.add(key)
        else:
            output.append(raw_line)

    if output and output[-1].strip():
        output.append("")
    for key, value in normalized.items():
        if key not in written:
            output.append(f"{key}={value}")

    temp_path = env_path.with_name(f"{env_path.name}.tmp-{uuid4().hex}")
    try:
        temp_path.write_text("\n".join(output).rstrip() + "\n", encoding="utf-8")
        os.replace(temp_path, env_path)
    finally:
        if temp_path.exists():
            temp_path.unlink()
    return env_path
