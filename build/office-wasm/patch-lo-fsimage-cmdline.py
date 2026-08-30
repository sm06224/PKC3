#!/usr/bin/env python3
"""🔴 **詰め込みの命令行が 128 KiB を越えて落ちるのを直す**(#591)。

## 症状

焼き run 33285888070 の `make` が **14 分 40 秒**で落ちた:

    make[1]: *** [static/CustomTarget_emscripten_fs_image.mk:1985:
      …/soffice.data.js.metadata] Error 127

⚠ `Error 127` は **command not found** に見えるが、**そうではない** ── 実体は
`/bin/sh: Argument list too long` である(make はこれを 127 で報告する)。

## 原因 ── `sh -c` の**1 引数**の上限を越えた

上流の recipe(`CustomTarget_emscripten_fs_image.mk`)はこう書いてある:

    cd $(BUILDDIR) && \\
    $(EMSDK_FILE_PACKAGER) …/soffice.data --preload $(shell cat $^) … \\
        || rm -f …

🔑 `$(shell cat $^)` は **make が展開する** ── つまり**数千の path が recipe の行に
そのまま並ぶ**。そして recipe は `&&` と `||` を含むので、make は
`/bin/sh -c "<行まるごと>"` で起動する ── **行全体が 1 引数**である。

⚠ ここで効くのは `ARG_MAX`(約 2 MB)ではなく **`MAX_ARG_STRLEN` = 128 KiB**
(1 引数の上限)である。

**実測(2026-08-30)**:

| | file 数 | `--preload` に並ぶ byte | 128 KiB まで |
|---|---|---|---|
| 直前の成功(33279050889) | 1,993 | **130,251** | 🟡 **残り 821** |
| テンプレート 34 件を足した回 | 2,027 | **132,359** | 🔴 **1,287 超過** |

🔑 **上流の注記どおりだった** ── 「*we won't run out of cmdline space that fast…*」
と書いてあるが、**もう使い切っていた**。テンプレートはその最後の一押しである。

## ⚠ 機構は手元の make で確かめた(推測ではない)

| 台 | 結果 |
|---|---|
| 129,000 byte の `sh -c` 行 | exit 0 |
| 133,000 byte の `sh -c` 行 | `make: /bin/sh: Argument list too long` / `Error 127` |
| 直し(下)を当てた 136,008 byte の一覧 | **exit 0**(133,979 byte が通った) |

## 🔑 直し ── 展開を **make から shell へ移す**

    --preload $(shell cat $^)      ← make が行に並べる(1 引数が肥大)
    --preload $$(cat $^)           ← shell が argv を組む(1 語ずつ別の引数)

`$$` は make が `$` へ縮めるので、shell は `$(cat …)` = コマンド置換として読む。
🔑 こうすると recipe の行は**短いまま**で、上限は `ARG_MAX`(約 2 MB)側になる ──
132 KB は遠く下である。

⚠ **語の分割は変わらない** ── `$(shell …)` の出力も shell が分割していたので、
分割の規則は同じである。実測で、詰め込む 1,993 件に**空白も shell 特殊文字も 0 件**
(最長の 1 件でも 87 byte)。

⚠ **この patch は `patch-lo-fsimage.py` とは別の行を触る**(あちらは一覧へ足す、
こちらは recipe の展開の仕方)── 当てる順に依存しない。
"""

from __future__ import annotations

import sys
from pathlib import Path

SRC = "static/CustomTarget_emscripten_fs_image.mk"

# ⚠ 錨は**その行だけ**を一意に取る(前後の行は patch-lo-fsimage.py が触りうる)
ANCHOR = "--preload $(shell cat $^)"
MARK = "--preload $$(cat $^)"


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <lo-core root>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        print(f"ERROR: {SRC} を読めない: {e}", file=sys.stderr)
        return 1

    # 🔑 **先に「もう当たっていないか」を見る**(`patch-lo-scripting.py` の作法)
    if MARK in text:
        print(f"SKIP: 既に当たっている({SRC})")
        return 0

    hits = text.count(ANCHOR)
    if hits != 1:
        print(f"ERROR: 錨が {hits} 件({SRC})── 上流が形を変えた", file=sys.stderr)
        print("  ⚠ file packager を呼ぶ recipe を読み直すこと", file=sys.stderr)
        return 1

    path.write_text(text.replace(ANCHOR, MARK, 1), encoding="utf-8")
    print(f"OK: 詰め込みの展開を shell 側へ移した({SRC})── #591")
    return 0


if __name__ == "__main__":
    sys.exit(main())
