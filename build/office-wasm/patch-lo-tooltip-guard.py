#!/usr/bin/env python3
"""Impress の文書を「ファイル → 閉じる」で閉じたとき、まれに「Office が停止しました」になる件(#1393 形 B)の**門(印つき)**。

## 症状(user の身に起きること)

Impress の文書を閉じる操作の最中に、30 回に 1 回ほど `RuntimeError: memory access out of bounds` で
「Office が停止しました」になる。stack の最上段は `PageObjectLayouter::GetBoundingBox` ←
`ToolTip::DoShow()`(スライド一覧のツールチップ)。stack と実測: https://github.com/sm06224/PKC3/issues/1393#issuecomment-6037204007

## 🔑 原因 ── 閉じている最中に、ツールチップの表示 timer が割り込む

`sd/source/ui/slidesorter/view/SlsToolTip.cxx`(上流 `d6226c1a`):

- Qt6 wasm(JSPI)構成では `ToolTip::maShowTimer` が main スレッドで SolarMutex を持たずに発火する。
  その瞬間に「閉じる」がスライド一覧(slide sorter)を dispose していると、`ToolTip::DoShow()` が走る。
- `DoShow()` が検めるのは `!pWindow`(内容の窓が在るか)だけで、そのあと
  `mrSlideSorter.GetView().GetLayouter().GetPageObjectLayouter()->GetBoundingBox(mpDescriptor, …)` を
  **null 検査なしで**呼ぶ。`GetPageObjectLayouter()` が空なら null 起点の呼び出しになり、
  release の wasm では範囲外アクセスとして落ちる。

## 直し(最小。印を数える門)

`DoShow()` の `!pWindow` の検査の直後に、「いま表示してよい状態か」を 5 つ見る門を足す。足すだけで、
原文の行は 1 行も書き換えない。1 つでも当たれば**そのツールチップ 1 回を出さずに**返る。

| `why=` | 見るもの | 意味 |
|---|---|---|
| 1 | `pWindow->isDisposed()` | 内容の窓が破棄済み |
| 2 | `!pWindow->IsReallyVisible()` | 窓が見えていない(閉じる途中) |
| 3 | `!mpDescriptor` | 対象のページの記述が空 |
| 4 | `!mpDescriptor->GetPage()` | ページ(`SdPage`)が無い |
| 5 | `!…GetPageObjectLayouter()` | ページ枠の配置器が空(原文が null 検査なしで使う所) |

- `std::fprintf(stderr, …)`(libc だけ)の行が、probe が当たった回数と**理由**を数える印を兼ねる(`PKC3-TOOLTIPGUARD:`)。
  🔑 印は **20 回まで**(`g_nPkc3TipSaid`、`patch-lo-viewdata-gone.py` と同じ作法)── ⚠ 上限は**印だけ**で、return は毎回やる。
- 📌 起きる害は「その 1 回のツールチップが出ない」だけ。次のマウス移動で timer が張り直されて出る。

## ⚠ 言えないこと(正直に)

- 🔴 **この門は、ぶら下がった pointer(解放済みの `SdPage` / `PageObjectLayouter`、null でない無効な view 参照)を
  捕まえられない。** 見られるのは「空(null)」と「窓が破棄済み / 見えない」だけである。
  解放済みの物を指しているだけなら、門を素通りして同じ場所で落ちる。
- 次の焼きの `why=` の回数で、当たりが分かる: 1〜2 が出る → 窓が先に消えている(門が効く側)/
  3〜5 が出る → 空の物を読んでいた(門が効く側)/ **どれも 0 回のまま落ちる → この門は原因に届いていない**
  (ぶら下がり。そのときは timer を dispose で止める側へ直す)。
- ⚠ **この箱では compile できない**。`isDisposed()` / `IsReallyVisible()` は `vcl::Window` の member、
  `mpDescriptor` / `GetPageObjectLayouter()` は shared_ptr なので `!` が使える、と原文の宣言で確かめただけ。

## ⚠ 作法(`patch-lo-viewdata-gone.py` と同じ)

- **毎回当たる直し**(入力で gate しない)。錨が**ちょうど 1 件**在ることを書く前に確かめる。1 つでも外れたら何も書かない。
- 既に印が在る(= 当て済み)ときは **SKIP して exit 0**(file は触らない)。
- **足した行は全部 `PKC3-TOOLTIPGUARD` を含む**。原文の行は 1 行も書き換えない(足すだけ)。
"""

import sys
from pathlib import Path

SRC = "sd/source/ui/slidesorter/view/SlsToolTip.cxx"
MARK = "PKC3-TOOLTIPGUARD"

# ── ① include(`std::fprintf`)と、印を出す回数のカウンタ(file scope)─────────────────
INC_ANCHOR = """#include <vcl/help.hxx>
"""
INC_REPLACE = """#include <vcl/help.hxx>
#include <cstdio> // PKC3-TOOLTIPGUARD
namespace { int g_nPkc3TipSaid = 0; } // PKC3-TOOLTIPGUARD
"""

# ── ② `ToolTip::DoShow()` の門(`!pWindow` の検査の直後)──────────────────────────────
# 🔑 錨は 3 行(`pWindow` の取得から `return;` まで)。原文に**1 件**。
GATE_ANCHOR = """    sd::Window *pWindow (mrSlideSorter.GetContentWindow().get());
    if (msCurrentHelpText.isEmpty() || !pWindow)
        return;
"""
GATE_REPLACE = """    sd::Window *pWindow (mrSlideSorter.GetContentWindow().get());
    if (msCurrentHelpText.isEmpty() || !pWindow)
        return;
    // PKC3-TOOLTIPGUARD(#1393 形 B): the show timer fires on the main thread without SolarMutex while Close disposes the slide sorter.
    int nPkc3Why = 0; // PKC3-TOOLTIPGUARD
    if (pWindow->isDisposed()) nPkc3Why = 1; // PKC3-TOOLTIPGUARD
    else if (!pWindow->IsReallyVisible()) nPkc3Why = 2; // PKC3-TOOLTIPGUARD
    else if (!mpDescriptor) nPkc3Why = 3; // PKC3-TOOLTIPGUARD
    else if (!mpDescriptor->GetPage()) nPkc3Why = 4; // PKC3-TOOLTIPGUARD
    else if (!mrSlideSorter.GetView().GetLayouter().GetPageObjectLayouter()) nPkc3Why = 5; // PKC3-TOOLTIPGUARD
    if (nPkc3Why != 0) // PKC3-TOOLTIPGUARD
    { // PKC3-TOOLTIPGUARD
        if (g_nPkc3TipSaid < 20) // PKC3-TOOLTIPGUARD
        { // PKC3-TOOLTIPGUARD
            ++g_nPkc3TipSaid; // PKC3-TOOLTIPGUARD
            std::fprintf(stderr, "PKC3-TOOLTIPGUARD: DoShow skipped why=%d\\n", nPkc3Why); // PKC3-TOOLTIPGUARD
        } // PKC3-TOOLTIPGUARD
        return; // PKC3-TOOLTIPGUARD
    } // PKC3-TOOLTIPGUARD
"""

PARTS = (
    (INC_ANCHOR, INC_REPLACE),
    (GATE_ANCHOR, GATE_REPLACE),
)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-tooltip-guard.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")

    # 🔑 先に「もう当たっていないか」を見る(`patch-lo-scripting.py` の作法)。file は触らない。
    if MARK in text:
        print(f"SKIP: 既に当たっている({SRC})")
        return 0

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
    if text.count("if (g_nPkc3TipSaid < 20)") != 1 or text.count("int nPkc3Why = 0;") != 1:
        print("ERROR: 門が 1 つ入っていない", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if MARK in line)
    if n_marks != n_expected or "DoShow skipped why=" not in after:
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 行(期待 {n_expected})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(ツールチップの表示門 / #1393 形 B ── 足した行 {n_marks})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
