#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""检查 README 和 docs/ 里所有相对链接是否指向真实存在的文件。

    python tests/check_links.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_PREFIX = ("http://", "https://", "#", "mailto:", "tel:")
LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)")


def check(md_path: Path) -> list[str]:
    text = md_path.read_text(encoding="utf-8", errors="replace")
    bad = []
    for target in LINK_RE.findall(text):
        target = target.split("#")[0].split("?")[0]
        if not target or target.startswith(SKIP_PREFIX):
            continue
        if target.startswith("/"):        # 站点绝对路径，跳过
            continue
        resolved = (md_path.parent / target).resolve()
        if not resolved.exists():
            bad.append(f"{md_path.relative_to(ROOT)} -> {target}")
    return bad


def main() -> int:
    files = [ROOT / "README.md"] + sorted((ROOT / "docs").glob("*.md"))
    all_bad = []
    for f in files:
        if not f.exists():
            print(f"[!] 缺少 {f.name}")
            continue
        bad = check(f)
        all_bad += bad
        print(("[ok] " if not bad else "[x]  ") + str(f.relative_to(ROOT)) +
              (f"  ({len(bad)} 个失效链接)" if bad else ""))

    # SVG 里引用的图片也检查一遍（README 用 <img src=...>）
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    for src in re.findall(r'<img[^>]+src="([^"]+)"', readme):
        if src.startswith(SKIP_PREFIX):
            continue
        if not (ROOT / src).exists():
            all_bad.append(f"README.md -> <img> {src}")

    if all_bad:
        print("\n失效链接：")
        for b in all_bad:
            print("  -", b)
        return 1
    print("\n所有相对链接有效")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
