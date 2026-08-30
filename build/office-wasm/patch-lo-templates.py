#!/usr/bin/env python3
"""🔴 **Impress の「テンプレートを選ぶ」を空にしない**(#591)。

## ⚠ 1 稿目(PR #601)の直しは**効かなかった**

#601 は configure に `--with-templates=yes` を渡した。⚠ **通ったが、届かなかった** ──
run 33279050889 の一式を落として目録を数えたら **`.otp` 0 件 / `.ott` 0 件**
(そもそも拡張子が `.otp .ott .otg .otm .ots` のどれも **1 件も無い**)。

⚠ そのとき workflow に書いた
「`=yes` は `configure.ac:3622` の `WITH_TEMPLATES=TRUE` を**保つ**枝である
(実装を読んで確かめた ── **別の所で弾かれない**)」は**誤り**である。
弾かれる。上流を落として読んだら、`patch-lo-scripting.py`(#431)と**同じ 2 段**だった:

| 場所 | 何をしているか |
|---|---|
| `configure.ac:1301` | Emscripten の host case で **`enable_wasm_strip=yes` を無条件に**立てる |
| `configure.ac:3462` | `if test "$enable_wasm_strip" = "yes"; then` に入る |
| `configure.ac:3495` | その中で **`with_templates=no` を無条件に**上書きする |
| `configure.ac:3625` | もう `no` なので `WITH_TEMPLATES=`(空) |
| `extras/Package_tplpresnt.mk:11` | `ifneq ($(WITH_TEMPLATES),)` が偽 → **空フォルダだけ**作る |

🔑 つまり **option では開かない**。option 解析は 2458 行、上書きは 3495 行なので
**後から来るほうが勝つ**。⚠ `--disable-wasm-strip` でも逃げられない
(1301 行が host case で無条件に立てる ── 2026-08-14 に確認済み、CLAUDE.md にも在る)。

## 🔑 直し ── 上流自身の書き方に揃える

同じブロックの `enable_dynamic_loading`(3470 行)と `with_fonts`(3499 行)は
**明示指定を尊重する**書き方になっている。`with_templates` だけ素の代入だった:

    test "${with_templates+set}" = set || with_templates=no

⚠ `patch-lo-scripting.py` では**この書き方が使えなかった** ── `scripting` の
`AC_ARG_ENABLE` は `action-if-not-given` を持ち、渡されなくても値を代入するので
`${...+set}` が常に set になるためである。🔑 **`templates` は事情が違う**:
`AC_ARG_WITH(templates, AS_HELP_STRING(...), )`(2458-2463 行)は
**action を 1 つも持たない**ので、`${with_templates+set}` は
「user が `--with-templates=…` を渡したか」を正しく表す
(3624 行の `if test -n "${with_templates}"` が同じ性質に依っている)。

🔑 だから**既定は 1 バイトも変わらない** ── 渡さなければ `no` のままである。
配る一式にテンプレートが入るのは、workflow が `--with-templates=yes` を渡すからで、
この patch はその指示を**届くようにする**だけである。

## ⚠ 「入れたら焼ける」ことも確かめてある

`extras/Module_extras.mk` を読むと、`Package_tplpresnt` は
**`WITH_TEMPLATES` と無関係に常に登録されている**(35 行目)── 畳まれているのは
Package の**中の file 一覧**だけである。そして `.otp` を焼く
`CustomTarget_templates` も**常に登録されている**(17 行目)で、
`.otp` は pattern rule で**要求された分だけ**焼かれる。
🔑 つまり `WITH_TEMPLATES` を立てれば、23 件の `.otp` が要求されて焼かれる。

⚠ 上流の実数は presnt が **23 件**、その他(`.ott`/`.otg`)が **11 件**。
検品は workflow の「検品(テンプレートが配られたか / #591)」が持つ
(`.otp >= 20` / `.ott+.otg >= 8` ── 取りこぼしを見たいので実数より少し下)。
"""

from __future__ import annotations

import sys
from pathlib import Path

SRC = "configure.ac"

# ⚠ 錨は**前後の行を含めて**一意にする(`with_templates=no` だけだと弱い)。
#    実測(LO 47104c82):この 3 行で 1 件、`with_templates=no` 単独でも 1 件。
#    🔑 それでも前後を含めるのは、**上流がこの行を別の場所へ増やした日**に
#    「どちらに当てたか分からない」状態を作らないためである。
ANCHOR = """    with_gssapi=no
    with_templates=no
    with_x=no
"""

MARK = 'test "${with_templates+set}" = set || with_templates=no'

REPLACE = """    with_gssapi=no
    dnl 🔴 PKC3: テンプレートを建てられるようにする(#591)。
    dnl    元は `with_templates=no` の無条件代入で、`--with-templates=yes` を
    dnl    渡しても**後から潰されていた**(option 解析 2458 行 < 上書き 3495 行)。
    dnl    ⚠ 症状は「Impress の『テンプレートを選ぶ』が空の一覧を出す」。
    dnl    🔑 同じブロックの enable_dynamic_loading(3470)/ with_fonts(3499)と
    dnl    同じ書き方へ揃える ── `AC_ARG_WITH(templates,...)` は action を持たない
    dnl    ので、`${...+set}` は「user が渡したか」を正しく表す。
    dnl    ⚠ 渡さなければ no のまま = 上流の既定は 1 バイトも変わらない。
    test "${with_templates+set}" = set || with_templates=no
    with_x=no
"""


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

    # 🔑 **先に「もう当たっていないか」を見る**(`patch-lo-scripting.py` の作法)──
    #    後に置くと、2 度目の実行が「錨が 0 件」という誤った説明で落ちる。
    if MARK in text:
        print(f"SKIP: 既に当たっている({SRC})")
        return 0

    hits = text.count(ANCHOR)
    if hits != 1:
        print(f"ERROR: 錨が {hits} 件({SRC})── 上流が形を変えた", file=sys.stderr)
        print("  ⚠ configure.ac:3462 の wasm_strip ブロックを読み直すこと", file=sys.stderr)
        return 1

    path.write_text(text.replace(ANCHOR, REPLACE, 1), encoding="utf-8")
    print(f"OK: {SRC} に templates の明示指定を尊重させた(#591)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
