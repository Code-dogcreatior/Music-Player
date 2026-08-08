# Audio Separation Lab

Isolated playground for testing vocal separation before wiring anything into the Music Player app.

## Models

- Main integration path: Demucs `htdemucs`

See `SEPARATION_NOTES.md` for the test result and MPS status.

## Layout

- `models/`: local model cache/downloads
- `samples/`: short test clips
- `outputs/`: separated stems
- `scripts/`: setup, download, and test helpers

## Setup For `music`

The install helper chooses a PyTorch build before installing the separation packages:

- macOS: normal PyPI torch wheel, which includes MPS support on Apple Silicon.
- Linux/Windows with NVIDIA: CUDA torch wheel from the official PyTorch CUDA index.
- Other machines: normal PyPI torch wheel.

Install into the existing `music` environment:

```bash
conda run -n music python -m pip install -r audio_separation_lab/requirements-music.txt
```

If TorchCodec cannot find FFmpeg libraries, install FFmpeg into the same environment:

```bash
conda install -n music ffmpeg -y
```

## Download Models

```bash
bash audio_separation_lab/scripts/download_models.sh
```

Demucs may also populate its own cache on first inference. The script keeps a local copy here so downloads are explicit and easy to inspect.

## Run A Smoke Test

Put a short `.wav`, `.flac`, `.mp3`, or `.m4a` file in `samples/`, or pass a source file directly:

```bash
python audio_separation_lab/scripts/separate_smoke_test.py "已下载音乐/十年 - 陈奕迅 - 黑白灰.flac"
```

Outputs are written under `audio_separation_lab/outputs/`.

## Run The Gradio App

```bash
conda run -n music python audio_separation_lab/scripts/gradio_demucs_app.py
```

Open:

```text
http://127.0.0.1:7860
```

The app writes separated files under `audio_separation_lab/outputs/gradio-demucs/`.

In the current `music` environment, PyTorch reports MPS available, so the app's default `auto` device should use Apple GPU acceleration.
