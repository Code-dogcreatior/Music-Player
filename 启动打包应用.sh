#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$ROOT/dist/music-server"
APP_BIN="$APP_DIR/music-server"

if [[ ! -d "$APP_DIR" ]]; then
  echo "未找到打包目录：$APP_DIR"
  echo "请先运行：conda run -n music python build.py"
  exit 1
fi

if [[ ! -f "$APP_BIN" ]]; then
  echo "未找到启动文件：$APP_BIN"
  echo "请重新打包后再启动。"
  exit 1
fi

chmod +x "$APP_BIN" 2>/dev/null || true

if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$APP_DIR" 2>/dev/null || true
fi

if command -v lsof >/dev/null 2>&1; then
  while IFS= read -r pid; do
    if [[ -n "$pid" ]]; then
      echo "关闭旧后端进程：$pid"
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done < <(lsof -ti tcp:8000 2>/dev/null || true)
fi

cd "$APP_DIR"
echo "启动 Music Player..."
exec "$APP_BIN"
