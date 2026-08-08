# Audio Separation Decision Notes

## Decision

Use Demucs as the app integration path.

## Test Result

Test track:

```text
已下载音乐/十年 - 陈奕迅 - 黑白灰.flac
```

Observed result:

- Demucs quality is acceptable for the product's first separation workflow.

Demucs output:

```text
audio_separation_lab/outputs/demucs/htdemucs/十年 - 陈奕迅 - 黑白灰/vocals.wav
audio_separation_lab/outputs/demucs/htdemucs/十年 - 陈奕迅 - 黑白灰/no_vocals.wav
```

## Demucs Integration Plan

Use:

```bash
python -m demucs -n htdemucs --two-stems vocals --out <output_dir> <audio_file>
```

Recommended product behavior:

- Default separation engine: Demucs `htdemucs`
- Output stems: `vocals.wav` and `no_vocals.wav`
- Run as a background job because full-song separation can still take tens of seconds.
- Keep model and generated stems outside the app source tree.

## Audio Dependency Notes

Current torchaudio versions may require `torchcodec` for loading audio through Demucs.

If Demucs reports:

```text
TorchCodec is required for load_with_torchcodec
```

install:

```bash
python -m pip install torchcodec
```

If TorchCodec then reports missing FFmpeg dynamic libraries, install FFmpeg inside the same conda environment:

```bash
conda install -n music ffmpeg -y
```

## MPS Status

The final `music` environment reports MPS working:

```text
Chip: Apple M5
Metal: Supported
macOS: 26.5
Python: 3.12.13 arm64
torch: 2.12.0
torchaudio: 2.11.0
torchcodec: 0.13.0
demucs: 4.0.1
ffmpeg: 8.0.1 conda-forge
torch.backends.mps.is_built(): True
torch.backends.mps.is_available(): True
torch.ones(1).to("mps"): tensor([1.], device='mps:0')
```

The earlier temporary `music-separation-test` environment reported MPS unavailable with the same `torch 2.12.0`, but it used Python 3.11 and a different environment state. Use the `music` environment as the source of truth for Demucs testing.

Known difference from the temporary environment:

- `music`: Python 3.12.13, `torch 2.12.0`, `torchaudio 2.11.0`, `torchcodec 0.13.0`, MPS works.
- `music-separation-test`: Python 3.11.15, `torch 2.12.0`, `torchaudio 2.11.0`, `torchcodec 0.13.0`, MPS reported unavailable and raised a macOS 14+ runtime error.
- The hardware and OS were the same, so the failure was environment-specific rather than a Mac/Metal limitation.
- The likely causes are PyTorch wheel/runtime differences across Python versions, dynamic library state inside the conda environment, or mixed package/user-site state during the temporary setup.

Conclusion: keep Demucs in the existing `music` environment and verify MPS there before integration.

To verify:

```bash
conda run -n music python -c "import torch; print(torch.__version__); print(torch.backends.mps.is_available()); print(torch.ones(1).to('mps'))"
```
