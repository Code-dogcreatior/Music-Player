import html
import os
import shutil
import re
import base64
import sys
import requests

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
os.environ.setdefault("PYTHONUTF8", "1")
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
from types import MethodType
from typing import Any

# 尝试导入 musicdl
#
# 注意：musicdl 在导入阶段会初始化文件日志；在部分受限环境下这一步可能因日志目录权限失败，
# 若直接抛错会导致整个桌面应用“点击无反应”。这里统一降级处理，保证应用能先启动。
try:
    from musicdl import musicdl
    from musicdl.modules.utils import SongInfo
    MUSICDL_AVAILABLE = True
except Exception as exc:
    SongInfo = None
    MUSICDL_AVAILABLE = False
    musicdl = None
    print(f"警告：musicdl 初始化失败，已禁用下载能力：{exc}")

try:
    from mutagen import File as MutagenFile
    MUTAGEN_AVAILABLE = True
except ImportError:
    MUTAGEN_AVAILABLE = False

try:
    import musicbrainzngs
    MUSICBRAINZ_AVAILABLE = True
except ImportError:
    musicbrainzngs = None
    MUSICBRAINZ_AVAILABLE = False

try:
    import pylistenbrainz
    PYLISTENBRAINZ_AVAILABLE = True
except ImportError:
    pylistenbrainz = None
    PYLISTENBRAINZ_AVAILABLE = False


class MusicService:
    def __init__(self):
        self.source_map_cn_to_en = {
            # 综合排序：曲库体量/命中率 50%，可播放成功率 30%，响应速度 20%。
            # dict 插入顺序会由 /api/sources 传给前端，前三项显示为综合推荐源。
            "QQ音乐": "QQMusicClient",
            "酷我音乐": "KuwoMusicClient",
            "网易云音乐": "NeteaseMusicClient",
            "咪咕音乐": "MiguMusicClient",
            "波点音乐": "BodianMusicClient",
            "5sing": "FiveSingMusicClient",
            "哔哩哔哩": "BilibiliMusicClient",
            "Deezer": "DeezerMusicClient",
            "Suno": "SunoMusicClient",
            # "苹果音乐": "AppleMusicClient",  # 已隐藏：需要付费 Apple Developer Program ($99/年) + Apple Music 订阅
        }
        self.source_map_en_to_cn = {v: k for k, v in self.source_map_cn_to_en.items()}
        self.lossless_exts = {"flac", "wav", "alac", "ape", "wv", "tta", "dsf", "dff"}
        self.recommendation_limit = 5
        self.recommendation_seed_limit = 3
        self.listenbrainz_username = os.getenv("LISTENBRAINZ_USERNAME", "").strip()
        self.listenbrainz_token = os.getenv("LISTENBRAINZ_TOKEN", "").strip()
        if MUSICBRAINZ_AVAILABLE:
            try:
                musicbrainzngs.set_useragent(
                    "Music-Player",
                    "1.0.0",
                    "https://github.com/local/Music-Player",
                )
            except Exception:
                pass

    def init_music_client(self, selected_sources, limit, save_dir):
        if not MUSICDL_AVAILABLE:
            return None

        os.makedirs(save_dir, exist_ok=True)
        my_init_music_clients_cfg = {}
        clients_threadings = {}
        src_names = []

        # 需要优化配置的音乐源列表（所有音乐源统一优化）
        optimized_sources = [
            "QQMusicClient", "NeteaseMusicClient", "KuwoMusicClient",
            "QianqianMusicClient", "BodianMusicClient", "StreetVoiceMusicClient",
            "SpotifyMusicClient", "AppleMusicClient", "YoutubeMusicClient",
            "TIDALMusicClient", "DeezerMusicClient", "QobuzMusicClient",
            "SoundCloudMusicClient", "JooxMusicClient", "MoovMusicClient",
            "JiosaavnMusicClient", "JamendoMusicClient", "FMAMusicClient",
            "OpengameartMusicClient", "SodaMusicClient", "KugouMusicClient",
            "SunoMusicClient", "BilibiliMusicClient", "FiveSingMusicClient",
            "MiguMusicClient"
        ]

        for source in selected_sources:
            source_cfg = {
                "search_size_per_source": limit,
                "work_dir": save_dir,
            }

            # QQ音乐特殊配置（保持原有优化）
            if source == "QQMusicClient":
                source_cfg.update({
                    # musicdl 会并发搜索不同页，但会串行解析同一页中的歌曲。
                    # 每页只取一首可让慢速播放地址解析并行执行，避免 10 首歌依次等待。
                    "search_size_per_page": 1,
                    "max_retries": 1,
                    "maintain_session": True,
                })
                clients_threadings[source] = max(1, min(int(limit or 1), 8))
            # 其他需要优化的音乐源统一配置
            elif source in optimized_sources:
                source_cfg.update({
                    "search_size_per_page": 1,
                    "max_retries": 1,
                })

            my_init_music_clients_cfg[source] = source_cfg
            src_names.append(source)

        if not src_names:
            return None

        music_client = musicdl.MusicClient(
            music_sources=src_names,
            init_music_clients_cfg=my_init_music_clients_cfg,
            clients_threadings=clients_threadings,
        )

        # 应用各音乐源的优化
        self._tune_qq_client(music_client)
        self._tune_netease_client(music_client)
        self._tune_kuwo_client(music_client)
        self._tune_all_sources(music_client)

        return music_client

    def _tune_qq_client(self, music_client):
        qq_client = getattr(music_client, "music_clients", {}).get("QQMusicClient")
        if not qq_client or SongInfo is None:
            return
        if not hasattr(qq_client, "_codex_original_parsewiththirdpartapis"):
            qq_client._codex_original_parsewiththirdpartapis = qq_client._parsewiththirdpartapis
        if not hasattr(qq_client, "_codex_original_parsewithofficialapiv1"):
            qq_client._codex_original_parsewithofficialapiv1 = qq_client._parsewithofficialapiv1

        def fast_parsewiththirdpartapis(client_self, search_result, request_overrides=None):
            request_overrides = request_overrides or {}
            return self._parse_qq_fast_playback(client_self, search_result, request_overrides)

        def fast_parsewithofficialapiv1(client_self, search_result, song_info_flac=None, *args, **kwargs):
            if song_info_flac is not None and getattr(song_info_flac, "with_valid_download_url", False):
                return song_info_flac
            return SongInfo(source=client_self.source, raw_data={"search": search_result, "download": {}, "lyric": {}})

        qq_client._parsewiththirdpartapis = MethodType(fast_parsewiththirdpartapis, qq_client)
        qq_client._parsewithofficialapiv1 = MethodType(fast_parsewithofficialapiv1, qq_client)

    def _tune_netease_client(self, music_client):
        """优化网易云音乐客户端，跳过耗时的第三方API调用"""
        netease_client = getattr(music_client, "music_clients", {}).get("NeteaseMusicClient")
        if not netease_client or SongInfo is None:
            return

        # 保存原始方法
        if not hasattr(netease_client, "_codex_original_parsewiththirdpartapis"):
            if hasattr(netease_client, "_parsewiththirdpartapis"):
                netease_client._codex_original_parsewiththirdpartapis = netease_client._parsewiththirdpartapis

        # 快速解析：跳过第三方API，直接返回基本信息
        def fast_parse_netease(client_self, search_result, request_overrides=None):
            # 直接返回简化的SongInfo，跳过耗时的第三方API调用
            return SongInfo(source=client_self.source, raw_data={"search": search_result, "download": {}, "lyric": {}})

        if hasattr(netease_client, "_parsewiththirdpartapis"):
            netease_client._parsewiththirdpartapis = MethodType(fast_parse_netease, netease_client)

    def _tune_kuwo_client(self, music_client):
        """优先使用仍可在浏览器播放的酷我 HTTPS 解析地址。"""
        kuwo_client = getattr(music_client, "music_clients", {}).get("KuwoMusicClient")
        if not kuwo_client or SongInfo is None:
            return

        if not hasattr(kuwo_client, "_codex_original_parsewiththirdpartapis"):
            if hasattr(kuwo_client, "_parsewiththirdpartapis"):
                kuwo_client._codex_original_parsewiththirdpartapis = kuwo_client._parsewiththirdpartapis

        def fast_parse_kuwo(client_self, search_result, request_overrides=None):
            empty = SongInfo(
                source=client_self.source,
                raw_data={"search": search_result, "download": {}, "lyric": {}},
            )
            # 酷我官方 mobi 接口目前常返回 kw-er 的 HTTP 地址，浏览器播放会 403。
            # 只尝试两个响应较快、返回 HTTPS CDN 地址的解析器，避免恢复全部慢接口。
            for parser_name in ("_parsewithnxinxzapi", "_parsewithhaitangwapi"):
                parser = getattr(client_self, parser_name, None)
                if not parser:
                    continue
                try:
                    candidate = parser(search_result, {})
                except Exception:
                    continue
                if self._is_valid_song_info(candidate):
                    return candidate
            return empty

        if hasattr(kuwo_client, "_parsewiththirdpartapis"):
            kuwo_client._parsewiththirdpartapis = MethodType(fast_parse_kuwo, kuwo_client)

    def _tune_all_sources(self, music_client):
        """为所有其他音乐源添加通用优化"""
        if not SongInfo:
            return

        # 需要优化的音乐源列表（除了已经单独优化的QQ、网易云、酷我）
        sources_to_optimize = [
            "QianqianMusicClient", "BodianMusicClient", "StreetVoiceMusicClient",
            "SpotifyMusicClient", "AppleMusicClient", "YoutubeMusicClient",
            "TIDALMusicClient", "DeezerMusicClient", "QobuzMusicClient",
            "SoundCloudMusicClient", "JooxMusicClient", "MoovMusicClient",
            "JiosaavnMusicClient", "JamendoMusicClient", "FMAMusicClient",
            "OpengameartMusicClient", "SodaMusicClient", "KugouMusicClient",
            "SunoMusicClient", "BilibiliMusicClient", "FiveSingMusicClient"
        ]

        for source_name in sources_to_optimize:
            client = getattr(music_client, "music_clients", {}).get(source_name)
            if not client:
                continue

            # 保存原始方法
            if not hasattr(client, "_codex_original_parsewiththirdpartapis"):
                if hasattr(client, "_parsewiththirdpartapis"):
                    client._codex_original_parsewiththirdpartapis = client._parsewiththirdpartapis

            # 快速解析：跳过第三方API
            def fast_parse_generic(client_self, search_result, request_overrides=None):
                return SongInfo(source=client_self.source, raw_data={"search": search_result, "download": {}, "lyric": {}})

            if hasattr(client, "_parsewiththirdpartapis"):
                client._parsewiththirdpartapis = MethodType(fast_parse_generic, client)

    def _song_get(self, song_info, key, default=None):
        if isinstance(song_info, dict):
            if key in song_info:
                return song_info.get(key, default)
            raw_data = song_info.get("raw_data") or {}
        else:
            value = getattr(song_info, key, default)
            if value != default:
                return value
            raw_data = getattr(song_info, "raw_data", {}) or {}

        if isinstance(raw_data, dict):
            meta = raw_data.get("_codex_meta") or {}
            if isinstance(meta, dict) and key in meta:
                return meta.get(key, default)
        return default

    def _song_ext(self, song_info) -> str:
        return str(self._song_get(song_info, "ext", "") or "").lower().lstrip(".")

    def _is_lossless_song(self, song_info) -> bool:
        return self._song_ext(song_info) in self.lossless_exts

    def _is_valid_song_info(self, song_info) -> bool:
        return bool(song_info and getattr(song_info, "with_valid_download_url", False))

    def _empty_song_info_from(self, song_info):
        source = self._song_get(song_info, "source") or ""
        raw_data = self._song_get(song_info, "raw_data", {}) or {}
        if not isinstance(raw_data, dict):
            raw_data = {}
        return SongInfo(source=source, raw_data=raw_data)

    def _extract_raw_search_result(self, song_info):
        raw_data = self._song_get(song_info, "raw_data", {}) or {}
        if isinstance(raw_data, dict) and isinstance(raw_data.get("search"), dict):
            return raw_data["search"]
        return None

    def _format_duration(self, seconds: int) -> str:
        seconds = max(0, int(seconds or 0))
        hours, remainder = divmod(seconds, 3600)
        minutes, secs = divmod(remainder, 60)
        if hours:
            return f"{hours:02d}:{minutes:02d}:{secs:02d}"
        return f"{minutes:02d}:{secs:02d}"

    def strip_html_tags(self, value) -> str:
        """去掉 QQ 等源搜索高亮返回的 <em> 等 HTML 标签，并解码常见实体。"""
        if isinstance(value, list):
            return ", ".join(
                part for part in (self.strip_html_tags(item) for item in value) if part
            )
        text = str(value or "")
        if not text:
            return ""
        cleaned = re.sub(r"<[^>]*>", "", text)
        return html.unescape(cleaned).strip()

    def _qq_search_meta(self, search_result: dict):
        singers = search_result.get("singer") or []
        if isinstance(singers, list):
            singers_text = ", ".join(
                self.strip_html_tags(singer.get("name"))
                for singer in singers
                if isinstance(singer, dict) and singer.get("name")
            )
        else:
            singers_text = self.strip_html_tags(singers)
        album = search_result.get("album") if isinstance(search_result.get("album"), dict) else {}
        album_mid = album.get("mid") or search_result.get("albummid") or ""
        duration_s = int(float(search_result.get("interval", 0) or 0))
        return {
            "song_id": search_result.get("mid") or search_result.get("songmid"),
            "song_name": self.strip_html_tags(
                search_result.get("title") or search_result.get("songname")
            ),
            "singers": singers_text,
            "album": self.strip_html_tags(album.get("title") or search_result.get("albumname")),
            "duration_s": duration_s,
            "duration": self._format_duration(duration_s),
            "cover_url": f"https://y.gtimg.cn/music/photo_new/T002R800x800M000{album_mid}.jpg" if album_mid else "",
        }

    def _set_song_attr(self, song_info, key, value):
        if isinstance(song_info, dict):
            song_info[key] = value
            raw_data = song_info.setdefault("raw_data", {})
            if isinstance(raw_data, dict):
                raw_data.setdefault("_codex_meta", {})[key] = value
            return
        try:
            setattr(song_info, key, value)
        except Exception:
            pass
        raw_data = getattr(song_info, "raw_data", None)
        if isinstance(raw_data, dict):
            raw_data.setdefault("_codex_meta", {})[key] = value

    def _song_source_label(self, source: str, parser: str) -> str:
        source_name = self.source_map_en_to_cn.get(source, source or "未知来源")
        return f"{source_name}/{parser}" if parser else source_name

    def _build_qq_song_info(
        self,
        client_self,
        search_result: dict,
        download_result: dict,
        download_url: str,
        request_overrides=None,
        audio_parser: str = "",
    ):
        empty = SongInfo(source=client_self.source, raw_data={"search": search_result, "download": {}, "lyric": {}})
        if not download_url or not str(download_url).startswith("http"):
            return empty
        request_overrides = request_overrides or {}
        try:
            download_url_status = client_self.audio_link_tester.test(
                url=download_url,
                request_overrides=request_overrides,
                renew_session=True,
            )
        except Exception:
            return empty
        meta = self._qq_search_meta(search_result)
        song_info = SongInfo(
            raw_data={"search": search_result, "download": download_result or {}, "lyric": {}},
            source=client_self.source,
            song_name=meta["song_name"],
            singers=meta["singers"],
            album=meta["album"],
            ext=download_url_status.get("ext"),
            file_size_bytes=download_url_status.get("file_size_bytes"),
            file_size=download_url_status.get("file_size"),
            identifier=str(meta["song_id"] or ""),
            duration_s=meta["duration_s"],
            duration=meta["duration"],
            lyric=None,
            cover_url=meta["cover_url"],
            download_url=download_url_status.get("download_url"),
            download_url_status=download_url_status,
        )
        if audio_parser:
            self._set_song_attr(song_info, "audio_parse_source", self._song_source_label(client_self.source, audio_parser))
        return song_info

    def _supplement_qq_lyric(self, client_self, song_info, search_result: dict, request_overrides=None):
        if not self._is_valid_song_info(song_info):
            return song_info
        if self._song_get(song_info, "lyric"):
            if not self._song_get(song_info, "lyric_parse_source"):
                parser = "tang" if self._song_get(song_info, "audio_parse_source") == self._song_source_label(client_self.source, "tang") else ""
                if parser:
                    self._set_song_attr(song_info, "lyric_parse_source", self._song_source_label(client_self.source, parser))
            return song_info
        song_id = search_result.get("mid") or search_result.get("songmid")
        if not song_id:
            return song_info
        lyric_overrides = dict(request_overrides or {})
        lyric_overrides.pop("headers", None)
        lyric_overrides.pop("timeout", None)
        try:
            response = client_self.get(
                "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
                headers={"Referer": "https://y.qq.com/portal/player.html"},
                params={
                    "songmid": str(song_id),
                    "g_tk": "5381",
                    "loginUin": "0",
                    "hostUin": "0",
                    "format": "json",
                    "inCharset": "utf8",
                    "outCharset": "utf-8",
                    "platform": "yqq",
                },
                timeout=5,
                **lyric_overrides,
            )
            if response is None:
                return song_info
            data = response.json()
            encoded = data.get("lyric") or ""
            if not encoded:
                return song_info
            lyric = base64.b64decode(encoded).decode("utf-8", errors="ignore").strip()
            if lyric:
                song_info.raw_data["lyric"] = data
                song_info.lyric = lyric
                self._set_song_attr(song_info, "lyric_parse_source", self._song_source_label(client_self.source, "official-yqq"))
        except Exception:
            pass
        return song_info

    def _parse_qq_lx_url(self, client_self, search_result: dict, quality: str, api_name: str, request_overrides=None):
        request_overrides = dict(request_overrides or {})
        song_id = search_result.get("mid") or search_result.get("songmid")
        if not song_id:
            return SongInfo(source=client_self.source, raw_data={"search": search_result, "download": {}, "lyric": {}})
        if api_name == "huibq":
            url = f"https://lxmusicapi.onrender.com/url/tx/{song_id}/{quality}"
            headers = {"Content-Type": "application/json", "User-Agent": "lx-music-request/2.6.0", "X-Request-Key": "share-v3"}
            download_key = "url"
        else:
            url = f"http://220.167.101.253:6001/api/musics/url/tx/{song_id}/{quality}"
            headers = {"Content-Type": "application/json", "User-Agent": "lx-music-request/2.6.0", "X-Request-Key": "lxmusic"}
            download_key = "data"
        try:
            request_overrides.setdefault("timeout", 3)
            response = client_self.get(url, headers=headers, **request_overrides)
            if response is None:
                raise RuntimeError("empty response")
            response.raise_for_status()
            download_result = response.json()
            download_url = download_result.get(download_key)
            return self._build_qq_song_info(
                client_self,
                search_result,
                download_result,
                download_url,
                request_overrides,
                audio_parser=api_name,
            )
        except Exception:
            return SongInfo(source=client_self.source, raw_data={"search": search_result, "download": {}, "lyric": {}})

    def _parse_qq_tang(self, client_self, search_result: dict, request_overrides=None):
        """解析 tang 接口，避开 musicdl 方法中 timeout 参数重复的问题。"""
        request_overrides = dict(request_overrides or {})
        request_overrides.pop("headers", None)
        request_overrides.setdefault("timeout", 8)
        song_id = search_result.get("mid") or search_result.get("songmid")
        empty = SongInfo(
            source=client_self.source,
            raw_data={"search": search_result, "download": {}, "lyric": {}},
        )
        if not song_id:
            return empty
        try:
            response = client_self.get(
                f"https://tang.api.s01s.cn/music_open_api.php?mid={song_id}",
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
                    )
                },
                **request_overrides,
            )
            if response is None:
                return empty
            response.raise_for_status()
            download_result = response.json()
            download_url = (
                download_result.get("song_play_url_sq")
                or download_result.get("song_play_url_hq")
                or download_result.get("song_play_url")
                or download_result.get("song_play_url_standard")
                or download_result.get("song_play_url_fq")
            )
            return self._build_qq_song_info(
                client_self,
                search_result,
                download_result,
                download_url,
                request_overrides,
                audio_parser="tang",
            )
        except Exception:
            return empty

    def _parse_qq_fast_playback(self, client_self, search_result: dict, request_overrides=None):
        request_overrides = request_overrides or {}
        empty = SongInfo(source=client_self.source, raw_data={"search": search_result, "download": {}, "lyric": {}})
        # QQ 默认优先策略：tang 优先（huibq 常返回“禁止批量下载”），失败再试 huibq。
        try:
            song_info = self._parse_qq_tang(client_self, search_result, request_overrides)
            if self._is_valid_song_info(song_info):
                return self._supplement_qq_lyric(client_self, song_info, search_result, request_overrides)
        except Exception:
            pass
        huibq_overrides = dict(request_overrides)
        huibq_overrides["timeout"] = min(int(huibq_overrides.get("timeout") or 3), 2)
        song_info = self._parse_qq_lx_url(client_self, search_result, "320k", "huibq", huibq_overrides)
        if self._is_valid_song_info(song_info):
            return self._supplement_qq_lyric(client_self, song_info, search_result, request_overrides)
        return empty

    def prefer_download_quality(self, music_client, song_info):
        if self._song_get(song_info, "source") != "QQMusicClient":
            return song_info
        if self._is_lossless_song(song_info):
            return song_info

        qq_client = getattr(music_client, "music_clients", {}).get("QQMusicClient")
        search_result = self._extract_raw_search_result(song_info)
        if not qq_client or not isinstance(search_result, dict):
            return song_info

        fallback = song_info if self._is_valid_song_info(song_info) else None
        req = {"timeout": 8}

        def consume(candidate):
            """收集有损备选；若无损则返回 True 表示调用方应立即返回 candidate。"""
            nonlocal fallback
            if not self._is_valid_song_info(candidate):
                return False
            if self._is_lossless_song(candidate):
                return True
            if fallback is None:
                fallback = candidate
            return False

        # QQ 下载提质：tang 优先拿无损；huibq 作短超时兜底。
        priority_try = [
            ("tang", lambda: self._parse_qq_tang(qq_client, search_result, req)),
            ("huibq", lambda: self._parse_qq_lx_url(qq_client, search_result, "flac", "huibq", {"timeout": 2})),
        ]
        for parser_name, fn in priority_try:
            try:
                cand = fn()
            except Exception:
                continue
            if self._is_valid_song_info(cand) and not self._song_get(cand, "audio_parse_source"):
                self._set_song_attr(cand, "audio_parse_source", self._song_source_label("QQMusicClient", parser_name))
            if consume(cand):
                return cand

        return fallback or self._empty_song_info_from(song_info)

    def search(self, music_client, keyword, search_type):
        if search_type == "搜索歌曲":
            return music_client.search(keyword=keyword)

        results = music_client.parseplaylist(keyword)
        if not isinstance(results, dict):
            results = {"歌单": results}
        return results

    def _text(self, value) -> str:
        if isinstance(value, list):
            return ", ".join(str(item).strip() for item in value if str(item).strip())
        return str(value or "").strip()

    def _song_identity(self, song_info) -> tuple[str, str]:
        title = self._text(self._song_get(song_info, "song_name") or self._song_get(song_info, "title"))
        artists = self._text(self._song_get(song_info, "singers") or self._song_get(song_info, "artist"))
        return (self._normalize_text(title), self._normalize_text(artists))

    def _normalize_text(self, value: str) -> str:
        return re.sub(r"\s+", " ", str(value or "").casefold()).strip()

    def _musicbrainz_artist_credit(self, recording: dict) -> str:
        credits = recording.get("artist-credit") or []
        names: list[str] = []
        for credit in credits:
            if isinstance(credit, dict):
                artist = credit.get("artist")
                if isinstance(artist, dict) and artist.get("name"):
                    names.append(str(artist["name"]))
                elif credit.get("name"):
                    names.append(str(credit["name"]))
        return ", ".join(name for name in names if name)

    def _musicbrainz_artist_ids(self, recording: dict) -> list[str]:
        ids: list[str] = []
        for credit in recording.get("artist-credit") or []:
            if isinstance(credit, dict):
                artist = credit.get("artist")
                if isinstance(artist, dict) and artist.get("id"):
                    ids.append(str(artist["id"]))
        return ids

    def _seed_from_song(self, song_info) -> dict[str, Any] | None:
        title = self._text(self._song_get(song_info, "song_name") or self._song_get(song_info, "title"))
        artists = self._text(self._song_get(song_info, "singers") or self._song_get(song_info, "artist"))
        album = self._text(self._song_get(song_info, "album"))
        if not title and not artists:
            return None
        return {"title": title, "artists": artists, "album": album}

    def _musicbrainz_lookup_seed(self, seed: dict[str, str]) -> dict[str, Any] | None:
        if not MUSICBRAINZ_AVAILABLE:
            return None
        try:
            query_kwargs = {"recording": seed.get("title") or "", "limit": 1}
            if seed.get("artists"):
                query_kwargs["artist"] = seed["artists"].split(",")[0].strip()
            if seed.get("album"):
                query_kwargs["release"] = seed["album"]
            result = musicbrainzngs.search_recordings(**query_kwargs)
            recordings = result.get("recording-list") or []
            if not recordings:
                return None
            recording = recordings[0]
            return {
                "recording_mbid": recording.get("id", ""),
                "title": recording.get("title") or seed.get("title", ""),
                "artist": self._musicbrainz_artist_credit(recording) or seed.get("artists", ""),
                "artist_mbids": self._musicbrainz_artist_ids(recording),
            }
        except Exception:
            return None

    def _extract_listenbrainz_recommendations(self, payload: Any) -> list[dict[str, str]]:
        recommendations: list[dict[str, str]] = []

        def walk(value: Any):
            if isinstance(value, dict):
                title = (
                    value.get("recording_name")
                    or value.get("track_name")
                    or value.get("title")
                    or value.get("name")
                )
                artist = (
                    value.get("artist_name")
                    or value.get("artist_credit_name")
                    or value.get("artist")
                )
                mbid = (
                    value.get("recording_mbid")
                    or value.get("recording_msid")
                    or value.get("mbid")
                    or value.get("id")
                )
                if title or artist or mbid:
                    recommendations.append(
                        {
                            "title": self._text(title),
                            "artist": self._text(artist),
                            "recording_mbid": self._text(mbid),
                            "source": "ListenBrainz",
                        }
                    )
                for item in value.values():
                    if isinstance(item, (dict, list)):
                        walk(item)
            elif isinstance(value, list):
                for item in value:
                    walk(item)

        walk(payload)
        return recommendations

    def _listenbrainz_recommendations(self) -> list[dict[str, str]]:
        username = self.listenbrainz_username or self._listenbrainz_username_from_token()
        if not PYLISTENBRAINZ_AVAILABLE or not username:
            return []
        try:
            client = pylistenbrainz.ListenBrainz()
            if self.listenbrainz_token:
                try:
                    client.set_auth_token(self.listenbrainz_token, check_validity=False)
                except TypeError:
                    client.set_auth_token(self.listenbrainz_token)
            payload = client.get_user_recommendation_recordings(
                username=username,
                artist_type="similar",
                count=25,
            )
            return self._extract_listenbrainz_recommendations(payload)
        except Exception:
            return []

    def _listenbrainz_username_from_token(self) -> str:
        if not self.listenbrainz_token:
            return ""
        try:
            response = requests.get(
                "https://api.listenbrainz.org/1/validate-token",
                headers={"Authorization": f"Token {self.listenbrainz_token}"},
                timeout=5,
            )
            response.raise_for_status()
            data = response.json()
            if not data.get("valid"):
                return ""
            return self._text(data.get("user_name") or data.get("username"))
        except Exception:
            return ""

    def _recording_by_mbid(self, recording_mbid: str) -> dict[str, str] | None:
        if not MUSICBRAINZ_AVAILABLE or not recording_mbid:
            return None
        try:
            result = musicbrainzngs.get_recording_by_id(recording_mbid, includes=["artists", "releases"])
            recording = result.get("recording") or {}
            title = self._text(recording.get("title"))
            artist = self._musicbrainz_artist_credit(recording)
            if not title and not artist:
                return None
            return {"title": title, "artist": artist, "source": "MusicBrainz"}
        except Exception:
            return None

    def _musicbrainz_fallback_recommendations(self, seeds: list[dict[str, Any]]) -> list[dict[str, str]]:
        if not MUSICBRAINZ_AVAILABLE:
            return []
        candidates: list[dict[str, str]] = []
        for seed in seeds:
            artist_mbids = seed.get("artist_mbids") or []
            seed_artist = self._text(seed.get("artist"))
            try:
                if artist_mbids:
                    result = musicbrainzngs.browse_recordings(
                        artist=artist_mbids[0],
                        includes=["artists"],
                        limit=25,
                    )
                    recordings = result.get("recording-list") or []
                else:
                    result = musicbrainzngs.search_recordings(artist=seed_artist, limit=25)
                    recordings = result.get("recording-list") or []
            except Exception:
                continue

            for recording in recordings:
                title = self._text(recording.get("title"))
                artist = self._musicbrainz_artist_credit(recording) or seed_artist
                if not title or self._normalize_text(title) == self._normalize_text(seed.get("title", "")):
                    continue
                candidates.append(
                    {
                        "title": title,
                        "artist": artist,
                        "source": "MusicBrainz",
                    }
                )
        return candidates

    def _recommendation_query(self, candidate: dict[str, str]) -> str:
        title = self._text(candidate.get("title"))
        artist = self._text(candidate.get("artist"))
        return " ".join(part for part in [title, artist] if part).strip()

    def _first_song_from_results(self, results: Any, seen: set[tuple[str, str]]):
        if not isinstance(results, dict):
            return None
        for source_results in results.values():
            if not isinstance(source_results, list):
                continue
            for song in source_results:
                identity = self._song_identity(song)
                if not identity[0] or identity in seen:
                    continue
                return song
        return None

    def recommend_songs(self, music_client, base_songs: list[Any], max_count: int | None = None) -> list[tuple[Any, dict[str, str]]]:
        max_count = max(0, int(max_count or self.recommendation_limit))
        if max_count <= 0 or not base_songs:
            return []

        seen = {identity for identity in (self._song_identity(song) for song in base_songs) if identity[0]}
        seed_meta: list[dict[str, Any]] = []
        for song in base_songs[: self.recommendation_seed_limit]:
            seed = self._seed_from_song(song)
            if not seed:
                continue
            looked_up = self._musicbrainz_lookup_seed(seed)
            seed_meta.append(looked_up or seed)

        candidates = self._listenbrainz_recommendations()
        enriched_candidates: list[dict[str, str]] = []
        for candidate in candidates:
            if candidate.get("title"):
                enriched_candidates.append(candidate)
                continue
            by_mbid = self._recording_by_mbid(candidate.get("recording_mbid", ""))
            if by_mbid:
                by_mbid["source"] = "ListenBrainz"
                enriched_candidates.append(by_mbid)
        if not enriched_candidates:
            enriched_candidates = self._musicbrainz_fallback_recommendations(seed_meta)

        recommendations: list[tuple[Any, dict[str, str]]] = []
        candidate_seen: set[tuple[str, str]] = set()
        reason_seed = self._text(seed_meta[0].get("title")) if seed_meta else "这首歌"
        for candidate in enriched_candidates:
            title = self._normalize_text(candidate.get("title", ""))
            artist = self._normalize_text(candidate.get("artist", ""))
            candidate_identity = (title, artist)
            if not title or candidate_identity in candidate_seen or candidate_identity in seen:
                continue
            candidate_seen.add(candidate_identity)
            query = self._recommendation_query(candidate)
            if not query:
                continue
            try:
                resolved = self._first_song_from_results(music_client.search(keyword=query), seen)
            except Exception:
                resolved = None
            if resolved is None:
                continue
            resolved_identity = self._song_identity(resolved)
            if not resolved_identity[0] or resolved_identity in seen:
                continue
            seen.add(resolved_identity)
            recommendations.append(
                (
                    resolved,
                    {
                        "is_recommendation": True,
                        "recommendation_reason": f"因为你搜索了 {reason_seed}，为你推荐相似歌曲",
                        "recommendation_source": candidate.get("source") or "MusicBrainz",
                    },
                )
            )
            if len(recommendations) >= max_count:
                break
        return recommendations

    def download(self, music_client, song_infos):
        music_client.download(song_infos=song_infos)

    def get_file_format(self, song_info):
        format_fields = ["format", "ext", "file_format", "type"]
        for field in format_fields:
            if field in song_info and song_info[field]:
                return str(song_info[field]).upper()

        if "download_url" in song_info and song_info["download_url"]:
            url = song_info["download_url"].lower()
            if ".mp3" in url:
                return "MP3"
            if ".flac" in url:
                return "FLAC"
            if ".wav" in url:
                return "WAV"
            if ".m4a" in url:
                return "M4A"
            if ".aac" in url:
                return "AAC"
        return "未知"

    def get_album_image_url(self, song_info):
        image_fields = [
            "cover",
            "album_cover",
            "pic",
            "picture",
            "img",
            "image",
            "album_img",
            "album_pic",
            "cover_url",
            "pic_url",
        ]
        for field in image_fields:
            if field in song_info and song_info[field]:
                url = str(song_info[field])
                if url.startswith("http"):
                    return url
        return ""

    def count_downloaded_files(self, save_dir):
        source_counts = {}
        if not os.path.isdir(save_dir):
            return source_counts

        for item in os.listdir(save_dir):
            item_path = os.path.join(save_dir, item)
            if os.path.isdir(item_path) and item in self.source_map_en_to_cn:
                file_count = 0
                for filename in os.listdir(item_path):
                    file_path = os.path.join(item_path, filename)
                    if os.path.isfile(file_path):
                        file_count += 1
                if file_count > 0:
                    source_counts[self.source_map_en_to_cn[item]] = {
                        "path": item_path,
                        "count": file_count,
                    }
        return source_counts

    def _get_unique_target_path(self, target_path):
        if not os.path.exists(target_path):
            return target_path

        base, ext = os.path.splitext(target_path)
        index = 1
        while True:
            candidate = f"{base} ({index}){ext}"
            if not os.path.exists(candidate):
                return candidate
            index += 1

    def list_audio_files(self, save_dir):
        allowed_exts = {".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".oga", ".aiff", ".wma"}
        files = []
        if not os.path.isdir(save_dir):
            return files
        for root, _, filenames in os.walk(save_dir):
            for filename in filenames:
                ext = os.path.splitext(filename)[1].lower()
                if ext in allowed_exts:
                    files.append(os.path.join(root, filename))
        return files

    def _sanitize_filename(self, text):
        cleaned = re.sub(r"[\\/:*?\"<>|]", " ", str(text or "")).strip()
        cleaned = re.sub(r"\s+", " ", cleaned)
        return cleaned

    def _strip_trailing_track_id(self, base_name):
        """仅在「两段式：歌名 - 疑似曲目 ID」时去掉尾部 ID，避免破坏「歌名 - 歌手 - 专辑」。"""
        raw_name = (base_name or "").strip()
        parts = [part.strip() for part in raw_name.split(" - ") if part.strip()]
        if len(parts) != 2:
            return raw_name
        if re.fullmatch(r"[0-9A-Za-z]{8,}", parts[1]):
            return parts[0]
        return raw_name

    def resolve_rename_fields(self, song_info) -> dict[str, str]:
        """从搜索结果 raw_data 还原 QQ 等源的完整歌名/歌手/专辑，避免解析链上字段不全。"""
        source = str(self._song_get(song_info, "source") or "")
        search_result = self._extract_raw_search_result(song_info)
        if source == "QQMusicClient" and isinstance(search_result, dict):
            meta = self._qq_search_meta(search_result)
            return {
                "song_name": str(meta.get("song_name") or ""),
                "singers": str(meta.get("singers") or ""),
                "album": str(meta.get("album") or ""),
            }

        song_name = self._song_get(song_info, "song_name") or ""
        singers = self._song_get(song_info, "singers") or ""
        if isinstance(singers, list):
            singers = "、".join(str(x) for x in singers[:4])
        album = self._song_get(song_info, "album") or ""
        return {"song_name": str(song_name), "singers": str(singers), "album": str(album)}

    def _read_embedded_track_meta(self, file_path: str) -> dict[str, str]:
        """musicdl 写入的 FLAC/MP3 内嵌标签（Windows 属性里看到的歌手/专辑）。"""
        if not MUTAGEN_AVAILABLE or not os.path.isfile(file_path):
            return {}
        try:
            audio = MutagenFile(file_path)
        except Exception:
            return {}
        if audio is None:
            return {}

        tags = getattr(audio, "tags", None)

        def pick(*wanted_upper: str) -> str:
            if not tags:
                return ""
            for w in wanted_upper:
                for k in list(tags.keys()):
                    if str(k).upper() == w.upper():
                        val = tags[k]
                        if isinstance(val, (list, tuple)):
                            val = val[0]
                        s = str(val).strip()
                        if s:
                            return s
            return ""

        # Vorbis (FLAC): TITLE / ARTIST / ALBUM；ID3: TIT2 / TPE1 / TALB
        title = pick("TITLE", "TIT2")
        artist = pick("ARTIST", "TPE1", "ALBUMARTIST", "TPE2")
        album = pick("ALBUM", "TALB")
        return {"song_name": title, "singers": artist, "album": album}

    def rename_file_with_song_meta(self, file_path, song_info):
        if not os.path.isfile(file_path):
            return ""

        directory = os.path.dirname(file_path)
        old_stem, ext = os.path.splitext(file_path)
        fields = self.resolve_rename_fields(song_info)
        embedded = self._read_embedded_track_meta(file_path)
        merged = {
            "song_name": (fields.get("song_name") or "").strip() or embedded.get("song_name", ""),
            "singers": (fields.get("singers") or "").strip() or embedded.get("singers", ""),
            "album": (fields.get("album") or "").strip() or embedded.get("album", ""),
        }
        song_name = self._sanitize_filename(merged.get("song_name", ""))
        singers_text = self._sanitize_filename(merged.get("singers") or "")
        album = self._sanitize_filename(merged.get("album", ""))

        pieces = [p for p in [song_name, singers_text, album] if p]
        if not pieces:
            return file_path

        new_name = " - ".join(pieces) + ext.lower()
        target = os.path.join(directory, new_name)
        target = self._get_unique_target_path(target)
        if os.path.abspath(target) == os.path.abspath(file_path):
            return file_path
        shutil.move(file_path, target)

        # 同步重命名同名歌词文件，确保本地播放可自动匹配
        old_lrc = f"{old_stem}.lrc"
        if os.path.isfile(old_lrc):
            new_lrc = f"{os.path.splitext(target)[0]}.lrc"
            new_lrc = self._get_unique_target_path(new_lrc)
            shutil.move(old_lrc, new_lrc)
        return target

    def normalize_audio_filenames(self, save_dir):
        changed = 0
        for file_path in self.list_audio_files(save_dir):
            directory = os.path.dirname(file_path)
            base_name, ext = os.path.splitext(os.path.basename(file_path))
            old_stem = os.path.splitext(file_path)[0]
            new_base = self._strip_trailing_track_id(base_name)
            new_base = self._sanitize_filename(new_base) or "未知歌曲"
            new_target = os.path.join(directory, f"{new_base}{ext.lower()}")
            if os.path.abspath(new_target) == os.path.abspath(file_path):
                continue
            new_target = self._get_unique_target_path(new_target)
            shutil.move(file_path, new_target)

            old_lrc = f"{old_stem}.lrc"
            if os.path.isfile(old_lrc):
                new_lrc = f"{os.path.splitext(new_target)[0]}.lrc"
                new_lrc = self._get_unique_target_path(new_lrc)
                shutil.move(old_lrc, new_lrc)
            changed += 1
        return changed

    def flatten_downloaded_files(self, save_dir):
        moved_count = 0
        if not os.path.isdir(save_dir):
            return moved_count

        allowed_exts = {".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".lrc"}
        for item in os.listdir(save_dir):
            item_path = os.path.join(save_dir, item)
            if not os.path.isdir(item_path):
                continue

            # 只处理 musicdl 生成的来源子目录，避免误搬用户自己的文件夹
            if item not in self.source_map_en_to_cn:
                continue

            for root, _, files in os.walk(item_path):
                for filename in files:
                    src_file = os.path.join(root, filename)
                    ext = os.path.splitext(filename)[1].lower()
                    if ext not in allowed_exts:
                        continue

                    target_file = os.path.join(save_dir, filename)
                    target_file = self._get_unique_target_path(target_file)
                    shutil.move(src_file, target_file)
                    moved_count += 1

            # 清理空目录（含多层）
            for root, dirs, files in os.walk(item_path, topdown=False):
                if not dirs and not files:
                    os.rmdir(root)

        return moved_count

    def count_all_downloaded_files(self, save_dir):
        if not os.path.isdir(save_dir):
            return 0

        file_count = 0
        for filename in os.listdir(save_dir):
            file_path = os.path.join(save_dir, filename)
            if os.path.isfile(file_path):
                file_count += 1
        return file_count

    def get_embedded_cover(self, file_path: str) -> dict[str, Any] | None:
        if not MUTAGEN_AVAILABLE or not os.path.isfile(file_path):
            return None

        try:
            audio = MutagenFile(file_path)
            if audio is None:
                return None

            tags = getattr(audio, "tags", None)
            if not tags:
                return None

            # MP3/ID3
            apic_frames = []
            if hasattr(tags, "getall"):
                apic_frames = tags.getall("APIC")
            if apic_frames:
                frame = apic_frames[0]
                data = getattr(frame, "data", None)
                mime = getattr(frame, "mime", "image/jpeg")
                if data:
                    return {"data": data, "mime": mime or "image/jpeg"}

            # FLAC
            pictures = getattr(audio, "pictures", None) or []
            if pictures:
                pic = pictures[0]
                data = getattr(pic, "data", None)
                mime = getattr(pic, "mime", "image/jpeg")
                if data:
                    return {"data": data, "mime": mime or "image/jpeg"}

            # MP4/M4A (covr)
            covr = None
            if hasattr(tags, "get"):
                covr = tags.get("covr")
            if covr:
                cover_item = covr[0]
                data = bytes(cover_item)
                imageformat = getattr(cover_item, "imageformat", None)
                mime = "image/png" if str(imageformat).endswith("PNG") else "image/jpeg"
                if data:
                    return {"data": data, "mime": mime}

            # OGG/OPUS: 优先 FLAC 风格 METADATA_BLOCK_PICTURE（base64）
            for key in ("metadata_block_picture", "METADATA_BLOCK_PICTURE"):
                values = tags.get(key) if hasattr(tags, "get") else None
                if not values:
                    continue
                raw = values[0]
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", errors="ignore")
                try:
                    pic_data = base64.b64decode(str(raw))
                    # 跳过 FLAC picture 头并提取 mime（格式见 FLAC metadata block）
                    if len(pic_data) > 32:
                        mime_len = int.from_bytes(pic_data[4:8], byteorder="big", signed=False)
                        mime_start = 8
                        mime_end = mime_start + mime_len
                        mime = pic_data[mime_start:mime_end].decode("utf-8", errors="ignore") or "image/jpeg"
                        desc_len_start = mime_end
                        desc_len_end = desc_len_start + 4
                        desc_len = int.from_bytes(pic_data[desc_len_start:desc_len_end], "big", signed=False)
                        # type(4)+mime_len(4)+mime+desc_len(4)+desc+width(4)+height(4)+depth(4)+colors(4)+data_len(4)+data
                        data_len_pos = desc_len_end + desc_len + 16
                        data_len_end = data_len_pos + 4
                        if data_len_end <= len(pic_data):
                            data_len = int.from_bytes(pic_data[data_len_pos:data_len_end], "big", signed=False)
                            data_start = data_len_end
                            data_end = data_start + data_len
                            if data_end <= len(pic_data):
                                return {"data": pic_data[data_start:data_end], "mime": mime}
                except Exception:
                    pass

            # OGG 兼容字段（coverart base64 + coverartmime）
            coverart = tags.get("coverart") if hasattr(tags, "get") else None
            if coverart:
                raw = coverart[0]
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", errors="ignore")
                try:
                    data = base64.b64decode(str(raw))
                    mime_list = tags.get("coverartmime") if hasattr(tags, "get") else None
                    mime = mime_list[0] if mime_list else "image/jpeg"
                    if data:
                        return {"data": data, "mime": str(mime)}
                except Exception:
                    pass

            # ASF/WMA
            asf_pictures = tags.get("WM/Picture") if hasattr(tags, "get") else None
            if asf_pictures:
                for pic in asf_pictures:
                    data = getattr(pic, "data", None)
                    mime = getattr(pic, "mime", "image/jpeg")
                    if data:
                        return {"data": data, "mime": mime or "image/jpeg"}
        except Exception:
            return None

        return None
