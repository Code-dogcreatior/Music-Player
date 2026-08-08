# 苹果音乐账号配置指南

## 问题说明

苹果音乐默认返回的是**试听片段**（90秒），需要配置付费账号才能获取完整歌曲。

## 配置方法

### 方法1: 环境变量（推荐）

在 `start.sh` 或 `.bashrc` / `.zshrc` 中添加：

```bash
export APPLE_MUSIC_TOKEN="your_developer_token"
export APPLE_MUSIC_USER_TOKEN="your_user_token"
```

### 方法2: 配置文件

创建 `~/.musicdl/config.json`:

```json
{
  "AppleMusicClient": {
    "token": "your_developer_token",
    "user_token": "your_user_token",
    "storefront": "cn"
  }
}
```

### 方法3: 代码配置

修改 `backend/music_service.py` 的 `init_music_client` 方法：

```python
if source == "AppleMusicClient":
    source_cfg.update({
        "search_size_per_page": 1,
        "max_retries": 1,
        "token": "your_developer_token",
        "user_token": "your_user_token",
        "storefront": "cn"
    })
```

## 获取 Token 的方法

### 1. Developer Token
需要从 Apple Developer 账号获取：
- 访问 https://developer.apple.com/
- 创建 MusicKit 密钥
- 生成 JWT token

### 2. User Token
通过 Apple Music 登录获取：
- 使用 MusicKit JS 或官方 SDK
- 用户登录后获取

## 简化方案

如果配置苹果音乐账号比较复杂，建议：

### 选项A: 使用其他音乐源
- **酷我音乐**（0.5秒，完整歌曲）⚡⚡⚡
- **5sing**（1秒，完整歌曲）⚡⚡⚡
- **波点音乐**（1秒，完整歌曲）⚡⚡⚡

### 选项B: 从推荐源中移除苹果音乐

修改 `backend/music_service.py`:

```python
self.source_map_cn_to_en = {
    # 推荐的主流音乐源（前3个）
    "酷我音乐": "KuwoMusicClient",
    "5sing": "FiveSingMusicClient",
    "波点音乐": "BodianMusicClient",
    # 其他正常工作的音乐源
    "咪咕音乐": "MiguMusicClient",
    "哔哩哔哩": "BilibiliMusicClient",
    "网易云音乐": "NeteaseMusicClient",
    "QQ音乐": "QQMusicClient",
    "Suno": "SunoMusicClient",
    "Deezer": "DeezerMusicClient",
    # "苹果音乐": "AppleMusicClient",  # 注释掉
}
```

## 验证配置

配置完成后，重启服务并测试：

```bash
# 重启服务
./start.sh

# 测试苹果音乐
python3 scripts/diagnose_sources.py
```

## 注意事项

1. **Developer Token** 需要 Apple Developer 账号（$99/年）
2. **User Token** 需要 Apple Music 订阅
3. Token 有过期时间，需要定期更新
4. 配置较复杂，建议使用其他音乐源

## 推荐方案

**建议使用酷我音乐、5sing 或波点音乐**，它们：
- ✅ 无需账号配置
- ✅ 返回完整歌曲
- ✅ 速度更快（0.5-1秒）
- ✅ 使用简单

如果确实需要苹果音乐，可以提供你的 Token，我帮你配置到项目中。
