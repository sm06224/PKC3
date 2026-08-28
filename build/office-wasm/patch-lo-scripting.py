#!/usr/bin/env python3
"""🔴 **マクロ(Basic)を wasm でも有効にできるようにする**(#431)。

> user 指示 2026-08-28:「**いまだに動かないマクロ機能なども全部完璧で
> 動かせるようにしっかり対応していきましょう**」

## ⚠ #431 の前提は間違っていた

#431 は「**上流の `LibreOfficeWASM32.conf` に `--disable-scripting` が在るから**」と
書いていた。⚠ それは**表面**であって、原因ではない ── 2026-08-28 に実際に外して
焼いたら、configure は通ったのに `BUILD_TYPE` に `SCRIPTING` が入らなかった。

上流を読むと、**2 段で潰されている**:

| 場所 | 何をしているか |
|---|---|
| `configure.ac:1301` | Emscripten の host case で **`enable_wasm_strip=yes` を無条件に**立てる |
| `configure.ac:3462` | `if test "$enable_wasm_strip" = "yes"; then` に入る |
| `configure.ac:3485` | その中で **`enable_scripting=no` を無条件に**上書きする |

🔑 だから:

- `--disable-scripting` を**外しても効かない**(既定 `yes` が 3485 で潰される)
- `--enable-scripting` を**渡しても効かない**(同上 ── option 解析は 1668 行、
  上書きは 3485 行なので**後から来るほうが勝つ**)
- ⚠ `--disable-wasm-strip` でも逃げられない(`configure.ac:1301` が host case で
  無条件に立てる ── これは 2026-08-14 に確認済みで CLAUDE.md にも書いてある)

## ⚠ 1 稿目の直しは**間違っていた**(書いた直後に検算して気づいた)

同じブロックの `enable_dynamic_loading` は明示指定を尊重する書き方なので、
最初はそれへ揃えようとした:

    test "${enable_scripting+set}" = set || enable_scripting=no   # 🔴 効かない

🔴 **これは効かない。** `dynamic-loading` の `AC_ARG_ENABLE` は
**`action-if-not-given` を持たない**(`configure.ac:1676-1679`)ので
`${...+set}` が「user が渡したか」を表すが、`scripting` のほうは
**持っている**(`configure.ac:1671` が渡されなくても `yes` を代入する)──
つまり `${enable_scripting+set}` は **常に set** で、条件が意味を成さない。
⚠ そのまま入れていたら、**wasm の既定まで scripting on** になっていた
(docstring には「既定は変わらない」と書いていたので、**嘘を残すところだった**)。

## 🔑 直し ── **上流が触らない合図**を使う

`PKC3_WASM_SCRIPTING` という環境変数で開ける。上流はこの名前を 1 度も読まないので、
**渡さない限り既定(`no`)のまま**である:

    test "$PKC3_WASM_SCRIPTING" = yes || enable_scripting=no

🔑 これなら「既定は 1 バイトも変わらない」が**本当に**成り立つ。
⚠ 合図は workflow の `env:` で渡す ── conf の option にしないのは、
`--enable-scripting` が上流の意味論(1671 行)と混ざって読みにくくなるためである。

## ⚠ これは「通るか」を見る段である

configure が通っても、**make が通るとは限らない**(Basic のコードが wasm で
リンクできるかは別問題)。⚠ 落ちたら**何で落ちたかを書いて止める**(#431 の約束)。
"""

from __future__ import annotations

import sys
from pathlib import Path

SRC = "configure.ac"

# ⚠ 錨は**前後の行を含めて**一意にする(`enable_scripting=no` だけだと弱い)。
#    実測: master / libreoffice-26-8 の両方でちょうど 1 件。
ANCHOR = """    enable_report_builder=no
    enable_scripting=no
    enable_sdremote=no
"""

REPLACE = """    enable_report_builder=no
    dnl 🔴 PKC3: マクロ(Basic)を開けるようにする(#431)。
    dnl    元は `enable_scripting=no` の無条件代入で、`--disable-scripting` を
    dnl    外しても `--enable-scripting` を渡しても**後から潰されていた**。
    dnl    ⚠ `${enable_scripting+set}` は使えない ── 1671 行が渡されなくても
    dnl    値を代入するので、常に set になる(隣の dynamic_loading とは事情が違う)。
    dnl    🔑 上流が 1 度も読まない名前で開ける = 渡さなければ既定の no のまま。
    test "$PKC3_WASM_SCRIPTING" = yes || enable_scripting=no
    enable_sdremote=no
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

    # 🔑 **先に「もう当たっていないか」を見る**(`patch-lo-qt-cjk-fonts.py` の作法)──
    #    後に置くと、2 度目の実行が「錨が 0 件」という誤った説明で落ちる。
    if 'test "$PKC3_WASM_SCRIPTING" = yes || enable_scripting=no' in text:
        print(f"SKIP: 既に当たっている({SRC})")
        return 0

    hits = text.count(ANCHOR)
    if hits != 1:
        print(f"ERROR: 錨が {hits} 件({SRC})── 上流が形を変えた", file=sys.stderr)
        print("  ⚠ configure.ac:3462 の wasm_strip ブロックを読み直すこと", file=sys.stderr)
        return 1

    path.write_text(text.replace(ANCHOR, REPLACE, 1), encoding="utf-8")
    print(f"OK: {SRC} に scripting の明示指定を尊重させた(#431)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
