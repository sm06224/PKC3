#!/usr/bin/env python3
"""Impress で枠を Tab → Enter → Esc で操作した後に「ファイル → 閉じる」を押すと Office が停止する件(#1393)の**直し(入口の門)**。

## 症状(user の身に起きること)

Impress の文書で、枠を Tab で選び、Enter で編集に入り、Esc で抜けてから「ファイル → 閉じる」を押すと、
閉じずに「Office が停止しました」になることがある(headless で 3/3 → 翌日 1/5)。
fault は `RuntimeError: table index is out of bounds` か `null function or function signature mismatch`。
何も選ばずに閉じる / 編集してから閉じる(「保存しますか」)と正常に閉じる。

## 🔑 原因 ── dispose の途中に、レイアウトの Idle が割り込む

`vcl/source/control/InterimItemWindow.cxx`(上流 `7f96a38cf750`、`libreoffice-26-8`):

- `InterimItemWindow::dispose()`(:48-59)は `m_xContainer.reset(); m_xBuilder.reset();
  m_xVclContentArea.disposeAndClear();` の**後**に `m_aLayoutIdle.Stop()` を呼ぶ。
- native では dispose の途中にタイマーが走る手段が無い。JSPI 構成の Qt backend では、レイアウトの Idle
  (`Timer::Invoke ← Scheduler::CallbackTaskScheduling ← QtTimer::timeoutActivated`)が main スレッドで走り、
  LO スレッドが SolarMutex を手放した瞬間(`QtInstance.cxx` の `ProcessEvent` の await)に割り込める。
- 割り込んだ `Layout()`(:98-105)は窓の状態を 1 つも検めず、**もう空の**子窓(`GetWindow(FirstChild)`)と
  **破棄済みの** wrapper(`SalInstanceScrolledWindow` など)へ触る。#1393 の stack の
  `table index is out of bounds` はその先。
- 🔴 #117 の直し(`patch-lo-scheduler-task-gone.py`)は `~Task` の**後**(`mpTask` が null)しか見ない。
  dispose の途中は `mpTask` がまだ非 null なので、その門は通り抜ける(= #117 の残りの穴)。

## 直し(最小)

`Layout()` の `m_aLayoutIdle.Stop();` の直後に「`m_xContainer` が無ければ(= dispose が始まっている)
何もせず返る」門を置く。`m_xContainer` は ctor の最後で代入され、dispose の最初の `reset()` で null になる。
Idle は `Stop()` で既に止めてあるので、返っても再予約は残らない。

- ⚠ **未確認(副作用)**: ctor が builder を作っている間(= `m_xContainer` が代入される前)に
  `queue_resize` → `StartIdleLayout` が来れば、この門はその回の Layout を捨てる(再予約はされない。
  後の `queue_resize` / `Resize` で回復する見込み)。⚠ 「ctor の途中に `Layout()` は届かない」とは
  確かめていない。印 `PKC3-LAYOUTGUARD` が停止しない回にも大量に出たら、この副作用を疑う。

- 効いた回数は `std::fputs`(libc だけ)で出す ── probe が `PKC3-LAYOUTGUARD:` の行を数える印でもある。
- 🔴 触らない: ctor / `dispose()` / `StartIdleLayout()` / `Resize()` / `Layout()` の残り。
  足すだけで、原文の行は 1 行も書き換えない。

## 覆る条件

焼いて A(これ)+ B(`patch-lo-hscroll-hdl.py`)でも停止が消えない → 割り込み先が dispose の窓ではない
(subclass の dispose や LO スレッドの別の作業中)。そのときは Layout の Idle を LO スレッドで走らせる案を再検討する
(⚠ 生の `pTask` を後から Invoke するので dangling の穴を新しく作る恐れがあり、今は推さない)。

## ⚠ 作法(`patch-lo-scheduler-task-gone.py` と同じ)

- **毎回当たる直し**(入力で gate しない)。錨が**ちょうど 1 件**在ることを確かめてから当てる。
- 当てた後に印が在ることを確かめる / 二重当ては exit 1 で **file は 1 バイトも変わらない**。
- **足した行は全部 `PKC3-LAYOUTGUARD` を含む**(括弧 / 注釈の続きの行も)。原文の行は 1 行も書き換えない
  (足すだけ)ので、印の行を全部除くと原文と一致する(test が見る)。
- ⚠ **この箱では compile できない**(Qt / LO の header が無い)。**焼いて**、Impress の閉じる probe で
  `PKC3-LAYOUTGUARD: Layout skipped` が出て fault が消えるまで確かめる。
"""

import sys
from pathlib import Path

SRC = "vcl/source/control/InterimItemWindow.cxx"
MARK = "PKC3-LAYOUTGUARD"

# ── ① include(`std::fputs`)────────────────────────────────────────────
# 🔑 無条件に足して印を付ける(在るかを見ない ── 当てる順で出力が変わるのを避ける)
INC_ANCHOR = """#include <window.h>
"""
INC_REPLACE = """#include <window.h>
#include <cstdio> // PKC3-LAYOUTGUARD
"""

# ── ② `Layout()` の入口: m_xContainer が無ければ返る ───────────────────────
# 🔑 錨は `Layout()` の冒頭 3 行の塊。原文に**1 件**(`m_aLayoutIdle.Stop();` は `dispose()` にも在るので
#    行だけでは一意にならない ── 関数の頭ごと錨にする)。
LAYOUT_ANCHOR = """void InterimItemWindow::Layout()
{
    m_aLayoutIdle.Stop();
"""
LAYOUT_REPLACE = """void InterimItemWindow::Layout()
{
    m_aLayoutIdle.Stop();
    // PKC3-LAYOUTGUARD(#1393): dispose() resets m_xContainer first. On wasm/JSPI this Idle can run on the main
    // PKC3-LAYOUTGUARD thread while the LO thread has released the SolarMutex in the middle of dispose(), and
    // PKC3-LAYOUTGUARD would lay out children that are already gone. Without m_xContainer there is nothing to lay out.
    if (!m_xContainer) // PKC3-LAYOUTGUARD
    { // PKC3-LAYOUTGUARD
        std::fputs("PKC3-LAYOUTGUARD: Layout skipped (window not ready or disposing)\\n", stderr); // PKC3-LAYOUTGUARD
        return; // PKC3-LAYOUTGUARD
    } // PKC3-LAYOUTGUARD
"""

# 直しの直前が、Idle を止める行であること(= 止めてから返る。再予約を残さない)
STOP_THEN_FIX = "    m_aLayoutIdle.Stop();\n    // PKC3-LAYOUTGUARD(#1393)"

PARTS = (
    (INC_ANCHOR, INC_REPLACE),
    (LAYOUT_ANCHOR, LAYOUT_REPLACE),
)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-layout-guard.py <lo-core-dir>", file=sys.stderr)
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

    n_stop_before = text.count("m_aLayoutIdle.Stop();")
    for anchor, replace in PARTS:
        text = text.replace(anchor, replace, 1)

    # ⚠ 置換が本当に効いたか(空振りを合格と読まない)
    if text.count("if (!m_xContainer) // PKC3-LAYOUTGUARD") != 1:
        print("ERROR: 入口の門が 1 つ入っていない", file=sys.stderr)
        return 1
    if text.count(STOP_THEN_FIX) != 1:
        print("ERROR: `m_aLayoutIdle.Stop();` の直後に門が入っていない(錨の取り違え)", file=sys.stderr)
        return 1
    # 🔴 足しただけ ── `Stop()` の呼び出しは 1 行も減らない
    if text.count("m_aLayoutIdle.Stop();") != n_stop_before:
        print("ERROR: `m_aLayoutIdle.Stop();` が増減している(足すだけの直しのはず)", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if MARK in line)
    if n_marks != n_expected or "Layout skipped" not in after:
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 行(期待 {n_expected})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(dispose 中の Layout を飛ばす / #1393 ── 足した行 {n_marks})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
