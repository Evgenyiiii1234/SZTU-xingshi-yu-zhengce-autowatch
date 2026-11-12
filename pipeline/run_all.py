#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
一条命令跑完：视频地址 → 下载 → 转写 → 提纲/总结

    python pipeline/run_all.py "https://cdn.xxx/lesson.m3u8" --referer "https://www.duifene.com/"
    python pipeline/run_all.py out/第3讲.mp4 --skip-download        # 已经下载好了
    python pipeline/run_all.py "URL" --model medium --name 第3讲
"""
import argparse
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).resolve().parent
PY = sys.executable


def call(args):
    print("\n" + "=" * 70)
    print("$", " ".join(str(a) for a in args))
    print("=" * 70)
    rc = subprocess.call([str(a) for a in args])
    if rc != 0:
        print(f"[!] 上一步返回 {rc}，停止。")
        raise SystemExit(rc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target", help="视频 URL，或本地视频文件")
    ap.add_argument("-o", "--outdir", default="out")
    ap.add_argument("--model", default="small")
    ap.add_argument("--referer", default="")
    ap.add_argument("--cookies", default="")
    ap.add_argument("--name", default="")
    ap.add_argument("--max-height", type=int, default=720)
    ap.add_argument("--skip-download", action="store_true")
    ap.add_argument("--fast", action="store_true")
    args = ap.parse_args()

    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)
    media = Path(args.target)

    if not args.skip_download:
        cmd = [PY, HERE / "fetch_media.py", args.target, "-o", out,
               "--max-height", args.max_height]
        if args.referer:
            cmd += ["--referer", args.referer]
        if args.cookies:
            cmd += ["--cookies", args.cookies]
        if args.name:
            cmd += ["--name", args.name]
        call(cmd)
        cands = sorted([p for p in out.iterdir() if p.suffix.lower() in
                        (".mp4", ".m4a", ".flv", ".ts", ".mkv", ".webm")],
                       key=lambda p: p.stat().st_mtime)
        if not cands:
            print("[!] 下载目录里没有媒体文件。")
            return 1
        media = cands[-1]

    cmd = [PY, HERE / "transcribe.py", media, "-o", out, "--model", args.model]
    if args.fast:
        cmd.append("--fast")
    call(cmd)

    call([PY, HERE / "summarize.py", out / (media.stem + ".md"), "-o", out])

    print("\n全部完成，产物：")
    for p in sorted(out.glob(media.stem + "*")):
        print("  ", p, f"({p.stat().st_size/1024:.0f} KB)")
    print("\n交作业用这份：", out / (media.stem + "-summary.md"))
    print("没有大模型 key 时用这份：", out / (media.stem + "-outline.md"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
