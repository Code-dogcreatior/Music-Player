#!/bin/bash
# 双击启动：后端 8000 + 前端 5173
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

export PYTHONNOUSERSITE=1
export PYTHONUNBUFFERED=1
export CONDA_PREFIX="$DIR/env"
export PATH="$DIR/env/bin:/usr/bin:/bin"
export NPM_CONFIG_PREFIX="$DIR/env"

if [[ ! -x "$DIR/env/bin/python" ]]; then
  echo "找不到打包环境：$DIR/env/bin/python"
  echo "请确认这是「音乐播放器-mac-arm64」完整文件夹，而不是只拷了单个文件。"
  read -r -p "按回车关闭…" _
  exit 1
fi

if [[ ! -f "$DIR/env/.conda_unpacked" ]]; then
  echo "第一次启动，正在适配这台电脑的路径…"
  "$DIR/env/bin/conda-unpack"
  touch "$DIR/env/.conda_unpacked"
fi

if [[ ! -f "$DIR/.env" && -f "$DIR/.env.example" ]]; then
  cp "$DIR/.env.example" "$DIR/.env"
fi

for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  while IFS= read -r pid; do
    if [[ -n "$pid" ]]; then
      echo "关闭占用端口 $port 的进程：$pid"
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  done < <(lsof -ti tcp:"$port" 2>/dev/null || true)
done

osascript >/dev/null <<APPLESCRIPT
tell application "Terminal"
  activate
  do script "cd \"$DIR\" && export PYTHONNOUSERSITE=1 PYTHONUNBUFFERED=1 CONDA_PREFIX=\"$DIR/env\" PATH=\"$DIR/env/bin:/usr/bin:/bin\" && exec \"$DIR/env/bin/python\" -m uvicorn backend.app:app --host 127.0.0.1 --port $BACKEND_PORT"
  do script "cd \"$DIR/frontend\" && export PATH=\"$DIR/env/bin:/usr/bin:/bin\" NPM_CONFIG_PREFIX=\"$DIR/env\" && exec \"$DIR/env/bin/npm\" run dev -- --host 127.0.0.1 --port $FRONTEND_PORT"
end tell
APPLESCRIPT

echo
echo "已启动："
echo "- 后端:  http://127.0.0.1:${BACKEND_PORT}"
echo "- 前端:  http://127.0.0.1:${FRONTEND_PORT}"
echo
echo "正在打开浏览器…"
open "http://127.0.0.1:${FRONTEND_PORT}" 2>/dev/null || true
echo "关闭对应终端窗口即可停止。"
read -r -p "按回车关闭本窗口…" _
