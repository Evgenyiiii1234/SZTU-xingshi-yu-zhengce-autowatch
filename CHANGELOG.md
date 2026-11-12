# Changelog

版本号跟用户脚本头部的 `@version` 保持一致。

## v1.2.0 — 2026-11-13

首个公开版本。

**用户脚本**
- 倍速伪装：改写 `HTMLMediaElement.prototype.playbackRate` 的 getter/setter，页面读到恒为 `1`
- 三档模式：激进（8× 伪装 1×）/ 保守（2× 如实）/ 关闭
- 防暂停：`pause` 事件 80ms 内反向拉回；600ms 巡检兜底
- 防失焦：`hidden`、`visibilityState`、`blur`、`visibilitychange`、`pagehide` 全部屏蔽
- 播完自动切下一节；同一 `<video>` 换片源自动重新接管
- 进度上报录制（XHR + fetch 钩子）+ 回放打点（秒/毫秒自动判别，只改位置字段）
- 弹题 / 人脸 / 防挂机检测告警（响铃 + 标题闪烁 + 面板提示）
- 视频直链导出，可从 `performance` 资源里穿透 MSE 的 `blob:` 播放器

**转写管线**
- `fetch_media.py`：yt-dlp 内置 HLS 下载器，不需要 ffmpeg；支持 Referer / Cookie
- `transcribe.py`：faster-whisper + PyAV 解码，CPU int8；VAD 切静音；输出 txt/srt/md/json
- `summarize.py`：分节提纲 + 高频概念表 + 提示词打包 +（可选）OpenAI 兼容接口成稿
- `run_all.py` / `go.ps1`：一条命令串联

**工程**
- `patch_av_compat()`：修 PyAV 19 删除 `metadata_errors` 参数导致 faster-whisper 崩溃的问题
- HF 直连失败自动切 `hf-mirror.com` 重试
- `tests/smoke_user_script.js`：jsdom 冒烟测试，8 项断言
- `tests/check_links.py`：README / docs 内链检查
- GitHub Actions：语法检查 + 冒烟测试 + 内链检查
