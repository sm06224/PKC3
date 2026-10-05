#!/usr/bin/env python3
"""popup(`QMenu::exec`)が返った後、user event が 13〜16 秒 dispatch されない件(#1344)の**直し**。

## 症状(判別焼き run 37256418166 の実測)

- popup(`QtMenu::ShowNativePopupMenu` の `mpQMenu->exec(...)`)が返った後、round が終わるまで
  **13〜16 秒、user event が 1 件も dispatch されない**(post は約 197 件積まれる)。
  マウスで選ぶ B2 / キーボードで選ぶ B2k の**両方**。
- `exec-ret` の直後(+12〜19 ms)に `PostUserEvent` → `TriggerUserEventProcessing` → `wakeUp()` は
  **呼ばれている**。それでも drain が起きない。
- `ImplYield` / `wake` / `post` の tid は全部同じ(Qt の main)── この build の LO の main loop は main thread で回る。

## 読み(⚠ 未確定。この直しの効きは印で見る)

exec の入れ子 loop は、外側の `ImplYield` → `processEvents(QEventLoop::WaitForMoreEvents)` の中で回っている。
exec が返った後、外側がもう一度待ちへ入ると、`wakeUp()` の印は入れ子 loop が既に消費済みで起きない。

## 直し(Emscripten の `ShowNativePopupMenu` だけ。gate なし ── 常に当たる)

`exec()` が返って関数を出る時に、**JS の `setTimeout` で必ず起きる Qt の event を 1 つ置く**
(`QTimer::singleShot(0, qApp, …)`)。timer の発火そのものが Qt の event なので、外側の待ちは必ず返る。
発火した lambda は `QtInstance::TriggerUserEventProcessing()`(public)も呼ぶ ── 待ちから返った
先で、積まれた user event を drain する印を重ねて立てる。
popup のときだけ通る(`ShowNativePopupMenu` の中)── **読み込み中の経路には触らない**。

🔑 **RAII にした理由**: 錨に使える原文の行が、`exec` の行(menu-trace の錨 `EXEC_ANCHOR`)と
`return true;` の直前(uev-trace の挿入点)の間に**空行しか無く**、その空行は uev-trace の錨の先頭に
含まれる。だから **exec の前の行**を錨にして、局所 struct のデストラクタ(関数を出る時 = exec が返った後)で
置く。3 本は**区間が 1 バイトも重ならず**、どの順で当てても出力が同一(test が見る)。

## ⚠ 作法(`patch-lo-ime-nowait.py` と同じ)

- **毎回当たる直し**。錨が**ちょうど 1 件**在ることを確かめてから当てる。1 件でも外れたら何も書かない。
- 二重当ては exit 1 で **file は 1 バイトも変わらない**。
- **足した行は全部 `PKC3-POPUPWAKE` を含む**(`#if` / `#endif` / 括弧 / 注釈の続きの行も)。
  原文の行は 1 行も書き換えない(足すだけ)ので、印の行を全部除くと原文と一致する(test が見る)。
- `#if defined __EMSCRIPTEN__` の中にだけ本体を置く(非 wasm では include 3 行以外 1 行も変わらない)。
- ⚠ 直しの C++ は LO の header が無い箱ではコンパイルできない ── **焼いて**、
  `PKC3-POPUPWAKE: armed after popup exec` の行が出ること・`exec-ret` の後 1 秒以内に
  `dispatch` が出ることを確かめる。
"""

import sys
from pathlib import Path

SRC = "vcl/qt5/QtMenu.cxx"
MARK = "PKC3-POPUPWAKE"

# ── ① include(`QTimer` / `qApp` / `std::fputs`)─────────────────────────────
# 🔑 無条件に `sal/config.h` の直後へ(他の patch の有無に引きずられない)。
#    ⚠ uev-trace / menu-trace はこの行を錨にしない(ヘルパーは関数の前に入る)。
INC_ANCHOR = """#include <sal/config.h>
"""
INC_REPLACE = """#include <sal/config.h>
#include <cstdio> // PKC3-POPUPWAKE
#include <QtCore/QTimer> // PKC3-POPUPWAKE
#include <QtWidgets/QApplication> // PKC3-POPUPWAKE
"""

# ── ② exec が返った後に Qt の event を 1 つ置く ─────────────────────────────
# 錨は `exec` の**前**の行(原文に 1 件)。⚠ `exec` の行は menu-trace の錨、`return true;` の直前は
# uev-trace の挿入点なので、**どちらにも触れない**。
WAKE_ANCHOR = """    const QRect aRect = toQRect(aFloatRect, 1 / pFrame->devicePixelRatioF());
"""
WAKE_REPLACE = """    const QRect aRect = toQRect(aFloatRect, 1 / pFrame->devicePixelRatioF());
#if defined __EMSCRIPTEN__ // PKC3-POPUPWAKE
    // PKC3-POPUPWAKE(#1344): after the popup's nested loop, the outer processEvents(WaitForMoreEvents)
    // PKC3-POPUPWAKE can go back to waiting with the wakeUp() flag already consumed, so no user event is
    // PKC3-POPUPWAKE drained for 13-16 s. Leaving this function (= exec() returned) puts one real Qt event
    // PKC3-POPUPWAKE (a JS setTimeout) in the queue, which always ends that wait. Only popups pass here.
    struct Pkc3PopupWake // PKC3-POPUPWAKE
    { // PKC3-POPUPWAKE
        ~Pkc3PopupWake() // PKC3-POPUPWAKE
        { // PKC3-POPUPWAKE
            QTimer::singleShot(0, qApp, [] { GetQtInstance().TriggerUserEventProcessing(); }); // PKC3-POPUPWAKE
            std::fputs("PKC3-POPUPWAKE: armed after popup exec\\n", stderr); // PKC3-POPUPWAKE
        } // PKC3-POPUPWAKE
    } aPkc3PopupWake; // PKC3-POPUPWAKE
#endif // PKC3-POPUPWAKE
"""

PARTS = (
    (INC_ANCHOR, INC_REPLACE),
    (WAKE_ANCHOR, WAKE_REPLACE),
)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-popup-wake.py <lo-core-dir>", file=sys.stderr)
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

    for anchor, replace in PARTS:
        text = text.replace(anchor, replace, 1)

    # ⚠ 置換が本当に効いたか(空振りを合格と読まない)
    if text.count("QTimer::singleShot(0, qApp,") != 1:
        print("ERROR: QTimer::singleShot が 1 つ入っていない", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if MARK in line)
    if n_marks != n_expected or "PKC3-POPUPWAKE: armed after popup exec" not in after:
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 行(期待 {n_expected})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(popup の exec が返った後に Qt の event を置く / #1344 ── 足した行 {n_marks})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
