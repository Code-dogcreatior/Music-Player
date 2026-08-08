#!/usr/bin/env python
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import gradio as gr


LAB_DIR = Path(__file__).resolve().parents[1]
OUTPUT_DIR = LAB_DIR / "outputs" / "gradio-demucs"
LOG_DIR = LAB_DIR / "logs"
TMP_DIR = LAB_DIR / ".tmp" / "gradio-demucs"
PROGRESS_RE = re.compile(
    r"(?P<percent>\d+(?:\.\d+)?)%\|.*?"
    r"(?P<done>\d+(?:\.\d+)?)/(?P<total>\d+(?:\.\d+)?).*?"
    r"\[(?P<elapsed>\d+:\d+)<(?P<remaining>\d+:\d+)"
)


def ffmpeg_path() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found

    for candidate in (
        Path("/opt/miniconda3/bin/ffmpeg"),
        Path("/opt/homebrew/bin/ffmpeg"),
        Path("/usr/local/bin/ffmpeg"),
    ):
        if candidate.exists():
            return str(candidate)

    raise RuntimeError("ffmpeg is required to normalize uploaded audio.")


def select_device(requested: str) -> str:
    if requested != "auto":
        return requested

    check = (
        "import torch; "
        "print('cuda' if torch.cuda.is_available() else "
        "'mps' if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available() else 'cpu')"
    )
    result = subprocess.run(
        [sys.executable, "-c", check],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    return result.stdout.strip() or "cpu"


def run_logged(cmd: list[str], log_path: Path) -> str:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    log_path.write_text(process.stdout, encoding="utf-8")
    if process.returncode != 0:
        raise RuntimeError(f"Command failed. Log: {log_path}\n\n{process.stdout[-3000:]}")
    return process.stdout


def run_logged_with_progress(
    cmd: list[str],
    log_path: Path,
    progress: gr.Progress,
    start: float = 0.2,
    end: float = 0.92,
) -> str:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"

    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=0,
        env=env,
    )
    assert process.stdout is not None

    output: list[str] = []
    buffer: list[str] = []
    last_update = 0.0
    started_at = time.time()

    def update_from_text(text: str) -> None:
        nonlocal last_update
        match = PROGRESS_RE.search(text)
        if not match:
            return

        percent = float(match.group("percent")) / 100
        done = float(match.group("done"))
        total = float(match.group("total"))
        elapsed = match.group("elapsed")
        remaining = match.group("remaining")
        now = time.time()
        if now - last_update <= 0.25 and percent < 1:
            return

        speed = done / max(now - started_at, 1)
        speed_text = f"{speed:.2f} 秒音频/秒"
        desc = (
            f"正在分离 {percent * 100:.1f}% | "
            f"已处理 {done:.1f}/{total:.1f} 秒 | "
            f"已用 {elapsed} | 预计剩余 {remaining} | {speed_text}"
        )
        progress(start + (end - start) * percent, desc=desc)
        last_update = now

    with log_path.open("w", encoding="utf-8") as log_file:
        while True:
            char = process.stdout.read(1)
            if char == "" and process.poll() is not None:
                break
            if not char:
                continue

            output.append(char)
            log_file.write(char)

            if char in {"\r", "\n"}:
                text = "".join(buffer)
                buffer.clear()
                update_from_text(text)
            else:
                buffer.append(char)

        remainder = "".join(buffer)
        update_from_text(remainder)

    if process.returncode != 0:
        joined = "".join(output)
        raise RuntimeError(f"Command failed. Log: {log_path}\n\n{joined[-3000:]}")

    return "".join(output)


def prepare_wav(input_path: Path, work_dir: Path, duration: float | None) -> Path:
    duration = duration if duration and duration > 0 else None
    wav_path = work_dir / f"{input_path.stem}.wav"
    if input_path.suffix.lower() == ".wav" and duration is None:
        shutil.copy2(input_path, wav_path)
        return wav_path

    cmd = [
        ffmpeg_path(),
        "-y",
        "-i",
        str(input_path),
        "-vn",
        "-ar",
        "44100",
        "-ac",
        "2",
        *([] if duration is None else ["-t", str(duration)]),
        str(wav_path),
    ]
    run_logged(cmd, LOG_DIR / "gradio-ffmpeg-convert.log")
    return wav_path


def separate_audio(
    audio_file: str | None,
    device_choice: str,
    duration: float | None,
    progress: gr.Progress = gr.Progress(track_tqdm=True),
) -> tuple[str | None, str | None, str]:
    if not audio_file:
        raise gr.Error("请先上传音频文件。")

    progress(0.05, desc="正在准备音频")
    input_path = Path(audio_file).expanduser().resolve()
    run_id = f"{input_path.stem}-{int(time.time())}"
    work_dir = TMP_DIR / run_id
    run_output_dir = OUTPUT_DIR / run_id
    work_dir.mkdir(parents=True, exist_ok=True)
    run_output_dir.mkdir(parents=True, exist_ok=True)

    device = select_device(device_choice)
    wav_path = prepare_wav(input_path, work_dir, duration)
    if wav_path.stat().st_size == 0:
        raise gr.Error("转换后的音频为空。请留空时长限制，或输入一个大于 0 的秒数。")

    progress(0.2, desc=f"正在使用 {device} 运行 Demucs")
    demucs_root = run_output_dir / "demucs"
    log_path = LOG_DIR / f"gradio-demucs-{run_id}.log"
    log = run_logged_with_progress(
        [
            sys.executable,
            "-m",
            "demucs",
            "-n",
            "htdemucs",
            "--device",
            device,
            "--two-stems",
            "vocals",
            "--out",
            str(demucs_root),
            str(wav_path),
        ],
        log_path,
        progress,
    )

    progress(0.95, desc="正在整理输出文件")
    stems_dir = demucs_root / "htdemucs" / wav_path.stem
    vocals = stems_dir / "vocals.wav"
    no_vocals = stems_dir / "no_vocals.wav"
    if not vocals.exists() or not no_vocals.exists():
        raise RuntimeError(f"Demucs completed but output stems were not found in {stems_dir}")

    message = (
        f"处理完成。\n"
        f"设备: {device}\n"
        f"输出目录: {run_output_dir}\n"
        f"日志: {log_path}\n\n"
        f"{log[-2000:]}"
    )
    return str(vocals), str(no_vocals), message


def build_app() -> gr.Blocks:
    with gr.Blocks(title="人声分离") as demo:
        gr.Markdown("# 人声分离")
        gr.Markdown("上传音频文件，分离后可试听并下载人声与伴奏。")

        with gr.Row():
            audio = gr.Audio(label="上传音频", type="filepath")
            with gr.Column():
                device = gr.Dropdown(
                    choices=["auto", "cpu", "cuda", "mps"],
                    value="auto",
                    label="处理设备",
                )
                duration = gr.Number(
                    label="仅处理前 N 秒（留空为整首）",
                    value=None,
                    precision=1,
                )
                run_button = gr.Button("开始分离", variant="primary")

        with gr.Row():
            vocals_preview = gr.Audio(label="人声试听", type="filepath")
            no_vocals_preview = gr.Audio(label="伴奏试听", type="filepath")

        with gr.Row():
            vocals = gr.DownloadButton(label="下载人声 vocals.wav")
            no_vocals = gr.DownloadButton(label="下载伴奏 no_vocals.wav")

        log = gr.Textbox(label="处理日志", lines=12)

        run_button.click(
            separate_audio,
            inputs=[audio, device, duration],
            outputs=[vocals, no_vocals, log],
        ).then(
            lambda v, n: (v, n),
            inputs=[vocals, no_vocals],
            outputs=[vocals_preview, no_vocals_preview],
        )

    return demo


if __name__ == "__main__":
    build_app().queue().launch(server_name="127.0.0.1", server_port=7860)
