#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把转写稿变成「可直接交的作业总结」。

两种模式：
  1) 本地模式（默认，零依赖、不联网）：生成结构化提纲稿 —— 时间轴、分节、每节要点句、术语表、待补充标记。
  2) 大模型模式（有 API key 时）：直接把全文喂给模型，产出成稿。

    set SUM_BASE=https://api.deepseek.com/v1
    set SUM_KEY=sk-xxxx
    set SUM_MODEL=deepseek-chat
    python pipeline/summarize.py out/第3讲.md

不管有没有 key，都会额外产出一份 out/<name>-prompt.md —— 把全文和指令打包好，
丢给任意网页版大模型就能拿到最终稿。
"""
import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

STOP = set("的了是在和与及或对从把被为就都也还很更最这那有个我们你们他们它们一个一些以及所以但是因为如果那么可以能够进行通过需要应该没有不是就是什么怎么这样那样同时然后目前首先是其次最后注意重点")

def parse_md(md: str):
    """把 transcribe.py 输出的 md 解析成 (ts, text) 段列表"""
    secs = []
    cur = None
    for line in md.splitlines():
        m = re.match(r"^## \[([^\]]+)\]", line)
        if m:
            if cur:
                secs.append(cur)
            cur = {"ts": m.group(1), "text": ""}
        elif cur is not None and line.strip() and not line.startswith("# "):
            cur["text"] += line.strip()
    if cur:
        secs.append(cur)
    return [s for s in secs if s["text"]]

def split_sents(text: str, cap: int = 80):
    """先按中文句末切，再把超长句按逗号顿号二次切开（自动转写经常整段没有标点）"""
    out = []
    for s in re.split(r"(?<=[。！？!?；;])", text):
        s = s.strip()
        if not s:
            continue
        if len(s) <= cap:
            out.append(s)
            continue
        buf = ""
        for piece in re.split(r"(?<=[，、：:])", s):
            if buf and len(buf) + len(piece) > cap:
                out.append(buf)
                buf = ""
            buf += piece
            while len(buf) > cap * 1.6:          # 连逗号都没有的，硬切
                out.append(buf[:cap])
                buf = buf[cap:]
        if buf:
            out.append(buf)
    return [s for s in out if len(s) >= 6]


def key_sentences(text: str, n: int = 3):
    """极简抽取：按词频+位置打分取前 n 句"""
    sents = split_sents(text)
    if not sents:
        return []
    freq = {}
    for ch in text:
        if "\u4e00" <= ch <= "\u9fff" and ch not in STOP:
            freq[ch] = freq.get(ch, 0) + 1
    scored = []
    for i, s in enumerate(sents):
        score = sum(freq.get(c, 0) for c in s if "\u4e00" <= c <= "\u9fff" and c not in STOP)
        score = score / (len(s) ** 0.7)
        score *= 1.25 if i == 0 else 1.0
        scored.append((score, i, s))
    top = sorted(scored, reverse=True)[:n]
    return [s for _, i, s in sorted(top, key=lambda x: x[1])]

def terms(text: str, n: int = 12):
    """抽可能的概念词：连续 2-6 个汉字的片段，重复出现 2 次以上"""
    cand = re.findall(r"[\u4e00-\u9fa5]{2,6}", text)
    cnt = {}
    for c in cand:
        if any(w in c for w in ("我们", "你们", "这个", "那个", "什么", "然后", "就是", "可以", "大家")):
            continue
        cnt[c] = cnt.get(c, 0) + 1
    items = [(c, k) for c, k in cnt.items() if k >= 3]
    items.sort(key=lambda x: -x[1])
    out, seen = [], set()
    for c, k in items:
        if any(c in s or s in c for s in seen):
            continue
        seen.add(c)
        out.append((c, k))
        if len(out) >= n:
            break
    return out

PROMPT = """你是一位顶尖的课程笔记整理者。下面是一节视频课（可能带自动转写错误）的完整文稿，请输出一份高质量的中文总结，直接可以交作业。

要求：
1. 开头 3–5 行「本讲概要」，讲清这节课在解决什么问题、结论是什么。
2. 正文按逻辑分 5–10 节，每节：小标题 + 3–6 条要点（要点是完整的判断句，不是关键词堆砌）。
3. 单独的「核心概念」表：术语 → 一句话解释（只列本讲真正讲过的）。
4. 单独的「例题 / 案例 / 演示」段落，写清步骤。
5. 单独的「易错点与考点」。
6. 结尾用 5 条以内做「一句话回顾」。
7. 自动转写可能有错别字：遇到明显不通的地方按上下文修正，专业术语按你的判断归一。
8. 不要写「本视频中提到」「讲师说」这类废话，直接写知识本身。不要编造文稿里没有的内容。

【文稿开始】
{transcript}
【文稿结束】
"""

def call_llm(prompt: str, base: str, key: str, model: str, timeout=300) -> str:
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
        "max_tokens": 8000,
    }).encode("utf-8")
    req = urllib.request.Request(
        base.rstrip("/") + "/chat/completions", data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input", help="transcribe.py 产出的 .md（或 .txt / .json）")
    ap.add_argument("-o", "--outdir", default="")
    ap.add_argument("--no-llm", action="store_true")
    args = ap.parse_args()

    src = Path(args.input)
    if not src.exists():
        print(f"[!] 找不到 {src}")
        return 2
    outdir = Path(args.outdir) if args.outdir else src.parent
    stem = src.stem
    raw = src.read_text(encoding="utf-8", errors="replace")

    secs = parse_md(raw) if src.suffix == ".md" else [{"ts": "全文", "text": raw}]
    full = "".join(s["text"] for s in secs)
    print(f"[i] 共 {len(secs)} 段，{len(full)} 字")

    # 打包提示词
    prompt_path = outdir / f"{stem}-prompt.md"
    prompt_path.write_text(PROMPT.format(transcript=raw), encoding="utf-8")

    # 本地提纲
    lines = [f"# {stem} — 课程笔记（提纲稿）\n",
             f"> 自动生成：{len(secs)} 段 / 约 {len(full)} 字。要点由抽取算法给出，交作业前请自己顺一遍语句。\n",
             "\n## 一、分节要点\n"]
    for i, s in enumerate(secs, 1):
        ks = key_sentences(s["text"], 3)
        lines.append(f"\n### {i}. [{s['ts']}]\n")
        for k in ks:
            lines.append(f"- {k}\n")
        if not ks:
            lines.append(f"- {s['text'][:120]}…\n")

    tm = terms(full)
    if tm:
        lines.append("\n## 二、高频概念\n\n| 概念 | 出现次数 |\n| --- | --- |\n")
        for c, k in tm:
            lines.append(f"| {c} | {k} |\n")
        tail_no = "三"
    else:
        tail_no = "二"

    lines.append(f"\n## {tail_no}、待补充（自己听完补）\n\n"
                 "- [ ] 本讲最重要的一条结论是：\n"
                 "- [ ] 老师强调的例题/步骤：\n"
                 "- [ ] 我没听懂、需要回头看的时间点：\n")

    outline = outdir / f"{stem}-outline.md"
    outline.write_text("".join(lines), encoding="utf-8")
    print(f"[ok] 提纲稿 {outline}")
    print(f"[ok] 提示词包 {prompt_path}")

    base, key, model = os.environ.get("SUM_BASE"), os.environ.get("SUM_KEY"), os.environ.get("SUM_MODEL", "gpt-4o-mini")
    final = outdir / f"{stem}-summary.md"
    if base and key and not args.no_llm:
        print(f"[i] 调用大模型 {model} …")
        try:
            txt = call_llm(PROMPT.format(transcript=raw), base, key, model)
            final.write_text(f"# {stem} — 课程总结\n\n{txt}\n", encoding="utf-8")
            print(f"[ok] 成稿 {final}")
        except Exception as e:
            print(f"[!] 大模型调用失败：{e}\n    先把 {prompt_path} 里的内容粘到任意网页版大模型，一样能出稿。")
    else:
        print(f"[i] 没配 SUM_BASE/SUM_KEY，跳过成稿。把 {prompt_path} 全文粘给大模型即可。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
