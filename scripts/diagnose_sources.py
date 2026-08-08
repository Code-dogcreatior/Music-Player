#!/usr/bin/env python3
"""
音乐源搜索结果诊断脚本
系统性检查所有音乐源的搜索结果返回问题
"""

import sys
import os
import time
import requests
from typing import Dict, List, Tuple

# 添加项目路径
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)

API_BASE = "http://127.0.0.1:8000"
TIMEOUT = 30  # 30秒超时

def get_all_sources() -> Dict[str, str]:
    """获取所有音乐源"""
    try:
        response = requests.get(f"{API_BASE}/api/sources", timeout=10)
        if response.status_code == 200:
            return response.json().get('sources', {})
    except Exception as e:
        print(f"❌ 无法获取音乐源列表: {e}")
        sys.exit(1)
    return {}

def test_source_search(source_cn: str, source_en: str, keyword: str = "周杰伦") -> Tuple[bool, float, int, str]:
    """
    测试单个音乐源的搜索
    返回: (是否成功, 耗时, 结果数, 错误信息)
    """
    try:
        # 提交搜索
        start_time = time.time()
        response = requests.post(f"{API_BASE}/api/search", json={
            "keyword": keyword,
            "search_type": "搜索歌曲",
            "selected_sources": [source_en],
            "limit": 5,
            "save_dir": ""
        }, timeout=10)

        if response.status_code != 200:
            return False, 0, 0, f"HTTP {response.status_code}"

        job_id = response.json().get("job_id")

        # 轮询结果
        for _ in range(60):  # 最多等待30秒
            time.sleep(0.5)
            status_response = requests.get(f"{API_BASE}/api/search/{job_id}", timeout=10)

            if status_response.status_code != 200:
                return False, 0, 0, "状态查询失败"

            status_data = status_response.json()
            status = status_data.get('status')

            if status == 'finished':
                elapsed = time.time() - start_time
                songs = status_data.get('songs', [])
                return True, elapsed, len(songs), ""

            elif status == 'failed':
                error = status_data.get('error', '未知错误')
                return False, 0, 0, error

        # 超时
        return False, TIMEOUT, 0, "搜索超时"

    except Exception as e:
        return False, 0, 0, str(e)

def main():
    print("="*70)
    print("🔍 音乐源搜索结果诊断")
    print("="*70)
    print()

    # 获取所有音乐源
    print("[1/3] 获取音乐源列表...")
    sources = get_all_sources()
    print(f"✅ 找到 {len(sources)} 个音乐源")
    print()

    # 测试所有音乐源
    print("[2/3] 测试所有音乐源...")
    print("-"*70)

    results = []
    problem_sources = []

    for i, (source_cn, source_en) in enumerate(sources.items(), 1):
        print(f"[{i}/{len(sources)}] 测试 {source_cn}...", end=" ", flush=True)

        success, elapsed, count, error = test_source_search(source_cn, source_en)

        if success:
            if count > 0:
                print(f"✅ {elapsed:.2f}秒, {count}条结果")
                results.append((source_cn, elapsed, count, "正常"))
            else:
                print(f"⚠️  {elapsed:.2f}秒, 0条结果")
                results.append((source_cn, elapsed, 0, "无结果"))
                problem_sources.append((source_cn, source_en, "返回0条结果"))
        else:
            print(f"❌ 失败: {error}")
            results.append((source_cn, 0, 0, f"失败: {error}"))
            problem_sources.append((source_cn, source_en, error))

    # 生成报告
    print()
    print("[3/3] 生成诊断报告...")
    print("="*70)
    print("📊 测试结果汇总")
    print("="*70)
    print()

    # 按速度排序
    normal_results = [(cn, t, c) for cn, t, c, s in results if s == "正常"]
    normal_results.sort(key=lambda x: x[1])

    if normal_results:
        print("✅ 正常工作的音乐源:")
        print()
        for i, (cn, elapsed, count) in enumerate(normal_results, 1):
            speed_icon = "⚡⚡⚡" if elapsed < 2 else "⚡⚡" if elapsed < 5 else "⚡"
            print(f"  {i:2d}. {cn:20s} {elapsed:5.2f}秒  {count}条结果  {speed_icon}")

    print()

    if problem_sources:
        print("⚠️  有问题的音乐源:")
        print()
        for i, (cn, en, error) in enumerate(problem_sources, 1):
            print(f"  {i:2d}. {cn:20s} ({en})")
            print(f"      问题: {error}")

        print()
        print("="*70)
        print("🔧 建议修复方案")
        print("="*70)
        print()
        print("对于返回0条结果的音乐源，建议添加优化配置：")
        print()
        print("1. 在 backend/music_service.py 的 init_music_client 方法中添加:")
        print()
        for cn, en, error in problem_sources:
            if "0条结果" in error:
                print(f"   elif source == \"{en}\":")
                print(f"       source_cfg.update({{")
                print(f"           \"search_size_per_page\": 1,")
                print(f"           \"max_retries\": 1,")
                print(f"       }})")
                print()

        print("2. 添加对应的优化方法 _tune_xxx_client()")
        print()
    else:
        print("✅ 所有音乐源工作正常！")

    print()
    print("="*70)
    print(f"✅ 诊断完成！共测试 {len(sources)} 个音乐源")
    print(f"   正常: {len(normal_results)} 个")
    print(f"   有问题: {len(problem_sources)} 个")
    print("="*70)

if __name__ == "__main__":
    main()
