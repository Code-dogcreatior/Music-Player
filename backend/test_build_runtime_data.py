import tempfile
import unittest
from pathlib import Path

from build import preserve_packaged_runtime_data


class BuildRuntimeDataTests(unittest.TestCase):
    def test_packaged_songs_and_database_are_restored_after_output_rebuild(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "dist" / "music-server"
            songs_dir = output_dir / "已下载音乐"
            songs_dir.mkdir(parents=True)
            song_file = songs_dir / "song.flac"
            song_file.write_bytes(b"audio-data")
            database = output_dir / "music_player.sqlite3"
            database.write_bytes(b"database-data")

            with preserve_packaged_runtime_data(output_dir):
                self.assertFalse(songs_dir.exists())
                self.assertFalse(database.exists())
                output_dir.mkdir(parents=True, exist_ok=True)
                (output_dir / "music-server.exe").write_bytes(b"binary")

            self.assertEqual(song_file.read_bytes(), b"audio-data")
            self.assertEqual(database.read_bytes(), b"database-data")
            self.assertTrue((output_dir / "music-server.exe").is_file())

    def test_runtime_data_is_restored_when_build_fails(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "dist" / "music-server"
            songs_dir = output_dir / "已下载音乐"
            songs_dir.mkdir(parents=True)
            song_file = songs_dir / "song.mp3"
            song_file.write_bytes(b"keep-me")

            with self.assertRaisesRegex(RuntimeError, "build failed"):
                with preserve_packaged_runtime_data(output_dir):
                    raise RuntimeError("build failed")

            self.assertEqual(song_file.read_bytes(), b"keep-me")


if __name__ == "__main__":
    unittest.main()
