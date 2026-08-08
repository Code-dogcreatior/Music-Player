#!/usr/bin/env bash
# 音乐源优化批处理脚本
# 自动为所有音乐源添加快速搜索优化

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=========================================="
echo "🚀 音乐源优化批处理脚本"
echo "=========================================="
echo ""

# 检查Python环境
if ! command -v conda &> /dev/null; then
    echo "❌ 未找到conda，请先安装Miniconda或Anaconda"
    exit 1
fi

# 激活conda环境
echo "[1/4] 激活conda环境..."
eval "$(conda shell.bash hook)"
conda activate music || {
    echo "❌ 无法激活music环境"
    exit 1
}

# 更新musicdl到最新版本
echo ""
echo "[2/4] 更新musicdl到最新版本..."
pip install --upgrade musicdl -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn

# 验证后端配置
echo ""
echo "[3/4] 验证后端配置..."
cd "$PROJECT_ROOT"
python << 'PYEOF'
import sys
sys.path.insert(0, '.')

from backend.music_service import MusicService

service = MusicService()
print(f"✅ 音乐源总数: {len(service.source_map_cn_to_en)}")

# 检查优化方法
optimized_sources = []
if hasattr(service, '_tune_qq_client'):
    optimized_sources.append('QQ音乐')
if hasattr(service, '_tune_netease_client'):
    optimized_sources.append('网易云音乐')
if hasattr(service, '_tune_kuwo_client'):
    optimized_sources.append('酷我音乐')

print(f"✅ 已优化的音乐源: {', '.join(optimized_sources)}")

# 显示前3个推荐源
top3 = list(service.source_map_cn_to_en.keys())[:3]
print(f"✅ 推荐音乐源: {', '.join(top3)}")
PYEOF

# 重新构建前端
echo ""
echo "[4/4] 重新构建前端..."
cd "$PROJECT_ROOT/frontend"
npm run build

echo ""
echo "=========================================="
echo "✅ 优化批处理完成！"
echo "=========================================="
echo ""
echo "下一步："
echo "  1. 重启开发环境: ./start.sh"
echo "  2. 访问前端: http://127.0.0.1:5173"
echo ""
