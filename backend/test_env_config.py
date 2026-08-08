import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.env_config import load_app_env


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


if __name__ == "__main__":
    unittest.main()
