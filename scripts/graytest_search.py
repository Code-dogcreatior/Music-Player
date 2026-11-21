#!/usr/bin/env python3
"""
搜索灰测脚本：量化「空结果率 / 重试是否生效 / 耗时」并支持新旧对比。

背景：QQ 源会因上游第三方解析接口抖动而返回 0 首，且后端把 0 首当「搜索完成」，
前端于是显示空表格、用户只能手动再搜一次。修复内容见 backend/app.py 的
`_run_source_search`（空结果自动重试）与 `MP_SEARCH_JOB_TIMEOUT_SECONDS`（放宽超时）。

灰测用法：
  # 1) 基线：用修复前行为启动后端
  MP_SEARCH_MAX_ATTEMPTS=1 MP_SEARCH_JOB_TIMEOUT_SECONDS=12 \
    conda run --no-capture-output -n music python -m uvicorn backend.app:app --port 8000
  python scripts/graytest_search.py --rounds 10 --json baseline.json

  # 2) 修复后：默认参数启动后端
  conda run --no-capture-output -n music python -m uvicorn backend.app:app --port 8000
  python scripts/graytest_search.py --rounds 10 --json after.json

判定：整体空结果率高于 --max-empty-rate 时退出码为 1（便于脚本化放量/回滚判定）。
"""

import argparse
import json
import sys
import time
from typing import Any

import requests

DEFAULT_KEYWORDS = ["周杰伦", "张国荣", "Taylor Swift", "Beyond", "伍佰"]
DEFAULT_SAVE_DIR = "已下载音乐"


def fetch_default_save_dir(base_url: str) -> str:
    try:
        resp = requests.get(f"{base_url}/api/config", timeout=10)
        if resp.status_code == 200:
            return str(resp.json().get("default_save_dir") or DEFAULT_SAVE_DIR)
    except requests.RequestException:
        pass
    return DEFAULT_SAVE_DIR


def run_once(
    base_url: str,
    keyword: str,
    source: str,
    limit: int,
    save_dir: str,
    round_timeout: float,
    poll_interval: float,
) -> dict[str, Any]:
    started = time.perf_counter()
    payload = {
        "keyword": keyword,
        "search_type": "搜索歌曲",
        "selected_sources": [source],
        "limit": limit,
        "save_dir": save_dir,
    }
    resp = requests.post(f"{base_url}/api/search", json=payload, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    job_id = data.get("job_id") or ""
    status = data.get("status") or ""
    songs = len(data.get("songs") or [])
    timed_out = bool(data.get("timed_out"))
    attempts = data.get("source_attempts") or {}
    message = data.get("message") or ""

    while job_id and status not in ("finished", "failed"):
        if time.perf_counter() - started > round_timeout:
            return {
                "keyword": keyword,
                "status": "client_timeout",
                "songs": songs,
                "elapsed": time.perf_counter() - started,
                "timed_out": timed_out,
                "attempts": attempts,
                "message": "客户端等待超时",
            }
        time.sleep(poll_interval)
        detail = requests.get(f"{base_url}/api/search/{job_id}", timeout=30)
        if detail.status_code == 404:
            return {
                "keyword": keyword,
                "status": "lost",
                "songs": songs,
                "elapsed": time.perf_counter() - started,
                "timed_out": timed_out,
                "attempts": attempts,
                "message": "任务已被清理",
            }
        detail.raise_for_status()
        body = detail.json()
        status = body.get("status") or ""
        songs = len(body.get("songs") or [])
        timed_out = bool(body.get("timed_out"))
        attempts = body.get("source_attempts") or {}
        message = body.get("message") or ""

    return {
        "keyword": keyword,
        "status": status,
        "songs": songs,
        "elapsed": time.perf_counter() - started,
        "timed_out": timed_out,
        "attempts": attempts,
        "message": message,
    }


def percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(round(ratio * len(ordered) + 0.5)) - 1))
    return ordered[index]


def summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(records)
    empty = [r for r in records if r["songs"] == 0]
    retried = [r for r in records if any(int(v) > 1 for v in (r.get("attempts") or {}).values())]
    elapsed = [float(r["elapsed"]) for r in records]
    return {
        "rounds": total,
        "empty_rounds": len(empty),
        "empty_rate": (len(empty) / total) if total else 0.0,
        "success_rate": ((total - len(empty)) / total) if total else 0.0,
        "retry_rounds": len(retried),
        "retry_rate": (len(retried) / total) if total else 0.0,
        "timed_out_rounds": len([r for r in records if r.get("timed_out")]),
        "p50_elapsed": percentile(elapsed, 0.5),
        "p95_elapsed": percentile(elapsed, 0.95),
        "avg_songs": (sum(int(r["songs"]) for r in records) / total) if total else 0.0,
    }


def print_report(records: list[dict[str, Any]], max_empty_rate: float) -> dict[str, Any]:
    print()
    print("%-14s %-4s %-8s %6s %8s %8s  %s" % ("关键词", "轮次", "状态", "歌曲数", "耗时", "重试", "后端 message"))
    print("-" * 104)
    for idx, record in enumerate(records, start=1):
        attempts = record.get("attempts") or {}
        attempt_text = ",".join(str(v) for v in attempts.values()) or "-"
        print(
            "%-14s %-4d %-8s %6d %7.1fs %8s  %s"
            % (
                record["keyword"],
                idx,
                record["status"],
                record["songs"],
                record["elapsed"],
                attempt_text,
                (record.get("message") or "")[:40],
            )
        )

    print()
    print("=" * 104)
    overall = summarize(records)
    print("整体：%d 轮 | 空结果 %d 轮（空结果率 %.0f%%）| 成功率 %.0f%% | 重试触发 %d 轮 | 截断 %d 轮"
          % (
              overall["rounds"],
              overall["empty_rounds"],
              overall["empty_rate"] * 100,
              overall["success_rate"] * 100,
              overall["retry_rounds"],
              overall["timed_out_rounds"],
          ))
    print("耗时：p50 %.1fs | p95 %.1fs | 平均歌曲数 %.1f"
          % (overall["p50_elapsed"], overall["p95_elapsed"], overall["avg_songs"]))

    keywords = sorted({r["keyword"] for r in records})
    for keyword in keywords:
        subset = [r for r in records if r["keyword"] == keyword]
        stats = summarize(subset)
        print("  %-14s 空结果率 %3.0f%% | 成功率 %3.0f%% | 重试 %d/%d | p95 %.1fs"
              % (
                  keyword,
                  stats["empty_rate"] * 100,
                  stats["success_rate"] * 100,
                  stats["retry_rounds"],
                  stats["rounds"],
                  stats["p95_elapsed"],
              ))

    verdict = "通过" if overall["empty_rate"] <= max_empty_rate else "未通过"
    print("判定：空结果率 %.0f%% %s 阈值 %.0f%% → %s"
          % (overall["empty_rate"] * 100, "<=" if verdict == "通过" else ">", max_empty_rate * 100, verdict))
    return overall


def main() -> int:
    parser = argparse.ArgumentParser(description="搜索灰测：空结果率与耗时对比")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--keyword", action="append", dest="keywords", help="可重复；默认覆盖 5 个代表性关键词")
    parser.add_argument("--rounds", type=int, default=10, help="每个关键词重复次数")
    parser.add_argument("--source", default="QQMusicClient")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--save-dir", default="")
    parser.add_argument("--json", dest="json_path", default="", help="把逐轮结果与汇总写入该文件")
    parser.add_argument("--max-empty-rate", type=float, default=0.2, help="空结果率阈值，超过则退出码 1")
    parser.add_argument("--round-timeout", type=float, default=120.0)
    parser.add_argument("--poll-interval", type=float, default=0.5)
    args = parser.parse_args()

    keywords = args.keywords or DEFAULT_KEYWORDS
    save_dir = args.save_dir or fetch_default_save_dir(args.base_url)
    print(f"灰测目标：{args.base_url} | 源：{args.source} | 关键词：{'、'.join(keywords)} | 每词 {args.rounds} 轮")
    print(f"保存目录：{save_dir}")

    records: list[dict[str, Any]] = []
    try:
        for keyword in keywords:
            for _ in range(args.rounds):
                records.append(
                    run_once(
                        args.base_url,
                        keyword,
                        args.source,
                        args.limit,
                        save_dir,
                        args.round_timeout,
                        args.poll_interval,
                    )
                )
    except requests.RequestException as exc:
        print(f"请求失败，灰测中断：{exc}", file=sys.stderr)
        return 2

    overall = print_report(records, args.max_empty_rate)

    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "meta": {
                        "base_url": args.base_url,
                        "source": args.source,
                        "rounds_per_keyword": args.rounds,
                        "keywords": keywords,
                        "finished_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                    },
                    "overall": overall,
                    "records": records,
                },
                handle,
                ensure_ascii=False,
                indent=2,
            )
        print(f"已写入 {args.json_path}")

    return 1 if overall["empty_rate"] > args.max_empty_rate else 0


if __name__ == "__main__":
    sys.exit(main())