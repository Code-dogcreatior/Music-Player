#!/bin/bash
# 拷到对方 Mac 上执行一次即可。
# 用法：
#   1) 把本文件放到「音乐播放器-mac-arm64」文件夹里，双击
#   2) 或在终端：bash 去掉系统拦截.command "/路径/音乐播放器-mac-arm64"
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

if [[ $# -ge 1 ]]; then
  target="$1"
else
  target="$here"
  if [[ ! -d "$target/env" && ! -f "$target/打开音乐播放器.command" ]]; then
    for cand in \
      "$here/音乐播放器-mac-arm64" \
      "$here/../音乐播放器-mac-arm64" \
      "$HOME/Desktop/音乐播放器-mac-arm64" \
      "$HOME/Downloads/音乐播放器-mac-arm64"
    do
      if [[ -d "$cand/env" || -f "$cand/打开音乐播放器.command" ]]; then
        target="$cand"
        break
      fi
    done
  fi
fi

if [[ ! -d "$target" ]]; then
  echo "找不到播放器目录：$target"
  echo "请把脚本放进「音乐播放器-mac-arm64」里再双击，或："
  echo "  bash 去掉系统拦截.command \"/完整路径/音乐播放器-mac-arm64\""
  read -r -p "按回车关闭…" _
  exit 1
fi

target="$(cd "$target" && pwd)"
echo "将处理：$target"
echo "正在去掉「来自互联网」隔离（一般不用输入密码）…"

xattr -cr "$target" 2>/dev/null || xattr -dr com.apple.quarantine "$target" || true

echo "正在给主要程序做本机签名，减少再次弹窗…"
sign() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  codesign --force --sign - "$f" >/dev/null 2>&1 || true
}

sign "$target/env/bin/python"
sign "$target/env/bin/python3"
sign "$target/env/bin/python3.12"
sign "$target/env/bin/node"
sign "$target/env/bin/npm"
sign "$target/env/bin/npx"
sign "$target/env/bin/ffmpeg"
sign "$target/env/bin/ffprobe"
sign "$target/打开音乐播放器.command"
sign "$target/去掉系统拦截.command"

echo
echo "完成。以后请双击「打开音乐播放器.command」。"
echo "若仍弹出拦截：系统设置 → 隐私与安全性 → 仍要打开（整次只需一次，不要每个都输密码）。"
read -r -p "按回车关闭…" _
