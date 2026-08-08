import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.env_config import load_app_env, read_app_env, write_app_env


class EnvConfigTests(unittest.TestCase):
    def test_loads_env_without_overriding_existing_values(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            env_path.write_text(
                "MUSIC_PLAYER_TEST_NEW='from-file'\n"
                "MUSIC_PLAYER_TEST_EXISTING=from-file\n",
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {
                    "MUSIC_PLAYER_ENV_FILE": str(env_path),
                    "MUSIC_PLAYER_TEST_EXISTING": "from-system",
                },
                clear=False,
            ):
                os.environ.pop("MUSIC_PLAYER_TEST_NEW", None)
                loaded = load_app_env()
                self.assertEqual(loaded, env_path.resolve())
                self.assertEqual(os.environ["MUSIC_PLAYER_TEST_NEW"], "from-file")
                self.assertEqual(os.environ["MUSIC_PLAYER_TEST_EXISTING"], "from-system")
                os.environ.pop("MUSIC_PLAYER_TEST_NEW", None)

    def test_override_reloads_changed_file_value(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            env_path.write_text("MUSIC_PLAYER_TEST_RELOAD=from-file\n", encoding="utf-8")
            with patch.dict(
                os.environ,
                {
                    "MUSIC_PLAYER_ENV_FILE": str(env_path),
                    "MUSIC_PLAYER_TEST_RELOAD": "stale-value",
                },
                clear=False,
            ):
                load_app_env(override=True)
                self.assertEqual(os.environ["MUSIC_PLAYER_TEST_RELOAD"], "from-file")

    def test_write_preserves_comments_and_unrelated_values(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            env_path.write_text("# local settings\nOTHER_SETTING=keep\nALI_TRANSLATE_API_KEY=old\n", encoding="utf-8")
            write_app_env(
                {
                    "ALI_TRANSLATE_API_KEY": "new-key",
                    "DEEPSEEK_API_KEY": "deep-key",
                },
                env_path,
            )
            content = env_path.read_text(encoding="utf-8")
            values = read_app_env(env_path)
            self.assertIn("# local settings", content)
            self.assertEqual(values["OTHER_SETTING"], "keep")
            self.assertEqual(values["ALI_TRANSLATE_API_KEY"], "new-key")
            self.assertEqual(values["DEEPSEEK_API_KEY"], "deep-key")


if __name__ == "__main__":
    unittest.main()
