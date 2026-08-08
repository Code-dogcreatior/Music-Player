import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.app import (
    is_translation_cache_usable,
    resolve_lyrics_request,
    translate_lrc_to_zh,
)


def _lrc(lines: list[str]) -> str:
    return "\n".join(f"[00:{index:02d}.000]{text}" for index, text in enumerate(lines)) + "\n"


class TranslationCacheTests(unittest.TestCase):
    def test_reuses_cache_when_a_few_names_remain_in_source_language(self):
        source = _lrc([f"English line {index}" for index in range(10)])
        translated = _lrc(["English line 0", "English line 1"] + [f"中文译文{index}" for index in range(2, 10)])
        self.assertTrue(is_translation_cache_usable(source, translated))

    def test_rejects_cache_that_is_only_a_copy_of_the_source(self):
        source = _lrc([f"English line {index}" for index in range(10)])
        self.assertFalse(is_translation_cache_usable(source, source))

    def test_existing_local_path_wins_over_inline_lyrics(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            lyric_path = Path(temp_dir) / "song.lrc"
            lyric_path.write_text("[00:00.000]from local file\n", encoding="utf-8")
            raw, resolved_path = resolve_lyrics_request(
                lyric_path=str(lyric_path),
                inline_lyrics="[00:00.000]from inline field\n",
            )
            self.assertIn("from local file", raw)
            self.assertEqual(resolved_path, str(lyric_path))

    def test_total_provider_failure_raises_instead_of_returning_source_copy(self):
        source = _lrc(["English line one", "English line two"])
        with patch("backend.app.translate_line_to_zh", side_effect=RuntimeError("provider unavailable")):
            with self.assertRaisesRegex(RuntimeError, "全部失败"):
                translate_lrc_to_zh(source, "dp")


if __name__ == "__main__":
    unittest.main()
