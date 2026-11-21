#!/usr/bin/env bash
# 把音乐播放器打成可拷到其他 Apple Silicon Mac 的目录（含 conda 环境、Node、前端依赖）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_NAME="${ENV_NAME:-music}"
CONDA_BIN="${CONDA_BIN:-/opt/miniconda3/bin}"
ENV_PREFIX="${CONDA_BIN%/bin}/envs/${ENV_NAME}"
PY="${ENV_PREFIX}/bin/python"
STAMP="$(date +%Y%m%d)"
DIST_NAME="音乐播放器-mac-arm64"
DIST="${PACK_DIR:-$ROOT/dist}/$DIST_NAME"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "只能在 Apple Silicon Mac 上打包（当前是 $(uname -m)）" >&2
  exit 1
fi
if [[ ! -x "$PY" ]]; then
  echo "找不到环境: $PY" >&2
  exit 1
fi

echo "==> 安装 conda-pack（仅打包机）"
"$PY" -m pip install -q conda-pack
CONDA_PACK="${ENV_PREFIX}/bin/conda-pack"

echo "==> 清理 $DIST"
rm -rf "$DIST"
mkdir -p "$DIST"

echo "==> 复制程序"
rsync -a \
  --exclude '.git/' \
  --exclude 'dist/' \
  --exclude 'build/' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.DS_Store' \
  --exclude '.cursor/' \
  --exclude '.kagent/' \
  --exclude '.claude/' \
  --exclude '已下载音乐/' \
  --exclude '下载/' \
  --exclude 'downloads/' \
  --exclude 'musicdl_outputs/' \
  --exclude 'audio_separation_lab/outputs/' \
  --exclude 'audio_separation_lab/logs/' \
  --exclude '.env' \
  --exclude 'music_player.sqlite3' \
  --exclude 'music_player.sqlite3-wal' \
  --exclude 'music_player.sqlite3-shm' \
  "$ROOT/" "$DIST/"

echo "==> 打包 conda 环境（music，含 Python / Node / ffmpeg / PySide6 等）"
PACK_TGZ="$DIST/.env.tar.gz"
"$CONDA_PACK" -p "$ENV_PREFIX" -o "$PACK_TGZ" --ignore-missing-files --ignore-editable-packages --n-threads 4 --force
mkdir -p "$DIST/env"
tar -xzf "$PACK_TGZ" -C "$DIST/env"
rm -f "$PACK_TGZ"

cp "$ROOT/打开音乐播放器.command" "$DIST/打开音乐播放器.command"
cp "$ROOT/scripts/去掉系统拦截.command" "$DIST/去掉系统拦截.command"
chmod +x "$DIST/打开音乐播放器.command" "$DIST/去掉系统拦截.command"

cat > "$DIST/使用说明.txt" <<EOF
音乐播放器（Apple Silicon Mac）
打包日期：${STAMP}

系统要求
- 必须是 Apple 芯片（M1 / M2 / M3 / M4），Intel Mac 不能用
- 不需要再装 conda / nvm / Node，环境已打进 env 文件夹

安装
1. 解压后把整个「${DIST_NAME}」文件夹拷到目标电脑（不要只拷里面单个文件）
2. 先双击「去掉系统拦截.command」（解压后做一次即可，避免每次启动都验证动态库）
3. 再双击「打开音乐播放器.command」
4. 浏览器打开 http://127.0.0.1:5173/

说明
- 第一次启动会跑 conda-unpack，适配本机路径，稍等即可
- 翻译等可选配置写在 .env（可参考 .env.example）
- 本包不含已下载音乐；曲库会在新电脑上重新生成
EOF

echo "==> 体积"
du -sh "$DIST" "$DIST/env" "$DIST/frontend/node_modules" "$DIST/audio_separation_lab" 2>/dev/null || true

ARCHIVE="${PACK_ARCHIVE:-$ROOT/dist/${DIST_NAME}-${STAMP}.tar.gz}"
echo "==> 压缩 $ARCHIVE"
mkdir -p "$(dirname "$ARCHIVE")"
tar -C "$(dirname "$DIST")" -czf "$ARCHIVE" "$(basename "$DIST")"
ls -lh "$ARCHIVE"
echo "完成：$DIST"
echo "压缩包：$ARCHIVE"
