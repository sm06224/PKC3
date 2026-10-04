#!/usr/bin/env python3
"""IME 入力(`ImplHandleExtTextInput`)が wasm/JSPI で process を落とす件(#121)の**直し**。

## 症状

popup / IME 入力のあとに `libc++abi: terminating`(型名の無い = JS 例外)で LO が止まる。
`PKC3-POPUPSYNC` で popup の命令を同期にしても、IME の入力が来ると同じ形で落ちる回が残る。

## 🔑 原因 ── 入力 method の callback の中で `Application::Yield()` を呼んでいる

`vcl/source/window/winproc.cxx` の `ImplHandleExtTextInput` は、frame の focus event がまだ
積まれている(`mnFocusId != 0`)間、`Application::Yield()` を最大 200 回呼んで**待つ**。
LibreOfficeKit だけはここで待たずに `break` する。
wasm では、この関数はブラウザの入力 method の callback の中で動く = **中断できない stack**。
その中の `Yield()` が積まれていた user event を dispatch すると、`QtInstance::ProcessEvent` が
`emscripten_promise_await` で proxy しようとして JS 例外になり、process ごと終わる。

計装(焼き run 37234042770)で観測した、落ちる唯一の経路がこれ(`ImplHandleExtTextInput` の `Yield`)。

## 🔴 取り下げた直し(`patch-lo-yield-proxy-guard.py`、#1342 / e0962741)

「proxy された yield の中でだけ user event を dispatch し、main thread の入れ子 Yield では
queue に残す」と **`Yield` 全体**を締めたら、**文書が開かなくなった**(probe 全 arm が
判定不能・`PKC3-YIELDGUARD` の印が起動 7 秒で出る)。読み込み中の入れ子 Yield も user event を
処理しており、それが進行に必要だった。つまり「入れ子 Yield は常に中断できない」は誤りで、
**落ちるのは入力 method の callback 経路だけ**。だから**その 1 か所だけ**を直す。

## 直し(最小。Emscripten の `ImplHandleExtTextInput` だけ)

LibreOfficeKit と同じ扱いにする: focus event の保留を**待たず**、いまある window へ字を渡す。
`Application::Yield();` の原文の行は `#else` 側にそのまま残す(wasm 以外は 1 字も変わらない)。

- 印(`PKC3-IMENOWAIT: …`)は先頭 20 回だけ stderr へ出す(直しが効いた回数を probe が数える)。
- 🔴 触らない: LibreOfficeKit の枝 / `nTries` のループ / `Yield` を呼ぶ他の経路。

## ⚠ 作法(`patch-lo-menu-popup-sync.py` と同じ)

- **毎回当たる直し**(入力で gate しない)。錨が**ちょうど 1 件**在ることを確かめてから当てる。
- 当てた後に印が在ることを確かめる / 二重当ては exit 1 で **file は 1 バイトも変わらない**。
- **足した行は全部 `PKC3-IMENOWAIT` を含む**(`#if` / `#else` / `#endif` / 括弧 / 注釈の続きの行も)。
  原文の行は 1 行も書き換えない(足すだけ)ので、印の行を全部除くと原文と一致する(test が見る)。
- ⚠ `patch-lo-idles-trace.py` も同じ file を触る(`ImplHandleUserEvent`)。**錨は重ならない**
  (両順で出力が同一 ── test が見る)。
- ⚠ 直しの C++ は LO の header が無い箱ではコンパイルできない ── **焼いて**、IME 入力が通ること・
  `PKC3-IMENOWAIT:` の行が出ること・B2 の fault が消えることを確かめる。
"""

import sys
from pathlib import Path

SRC = "vcl/source/window/winproc.cxx"
MARK = "PKC3-IMENOWAIT"

# ── ① include(`std::fputs`)────────────────────────────────────────────
# 🔑 無条件に `sal/config.h` の直後へ(他の patch の有無に引きずられない)
INC_ANCHOR = """#include <sal/config.h>
"""
INC_REPLACE = """#include <sal/config.h>
#include <cstdio> // PKC3-IMENOWAIT
"""

# ── ② 印のカウンタ(関数の直前。file scope)──────────────────────────────
# 錨は `ImplHandleExtTextInput` の宣言の 1 行目(原文に**1 件**)。直前の行は空行。
COUNTER_ANCHOR = """static bool ImplHandleExtTextInput( vcl::Window* pWindow,
"""
COUNTER_REPLACE = """#if defined __EMSCRIPTEN__ // PKC3-IMENOWAIT
namespace { int g_nPkc3ImeNoWaitSaid = 0; } // PKC3-IMENOWAIT
#endif // PKC3-IMENOWAIT
static bool ImplHandleExtTextInput( vcl::Window* pWindow,
"""

# ── ③ 待つ `Yield` をやめる ────────────────────────────────────────────
# 🔑 `Application::Yield();` は file 内に複数在るので、**LOK の 5 行を含めた塊**を錨にする(1 件)。
#    ⚠ 足す行は**全部**印を含む(注釈の続きの行も)。原文の行は 1 字も変えない。
YIELD_ANCHOR = """        if (comphelper::LibreOfficeKit::isActive())
        {
            SAL_WARN("vcl", "Failed to get ext text input context");
            break;
        }
        Application::Yield();
"""
YIELD_REPLACE = """        if (comphelper::LibreOfficeKit::isActive())
        {
            SAL_WARN("vcl", "Failed to get ext text input context");
            break;
        }
#if defined __EMSCRIPTEN__ // PKC3-IMENOWAIT
        // PKC3-IMENOWAIT(#121): on wasm/JSPI this Yield() runs inside the browser's input-method
        // PKC3-IMENOWAIT callback, whose stack cannot suspend. If a user event is pending, dispatching it from
        // PKC3-IMENOWAIT here (QtInstance::ProcessEvent proxies it with emscripten_promise_await) raises a JS
        // PKC3-IMENOWAIT exception that terminates the process. Treat it like LibreOfficeKit: do not wait for the
        // PKC3-IMENOWAIT pending focus event, deliver the text to the window we have.
        if (g_nPkc3ImeNoWaitSaid < 20) // PKC3-IMENOWAIT
        { // PKC3-IMENOWAIT
            ++g_nPkc3ImeNoWaitSaid; // PKC3-IMENOWAIT
            std::fputs("PKC3-IMENOWAIT: focus event pending; not yielding on wasm\\n", stderr); // PKC3-IMENOWAIT
        } // PKC3-IMENOWAIT
        break; // PKC3-IMENOWAIT
#else // PKC3-IMENOWAIT
        Application::Yield();
#endif // PKC3-IMENOWAIT
"""

PARTS = (
    (INC_ANCHOR, INC_REPLACE),
    (COUNTER_ANCHOR, COUNTER_REPLACE),
    (YIELD_ANCHOR, YIELD_REPLACE),
)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-ime-nowait.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")

    # ⚠ 二重当ては止める(冪等ではない ── 行が 2 組入る)。file は触らない。
    if MARK in text:
        print(f"ERROR: {SRC} に既に {MARK} が入っている(二重当て)", file=sys.stderr)
        return 1

    # ⚠ 錨は全部**ちょうど 1 件**。1 つでも外れたら何も書かない(「半分だけ当たる」を作らない)。
    for anchor, _replace in PARTS:
        hits = text.count(anchor)
        if hits != 1:
            print(
                f"ERROR: 錨が {hits} 件({SRC})。上流が形を変えた可能性がある:\n{anchor[:160]}...",
                file=sys.stderr,
            )
            return 1

    # 足す行は**全部**印を含む(印の無い足し行は、後で「原文」と見分けられない)
    n_expected = 0
    for anchor, replace in PARTS:
        added = _added_lines(anchor, replace)
        bare = [ln for ln in added if MARK not in ln]
        if bare:
            print(f"ERROR: 印の無い足し行が在る(この patch の書き方の誤り): {bare}", file=sys.stderr)
            return 1
        n_expected += len(added)

    n_yield_before = text.count("Application::Yield();")
    for anchor, replace in PARTS:
        text = text.replace(anchor, replace, 1)

    # ⚠ 置換が本当に効いたか(空振りを合格と読まない)
    if text.count("break; // PKC3-IMENOWAIT") != 1:
        print("ERROR: wasm の break が 1 つ入っていない", file=sys.stderr)
        return 1
    # 🔴 原文の `Application::Yield();` は 1 本も減らない(`#else` 側に残る ── wasm 以外は無傷)
    if text.count("Application::Yield();") != n_yield_before:
        print("ERROR: 原文の Application::Yield() が減っている(足すだけの直しのはず)", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if MARK in line)
    if n_marks != n_expected or "focus event pending; not yielding on wasm" not in after:
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 行(期待 {n_expected})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(IME 入力の中の Yield をやめる / #121 ── 足した行 {n_marks})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
