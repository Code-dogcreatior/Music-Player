"""阿里云百炼 vs DeepSeek 并发压测脚本

用法（使用 translate 环境）：
    D:\\Anaconda\\envs\\translate\\python.exe backend\\test_translate_concurrency.py

可选参数：
    --provider ali|dp|both        默认 both
    --levels 1,5,10,15,20,30,50   并发档位
    --samples 30                   每档发送的请求数
    --timeout 30                   单请求超时秒数

测试目的：
    1. 找出阿里云百炼网关层是否对当前 API Key 有并发限制
    2. 对比 ali 与 deepseek 在相同并发下的实际吞吐 / 延迟
    3. 给出推荐的 max_workers（建议 15-20）
"""
from __future__ import annotations

import argparse
import os
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

import requests


ALI_API_KEY = os.getenv("ALI_TRANSLATE_API_KEY", "").strip()
ALI_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
ALI_MODEL = os.getenv("ALI_TRANSLATE_MODEL") or "deepseek-v4-flash"

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "").strip()
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_TRANSLATE_MODEL") or "deepseek-v4-flash"


SAMPLE_LINES = [
    "I see the light in your eyes",
    "Take me back to the place where we used to dance",
    "Every breath I take reminds me of you",
    "The moonlight whispers softly through the trees",
    "We were dreamers chasing fading stars",
    "Tell me how to let your memory go",
    "All the words I never said still haunt me",
    "Holding on too tight, but I can't let go",
    "Your laughter echoes down the empty hall",
    "I would walk a thousand miles to find you",
    "Lost inside this melody of broken hearts",
    "Time will fade but love stays here forever",
    "The city sleeps beneath a velvet sky",
    "Promise me you'll never leave my side",
    "Fragments of yesterday slip through my hands",
    "The rain keeps falling on a Sunday afternoon",
    "I built a fortress out of all my fears",
    "Your shadow lingers on the bedroom wall",
    "Dancing slowly to the songs we knew by heart",
    "Tomorrow comes but you are still not here",
    "Stars collide and burn the indigo night",
    "Carry me home before the sunrise",
    "Whispers of regret inside the morning fog",
    "I traced your name across the frozen glass",
    "Heartbeats fading like an old cassette",
    "Silver threads of hope around my wrist",
    "Maybe we were never meant to stay",
    "The ocean knows the secrets that we keep",
    "Footsteps echo where the silence grew",
    "We are flames against an endless dark",
]


@dataclass
class CallResult:
    ok: bool
    latency: float
    status_code: int = 0
    error: str = ""


@dataclass
class LevelStats:
    concurrency: int
    samples: int
    wall_time: float
    success: int
    failed: int
    rate_limited: int
    latencies: list[float] = field(default_factory=list)
    errors: dict[str, int] = field(default_factory=dict)

    @property
    def throughput(self) -> float:
        return self.success / self.wall_time if self.wall_time > 0 else 0.0

    @property
    def avg_latency(self) -> float:
        return statistics.mean(self.latencies) if self.latencies else 0.0

    @property
    def p50(self) -> float:
        return statistics.median(self.latencies) if self.latencies else 0.0

    @property
    def p95(self) -> float:
        if not self.latencies:
            return 0.0
        ordered = sorted(self.latencies)
        idx = max(0, int(len(ordered) * 0.95) - 1)
        return ordered[idx]


def call_ali(text: str, timeout: float) -> CallResult:
    start = time.perf_counter()
    try:
        resp = requests.post(
            ALI_URL,
            headers={
                "Authorization": f"Bearer {ALI_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": ALI_MODEL,
                "messages": [
                    {
                        "role": "system",
                        "content": "Translate the user's single lyric line into natural Simplified Chinese only. No explanation, no quotes, no original text.",
                    },
                    {"role": "user", "content": text},
                ],
                "extra_body": {"enable_thinking": False},
            },
            timeout=timeout,
        )
        latency = time.perf_counter() - start
        if resp.status_code == 200:
            return CallResult(ok=True, latency=latency, status_code=200)
        return CallResult(
            ok=False,
            latency=latency,
            status_code=resp.status_code,
            error=resp.text[:200],
        )
    except requests.Timeout:
        return CallResult(ok=False, latency=time.perf_counter() - start, error="timeout")
    except Exception as exc:
        return CallResult(ok=False, latency=time.perf_counter() - start, error=str(exc)[:200])


def call_deepseek(text: str, timeout: float) -> CallResult:
    start = time.perf_counter()
    try:
        resp = requests.post(
            DEEPSEEK_URL,
            headers={
                "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": DEEPSEEK_MODEL,
                "messages": [
                    {
                        "role": "system",
                        "content": "Translate the user's single lyric line into natural Simplified Chinese only. No explanation, no quotes, no original text.",
                    },
                    {"role": "user", "content": text},
                ],
                "thinking": {"type": "disabled"},
                "temperature": 0.2,
                "stream": False,
            },
            timeout=timeout,
        )
        latency = time.perf_counter() - start
        if resp.status_code == 200:
            return CallResult(ok=True, latency=latency, status_code=200)
        return CallResult(
            ok=False,
            latency=latency,
            status_code=resp.status_code,
            error=resp.text[:200],
        )
    except requests.Timeout:
        return CallResult(ok=False, latency=time.perf_counter() - start, error="timeout")
    except Exception as exc:
        return CallResult(ok=False, latency=time.perf_counter() - start, error=str(exc)[:200])


def run_level(provider: str, concurrency: int, samples: int, timeout: float) -> LevelStats:
    caller = call_ali if provider == "ali" else call_deepseek
    texts = [SAMPLE_LINES[i % len(SAMPLE_LINES)] for i in range(samples)]

    stats = LevelStats(concurrency=concurrency, samples=samples, wall_time=0.0, success=0, failed=0, rate_limited=0)
    print(f"  [{provider}] 并发={concurrency:>2} 启动 {samples} 个请求...", flush=True)
    wall_start = time.perf_counter()
    completed = 0
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(caller, t, timeout) for t in texts]
        for fut in as_completed(futures):
            res: CallResult = fut.result()
            completed += 1
            if res.ok:
                stats.success += 1
                stats.latencies.append(res.latency)
            else:
                stats.failed += 1
                key = f"{res.status_code or 'EXC'}: {res.error[:80]}" if res.error else str(res.status_code)
                stats.errors[key] = stats.errors.get(key, 0) + 1
                if res.status_code == 429 or "rate" in res.error.lower() or "limit" in res.error.lower() or "throttl" in res.error.lower():
                    stats.rate_limited += 1
            elapsed = time.perf_counter() - wall_start
            tag = "OK " if res.ok else f"ERR{res.status_code}"
            print(
                f"    {completed:>3}/{samples}  {tag}  lat={res.latency:5.2f}s  cum={elapsed:6.2f}s",
                flush=True,
            )
    stats.wall_time = time.perf_counter() - wall_start
    return stats


def print_level(provider: str, stats: LevelStats) -> None:
    print(
        f"  [{provider:>3}] 并发={stats.concurrency:>2}  样本={stats.samples:>3}  "
        f"耗时={stats.wall_time:6.2f}s  吞吐={stats.throughput:5.2f} req/s  "
        f"成功={stats.success:>3}  失败={stats.failed:>3}  限流={stats.rate_limited:>3}  "
        f"avg={stats.avg_latency:5.2f}s  p50={stats.p50:5.2f}s  p95={stats.p95:5.2f}s"
    )
    if stats.errors:
        for err, cnt in stats.errors.items():
            print(f"        ! {cnt}x  {err}")


def recommend(stats_by_level: dict[int, LevelStats]) -> int:
    """根据测试结果推荐最佳并发：成功率≥95% 且 p95 没有显著恶化的最大档位"""
    valid = []
    for level in sorted(stats_by_level):
        s = stats_by_level[level]
        if s.samples == 0:
            continue
        success_rate = s.success / s.samples
        if success_rate >= 0.95 and s.rate_limited == 0:
            valid.append((level, s))
    if not valid:
        return 1
    best = valid[0]
    for level, s in valid:
        if s.throughput > best[1].throughput * 0.95:
            best = (level, s)
    return best[0]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=["ali", "dp", "both"], default="both")
    parser.add_argument("--levels", default="1,5,10,15,20,30,50")
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--warmup", action="store_true", help="测前先单请求预热")
    args = parser.parse_args()

    levels = [int(x.strip()) for x in args.levels.split(",") if x.strip()]
    providers = ["ali", "dp"] if args.provider == "both" else [args.provider]

    missing_keys = []
    if "ali" in providers and not ALI_API_KEY:
        missing_keys.append("ALI_TRANSLATE_API_KEY")
    if "dp" in providers and not DEEPSEEK_API_KEY:
        missing_keys.append("DEEPSEEK_API_KEY")
    if missing_keys:
        parser.error(f"请先配置环境变量：{', '.join(missing_keys)}")

    print("=" * 100)
    print(f"翻译 API 并发压测  |  样本={args.samples}/档  超时={args.timeout}s  档位={levels}")
    print(f"  ali  -> {ALI_URL}  model={ALI_MODEL}")
    print(f"  dp   -> {DEEPSEEK_URL}  model={DEEPSEEK_MODEL}")
    print("=" * 100)

    if args.warmup:
        print("\n[预热] 各发 1 个请求...")
        for p in providers:
            caller = call_ali if p == "ali" else call_deepseek
            r = caller(SAMPLE_LINES[0], args.timeout)
            print(f"  [{p}] ok={r.ok} status={r.status_code} latency={r.latency:.2f}s err={r.error[:80]}")

    summary: dict[str, dict[int, LevelStats]] = {p: {} for p in providers}
    for p in providers:
        print(f"\n>>> 提供商: {p}")
        for level in levels:
            stats = run_level(p, level, args.samples, args.timeout)
            summary[p][level] = stats
            print_level(p, stats)
            time.sleep(2)

    print("\n" + "=" * 100)
    print("汇总")
    print("=" * 100)
    print(f"{'provider':<10}{'concurrency':<14}{'wall(s)':<10}{'tput(r/s)':<12}{'success%':<10}{'rate_limited':<14}{'p95(s)':<10}")
    for p in providers:
        for level in levels:
            s = summary[p].get(level)
            if not s:
                continue
            sr = (s.success / s.samples * 100) if s.samples else 0
            print(
                f"{p:<10}{level:<14}{s.wall_time:<10.2f}{s.throughput:<12.2f}{sr:<10.1f}{s.rate_limited:<14}{s.p95:<10.2f}"
            )

    print()
    for p in providers:
        rec = recommend(summary[p])
        print(f"  推荐 {p} 的 max_workers ≈ {rec}")
    print()
    print("说明：若阿里档位增大但吞吐不再线性提升、或 p95 显著上升、或出现 429/限流错误，")
    print("      说明已触达账号侧并发上限，建议在 ThreadPoolExecutor 中固定 max_workers=15~20。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
