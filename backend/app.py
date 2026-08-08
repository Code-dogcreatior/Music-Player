import threading
import time
import uuid
from datetime import datetime
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, TimeoutError, as_completed
from typing import Any, Callable
from urllib.parse import quote, urlparse
import requests
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(CURRENT_DIR)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from backend.env_config import load_app_env

load_app_env()

from backend.music_service import MUSICDL_AVAILABLE, MusicService
from backend.music_db import MusicDatabase
from backend.app_version import APP_VERSION
from backend.update_service import UpdateError, update_manager


def get_runtime_base_dir() -> str:
    if getattr(sys, "frozen", False):
        return getattr(sys, "_MEIPASS", PROJECT_ROOT)
    return PROJECT_ROOT


def get_runtime_data_dir() -> str:
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return PROJECT_ROOT


def get_frontend_dist_dir() -> str:
    return os.path.join(get_runtime_base_dir(), "frontend", "dist")


def get_default_save_dir() -> str:
    return os.path.join(get_runtime_data_dir(), "已下载音乐")


def _effective_save_dir(save_dir: str | None) -> str:
    """前端未填目录时使用默认「已下载音乐」，避免下载落到当前工作目录或其它路径。"""
    s = (save_dir or "").strip()
    if not s:
        return get_default_save_dir()
    return os.path.normpath(os.path.expanduser(s))


class SearchPayload(BaseModel):
    keyword: str = Field(min_length=1)
    search_type: str = "搜索歌曲"
    selected_sources: list[str]
    limit: int = 10
    save_dir: str


class DownloadPayload(BaseModel):
    songs: list[dict[str, Any]]
    selected_sources: list[str]
    limit: int = 10
    save_dir: str


class RecommendationPayload(BaseModel):
    selected_sources: list[str]
    limit: int = 15
    save_dir: str


class PlayHistoryPayload(BaseModel):
    song: dict[str, Any]
    save_dir: str = ""


class LocalDeletePayload(BaseModel):
    file_paths: list[str]
    save_dir: str


class LyricShiftPayload(BaseModel):
    lyric_path: str = Field(min_length=1)
    delta_sec: float


class LyricsTranslatePayload(BaseModel):
    lrc_url: str | None = None
    lyric_path: str | None = None
    inline_lyrics: str | None = None
    translate_provider: str = "ali"


class UiSettingsPayload(BaseModel):
    show_source_columns: bool = False


class DownloadJob:
    def __init__(self, total: int):
        self.id = str(uuid.uuid4())
        self.total = total
        self.done = 0
        self.status = "pending"
        self.error = ""
        self.created_at = datetime.now().isoformat(timespec="seconds")
        self.finished_at = ""


class SearchJob:
    def __init__(self, total_sources: int):
        self.id = str(uuid.uuid4())
        self.total_sources = total_sources
        self.done_sources = 0
        self.status = "pending"
        self.error = ""
        self.message = "搜索任务已提交"
        self.songs: list[dict[str, Any]] = []
        self.results: dict[str, Any] = {}
        self.cached = False
        self.search_elapsed_ms = 0
        self.created_at = datetime.now().isoformat(timespec="seconds")
        self.finished_at = ""
        self._lock = threading.Lock()

    def add_source_results(self, source: str, source_results: Any) -> None:
        songs_for_source: list[dict[str, Any]] = []
        raw_items = sort_source_results_for_display(source, normalize_source_results(source_results))
        for song in raw_items:
            song_id = str(uuid.uuid4())
            remember_search_song(song_id, song)
            song_dict = song_to_response_dict(song)
            song_dict["song_id"] = song_id
            songs_for_source.append(song_dict)

        with self._lock:
            self.results[source] = source_results
            self.songs.extend(songs_for_source)
            self.done_sources += 1
            self.message = f"已返回 {len(self.songs)} 首，来源 {self.done_sources}/{self.total_sources}"

    def mark_source_done(self, source: str, error: str | None = None) -> None:
        with self._lock:
            if source not in self.results:
                self.results[source] = []
                self.done_sources += 1
            if error:
                self.error = error if not self.error else f"{self.error}; {error}"
            self.message = f"已返回 {len(self.songs)} 首，来源 {self.done_sources}/{self.total_sources}"

    def finish(self, started_at: float, timed_out: bool = False) -> None:
        with self._lock:
            self.status = "finished"
            self.search_elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            self.finished_at = datetime.now().isoformat(timespec="seconds")
            if timed_out and self.done_sources < self.total_sources:
                pending = self.total_sources - self.done_sources
                self.message = f"已先返回 {len(self.songs)} 首，{pending} 个来源仍未响应"
            else:
                self.message = f"搜索完成，共 {len(self.songs)} 首"

    def fail(self, started_at: float, error: str) -> None:
        with self._lock:
            self.status = "failed"
            self.error = error
            self.message = "搜索失败"
            self.search_elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            self.finished_at = datetime.now().isoformat(timespec="seconds")

    def to_response(self) -> dict[str, Any]:
        with self._lock:
            return {
                "job_id": self.id,
                "status": self.status,
                "total_sources": self.total_sources,
                "done_sources": self.done_sources,
                "message": self.message,
                "error": self.error,
                # 前端只用 songs；省略原始 results，避免重复大包导致轮询超时。
                "results": {},
                "songs": list(self.songs),
                "cached": self.cached,
                "search_elapsed_ms": self.search_elapsed_ms,
                "created_at": self.created_at,
                "finished_at": self.finished_at,
        }


def sort_source_results_for_display(source: str, source_results: list[Any]) -> list[Any]:
    if source != "QQMusicClient":
        return source_results

    def qq_parser_rank(song: Any) -> int:
        audio_source = str(service._song_get(song, "audio_parse_source", "") or "").lower()
        if "huibq" in audio_source:
            return 0
        if "tang" in audio_source:
            return 1
        return 2

    return sorted(source_results, key=qq_parser_rank)


def normalize_source_results(source_results: Any) -> list[Any]:
    if isinstance(source_results, list):
        return source_results
    if isinstance(source_results, dict):
        merged_results: list[Any] = []
        for value in source_results.values():
            if isinstance(value, list):
                merged_results.extend(value)
        return merged_results
    return []


class RecommendationJob:
    def __init__(self):
        self.id = str(uuid.uuid4())
        self.status = "pending"
        self.songs: list[dict[str, Any]] = []
        self.seed_count = 0
        self.message = "推荐任务已提交"
        self.error = ""
        self.created_at = datetime.now().isoformat(timespec="seconds")
        self.finished_at = ""

    def to_response(self) -> dict[str, Any]:
        return {
            "job_id": self.id,
            "status": self.status,
            "songs": self.songs,
            "seed_count": self.seed_count,
            "message": self.message,
            "error": self.error,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
        }


class LyricsTranslateJob:
    def __init__(self, raw_lyrics: str, lyric_path: str | None = None, provider: str = "ali"):
        self.id = str(uuid.uuid4())
        self.raw_lyrics = raw_lyrics
        self.lyric_path = lyric_path or ""
        self.provider = normalize_translate_provider(provider)
        self.status = "pending"
        self.done = 0
        self.total = 0
        self.percent = 0
        self.message = "翻译任务已提交"
        self.error = ""
        self.translated_lyrics = ""
        self.created_at = datetime.now().isoformat(timespec="seconds")
        self.finished_at = ""
        self._lock = threading.Lock()

    def set_progress(self, done: int, total: int) -> None:
        with self._lock:
            self.done = max(0, done)
            self.total = max(0, total)
            self.percent = int(round((self.done / self.total) * 100)) if self.total else 100
            if self.status != "finished":
                self.message = f"正在翻译歌词 {self.done}/{self.total}"

    def finish(self, translated_lyrics: str) -> None:
        with self._lock:
            self.translated_lyrics = translated_lyrics
            self.status = "finished"
            self.done = self.total
            self.percent = 100
            self.message = "歌词翻译完成"
            self.finished_at = datetime.now().isoformat(timespec="seconds")

    def fail(self, error: str) -> None:
        with self._lock:
            self.status = "failed"
            self.error = error
            self.message = "歌词翻译失败"
            self.finished_at = datetime.now().isoformat(timespec="seconds")

    def to_response(self) -> dict[str, Any]:
        return {
            "job_id": self.id,
            "status": self.status,
            "done": self.done,
            "total": self.total,
            "percent": self.percent,
            "message": self.message,
            "error": self.error,
            "translated_lyrics": self.translated_lyrics,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
        }


app = FastAPI(title="Music Downloader API", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

frontend_dist_dir = get_frontend_dist_dir()
frontend_assets_dir = os.path.join(frontend_dist_dir, "assets")
frontend_index_file = os.path.join(frontend_dist_dir, "index.html")

if os.path.isdir(frontend_assets_dir):
    app.mount("/assets", StaticFiles(directory=frontend_assets_dir), name="assets")

service = MusicService()
music_db = MusicDatabase(os.path.join(get_runtime_data_dir(), "music_player.sqlite3"))
download_jobs: dict[str, DownloadJob] = {}
finished_download_jobs: dict[str, dict[str, Any]] = {}
search_jobs: dict[str, SearchJob] = {}
finished_search_jobs: dict[str, dict[str, Any]] = {}
recommendation_jobs: dict[str, RecommendationJob] = {}
finished_recommendation_jobs: dict[str, dict[str, Any]] = {}
lyrics_translate_jobs: dict[str, LyricsTranslateJob] = {}
finished_lyrics_translate_jobs: dict[str, dict[str, Any]] = {}
current_recommendation_job_id = ""
MAX_RECOMMENDATIONS = 15
SEARCH_JOB_TIMEOUT_SECONDS = 12
MAX_ACTIVE_SEARCH_JOBS = 3
MAX_ACTIVE_DOWNLOAD_JOBS = 2
MAX_ACTIVE_RECOMMENDATION_JOBS = 1
MAX_ACTIVE_LYRICS_TRANSLATE_JOBS = 2
MAX_FINISHED_JOBS_PER_TYPE = 100
MAX_SEARCH_SONG_CACHE_ITEMS = 1000
search_song_cache: dict[str, Any] = {}
search_song_cache_timestamps: dict[str, float] = {}
FINISHED_JOB_TTL_SECONDS = 30 * 60
SEARCH_SONG_CACHE_TTL_SECONDS = 30 * 60
RUNTIME_CLEANUP_INTERVAL_SECONDS = 60
finished_download_job_timestamps: dict[str, float] = {}
finished_search_job_timestamps: dict[str, float] = {}
finished_recommendation_job_timestamps: dict[str, float] = {}
finished_lyrics_translate_job_timestamps: dict[str, float] = {}
runtime_state_lock = threading.RLock()
last_runtime_cleanup_at = 0.0
ALLOWED_AUDIO_EXTS = {".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".oga", ".aiff", ".wma"}
COVER_PROXY_MAX_BYTES = 8 * 1024 * 1024
AUDIO_PROXY_CONNECT_TIMEOUT = 10
AUDIO_PROXY_READ_TIMEOUT = 60
RESPONSE_SONG_DROP_KEYS = {
    "raw_data",
    "download_url_status",
    "default_download_headers",
    "default_download_cookies",
    "downloaded_contents",
    "work_dir",
    "chunk_size",
    "protocol",
    "root_source",
    "episodes",
}
ALI_TRANSLATE_API_KEY = os.getenv("ALI_TRANSLATE_API_KEY", "").strip()
ALI_TRANSLATE_MODEL = os.getenv("ALI_TRANSLATE_MODEL", "deepseek-v4-flash").strip()
ALI_CHAT_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "").strip()
DEEPSEEK_TRANSLATE_MODEL = os.getenv("DEEPSEEK_TRANSLATE_MODEL", "deepseek-v4-flash").strip()
DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions"
# 经压测：阿里百炼网关在 ~20 并发后吞吐回退（详见 backend/ali_concurrency_result.txt）
# 取 18 留余量防抖动；DeepSeek 默认给到 24，环境变量可覆盖但会被限制在 64 以内。
def _read_limited_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        raw = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        raw = default
    return max(minimum, min(maximum, raw))


ALI_MAX_WORKERS = _read_limited_int_env("ALI_TRANSLATE_MAX_WORKERS", 18, 1, 64)
DEEPSEEK_MAX_WORKERS = _read_limited_int_env("DEEPSEEK_TRANSLATE_MAX_WORKERS", 24, 1, 64)
translate_provider_semaphores = {
    "ali": threading.BoundedSemaphore(ALI_MAX_WORKERS),
    "dp": threading.BoundedSemaphore(DEEPSEEK_MAX_WORKERS),
}
LRC_TIME_PATTERN = re.compile(r"(\[\d{1,2}:\d{1,2}(?:\.\d{1,3})?\])")
JAPANESE_KANA_PATTERN = re.compile(r"[\u3040-\u30ff\u31f0-\u31ff]")
LATIN_PATTERN = re.compile(r"[A-Za-z]")
HANGUL_PATTERN = re.compile(r"[\uac00-\ud7af]")
TRANSLATE_SYSTEM_PROMPT = (
    "You are a professional lyric translator. Translate the user's single lyric line into natural Simplified Chinese.\n"
    "Rules:\n"
    "1. Output Simplified Chinese only.\n"
    "2. Do not output the original line, quotes, explanations, notes, pinyin, romaji, or multiple alternatives.\n"
    "3. If the line is Japanese, translate all kana and kanji by meaning; never keep Japanese text just because it contains kanji.\n"
    "4. Keep artist names and proper nouns only when they should not be translated.\n"
    "5. If the input is already natural Simplified Chinese, return it unchanged."
)


def _prune_timestamped_map(target: dict[str, Any], timestamps: dict[str, float], ttl_seconds: int, now: float) -> None:
    for key in list(target.keys()):
        created_at = timestamps.setdefault(key, now)
        if now - created_at > ttl_seconds:
            target.pop(key, None)
            timestamps.pop(key, None)
    for key in list(timestamps.keys()):
        if key not in target:
            timestamps.pop(key, None)


def _cap_timestamped_map(target: dict[str, Any], timestamps: dict[str, float], max_items: int) -> None:
    if len(target) <= max_items:
        return
    overflow = len(target) - max_items
    ordered_keys = sorted(target.keys(), key=lambda key: timestamps.get(key, 0.0))
    for key in ordered_keys[:overflow]:
        target.pop(key, None)
        timestamps.pop(key, None)


def _active_job_count_unlocked(target: dict[str, Any]) -> int:
    return sum(1 for job in target.values() if getattr(job, "status", "pending") in {"pending", "running"})


def register_active_job(target: dict[str, Any], job: Any, max_active: int) -> None:
    cleanup_expired_runtime_state()
    with runtime_state_lock:
        if _active_job_count_unlocked(target) >= max_active:
            raise HTTPException(status_code=429, detail="当前任务较多，请稍后再试")
        target[job.id] = job


def remove_active_job(target: dict[str, Any], job_id: str) -> None:
    with runtime_state_lock:
        target.pop(job_id, None)


def cleanup_expired_runtime_state(force: bool = False) -> None:
    global current_recommendation_job_id, last_runtime_cleanup_at
    now = time.time()
    with runtime_state_lock:
        if not force and now - last_runtime_cleanup_at < RUNTIME_CLEANUP_INTERVAL_SECONDS:
            return
        last_runtime_cleanup_at = now
        _prune_timestamped_map(finished_download_jobs, finished_download_job_timestamps, FINISHED_JOB_TTL_SECONDS, now)
        _prune_timestamped_map(finished_search_jobs, finished_search_job_timestamps, FINISHED_JOB_TTL_SECONDS, now)
        _prune_timestamped_map(
            finished_recommendation_jobs,
            finished_recommendation_job_timestamps,
            FINISHED_JOB_TTL_SECONDS,
            now,
        )
        _prune_timestamped_map(
            finished_lyrics_translate_jobs,
            finished_lyrics_translate_job_timestamps,
            FINISHED_JOB_TTL_SECONDS,
            now,
        )
        _prune_timestamped_map(search_song_cache, search_song_cache_timestamps, SEARCH_SONG_CACHE_TTL_SECONDS, now)
        _cap_timestamped_map(finished_download_jobs, finished_download_job_timestamps, MAX_FINISHED_JOBS_PER_TYPE)
        _cap_timestamped_map(finished_search_jobs, finished_search_job_timestamps, MAX_FINISHED_JOBS_PER_TYPE)
        _cap_timestamped_map(finished_recommendation_jobs, finished_recommendation_job_timestamps, MAX_FINISHED_JOBS_PER_TYPE)
        _cap_timestamped_map(
            finished_lyrics_translate_jobs,
            finished_lyrics_translate_job_timestamps,
            MAX_FINISHED_JOBS_PER_TYPE,
        )
        _cap_timestamped_map(search_song_cache, search_song_cache_timestamps, MAX_SEARCH_SONG_CACHE_ITEMS)

        if (
            current_recommendation_job_id
            and current_recommendation_job_id not in recommendation_jobs
            and current_recommendation_job_id not in finished_recommendation_jobs
        ):
            current_recommendation_job_id = ""


def remember_search_song(song_id: str, song: Any) -> None:
    with runtime_state_lock:
        search_song_cache[song_id] = song
        search_song_cache_timestamps[song_id] = time.time()
        _cap_timestamped_map(search_song_cache, search_song_cache_timestamps, MAX_SEARCH_SONG_CACHE_ITEMS)


def get_cached_search_song(song_id: str) -> Any | None:
    cleanup_expired_runtime_state()
    with runtime_state_lock:
        return search_song_cache.get(song_id)


def store_finished_job(
    target: dict[str, dict[str, Any]],
    timestamps: dict[str, float],
    job_id: str,
    payload: dict[str, Any],
) -> None:
    with runtime_state_lock:
        target[job_id] = payload
        timestamps[job_id] = time.time()
    cleanup_expired_runtime_state(force=True)


def store_finished_download_job(job_id: str, payload: dict[str, Any]) -> None:
    store_finished_job(finished_download_jobs, finished_download_job_timestamps, job_id, payload)


def store_finished_search_job(job_id: str, payload: dict[str, Any]) -> None:
    store_finished_job(finished_search_jobs, finished_search_job_timestamps, job_id, payload)


def store_finished_recommendation_job(job_id: str, payload: dict[str, Any]) -> None:
    store_finished_job(finished_recommendation_jobs, finished_recommendation_job_timestamps, job_id, payload)


def store_finished_lyrics_translate_job(job_id: str, payload: dict[str, Any]) -> None:
    store_finished_job(finished_lyrics_translate_jobs, finished_lyrics_translate_job_timestamps, job_id, payload)


def _cover_proxy_host_allowed(hostname: str) -> bool:
    """在线封面多为外链；仅允许常见音乐 CDN，供前端同源拉取后 canvas 模糊，避免开放任意 URL。"""
    h = (hostname or "").lower()
    if not h:
        return False
    exact_ok = {
        "y.gtimg.cn",
        "img.gtimg.cn",
        "p1.music.126.net",
        "p2.music.126.net",
        "p3.music.126.net",
        "p4.music.126.net",
    }
    if h in exact_ok:
        return True
    suffixes = (
        ".qq.com",
        ".gtimg.cn",
        ".qpic.cn",
        ".music.126.net",
        ".kgimg.com",
        ".kuwo.cn",
        ".kugou.com",
    )
    return any(h.endswith(s) for s in suffixes)


def _audio_proxy_host_allowed(hostname: str) -> bool:
    """仅代理常见音乐 CDN，避免开放任意 URL 代理。"""
    h = (hostname or "").lower()
    if not h:
        return False
    suffixes = (
        ".qq.com",
        ".qqmusic.qq.com",
        ".tencentmusic.com",
        ".kuwo.cn",
        ".kugou.com",
        ".music.126.net",
        ".126.net",
        ".netease.com",
    )
    return any(h == s[1:] or h.endswith(s) for s in suffixes)


def _proxy_stream_url(download_url: str) -> str:
    raw = str(download_url or "").strip()
    if not raw.startswith(("http://", "https://")):
        return ""
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return ""
    if not _audio_proxy_host_allowed(parsed.hostname or ""):
        return ""
    return f"/api/audio-proxy?url={quote(raw, safe='')}"


def parse_local_music_name(filename: str) -> dict[str, str]:
    raw_name = os.path.splitext(filename)[0].strip()
    parts = [part.strip() for part in raw_name.split(" - ") if part.strip()]

    # 常见下载命名：歌名 - 歌手 - 专辑
    if len(parts) >= 3:
        return {
            "song_name": parts[0],
            "singers": parts[1],
            "album": " - ".join(parts[2:]),
        }

    # 兼容：歌名 - 歌手
    if len(parts) == 2:
        possible_id = parts[1]
        if possible_id.isalnum() and len(possible_id) >= 8:
            return {"song_name": parts[0], "singers": "", "album": ""}
        return {"song_name": parts[0], "singers": parts[1], "album": ""}

    return {"song_name": raw_name, "singers": "", "album": ""}


@app.get("/api/health")
def health():
    cleanup_expired_runtime_state()
    with runtime_state_lock:
        runtime = {
            "active_search_jobs": _active_job_count_unlocked(search_jobs),
            "active_download_jobs": _active_job_count_unlocked(download_jobs),
            "active_recommendation_jobs": _active_job_count_unlocked(recommendation_jobs),
            "active_lyrics_translate_jobs": _active_job_count_unlocked(lyrics_translate_jobs),
            "finished_search_jobs": len(finished_search_jobs),
            "finished_download_jobs": len(finished_download_jobs),
            "finished_recommendation_jobs": len(finished_recommendation_jobs),
            "finished_lyrics_translate_jobs": len(finished_lyrics_translate_jobs),
            "search_song_cache_size": len(search_song_cache),
        }
    return {
        "ok": True,
        "version": APP_VERSION,
        "musicdl_available": MUSICDL_AVAILABLE,
        "frontend_dist_exists": os.path.isdir(frontend_dist_dir),
        "runtime": runtime,
    }


@app.get("/api/update/check")
def check_update(force: bool = False):
    try:
        return update_manager.public_check(force=force)
    except UpdateError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/update/download")
def download_update():
    try:
        return update_manager.start_download()
    except UpdateError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/update/status")
def update_status():
    return update_manager.status()


@app.post("/api/update/apply")
def apply_update():
    try:
        return update_manager.request_install_and_restart()
    except UpdateError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/config")
def config():
    default_save_dir = get_default_save_dir()
    os.makedirs(default_save_dir, exist_ok=True)
    return {"default_save_dir": default_save_dir}


@app.get("/api/ui-settings")
def get_ui_settings():
    return {"show_source_columns": music_db.get_bool_setting("show_source_columns", False)}


@app.post("/api/ui-settings")
def save_ui_settings(payload: UiSettingsPayload):
    music_db.set_bool_setting("show_source_columns", payload.show_source_columns)
    return {"show_source_columns": payload.show_source_columns}


@app.get("/api/sources")
def sources():
    return {"sources": service.source_map_cn_to_en}


def song_to_response_dict(song: Any) -> dict[str, Any]:
    if isinstance(song, dict):
        song_dict = dict(song)
    else:
        try:
            song_dict = dict(vars(song))
        except Exception:
            song_dict = {}
    for key in RESPONSE_SONG_DROP_KEYS:
        song_dict.pop(key, None)
    for key in ("song_name", "singers", "album", "title", "artist"):
        if song_dict.get(key):
            song_dict[key] = service.strip_html_tags(song_dict[key])
    if not song_dict.get("cover"):
        song_dict["cover"] = service.get_album_image_url(song_dict)
    # 外链音频常缺 CORS，且酷我会校验 UA；同源代理后前端 crossOrigin/音效可正常工作。
    download_url = str(song_dict.get("download_url") or "").strip()
    if download_url and not song_dict.get("stream_url"):
        proxy_url = _proxy_stream_url(download_url)
        if proxy_url:
            song_dict["stream_url"] = proxy_url
    return song_dict


def _song_attr(song: Any, key: str, default: Any = "") -> Any:
    if isinstance(song, dict):
        return song.get(key, default)
    return getattr(song, key, default)


def local_item_from_audio_file(file_path: str, save_dir: str, existing: dict[str, Any] | None = None) -> dict[str, Any]:
    stem = os.path.splitext(file_path)[0]
    lrc_path = f"{stem}.lrc"
    root = os.path.dirname(file_path)
    filename = os.path.basename(file_path)
    relative = os.path.relpath(file_path, save_dir)
    parsed_name = parse_local_music_name(filename)
    existing = existing or {}
    return {
        "song_name": parsed_name["song_name"],
        "singers": parsed_name["singers"],
        "album": parsed_name["album"] or ("" if root == save_dir else os.path.basename(root)),
        "source": "",
        "file_size": os.path.getsize(file_path),
        "download_url": "",
        "stream_url": f"/api/stream?path={requests.utils.quote(file_path)}",
        "cover": f"/api/cover?path={requests.utils.quote(file_path)}",
        "file_path": file_path,
        "lyric_path": lrc_path if os.path.exists(lrc_path) else "",
        "audio_parse_source": existing.get("audio_parse_source") or "",
        "lyric_parse_source": existing.get("lyric_parse_source") or "",
        "relative_path": relative,
    }


def upsert_downloaded_audio_metadata(file_path: str, save_dir: str, song_info: Any) -> None:
    fields = service.resolve_rename_fields(song_info)
    item = local_item_from_audio_file(file_path, save_dir)
    item.update(
        {
            "song_name": fields.get("song_name") or item["song_name"],
            "singers": fields.get("singers") or item["singers"],
            "album": fields.get("album") or item["album"],
            "source": _song_attr(song_info, "source", ""),
            "audio_parse_source": _song_attr(song_info, "audio_parse_source", ""),
            "lyric_parse_source": _song_attr(song_info, "lyric_parse_source", ""),
        }
    )
    music_db.upsert_local_songs([item])


def list_downloaded_song_dicts(save_dir: str) -> list[dict[str, Any]]:
    save_dir = _effective_save_dir(save_dir)
    if not os.path.isdir(save_dir):
        return []

    audio_files: list[str] = []
    for root, _, files in os.walk(save_dir):
        for filename in files:
            file_path = os.path.join(root, filename)
            ext = os.path.splitext(filename)[1].lower()
            if ext in ALLOWED_AUDIO_EXTS:
                audio_files.append(file_path)

    existing_by_path = music_db.songs_by_file_path(audio_files)
    items: list[dict[str, Any]] = []
    for file_path in audio_files:
        items.append(local_item_from_audio_file(file_path, save_dir, existing_by_path.get(file_path)))

    items.sort(key=lambda x: x["relative_path"])
    music_db.upsert_local_songs(items)
    return items


def _run_source_search(payload: SearchPayload, source: str) -> tuple[str, Any]:
    music_client = service.init_music_client(
        selected_sources=[source],
        limit=payload.limit,
        save_dir=_effective_save_dir(payload.save_dir),
    )
    if not music_client:
        raise RuntimeError("musicdl 初始化失败")
    results = service.search(music_client, payload.keyword, payload.search_type)
    if isinstance(results, dict):
        if source in results:
            return source, results[source]
        merged_results: list[Any] = []
        for source_results in results.values():
            if isinstance(source_results, list):
                merged_results.extend(source_results)
        return source, merged_results
    return source, results


def _search_worker(job: SearchJob, payload: SearchPayload, started_at: float):
    try:
        job.status = "running"
        job.message = "搜索中..."
        deadline = time.perf_counter() + SEARCH_JOB_TIMEOUT_SECONDS
        executor = ThreadPoolExecutor(max_workers=max(1, min(len(payload.selected_sources), 6)))
        future_to_source = {
            executor.submit(_run_source_search, payload, source): source
            for source in payload.selected_sources
        }
        try:
            pending = set(future_to_source)
            while pending:
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    break
                done = []
                try:
                    done = list(as_completed(pending, timeout=min(0.5, remaining)))
                except TimeoutError:
                    continue
                for future in done:
                    pending.discard(future)
                    source = future_to_source[future]
                    try:
                        resolved_source, source_results = future.result()
                        job.add_source_results(resolved_source, source_results)
                    except Exception as exc:
                        job.mark_source_done(source, f"{source}: {exc}")

            timed_out = bool(pending)
            for future in pending:
                future.cancel()
            job.finish(started_at, timed_out=timed_out)
        finally:
            executor.shutdown(wait=False, cancel_futures=True)

        store_finished_search_job(job.id, job.to_response())
        remove_active_job(search_jobs, job.id)
    except Exception as exc:
        job.fail(started_at, str(exc))
        store_finished_search_job(job.id, job.to_response())
        remove_active_job(search_jobs, job.id)


@app.post("/api/search")
def search_music(payload: SearchPayload):
    cleanup_expired_runtime_state()
    if not MUSICDL_AVAILABLE:
        raise HTTPException(status_code=500, detail="musicdl 未安装")
    if not payload.selected_sources:
        raise HTTPException(status_code=400, detail="请至少选择一个音乐来源")
    started_at = time.perf_counter()
    job = SearchJob(total_sources=len(payload.selected_sources))
    register_active_job(search_jobs, job, MAX_ACTIVE_SEARCH_JOBS)
    thread = threading.Thread(target=_search_worker, args=(job, payload, started_at), daemon=True)
    thread.start()
    return job.to_response()


@app.get("/api/search/{job_id}")
def search_status(job_id: str):
    cleanup_expired_runtime_state()
    job = search_jobs.get(job_id)
    if job:
        return job.to_response()
    finished = finished_search_jobs.get(job_id)
    if finished:
        return finished
    raise HTTPException(status_code=404, detail="搜索任务不存在")


def _recommendation_worker(job: RecommendationJob, payload: RecommendationPayload):
    try:
        requested_limit = max(1, min(int(payload.limit or MAX_RECOMMENDATIONS), MAX_RECOMMENDATIONS))
        job.status = "running"
        job.message = "正在读取本地音乐库..."
        base_songs = list_downloaded_song_dicts(payload.save_dir)
        job.seed_count = len(base_songs)
        if not base_songs:
            job.status = "finished"
            job.message = "本地音乐库为空，暂时无法生成推荐"
            job.finished_at = datetime.now().isoformat(timespec="seconds")
            store_finished_recommendation_job(job.id, job.to_response())
            remove_active_job(recommendation_jobs, job.id)
            return

        job.message = "正在生成在线推荐..."
        songs: list[dict[str, Any]] = []
        try:
            music_client = service.init_music_client(
                selected_sources=payload.selected_sources,
                limit=requested_limit,
                save_dir=_effective_save_dir(payload.save_dir),
            )
            if not music_client:
                raise RuntimeError("musicdl 初始化失败")

            for song, recommendation_meta in service.recommend_songs(music_client, base_songs, max_count=requested_limit):
                song_id = str(uuid.uuid4())
                remember_search_song(song_id, song)
                song_dict = song_to_response_dict(song)
                song_dict.update(recommendation_meta)
                song_dict["song_id"] = song_id
                songs.append(song_dict)
        except Exception as exc:
            job.error = str(exc)

        if not songs:
            songs = music_db.local_recommendations(requested_limit)
            for song_dict in songs:
                song_dict["song_id"] = str(uuid.uuid4())

        job.songs = songs
        job.status = "finished"
        job.message = f"基于本地音乐 {job.seed_count} 首，推荐 {len(songs)} 首"
        if not songs:
            job.message = f"基于本地音乐 {job.seed_count} 首，暂时没有匹配到推荐歌曲"
        elif songs and songs[0].get("recommendation_source") == "本地曲库":
            job.message = f"在线推荐暂未返回，已基于本地音乐 {job.seed_count} 首生成推荐"
        job.finished_at = datetime.now().isoformat(timespec="seconds")
        store_finished_recommendation_job(job.id, job.to_response())
        remove_active_job(recommendation_jobs, job.id)
    except Exception as exc:
        job.status = "failed"
        job.error = str(exc)
        job.message = "推荐生成失败，不影响其他操作"
        job.finished_at = datetime.now().isoformat(timespec="seconds")
        store_finished_recommendation_job(job.id, job.to_response())
        remove_active_job(recommendation_jobs, job.id)


@app.on_event("startup")
def ensure_default_save_dir():
    default_save_dir = get_default_save_dir()
    os.makedirs(default_save_dir, exist_ok=True)


@app.post("/api/recommendations")
def recommendations(payload: RecommendationPayload, force: bool = False):
    cleanup_expired_runtime_state()
    global current_recommendation_job_id
    if not MUSICDL_AVAILABLE:
        raise HTTPException(status_code=500, detail="musicdl 未安装")
    if not payload.selected_sources:
        raise HTTPException(status_code=400, detail="请至少选择一个音乐来源")

    if current_recommendation_job_id and not force:
        job = recommendation_jobs.get(current_recommendation_job_id)
        if job:
            return job.to_response()
        finished = finished_recommendation_jobs.get(current_recommendation_job_id)
        if finished:
            return finished
    job = RecommendationJob()
    register_active_job(recommendation_jobs, job, MAX_ACTIVE_RECOMMENDATION_JOBS)
    current_recommendation_job_id = job.id
    thread = threading.Thread(target=_recommendation_worker, args=(job, payload), daemon=True)
    thread.start()
    return job.to_response()


@app.get("/api/recommendations/current")
def current_recommendation_status():
    cleanup_expired_runtime_state()
    if not current_recommendation_job_id:
        return {"job_id": "", "status": "idle", "songs": [], "seed_count": 0, "message": "暂无推荐任务"}
    job = recommendation_jobs.get(current_recommendation_job_id)
    if job:
        return job.to_response()
    finished = finished_recommendation_jobs.get(current_recommendation_job_id)
    if finished:
        return finished
    return {"job_id": "", "status": "idle", "songs": [], "seed_count": 0, "message": "暂无推荐任务"}


@app.get("/api/recommendations/{job_id}")
def recommendation_status(job_id: str):
    cleanup_expired_runtime_state()
    job = recommendation_jobs.get(job_id)
    if job:
        return job.to_response()
    finished = finished_recommendation_jobs.get(job_id)
    if finished:
        return finished
    raise HTTPException(status_code=404, detail="推荐任务不存在")


def _download_worker(job: DownloadJob, payload: DownloadPayload):
    try:
        save_dir = os.path.abspath(_effective_save_dir(payload.save_dir))
        os.makedirs(save_dir, exist_ok=True)
        job.status = "running"
        music_client = service.init_music_client(
            selected_sources=payload.selected_sources,
            limit=payload.limit,
            save_dir=save_dir,
        )
        if not music_client:
            raise RuntimeError("musicdl 初始化失败")

        for song in payload.songs:
            before_files = set(service.list_audio_files(save_dir))
            download_item = song
            if isinstance(song, dict):
                song_id = song.get("song_id")
                cached_song = get_cached_search_song(song_id) if song_id else None
                if cached_song is not None:
                    download_item = cached_song
                else:
                    download_item = SimpleNamespace(**song)
            download_item = service.prefer_download_quality(music_client, download_item)
            # musicdl：prefer 换无损后会新建 SongInfo，work_dir 默认 ./ → 文件落到进程 cwd（项目根）。
            # 强制写入用户选择的保存目录，并清空 save_path 缓存以便重新计算路径。
            if hasattr(download_item, "work_dir"):
                download_item.work_dir = save_dir
            if hasattr(download_item, "_save_path"):
                download_item._save_path = None
            if not getattr(download_item, "with_valid_download_url", False):
                raise RuntimeError("下载失败：QQ 当前仅使用 huibq/tang 解析，但这两条通路未返回有效下载地址")
            service.download(music_client, [download_item])
            after_files = set(service.list_audio_files(save_dir))
            new_files = sorted(after_files - before_files)
            if isinstance(song, dict) and new_files:
                # 传入完整 SongInfo（勿用 todict，以免嵌套 raw_data 在个别版本丢失）；命名失败时用内嵌标签兜底
                audio_candidates = [p for p in new_files if os.path.splitext(p)[1].lower() in ALLOWED_AUDIO_EXTS]
                target_audio = audio_candidates[0] if audio_candidates else new_files[0]
                final_audio = service.rename_file_with_song_meta(target_audio, download_item) or target_audio
                upsert_downloaded_audio_metadata(final_audio, save_dir, download_item)
            job.done += 1
            time.sleep(0.01)

        moved_count = service.flatten_downloaded_files(save_dir)
        service.normalize_audio_filenames(save_dir)
        total_files = service.count_all_downloaded_files(save_dir)
        list_downloaded_song_dicts(save_dir)
        job.status = "finished"
        job.finished_at = datetime.now().isoformat(timespec="seconds")
        store_finished_download_job(job.id, {
            "status": "finished",
            "done": job.total,
            "total": job.total,
            "error": "",
            "finished_at": job.finished_at,
            "moved_count": moved_count,
            "total_files": total_files,
        })
        remove_active_job(download_jobs, job.id)
    except Exception as exc:
        job.status = "failed"
        job.error = str(exc)
        job.finished_at = datetime.now().isoformat(timespec="seconds")
        store_finished_download_job(job.id, {
            "status": "failed",
            "done": job.done,
            "total": job.total,
            "error": job.error,
            "finished_at": job.finished_at,
        })
        remove_active_job(download_jobs, job.id)


@app.post("/api/download")
def start_download(payload: DownloadPayload):
    cleanup_expired_runtime_state()
    if not MUSICDL_AVAILABLE:
        raise HTTPException(status_code=500, detail="musicdl 未安装")
    if not payload.songs:
        raise HTTPException(status_code=400, detail="歌曲列表为空")
    if not payload.selected_sources:
        raise HTTPException(status_code=400, detail="未选择音乐来源")
    job = DownloadJob(total=len(payload.songs))
    register_active_job(download_jobs, job, MAX_ACTIVE_DOWNLOAD_JOBS)
    thread = threading.Thread(target=_download_worker, args=(job, payload), daemon=True)
    thread.start()
    return {"job_id": job.id}


@app.get("/api/download/{job_id}")
def download_status(job_id: str):
    cleanup_expired_runtime_state()
    job = download_jobs.get(job_id)
    if not job:
        finished = finished_download_jobs.get(job_id)
        if finished:
            return {"job_id": job_id, **finished}
        raise HTTPException(status_code=404, detail="任务不存在")

    return {
        "job_id": job.id,
        "status": job.status,
        "done": job.done,
        "total": job.total,
        "error": job.error,
    }


@app.post("/api/library/organize")
def organize_library(save_dir: str):
    save_dir = _effective_save_dir(save_dir)
    moved_count = service.flatten_downloaded_files(save_dir)
    total_files = service.count_all_downloaded_files(save_dir)
    return {"moved_count": moved_count, "total_files": total_files}


@app.get("/api/downloaded")
def downloaded(save_dir: str):
    return {"items": list_downloaded_song_dicts(save_dir)}


@app.post("/api/downloaded/delete")
def delete_downloaded(payload: LocalDeletePayload):
    if not payload.file_paths:
        raise HTTPException(status_code=400, detail="未选择要删除的文件")
    base_dir = os.path.abspath(_effective_save_dir(payload.save_dir))
    deleted_count = 0
    deleted_paths: list[str] = []

    for raw_path in payload.file_paths:
        file_path = os.path.abspath(raw_path)
        if not file_path.startswith(base_dir):
            continue
        if os.path.isfile(file_path):
            os.remove(file_path)
            deleted_count += 1
            deleted_paths.append(file_path)
            lrc_path = os.path.splitext(file_path)[0] + ".lrc"
            if os.path.isfile(lrc_path):
                os.remove(lrc_path)

    music_db.remove_local_songs(deleted_paths)
    return {"deleted_count": deleted_count}


@app.post("/api/play-history")
def play_history(payload: PlayHistoryPayload):
    song = dict(payload.song or {})
    if not song:
        raise HTTPException(status_code=400, detail="歌曲为空")
    music_db.record_play(song)
    return {"ok": True}


@app.get("/api/stream")
def stream(path: str):
    if not os.path.exists(path) or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="音频文件不存在")
    ext = os.path.splitext(path)[1].lower()
    if ext not in ALLOWED_AUDIO_EXTS:
        raise HTTPException(status_code=400, detail="不支持的音频格式")

    media_type = {
        ".mp3": "audio/mpeg",
        ".flac": "audio/flac",
        ".wav": "audio/wav",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".ogg": "audio/ogg",
        ".opus": "audio/ogg",
        ".oga": "audio/ogg",
        ".aiff": "audio/aiff",
        ".wma": "audio/x-ms-wma",
    }.get(ext, "application/octet-stream")
    return FileResponse(path, media_type=media_type, filename=os.path.basename(path))


@app.get("/api/cover")
def cover(path: str):
    if not os.path.exists(path) or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="音频文件不存在")
    ext = os.path.splitext(path)[1].lower()
    if ext not in ALLOWED_AUDIO_EXTS:
        raise HTTPException(status_code=400, detail="不支持的音频格式")

    cover_data = service.get_embedded_cover(path)
    if not cover_data:
        raise HTTPException(status_code=404, detail="未找到内嵌专辑封面")
    return Response(content=cover_data["data"], media_type=cover_data["mime"])


@app.get("/api/audio-proxy")
def audio_proxy(url: str, request: Request):
    """把外链音频转为同源流，解决酷我/QQ CDN 缺 CORS 与 UA 校验导致浏览器播不了。"""
    raw = (url or "").strip()
    if not raw.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="仅支持 http(s) 音频地址")
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="无效的 URL")
    host = parsed.hostname or ""
    if not _audio_proxy_host_allowed(host):
        raise HTTPException(status_code=403, detail="该域名不允许代理音频")

    upstream_headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "*/*",
    }
    range_header = request.headers.get("range")
    if range_header:
        upstream_headers["Range"] = range_header
    if host.endswith(".kuwo.cn"):
        upstream_headers["Referer"] = "https://www.kuwo.cn/"

    try:
        resp = requests.get(
            raw,
            headers=upstream_headers,
            stream=True,
            timeout=(AUDIO_PROXY_CONNECT_TIMEOUT, AUDIO_PROXY_READ_TIMEOUT),
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"拉取音频失败: {exc}") from exc

    if resp.status_code >= 400:
        resp.close()
        raise HTTPException(status_code=502, detail=f"上游音频返回 {resp.status_code}")

    media_type = (resp.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip()
    out_headers: dict[str, str] = {}
    for key in ("Content-Length", "Content-Range", "Accept-Ranges", "Content-Type"):
        value = resp.headers.get(key)
        if value:
            out_headers[key] = value
    if "Accept-Ranges" not in out_headers:
        out_headers["Accept-Ranges"] = "bytes"

    def iter_audio_bytes():
        try:
            for chunk in resp.iter_content(chunk_size=64 * 1024):
                if chunk:
                    yield chunk
        finally:
            resp.close()

    return StreamingResponse(
        iter_audio_bytes(),
        status_code=resp.status_code,
        media_type=media_type,
        headers=out_headers,
    )


@app.get("/api/cover-proxy")
def cover_proxy(url: str):
    """将外链专辑图转为同源响应，便于前端 canvas 生成静态模糊背景（跨域图片会污染 canvas）。"""
    raw = (url or "").strip()
    if not raw.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="仅支持 http(s) 封面地址")
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="无效的 URL")
    host = parsed.hostname or ""
    if not _cover_proxy_host_allowed(host):
        raise HTTPException(status_code=403, detail="该域名不允许代理封面")

    try:
        resp = requests.get(
            raw,
            timeout=15,
            stream=True,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
        )
        resp.raise_for_status()
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"拉取封面失败: {exc}") from exc

    content_length = resp.headers.get("Content-Length")
    try:
        declared_size = int(content_length or "0")
    except ValueError:
        declared_size = 0
    if declared_size > COVER_PROXY_MAX_BYTES:
        resp.close()
        raise HTTPException(status_code=400, detail="封面过大")
    ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if not ctype.startswith("image/"):
        resp.close()
        raise HTTPException(status_code=400, detail="响应不是图片")

    def iter_cover_bytes():
        total = 0
        try:
            for chunk in resp.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > COVER_PROXY_MAX_BYTES:
                    break
                yield chunk
        finally:
            resp.close()

    return StreamingResponse(iter_cover_bytes(), media_type=ctype)


@app.get("/api/lyrics")
def lyrics(
    lrc_url: str | None = None,
    lyric_path: str | None = None,
    inline_lyrics: str | None = None,
    translate_to_zh: bool = False,
    translate_provider: str = "dp",
):
    try:
        if inline_lyrics:
            translated_lyrics = translate_lrc_to_zh(inline_lyrics, translate_provider) if translate_to_zh else ""
            return {"lyrics": inline_lyrics, "translated_lyrics": translated_lyrics}

        if lrc_url:
            response = requests.get(lrc_url, timeout=10)
            response.raise_for_status()
            response.encoding = response.apparent_encoding or "utf-8"
            translated_lyrics = translate_lrc_to_zh(response.text, translate_provider) if translate_to_zh else ""
            return {"lyrics": response.text, "translated_lyrics": translated_lyrics}

        if lyric_path:
            if not os.path.exists(lyric_path):
                raise HTTPException(status_code=404, detail="歌词文件不存在")
            for encoding in ("utf-8", "gbk", "utf-16"):
                try:
                    with open(lyric_path, "r", encoding=encoding) as file:
                        raw_lyrics = file.read()
                    translated_lyrics = (
                        get_or_create_zh_lrc(lyric_path, raw_lyrics, translate_provider)
                        if translate_to_zh
                        else read_cached_zh_lrc(lyric_path, raw_lyrics, translate_provider)
                    )
                    return {"lyrics": raw_lyrics, "translated_lyrics": translated_lyrics}
                except UnicodeDecodeError:
                    continue
            raise HTTPException(status_code=500, detail="歌词文件编码无法识别")

        raise HTTPException(status_code=400, detail="请提供 lrc_url、lyric_path 或 inline_lyrics")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"读取歌词失败: {exc}") from exc


def resolve_lyrics_request(lrc_url: str | None = None, lyric_path: str | None = None, inline_lyrics: str | None = None) -> tuple[str, str]:
    normalized_lyric_path = os.path.normpath(os.path.expanduser((lyric_path or "").strip()))
    if normalized_lyric_path and os.path.isfile(normalized_lyric_path):
        for encoding in ("utf-8", "gbk", "utf-16"):
            try:
                with open(normalized_lyric_path, "r", encoding=encoding) as file:
                    return file.read(), normalized_lyric_path
            except UnicodeDecodeError:
                continue
        raise HTTPException(status_code=500, detail="歌词文件编码无法识别")

    if inline_lyrics:
        return inline_lyrics, ""

    if lrc_url:
        response = requests.get(lrc_url, timeout=20)
        response.raise_for_status()
        response.encoding = response.apparent_encoding or response.encoding or "utf-8"
        return response.text, ""

    if normalized_lyric_path:
        raise HTTPException(status_code=404, detail="歌词文件不存在")

    raise HTTPException(status_code=400, detail="请提供 lrc_url、lyric_path 或 inline_lyrics")


def run_lyrics_translate_job(job: LyricsTranslateJob) -> None:
    try:
        job.status = "running"
        job.message = "正在准备翻译歌词"
        translated = translate_lrc_to_zh(job.raw_lyrics, job.provider, progress_callback=job.set_progress)
        if job.lyric_path and translated.strip():
            zh_path = get_translation_lrc_path(job.lyric_path, job.provider)
            write_translation_cache(zh_path, translated)
        job.finish(translated)
        store_finished_lyrics_translate_job(job.id, job.to_response())
        remove_active_job(lyrics_translate_jobs, job.id)
    except Exception as exc:
        job.fail(str(exc))
        store_finished_lyrics_translate_job(job.id, job.to_response())
        remove_active_job(lyrics_translate_jobs, job.id)


@app.post("/api/lyrics/translate")
def create_lyrics_translate_job(payload: LyricsTranslatePayload):
    cleanup_expired_runtime_state()
    try:
        raw_lyrics, resolved_lyric_path = resolve_lyrics_request(
            lrc_url=payload.lrc_url,
            lyric_path=payload.lyric_path,
            inline_lyrics=payload.inline_lyrics,
        )
        if resolved_lyric_path:
            cached = read_cached_zh_lrc(resolved_lyric_path, raw_lyrics, payload.translate_provider)
            if cached.strip():
                job = LyricsTranslateJob(raw_lyrics=raw_lyrics, lyric_path=resolved_lyric_path, provider=payload.translate_provider)
                translatable_count = count_translatable_lyric_lines(raw_lyrics)
                job.total = translatable_count
                job.done = translatable_count
                job.percent = 100
                job.finish(cached)
                store_finished_lyrics_translate_job(job.id, job.to_response())
                return job.to_response()

        job = LyricsTranslateJob(raw_lyrics=raw_lyrics, lyric_path=resolved_lyric_path, provider=payload.translate_provider)
        register_active_job(lyrics_translate_jobs, job, MAX_ACTIVE_LYRICS_TRANSLATE_JOBS)
        thread = threading.Thread(target=run_lyrics_translate_job, args=(job,), daemon=True)
        thread.start()
        return job.to_response()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"创建歌词翻译任务失败: {exc}") from exc


@app.get("/api/lyrics/translate/{job_id}")
def get_lyrics_translate_job(job_id: str):
    cleanup_expired_runtime_state()
    if job_id in lyrics_translate_jobs:
        return lyrics_translate_jobs[job_id].to_response()
    if job_id in finished_lyrics_translate_jobs:
        return finished_lyrics_translate_jobs[job_id]
    raise HTTPException(status_code=404, detail="歌词翻译任务不存在")


def normalize_translate_provider(provider: str) -> str:
    return "dp" if provider == "dp" else "ali"


def get_translation_lrc_path(lyric_path: str, provider: str = "ali") -> str:
    del provider
    stem, _ = os.path.splitext(lyric_path)
    return f"{stem}.zh.lrc"


def read_text_file(path: str) -> str:
    for encoding in ("utf-8", "gbk", "utf-16"):
        try:
            with open(path, "r", encoding=encoding) as file:
                return file.read()
        except UnicodeDecodeError:
            continue
    return ""


def get_or_create_zh_lrc(lyric_path: str, raw_lyrics: str, provider: str = "ali") -> str:
    zh_path = get_translation_lrc_path(lyric_path, provider)
    if os.path.exists(zh_path):
        cached = read_text_file(zh_path)
        if cached.strip() and is_translation_cache_usable(raw_lyrics, cached):
            return cached

    translated = translate_lrc_to_zh(raw_lyrics, provider)
    if translated.strip():
        write_translation_cache(zh_path, translated)
    return translated


def read_cached_zh_lrc(lyric_path: str, raw_lyrics: str, provider: str = "ali") -> str:
    zh_path = get_translation_lrc_path(lyric_path, provider)
    if not os.path.exists(zh_path):
        return ""
    cached = read_text_file(zh_path)
    if cached.strip() and is_translation_cache_usable(raw_lyrics, cached):
        return cached
    return ""


def write_translation_cache(path: str, content: str) -> None:
    temp_path = f"{path}.tmp-{uuid.uuid4().hex}"
    try:
        with open(temp_path, "w", encoding="utf-8") as file:
            file.write(content)
        os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


def split_lrc_line(line: str) -> tuple[str, str]:
    tags = "".join(LRC_TIME_PATTERN.findall(line))
    text = LRC_TIME_PATTERN.sub("", line).strip()
    return tags, text


def parse_lrc_timestamp(tag: str) -> float | None:
    match = re.match(r"\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]", tag)
    if not match:
        return None
    minute = int(match.group(1))
    second = int(match.group(2))
    frac_raw = match.group(3) or ""
    frac = int(frac_raw.ljust(3, "0")) if frac_raw else 0
    return minute * 60 + second + frac / 1000


def format_lrc_timestamp(total_sec: float) -> str:
    safe_sec = max(0.0, total_sec)
    minute = int(safe_sec // 60)
    second_whole = int(safe_sec % 60)
    milli = int(round((safe_sec - int(safe_sec)) * 1000))
    if milli >= 1000:
        milli = 0
        second_whole += 1
    if second_whole >= 60:
        second_whole -= 60
        minute += 1
    return f"[{minute:02d}:{second_whole:02d}.{milli:03d}]"


def shift_lrc_text_timestamps(raw_text: str, delta_sec: float) -> tuple[str, int]:
    changed_count = 0

    def repl(match: re.Match[str]) -> str:
        nonlocal changed_count
        original = match.group(0)
        sec = parse_lrc_timestamp(original)
        if sec is None:
            return original
        shifted = format_lrc_timestamp(sec + delta_sec)
        if shifted != original:
            changed_count += 1
        return shifted

    shifted_text = LRC_TIME_PATTERN.sub(repl, raw_text)
    return shifted_text, changed_count


def write_text_file_with_detected_encoding(path: str, content: str) -> None:
    for encoding in ("utf-8", "gbk", "utf-16"):
        try:
            with open(path, "r", encoding=encoding) as file:
                file.read()
            with open(path, "w", encoding=encoding) as file:
                file.write(content)
            return
        except UnicodeDecodeError:
            continue
    with open(path, "w", encoding="utf-8") as file:
        file.write(content)


def clean_lyric_text(text: str) -> str:
    return re.sub(r"[^\w\u3040-\u30ff\u31f0-\u31ff\u3400-\u9fff\uac00-\ud7af]+", "", text, flags=re.UNICODE)


def is_probably_chinese_line(text: str) -> bool:
    cleaned = clean_lyric_text(text)
    if not cleaned:
        return False
    if JAPANESE_KANA_PATTERN.search(cleaned) or HANGUL_PATTERN.search(cleaned) or LATIN_PATTERN.search(cleaned):
        return False
    cjk_count = len(re.findall(r"[\u3400-\u9fff]", cleaned))
    return cjk_count > 0 and cjk_count / len(cleaned) >= 0.65


def should_translate_lyric_text(text: str) -> bool:
    stripped = text.strip()
    if not stripped or stripped == "...":
        return False
    return not is_probably_chinese_line(stripped)


def is_translation_cache_usable(raw_lyrics: str, translated_lyrics: str) -> bool:
    source_lines = raw_lyrics.splitlines()
    translated_lines = translated_lyrics.splitlines()
    if len(translated_lines) < len(source_lines):
        return False

    checked = 0
    translated_count = 0
    for index, source_line in enumerate(source_lines):
        _, source_text = split_lrc_line(source_line)
        if not should_translate_lyric_text(source_text):
            continue
        if index >= len(translated_lines):
            continue
        _, translated_text = split_lrc_line(translated_lines[index])
        checked += 1
        if not translated_text.strip():
            continue
        if clean_lyric_text(translated_text) == clean_lyric_text(source_text):
            continue
        if not re.search(r"[\u3400-\u9fff]", translated_text):
            continue
        translated_count += 1

    # 专名、标题或重复句可能被模型合理地保留原文；只要大部分可翻译行已有中文，
    # 就复用整份缓存，避免因少量未变化行重复翻译整首歌词。
    return checked > 0 and translated_count * 100 >= checked * 70


def count_translatable_lyric_lines(raw_lyrics: str) -> int:
    total = 0
    for line in raw_lyrics.splitlines():
        tags, text = split_lrc_line(line)
        if tags and should_translate_lyric_text(text):
            total += 1
    return total


def translate_lrc_to_zh(
    raw_lyrics: str,
    provider: str = "ali",
    progress_callback: Callable[[int, int], None] | None = None,
) -> str:
    lines = raw_lyrics.splitlines()
    output = list(lines)
    jobs: list[tuple[int, str, str]] = []

    for index, line in enumerate(lines):
        tags, text = split_lrc_line(line)
        if not tags or not should_translate_lyric_text(text):
            continue
        jobs.append((index, tags, text))

    if not jobs:
        if progress_callback:
            progress_callback(0, 0)
        return ""

    if progress_callback:
        progress_callback(0, len(jobs))

    cap = DEEPSEEK_MAX_WORKERS if normalize_translate_provider(provider) == "dp" else ALI_MAX_WORKERS
    max_workers = max(1, min(len(jobs), cap))
    completed = 0
    failed = 0
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_map = {
            executor.submit(translate_line_to_zh, text, provider): (index, tags, text)
            for index, tags, text in jobs
        }
        for future in as_completed(future_map):
            index, tags, text = future_map[future]
            try:
                translated = future.result().strip()
            except Exception:
                translated = text
                failed += 1
            output[index] = f"{tags}{translated or text}"
            completed += 1
            if progress_callback:
                progress_callback(completed, len(jobs))

    if failed == len(jobs):
        raise RuntimeError("歌词翻译全部失败，未写入翻译缓存")

    return "\n".join(output) + "\n"


def translate_line_to_zh(text: str, provider: str = "ali") -> str:
    provider = normalize_translate_provider(provider)
    if provider == "dp":
        with translate_provider_semaphores["dp"]:
            return translate_line_with_deepseek(text)
    try:
        with translate_provider_semaphores["ali"]:
            return translate_line_with_ali(text)
    except Exception:
        with translate_provider_semaphores["dp"]:
            return translate_line_with_deepseek(text)


def translate_line_with_ali(text: str) -> str:
    if not ALI_TRANSLATE_API_KEY:
        raise RuntimeError("未配置 ALI_TRANSLATE_API_KEY，无法使用阿里百炼翻译")
    response = requests.post(
        ALI_CHAT_URL,
        headers={
            "Authorization": f"Bearer {ALI_TRANSLATE_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": ALI_TRANSLATE_MODEL,
            "messages": [
                {
                    "role": "system",
                    "content": TRANSLATE_SYSTEM_PROMPT,
                },
                {"role": "user", "content": text},
            ],
            "extra_body": {"enable_thinking": False},
            "temperature": 0.1,
        },
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    return str(data["choices"][0]["message"]["content"]).strip()


def translate_line_with_deepseek(text: str) -> str:
    if not DEEPSEEK_API_KEY:
        raise RuntimeError("未配置 DEEPSEEK_API_KEY，无法使用 DeepSeek 翻译")
    response = requests.post(
        DEEPSEEK_CHAT_URL,
        headers={
            "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": DEEPSEEK_TRANSLATE_MODEL,
            "messages": [
                {
                    "role": "system",
                    "content": TRANSLATE_SYSTEM_PROMPT,
                },
                {"role": "user", "content": text},
            ],
            "thinking": {"type": "disabled"},
            "temperature": 0.2,
            "stream": False,
        },
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    return str(data["choices"][0]["message"]["content"]).strip()


@app.post("/api/lyrics/shift")
def shift_local_lyrics(payload: LyricShiftPayload):
    lyric_path = os.path.normpath(os.path.expanduser((payload.lyric_path or "").strip()))
    if not lyric_path:
        raise HTTPException(status_code=400, detail="lyric_path 不能为空")
    if not os.path.isfile(lyric_path):
        raise HTTPException(status_code=404, detail="歌词文件不存在")
    if not lyric_path.lower().endswith(".lrc"):
        raise HTTPException(status_code=400, detail="仅支持 .lrc 文件")
    if abs(payload.delta_sec) < 1e-9:
        return {"ok": True, "delta_sec": 0.0, "changed_tags": 0, "changed_translation_tags": 0}

    try:
        raw = read_text_file(lyric_path)
        if not raw:
            raise HTTPException(status_code=500, detail="歌词文件读取失败或为空")

        shifted, changed_tags = shift_lrc_text_timestamps(raw, payload.delta_sec)
        write_text_file_with_detected_encoding(lyric_path, shifted)

        zh_path = get_translation_lrc_path(lyric_path, "ali")
        changed_translation_tags = 0
        if os.path.isfile(zh_path):
            zh_raw = read_text_file(zh_path)
            if zh_raw:
                zh_shifted, changed_translation_tags = shift_lrc_text_timestamps(zh_raw, payload.delta_sec)
                write_text_file_with_detected_encoding(zh_path, zh_shifted)

        return {
            "ok": True,
            "delta_sec": payload.delta_sec,
            "changed_tags": changed_tags,
            "translation_path": zh_path if os.path.isfile(zh_path) else "",
            "changed_translation_tags": changed_translation_tags,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"调整歌词时间失败: {exc}") from exc


@app.get("/")
def index():
    if not os.path.isfile(frontend_index_file):
        raise HTTPException(status_code=404, detail="前端资源不存在，请先构建 frontend/dist")
    return FileResponse(frontend_index_file, media_type="text/html")


@app.get("/{full_path:path}")
def spa_fallback(full_path: str):
    if full_path.startswith("api/") or full_path.startswith("assets/"):
        raise HTTPException(status_code=404, detail="Not Found")
    if not os.path.isfile(frontend_index_file):
        raise HTTPException(status_code=404, detail="前端资源不存在，请先构建 frontend/dist")
    return FileResponse(frontend_index_file, media_type="text/html")
