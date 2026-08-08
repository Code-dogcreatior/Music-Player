import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from backend.music_service import MusicService


class MusicSourceFallbackTests(unittest.TestCase):
    def setUp(self):
        self.service = MusicService()

    def test_qq_tang_fallback_uses_single_timeout_and_returns_audio(self):
        response = Mock()
        response.json.return_value = {
            "song_play_url_sq": "https://example.com/song.flac",
        }
        client = SimpleNamespace(
            source="QQMusicClient",
            get=Mock(return_value=response),
            audio_link_tester=SimpleNamespace(
                test=Mock(
                    return_value={
                        "ok": True,
                        "ext": "flac",
                        "file_size_bytes": 123,
                        "file_size": "123 B",
                        "download_url": "https://example.com/song.flac",
                    }
                )
            ),
        )

        song = self.service._parse_qq_tang(
            client,
            {
                "mid": "song-mid",
                "title": "歌曲",
                "singer": [{"name": "歌手"}],
                "album": {"title": "专辑", "mid": "album-mid"},
                "interval": 180,
            },
            {"timeout": 3, "headers": {"X-Old": "ignored"}},
        )

        self.assertTrue(song.with_valid_download_url)
        self.assertEqual(song.audio_parse_source, "QQ音乐/tang")
        _, kwargs = client.get.call_args
        self.assertEqual(kwargs["timeout"], 3)
        self.assertNotIn("X-Old", kwargs["headers"])

    def test_kuwo_prefers_https_third_party_fallback(self):
        expected = SimpleNamespace(
            with_valid_download_url=True,
            download_url="https://example.com/song.flac",
        )
        kuwo = SimpleNamespace(
            source="KuwoMusicClient",
            _parsewiththirdpartapis=Mock(),
            _parsewithnxinxzapi=Mock(return_value=expected),
            _parsewithhaitangwapi=Mock(),
        )
        music_client = SimpleNamespace(music_clients={"KuwoMusicClient": kuwo})

        self.service._tune_kuwo_client(music_client)
        actual = kuwo._parsewiththirdpartapis({"MUSICRID": "MUSIC_1"}, {"timeout": 1})

        self.assertIs(actual, expected)
        kuwo._parsewithnxinxzapi.assert_called_once_with({"MUSICRID": "MUSIC_1"}, {})
        kuwo._parsewithhaitangwapi.assert_not_called()

    @patch("backend.music_service.musicdl.MusicClient")
    def test_qq_search_uses_parallel_single_item_pages(self, music_client_cls):
        music_client_cls.return_value.music_clients = {}

        self.service.init_music_client(
            selected_sources=["QQMusicClient"],
            limit=10,
            save_dir=".",
        )

        kwargs = music_client_cls.call_args.kwargs
        qq_config = kwargs["init_music_clients_cfg"]["QQMusicClient"]
        self.assertEqual(qq_config["search_size_per_source"], 10)
        self.assertEqual(qq_config["search_size_per_page"], 1)
        self.assertEqual(kwargs["clients_threadings"]["QQMusicClient"], 8)

    def test_sources_follow_composite_ranking(self):
        self.assertEqual(
            list(self.service.source_map_cn_to_en),
            [
                "QQ音乐",
                "酷我音乐",
                "网易云音乐",
                "咪咕音乐",
                "波点音乐",
                "5sing",
                "哔哩哔哩",
                "Deezer",
                "Suno",
            ],
        )


if __name__ == "__main__":
    unittest.main()
