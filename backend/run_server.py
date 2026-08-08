import os

import uvicorn


def env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def main():
    host = os.getenv("MUSIC_SERVER_HOST", "127.0.0.1")
    port = int(os.getenv("MUSIC_SERVER_PORT", "8000"))
    reload = env_flag("MUSIC_SERVER_RELOAD", True)
    uvicorn.run("backend.app:app", host=host, port=port, reload=reload, log_level="info")


if __name__ == "__main__":
    main()
