#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
下载课程视频（mp4 直链 / m3u8 切片 / 网页内的 video 源）。
只用 yt-dlp 内置下载器，不依赖 ffmpeg。

用法：
    python pipeline/fetch_media.py "https://cdn.example.com/xxx.m3u8" -o out
    python pipeline/fetch_media.py "URL" -o out --referer "https://www.duifene.com/" --cookies cookies.txt
"""
import argparse
import os
import re
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str]) -> int:
    print(">", " ".join(cmd))
    return subprocess.call(cmd)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("url", help="视频地址（mp4/m3u8）或包含视频的网页地址")
    ap.add_argument("-o", "--outdir", default="out")
    ap.add_argument("--referer", default="")
    ap.add_argument("--cookies", default="", help="导出的 cookies.txt（Netscape 格式）")
    ap.add_argument("--name", default="", help="自定义输出文件名（不含扩展名）")
    ap.add_argument("--max-height", type=int, default=720, help="最高分辨率，默认 720，越小越快")
    args = ap.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    tmpl = str(outdir / ((args.name or "%(title).60s") + ".%(ext)s"))

    cmd = [
        sys.executable, "-m", "yt_dlp",
        "--no-playlist",
        "--no-part",
        "--no-mtime",
        "--no-warnings",
        "--retries", "10",
        "--fragment-retries", "20",
        "--concurrent-fragments", "8",
        "--hls-prefer-native",          # 关键：走内置 HLS 下载器，不需要 ffmpeg
        "-f", f"best[height<={args.max_height}][ext=mp4]/best[height<={args.max_height}]/best",
        "-o", tmpl,
        "--print", "after_move:filepath",
    ]
    if args.referer:
        cmd += ["--add-header", f"Referer:{args.referer}",
                "--add-header", f"Origin:{re.sub(r'(https?://[^/]+).*', r'\\1', args.referer)}"]
    if args.cookies:
        cmd += ["--cookies", args.cookies]
    cmd.append(args.url)

    rc = run(cmd)
    if rc != 0:
        print("\n[!] 下载失败。常见原因：链接需要登录态 / 需要 Referer / 链接已过期。")
        print("    处理：浏览器里把视频播起来 → 面板点「复制视频直链」→ 带上 --referer 重试；")
        print("    仍然 403 就 F12 → Network → 右键请求 → Copy as cURL，再把 -H 参数补进来。")
        return rc

    files = sorted([p for p in outdir.iterdir() if p.is_file()
                    and p.suffix.lower() in (".mp4", ".m4a", ".flv", ".ts", ".mkv", ".webm")],
                   key=lambda p: p.stat().st_mtime)
    if files:
        print(f"\n[ok] 已下载: {files[-1]}  ({files[-1].stat().st_size/1048576:.1f} MB)")
        print(f"     转写: python pipeline/transcribe.py \"{files[-1]}\"")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
