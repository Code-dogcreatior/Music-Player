"""Load optional local configuration without adding a runtime dependency.

The real ``.env`` file is intentionally ignored by Git. In a packaged build it
can live next to ``music-server.exe``; in source checkouts it lives at the
repository root.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


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


def load_app_env() -> Path | None:
    """Load the first available .env file without overriding OS variables."""
    for path in _env_candidates():
        if not path.is_file():
            continue
        for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
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
            os.environ.setdefault(key, value)
        return path
    return None
