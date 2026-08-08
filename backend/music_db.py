import os
import sqlite3
import threading
from datetime import datetime
from typing import Any


class MusicDatabase:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._lock = threading.Lock()
        self.init()

    def init(self) -> None:
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        with self._lock, sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS local_songs (
                    file_path TEXT PRIMARY KEY,
                    song_name TEXT,
                    singers TEXT,
                    album TEXT,
                    cover TEXT,
                    stream_url TEXT,
                    lyric_path TEXT,
                    audio_parse_source TEXT,
                    lyric_parse_source TEXT,
                    relative_path TEXT,
                    play_count INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS play_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_path TEXT,
                    song_name TEXT,
                    singers TEXT,
                    album TEXT,
                    cover TEXT,
                    stream_url TEXT,
                    played_at TEXT
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TEXT
                )
                """
            )
            self._ensure_column(conn, "local_songs", "play_count", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "local_songs", "audio_parse_source", "TEXT")
            self._ensure_column(conn, "local_songs", "lyric_parse_source", "TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_play_history_played_at ON play_history(played_at)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_play_history_song ON play_history(song_name, singers, album)")

    def _ensure_column(self, conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
        columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in columns:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def upsert_local_songs(self, items: list[dict[str, Any]]) -> None:
        now = datetime.now().isoformat(timespec="seconds")
        rows = [
            (
                item.get("file_path") or "",
                item.get("song_name") or "",
                self.song_text(item.get("singers")),
                item.get("album") or "",
                item.get("cover") or "",
                item.get("stream_url") or "",
                item.get("lyric_path") or "",
                item.get("audio_parse_source") or "",
                item.get("lyric_parse_source") or "",
                item.get("relative_path") or "",
                now,
            )
            for item in items
            if item.get("file_path")
        ]
        if not rows:
            return
        with self._lock, sqlite3.connect(self.db_path) as conn:
            conn.executemany(
                """
                INSERT INTO local_songs (
                    file_path, song_name, singers, album, cover, stream_url, lyric_path,
                    audio_parse_source, lyric_parse_source, relative_path, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(file_path) DO UPDATE SET
                    song_name = excluded.song_name,
                    singers = excluded.singers,
                    album = excluded.album,
                    cover = excluded.cover,
                    stream_url = excluded.stream_url,
                    lyric_path = excluded.lyric_path,
                    audio_parse_source = COALESCE(NULLIF(excluded.audio_parse_source, ''), local_songs.audio_parse_source),
                    lyric_parse_source = COALESCE(NULLIF(excluded.lyric_parse_source, ''), local_songs.lyric_parse_source),
                    relative_path = excluded.relative_path,
                    updated_at = excluded.updated_at
                """,
                rows,
            )

    def remove_local_songs(self, file_paths: list[str]) -> None:
        paths = [path for path in file_paths if path]
        if not paths:
            return
        with self._lock, sqlite3.connect(self.db_path) as conn:
            conn.executemany("DELETE FROM local_songs WHERE file_path = ?", [(path,) for path in paths])
            conn.executemany("DELETE FROM play_history WHERE file_path = ?", [(path,) for path in paths])

    def record_play(self, song: dict[str, Any]) -> None:
        file_path = song.get("file_path") or ""
        played_at = datetime.now().isoformat(timespec="seconds")
        with self._lock, sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO play_history (file_path, song_name, singers, album, cover, stream_url, played_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    file_path,
                    song.get("song_name") or "",
                    self.song_text(song.get("singers")),
                    song.get("album") or "",
                    song.get("cover") or "",
                    song.get("stream_url") or "",
                    played_at,
                ),
            )
            if file_path:
                conn.execute(
                    """
                    UPDATE local_songs
                    SET play_count = play_count + 1, updated_at = ?
                    WHERE file_path = ?
                    """,
                    (played_at, file_path),
                )

    def local_recommendations(self, limit: int) -> list[dict[str, Any]]:
        limit = max(1, int(limit or 10))
        with self._lock, sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT *
                FROM local_songs
                ORDER BY play_count DESC, updated_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [self.song_from_row(row) for row in rows]

    def songs_by_file_path(self, file_paths: list[str]) -> dict[str, dict[str, Any]]:
        paths = [path for path in file_paths if path]
        if not paths:
            return {}
        placeholders = ",".join("?" for _ in paths)
        with self._lock, sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"SELECT * FROM local_songs WHERE file_path IN ({placeholders})",
                paths,
            ).fetchall()
        return {row["file_path"]: self.song_from_row(row) for row in rows}

    def song_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "song_name": row["song_name"],
            "singers": row["singers"],
            "album": row["album"],
            "source": "本地推荐",
            "download_url": "",
            "stream_url": row["stream_url"],
            "cover": row["cover"],
            "file_path": row["file_path"],
            "lyric_path": row["lyric_path"],
            "audio_parse_source": row["audio_parse_source"],
            "lyric_parse_source": row["lyric_parse_source"],
            "relative_path": row["relative_path"],
            "play_count": row["play_count"],
            "is_recommendation": True,
            "recommendation_source": "本地曲库",
            "recommendation_reason": "基于本地音乐库与播放历史推荐",
        }

    def get_bool_setting(self, key: str, default: bool = False) -> bool:
        with self._lock, sqlite3.connect(self.db_path) as conn:
            row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
        if not row:
            return default
        return str(row[0] or "").strip().lower() in {"1", "true", "yes", "on"}

    def set_bool_setting(self, key: str, value: bool) -> None:
        now = datetime.now().isoformat(timespec="seconds")
        with self._lock, sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO app_settings (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                """,
                (key, "1" if value else "0", now),
            )

    @staticmethod
    def song_text(value: Any) -> str:
        if isinstance(value, list):
            return ", ".join(str(item) for item in value if item)
        return str(value or "")
