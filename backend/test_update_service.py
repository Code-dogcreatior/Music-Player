import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from backend.update_service import UpdateManager, is_newer_version, normalize_version


class FakeResponse:
    def __init__(self, *, payload=None, content=b"", status_code=200, headers=None):
        self.payload = payload
        self.content = content
        self.status_code = status_code
        self.headers = headers or {"Content-Length": str(len(content))}
        self.text = content.decode("utf-8", errors="replace")

    def json(self):
        return self.payload

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests

            raise requests.HTTPError(f"HTTP {self.status_code}")

    def iter_content(self, chunk_size):
        for start in range(0, len(self.content), chunk_size):
            yield self.content[start : start + chunk_size]

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False


class UpdateServiceTests(unittest.TestCase):
    def test_semantic_version_comparison(self):
        self.assertEqual(normalize_version("v1.2.3"), "1.2.3")
        self.assertTrue(is_newer_version("v0.2.0", "0.1.9"))
        self.assertFalse(is_newer_version("v0.1.0", "0.1.0"))

    @patch("backend.update_service.requests.get")
    def test_check_uses_release_asset_digest(self, get_mock):
        get_mock.return_value = FakeResponse(
            payload={
                "tag_name": "v0.2.0",
                "html_url": "https://github.com/example/repo/releases/tag/v0.2.0",
                "body": "release notes",
                "published_at": "2026-08-08T00:00:00Z",
                "assets": [
                    {
                        "name": "music-player-windows-x64.zip",
                        "size": 123,
                        "browser_download_url": "https://example.invalid/update.zip",
                        "digest": f"sha256:{'a' * 64}",
                    }
                ],
            }
        )
        manager = UpdateManager(current_version="0.1.0", repository="example/repo", packaged_override=True)

        result = manager.public_check(force=True)

        self.assertTrue(result["update_available"])
        self.assertTrue(result["can_auto_update"])
        self.assertEqual(result["latest_version"], "0.2.0")
        self.assertNotIn("asset_url", result)
        self.assertNotIn("asset_sha256", result)

    @patch("backend.update_service.shutil.disk_usage")
    @patch("backend.update_service.requests.get")
    def test_download_rejects_checksum_mismatch(self, get_mock, disk_usage_mock):
        disk_usage_mock.return_value = Mock(free=10 * 1024 * 1024 * 1024)
        get_mock.return_value = FakeResponse(content=b"not-the-expected-package")
        with tempfile.TemporaryDirectory() as tmp:
            manager = UpdateManager(update_root=Path(tmp), packaged_override=True)
            manager._download_update(
                {
                    "latest_version": "0.2.0",
                    "asset_size": 24,
                    "asset_url": "https://example.invalid/update.zip",
                    "asset_sha256": "0" * 64,
                    "checksum_url": "",
                }
            )

            state = manager.status()
            self.assertEqual(state["status"], "failed")
            self.assertIn("SHA-256", state["error"])
            self.assertFalse(state["ready_to_install"])


if __name__ == "__main__":
    unittest.main()

