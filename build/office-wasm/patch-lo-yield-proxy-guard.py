#!/usr/bin/env python3
"""JSPI の wasm で「main thread の入力 callback の中の `Application::Yield()`」が user event を
dispatch して落ちる件(#121)の**直し**。

## 症状

Writer で IME の入力(`ImplHandleExtTextInput`)や popup の「コピー」のあと、
`libc++abi: terminating` → `RuntimeError: unreachable`(再現 3/3)で LO ごと落ちる。

## 🔑 原因 ── dispatch してよい stack と、してはいけない stack が区別されていない

計装(焼き run 37234042770 の probe)で割れた事実(推測ではない):

1. JSPI の wasm build では、LO の main loop は **event handler thread**(別 pthread)で回る。
   `QtInstance::DoYield`(`vcl/qt5/QtInstance.cxx`)はそこから `emscripten_proxy_promise` で
   **main(ブラウザ)thread** へ `DoYield` を proxy し、main thread の `ImplYield` →
   `DispatchUserEvents` → `QtInstance::ProcessEvent` が、各 user event の処理を event handler thread へ
   **`emscripten_promise_await` で proxy し戻す**。
   この往復は、main thread 側が「proxy された task」の中(JSPI で**中断できる** stack)に居るときだけ成立する。
2. ところが main thread の**入力 callback の中**で LO が `Application::Yield()` を呼ぶ経路が在る
   (実測: `ImplHandleExtTextInput`(`vcl/source/window/winproc.cxx`)の `Application::Yield()`)。
   そこは `DoYield` の「`qApp->thread() == QThread::currentThread()`」の枝で `ImplYield` を**直に**回す。
   **user event が 1 つでも溜まっていると**、`ProcessEvent` の `emscripten_promise_await` が
   中断できない stack から呼ばれ、JS 例外 → `SalUserEventList::DispatchUserEvents` の
   `noexcept` な lambda で `libc++abi: terminating`。
3. 溜まっていた event は `Window::ImplGenerateMouseMove` が積んだ物で、通常 loop が 12 秒処理していなかった。

## 直し(最小。Emscripten + JSPI の build だけ)

**proxy された yield の中でだけ** user event を dispatch する。

- `DoYield` の proxy lambda が `DoYield` を呼ぶ前後で、この file の静的な旗 `g_bPkc3InProxiedYield` を
  立てて戻す(旗を読み書きするのは main thread だけ ── 入れ子の Yield も proxy された task も main thread)。
- `ImplYield` は、旗が立っているときだけ `DispatchUserEvents` する(= 原文のまま)。
  旗が無い(= 入れ子の main-thread Yield)ときは `DispatchUserEvents` を**飛ばし**、event は queue に
  残す。残した event を取り逃がさないよう `TriggerUserEventProcessing()` で loop を起こす。
- 印 `PKC3-YIELDGUARD: user events deferred (nested main-thread yield)` を stderr へ
  (probe が数える。回数は多くなりうるので**先頭 20 回だけ**。以後は黙る)。
- 🔴 触らない: `DispatchUserEvents` の中身 / `ProcessEvent` / `DoYield` の他の枝 / 非 JSPI の build
  (`#else` 側は原文のまま)。

## ⚠ 作法(`patch-lo-menu-popup-sync.py` と同じ)

- **毎回当たる直し**(入力で gate しない)。錨が**ちょうど 1 件**在ることを確かめてから当てる。
- 当てた後に印が在ることを確かめる / 二重当ては exit 1 で **file は 1 バイトも変わらない**。
- **足した行は全部 `PKC3-YIELDGUARD` を含む**(`#if` / `#else` / `#endif` / 括弧 / 注釈の続きの行も)。
  原文の行は 1 行も書き換えない(足すだけ。`bool wasEvent = DispatchUserEvents(…)` の原文の行は
  `#else` 側にそのまま残る)ので、印の行を全部除くと原文と一致する(test が見る)。
- ⚠ 直しの C++ は Qt / LO の header が無い箱ではコンパイルできない ── **焼いて**、probe が
  `PKC3-YIELDGUARD: user events deferred` を出して**落ちずに**入力が通るまで確かめる。

## ⚠ 同じ file に当たる他の 2 本との関係(どの順でも出力が同一)

- `patch-lo-idles-trace.py`(gate 付き計装): `ImplYield` の**頭**を錨にしている。
  - 🔴 (b) の旗は**`ImplYield` の 2 行前**(`CreateSalSystem` の直後)へ置く。計装のヘルパーは
    `bool QtInstance::ImplYield(` の**直前**へ入るので、同じ点へ 2 つ入れると**順番で出力が変わる**。
  - 🔴 (c) の錨は計装の旧い錨(`SolarMutexGuard aGuard;` + `bool wasEvent = …` の連続 2 行)の中に
    在ったので、計装側の錨を割った(`yield:disp` の塊は `if (!bHandleAllCurrentEvents && wasEvent)` の
    直前へ。計装だけを当てたときの出力は 1 バイトも変わらない)。
- `patch-lo-qt-cjk-fonts.py`: `<QtGui/QStyleHints>` の include と `CreateQApplication` の末尾。重ならない。
"""

import sys
from pathlib import Path

SRC = "vcl/qt5/QtInstance.cxx"
MARK = "PKC3-YIELDGUARD"

# 3 つの `#if` は、この file が JSPI の枝に使っている条件と**同じ字**にする(`ImplYield` /
# `DoYield` の lambda / `ProcessEvent` と揃える)。
JSPI_IF = "#if defined __EMSCRIPTEN__ && ENABLE_QT6 && HAVE_EMSCRIPTEN_JSPI && !HAVE_EMSCRIPTEN_PROXY_TO_PTHREAD"

# ── ① include(`std::fputs`)────────────────────────────────────────────
#    ⚠ 原文に `<cstdio>` は無い(原文を grep して 0 件)。**無条件に足す**(下の `main` の注を参照)。
INC_ANCHOR = """#include <sal/config.h>
"""
INC_REPLACE = """#include <sal/config.h>
#include <cstdio> // PKC3-YIELDGUARD
"""

# ── ② file 内の静的な旗 ──────────────────────────────────────────────────
# 🔑 錨は `CreateSalSystem` の 1 行(= `ImplYield` の 2 行前)。⚠ `ImplYield` の定義の**直前**を錨に
#    しない ── `patch-lo-idles-trace.py` のヘルパーが同じ点へ入り、順番で出力が変わる。
#    旗は `ImplYield`(452 行)と `DoYield` の lambda(473 行〜)より**前**に在る。
FLAG_ANCHOR = """SalSystem* QtInstance::CreateSalSystem() { return new QtSystem; }
"""
FLAG_REPLACE = f"""SalSystem* QtInstance::CreateSalSystem() {{ return new QtSystem; }}
{JSPI_IF} // PKC3-YIELDGUARD
namespace // PKC3-YIELDGUARD
{{ // PKC3-YIELDGUARD
bool g_bPkc3InProxiedYield = false; // PKC3-YIELDGUARD
int g_nPkc3YieldGuardSaid = 0; // PKC3-YIELDGUARD
}} // PKC3-YIELDGUARD
#endif // PKC3-YIELDGUARD
"""

# ── ③ `ImplYield`: proxy された yield の中でだけ dispatch する ────────────────
#    原文の 1 行(4 字下げ)。`#else` 側へ**そのまま**残す。
YIELD_ANCHOR = """    bool wasEvent = DispatchUserEvents(bHandleAllCurrentEvents);
"""
YIELD_REPLACE = f"""{JSPI_IF} // PKC3-YIELDGUARD
    // PKC3-YIELDGUARD(#121): ProcessEvent proxies each user event to the event handler thread
    // PKC3-YIELDGUARD with emscripten_promise_await, which only works while this ImplYield itself runs inside the
    // PKC3-YIELDGUARD DoYield task proxied from that thread. A nested Application::Yield() from a main-thread
    // PKC3-YIELDGUARD input callback (e.g. ImplHandleExtTextInput) is not suspendable there and terminated the
    // PKC3-YIELDGUARD process whenever a user event was pending. Leave the queue to the proxied yield instead.
    bool wasEvent = false; // PKC3-YIELDGUARD
    if (g_bPkc3InProxiedYield) // PKC3-YIELDGUARD
        wasEvent = DispatchUserEvents(bHandleAllCurrentEvents); // PKC3-YIELDGUARD
    else if (HasUserEvents()) // PKC3-YIELDGUARD
    {{ // PKC3-YIELDGUARD
        if (g_nPkc3YieldGuardSaid < 20) // PKC3-YIELDGUARD
        {{ // PKC3-YIELDGUARD
            ++g_nPkc3YieldGuardSaid; // PKC3-YIELDGUARD
            std::fputs("PKC3-YIELDGUARD: user events deferred (nested main-thread yield)\\n", stderr); // PKC3-YIELDGUARD
        }} // PKC3-YIELDGUARD
        TriggerUserEventProcessing(); // PKC3-YIELDGUARD
    }} // PKC3-YIELDGUARD
#else // PKC3-YIELDGUARD
    bool wasEvent = DispatchUserEvents(bHandleAllCurrentEvents);
#endif // PKC3-YIELDGUARD
"""

# ── ④ `DoYield` の proxy lambda: 旗を立てて戻す ──────────────────────────────
#    原文の 1 行(16 字下げ)。この lambda は JSPI の `#if` の中に在るので、旗の条件と揃う。
PROXY_ANCHOR = """                args.bWasEvent = args.This->DoYield(args.bWait, args.bHandleAllCurrentEvents);
"""
PROXY_REPLACE = """                g_bPkc3InProxiedYield = true; // PKC3-YIELDGUARD
                args.bWasEvent = args.This->DoYield(args.bWait, args.bHandleAllCurrentEvents);
                g_bPkc3InProxiedYield = false; // PKC3-YIELDGUARD
"""

PARTS = (
    (INC_ANCHOR, INC_REPLACE),
    (FLAG_ANCHOR, FLAG_REPLACE),
    (YIELD_ANCHOR, YIELD_REPLACE),
    (PROXY_ANCHOR, PROXY_REPLACE),
)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-yield-proxy-guard.py <lo-core-dir>", file=sys.stderr)
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

    # ⚠ `<cstdio>` が在るかで足すかを**決めない**: `patch-lo-idles-trace.py` のヘルパー(file の途中へ入る)も
    #    `<cstdio>` を持つので、先に当たっていると足さなくなり、**順番で出力が変わる**。
    #    二重 include は無害(include guard)。
    parts = PARTS

    # 足す行は**全部**印を含む(印の無い足し行は、後で「原文」と見分けられない)
    n_expected = 0
    for anchor, replace in parts:
        added = _added_lines(anchor, replace)
        bare = [ln for ln in added if MARK not in ln]
        if bare:
            print(f"ERROR: 印の無い足し行が在る(この patch の書き方の誤り): {bare}", file=sys.stderr)
            return 1
        n_expected += len(added)

    n_dispatch_before = text.count("DispatchUserEvents(bHandleAllCurrentEvents)")
    for anchor, replace in parts:
        text = text.replace(anchor, replace, 1)

    # ⚠ 置換が本当に効いたか(空振りを合格と読まない)
    if text.count("if (g_bPkc3InProxiedYield) // PKC3-YIELDGUARD") != 1:
        print("ERROR: ImplYield の旗の分岐が 1 つ入っていない", file=sys.stderr)
        return 1
    if text.count("g_bPkc3InProxiedYield = true; // PKC3-YIELDGUARD") != 1:
        print("ERROR: DoYield の lambda に旗を立てる行が 1 つ入っていない", file=sys.stderr)
        return 1
    # 🔴 `DispatchUserEvents` は足しただけ(旗の中の 1 回 + `#else` 側の原文の 1 回 = 元の 1 回 + 1 回)
    if text.count("DispatchUserEvents(bHandleAllCurrentEvents)") != n_dispatch_before + 1:
        print("ERROR: DispatchUserEvents の呼び出しが「元 + 旗の中の 1 回」になっていない", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if MARK in line)
    if n_marks != n_expected or "user events deferred (nested main-thread yield)" not in after:
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 行(期待 {n_expected})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(proxy された yield の中でだけ user event を dispatch / #121 ── 足した行 {n_marks})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
