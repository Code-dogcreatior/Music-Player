#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_ENV="${BACKEND_ENV:-music}"
NODE_VERSION="${NODE_VERSION:-22.22.2}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

cd "$ROOT"

echo "[0/4] Clean occupied ports if needed..."
for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  while IFS= read -r pid; do
    if [[ -n "$pid" ]]; then
      echo "Killing PID $pid on port $port..."
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  done < <(lsof -ti tcp:"$port" 2>/dev/null || true)
done

if ! command -v conda >/dev/null 2>&1; then
  echo "conda not found. Please install Miniconda/Anaconda or add conda to PATH."
  exit 1
fi

if [[ ! -f "$HOME/.nvm/nvm.sh" ]]; then
  echo "nvm not found at $HOME/.nvm/nvm.sh. Please install nvm first."
  exit 1
fi

if [[ ! -f "$ROOT/frontend/package.json" ]]; then
  echo "Frontend folder not found: $ROOT/frontend"
  exit 1
fi

echo "[1/4] Check backend conda env..."
if ! conda env list | awk '{print $1}' | grep -qx "$BACKEND_ENV"; then
  echo "Creating conda env: $BACKEND_ENV"
  conda create -y -n "$BACKEND_ENV" python=3.12
fi

echo "[2/4] Check backend dependencies..."
echo "Updating musicdl to latest version..."
conda run -n "$BACKEND_ENV" python -m pip install --upgrade musicdl \
  -i https://pypi.tuna.tsinghua.edu.cn/simple \
  --trusted-host pypi.tuna.tsinghua.edu.cn >/dev/null 2>&1 || true

if ! conda run -n "$BACKEND_ENV" python -c "import fastapi, uvicorn, musicdl, musicbrainzngs, pylistenbrainz" >/dev/null 2>&1; then
  conda run -n "$BACKEND_ENV" python -m pip install -r "$ROOT/backend/requirements.txt" \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    --trusted-host pypi.tuna.tsinghua.edu.cn
fi

echo "[3/4] Check frontend dependencies with nvm..."
source "$HOME/.nvm/nvm.sh"
nvm use "$NODE_VERSION" >/dev/null
(
  cd "$ROOT/frontend"
  if [[ ! -d node_modules ]]; then
    npm install
  fi
)

echo "[4/4] Starting backend and frontend..."
osascript >/dev/null <<APPLESCRIPT
tell application "Terminal"
  activate
  do script "cd \"$ROOT\" && PYTHONUNBUFFERED=1 conda run --no-capture-output -n \"$BACKEND_ENV\" python -m uvicorn backend.app:app --reload --host 127.0.0.1 --port $BACKEND_PORT"
  do script "cd \"$ROOT/frontend\" && source \"$HOME/.nvm/nvm.sh\" && nvm use \"$NODE_VERSION\" && npm run dev -- --host 127.0.0.1 --port $FRONTEND_PORT"
end tell
APPLESCRIPT

echo
echo "Started:"
echo "- Backend:  http://127.0.0.1:$BACKEND_PORT"
echo "- Frontend: http://127.0.0.1:$FRONTEND_PORT"
echo
echo "Tips:"
echo "- Override conda env: BACKEND_ENV=music ./启动前后端_mac.sh"
echo "- Override Node:      NODE_VERSION=22.22.2 ./启动前后端_mac.sh"
