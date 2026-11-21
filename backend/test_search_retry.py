"""搜索空结果自动重试，以及超时/重试次数上报的单元测试。"""

import time
import unittest
from unittest.mock import Mock, patch

from backend import app as backend_app


def _payload(**overrides):
    data = {
        "keyword": "张国荣",
        "search_type": "搜索歌曲",
        "selected_sources": ["QQMusicClient"],
        "limit": 10,
        "save_dir": ".",
    }
    data.update(overrides)
    return backend_app.SearchPayload(**data)


class SourceSearchRetryTests(unittest.TestCase):
    """QQ 等源会因第三方解析抖动返回 0 首，这里验证「空结果才重试」。"""

    def setUp(self):
        self.payload = _payload()
        self.deadline = time.perf_counter() + 60

    @patch("backend.app.service")
    def test_retries_once_when_first_attempt_is_empty(self, service):
        service.init_music_client.return_value = Mock()
        service.search.side_effect = [[], [{"song_name": "沉默是金"}]]

        source, results, attempts = backend_app._run_source_search(
            self.payload, "QQMusicClient", self.deadline
        )

        self.assertEqual(source, "QQMusicClient")
        self.assertEqual(attempts, 2)
        self.assertEqual(len(results), 1)
        self.assertEqual(service.search.call_count, 2)

    @patch("backend.app.service")
    def test_does_not_retry_when_first_attempt_has_results(self, service):
        service.init_music_client.return_value = Mock()
        service.search.return_value = [{"song_name": "当年情"}]

        _, results, attempts = backend_app._run_source_search(
            self.payload, "QQMusicClient", self.deadline
        )

        self.assertEqual(attempts, 1)
        self.assertEqual(len(results), 1)
        self.assertEqual(service.search.call_count, 1)

    @patch("backend.app.service")
    def test_returns_empty_when_all_attempts_are_empty(self, service):
        service.init_music_client.return_value = Mock()
        service.search.side_effect = [[], []]

        _, results, attempts = backend_app._run_source_search(
            self.payload, "QQMusicClient", self.deadline
        )

        self.assertEqual(attempts, 2)
        self.assertEqual(results, [])
        self.assertEqual(service.search.call_count, 2)

    @patch("backend.app.service")
    def test_skips_retry_when_time_budget_is_exhausted(self, service):
        service.init_music_client.return_value = Mock()
        service.search.side_effect = [[], [{"song_name": "不该出现"}]]

        _, results, attempts = backend_app._run_source_search(
            self.payload, "QQMusicClient", time.perf_counter() - 1
        )

        self.assertEqual(attempts, 1)
        self.assertEqual(results, [])
        self.assertEqual(service.search.call_count, 1)

    @patch("backend.app.MAX_SOURCE_SEARCH_ATTEMPTS", 1)
    @patch("backend.app.service")
    def test_max_attempts_one_disables_retry(self, service):
        """MP_SEARCH_MAX_ATTEMPTS=1 时应退回修复前行为，供灰测回滚。"""
        service.init_music_client.return_value = Mock()
        service.search.side_effect = [[], [{"song_name": "不该出现"}]]

        _, results, attempts = backend_app._run_source_search(
            self.payload, "QQMusicClient", self.deadline
        )

        self.assertEqual(attempts, 1)
        self.assertEqual(results, [])
        self.assertEqual(service.search.call_count, 1)

    @patch("backend.app.service")
    def test_dict_results_are_flattened_for_source(self, service):
        service.init_music_client.return_value = Mock()
        service.search.return_value = {
            "QQMusicClient": [{"song_name": "a"}, {"song_name": "b"}],
        }

        _, results, attempts = backend_app._run_source_search(
            self.payload, "QQMusicClient", self.deadline
        )

        self.assertEqual(attempts, 1)
        self.assertEqual(len(results), 2)

    @patch("backend.app.service")
    def test_raises_when_music_client_unavailable(self, service):
        service.init_music_client.return_value = None

        with self.assertRaises(RuntimeError):
            backend_app._run_source_search(self.payload, "QQMusicClient", self.deadline)


class SearchJobReportingTests(unittest.TestCase):
    """前端要靠 timed_out / source_attempts 区分「完整 / 截断 / 空」。"""

    def test_response_exposes_timed_out_and_source_attempts(self):
        job = backend_app.SearchJob(total_sources=1)
        job.set_source_attempts("QQMusicClient", 2)
        job.finish(time.perf_counter(), timed_out=True)

        response = job.to_response()

        self.assertTrue(response["timed_out"])
        self.assertEqual(response["source_attempts"], {"QQMusicClient": 2})

    def test_response_defaults_for_completed_job(self):
        job = backend_app.SearchJob(total_sources=1)
        job.finish(time.perf_counter(), timed_out=False)

        response = job.to_response()

        self.assertFalse(response["timed_out"])
        self.assertEqual(response["source_attempts"], {})
        self.assertEqual(response["status"], "finished")


if __name__ == "__main__":
    unittest.main()