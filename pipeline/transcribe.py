#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把下载到的课程视频/音频转成文字（faster-whisper + PyAV，不需要 ffmpeg 可执行文件）。

输出：
    out/<name>.txt    带时间戳的完整文稿
    out/<name>.srt    字幕
    out/<name>.md     按 ~75 秒合并段落的阅读稿（给总结用）

用法：
    python pipeline/transcribe.py out/第3讲.mp4                   # 默认 small，中文
    python pipeline/transcribe.py out/第3讲.mp4 --model medium     # 更准、更慢
    python pipeline/transcribe.py out/第3讲.mp4 --model tiny --fast # 先粗跑一遍看时长
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

MODELS = ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"]


def patch_av_compat():
    """PyAV 19 去掉了 av.open(metadata_errors=...) 参数，faster-whisper 还在传。
    这里包一层把多余参数吃掉，避免 'unexpected keyword argument'。"""
    try:
        import av
        if getattr(av, "_dfe_patched", False):
            return
        orig = av.open

        def _open(*a, **kw):
            kw.pop("metadata_errors", None)
            return orig(*a, **kw)

        av.open = _open
        av._dfe_patched = True
    except Exception as e:
        print(f"[!] PyAV 兼容补丁未生效: {e}")


def ts(sec: float, srt: bool = False) -> str:
    sec = max(0.0, float(sec))
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = int(round((sec - int(sec)) * 1000))
    if srt:
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input", help="视频或音频文件")
    ap.add_argument("-o", "--outdir", default="out")
    ap.add_argument("--model", default="small",
                    help="tiny/base/small/medium/large-v3，或本地模型目录的路径")
    ap.add_argument("--lang", default="zh")
    ap.add_argument("--fast", action="store_true", help="beam_size=1 + 关闭 VAD 重排，速度最快")
    ap.add_argument("--prompt", default="以下是普通话的课程讲解，可能包含专业术语。",
                    help="初始提示，写几个本课专业词能明显提准")
    args = ap.parse_args()

    src = Path(args.input)
    if not src.exists():
        print(f"[!] 找不到文件: {src}")
        return 2
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    stem = src.stem

    print(f"[i] 加载模型 {args.model} …（首次会从 HuggingFace 下载，约 0.5–3 GB）")
    patch_av_compat()
    from faster_whisper import WhisperModel

    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
    except Exception as e:
        if os.environ.get("DFE_MIRROR_TRIED") == "1":
            print(f"[!] 镜像也失败了：{type(e).__name__}: {e}")
            print("    手动办法：设 HF_ENDPOINT=https://hf-mirror.com 再跑；")
            print("    或者从 https://hf-mirror.com/Systran/faster-whisper-small 下载整个目录，")
            print("    解压后用 --model \"本地目录路径\" 直接指向它。")
            return 3
        print(f"[i] 直连 HuggingFace 不行（{type(e).__name__}），改用镜像 hf-mirror.com 自动重试 …")
        env = dict(os.environ, HF_ENDPOINT="https://hf-mirror.com", DFE_MIRROR_TRIED="1")
        os.execve(sys.executable, [sys.executable] + sys.argv, env)
        return 3

    t0 = time.time()
    print(f"[i] 开始转写: {src.name}")
    segments, info = model.transcribe(
        str(src),
        language=args.lang or None,
        beam_size=1 if args.fast else 5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
        initial_prompt=args.prompt or None,
        condition_on_previous_text=False,
    )
    dur = getattr(info, "duration", 0) or 0
    print(f"[i] 音频时长 {ts(dur)}，检测语言 {getattr(info, 'language', '?')}")

    rows = []
    last = 0.0
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        rows.append({"start": float(seg.start), "end": float(seg.end), "text": text})
        if seg.end - last >= 15:
            last = seg.end
            pct = (seg.end / dur * 100) if dur else 0
            print(f"    {ts(seg.end)}  {pct:5.1f}%  {text[:50]}")

    if not rows:
        print("[!] 没有识别到语音。可能是纯音乐/无人声，或音轨编码异常。")
        return 1

    # 1) 带时间戳文稿
    txt_path = outdir / f"{stem}.txt"
    txt_path.write_text("\n".join(f"[{ts(r['start'])}] {r['text']}" for r in rows), encoding="utf-8")

    # 2) SRT
    srt_path = outdir / f"{stem}.srt"
    with srt_path.open("w", encoding="utf-8") as f:
        for i, r in enumerate(rows, 1):
            f.write(f"{i}\n{ts(r['start'], True)} --> {ts(r['end'], True)}\n{r['text']}\n\n")

    # 3) 合并段落的阅读稿（每段 ~75 秒）
    md_path = outdir / f"{stem}.md"
    paras, buf, buf_start, buf_end = [], [], None, None
    for r in rows:
        if buf_start is None:
            buf_start = r["start"]
        buf.append(r["text"])
        buf_end = r["end"]
        if buf_end - buf_start >= 75:
            paras.append((buf_start, buf_end, "".join(buf)))
            buf, buf_start = [], None
    if buf:
        paras.append((buf_start, buf_end, "".join(buf)))

    with md_path.open("w", encoding="utf-8") as f:
        f.write(f"# {stem}\n\n")
        f.write(f"- 时长：{ts(dur)}（{dur:.0f} 秒）\n- 段落：{len(paras)}\n- 字数：{sum(len(r['text']) for r in rows)}\n\n---\n\n")
        for s, e, t in paras:
            f.write(f"## [{ts(s)} – {ts(e)}]\n\n{t}\n\n")

    # 4) JSON（给后续脚本用）
    (outdir / f"{stem}.json").write_text(
        json.dumps({"file": src.name, "duration": dur, "segments": rows}, ensure_ascii=False, indent=1),
        encoding="utf-8")

    el = time.time() - t0
    print(f"\n[ok] 完成，用时 {el/60:.1f} 分钟")
    print(f"     文稿 {txt_path}")
    print(f"     阅读稿 {md_path}")
    print(f"     字幕 {srt_path}")
    print(f"     下一步: python pipeline/summarize.py \"{md_path}\"")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
