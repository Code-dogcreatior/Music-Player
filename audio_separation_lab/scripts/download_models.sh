#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMUX_DIR="$ROOT_DIR/models/demucs"

mkdir -p "$DEMUX_DIR"

echo "Downloading Demucs htdemucs..."
curl -L --fail --continue-at - \
  "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th" \
  -o "$DEMUX_DIR/htdemucs-955717e8-8726e21a.th"

echo "Done. Models are in:"
echo "  $DEMUX_DIR"
