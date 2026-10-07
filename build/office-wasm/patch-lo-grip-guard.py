#!/usr/bin/env python3
"""Impress を開いたとき、約 3 % で「Office が停止しました」になる件(#1402)の**印と null 門**。

## 症状(user の身に起きること)

Impress(`.odp`)を開くと、開いた直後に何もしていないのに `RuntimeError: memory access out of bounds` で
「Office が停止しました」になることがある(約 3 %)。出ない回は正常に使える。
stack の最上段は `SalGraphics::DrawPolyLine`(非 virtual の wrapper)←
`OutputDevice::DrawPolygon(tools::Polygon)`(hairline の経路)← `SplitWindow::ImplDrawGrip`。
stack と実測: https://github.com/sm06224/PKC3/issues/1402#issuecomment-6037204233

## 🔑 読んでいること(推測。実機では未確認)

`vcl/source/outdev/polygon.cxx`(上流 `d6226c1a`)の `OutputDevice::DrawPolygon(const tools::Polygon&)`:

- 冒頭で `mpGraphics` を取り(`AcquireGraphics()`)、`IsFillColor()` なら `mpGraphics->DrawPolyPolygon(...)` で塗り、
  そのあと `IsLineColor()` なら `mpGraphics->DrawPolyLine(...)` で縁を引く。
- Qt6 wasm(JSPI)では**塗りの呼び出し**が main スレッドへ hop する(`QtFrame::Damage`)ので、その間に
  `mpGraphics` が別の経路で解放 / 差し替えされうる。縁を引く直前に `mpGraphics` を**読み直しても、誰も再検査しない**。
  `SalGraphics::DrawPolyLine` は非 virtual の wrapper なので、`this` が無効だと wrapper の中で落ちる。

## この patch がすること(⚠ 直しではなく、主に**印**)

縁を引く直前(`DrawPolyLine` の呼び出しの前)に 2 つ足す。足すだけで、原文の行は 1 行も書き換えない。

1. **null 門**: `mpGraphics` が null なら、印を出して**縁を引かずに**返る。
2. **印**: `mpGraphics` と `this` と(Emscripten のときだけ)残りの stack を、**100 回まで**出す
   (`g_nPkc3GripSaid`)。`DrawPolyLine` から**戻った**ときにも 1 行出す(その回に前の印を出した場合だけ)。
   🔑 `before` が出て `after` が出ないまま落ちれば、落ちたのは `DrawPolyLine` の中である。

## ⚠ 言えないこと(正直に)

- 🔴 **この patch は、ぶら下がった pointer(解放済みの `SalGraphics` を指したままの `mpGraphics`)を直せない。**
  null 門が捕まえるのは「null になっていた」場合だけで、解放済みの物を指しているだけなら素通りして同じ場所で落ちる。
- 次の焼きで読む: `mpGraphics null` の行が出る → null 門が効いた(その回の縁が 1 本出ない)/
  `before` が出て `after` が出ない → `DrawPolyLine` の中で落ちている(`gfx=` の値が前後の回と違うかを見る)/
  `before` が出ず落ちる → この経路ではない(`DrawPolygon` に来る前)。
- ⚠ **この箱では compile できない**。`emscripten_stack_get_free()` は `<emscripten/stack.h>` の関数(`__EMSCRIPTEN__` の中だけ使う)。

## ⚠ 作法(錨と印は `patch-lo-viewdata-gone.py`、当て済みの扱いは `patch-lo-scripting.py` と同じ)

- **毎回当たる直し**(入力で gate しない)。錨が**ちょうど 1 件**在ることを書く前に確かめる。1 つでも外れたら何も書かない。
- 印の行数が期待どおり(= 当て済み)なら **SKIP して exit 0**(file は触らない)。印が在るのに行数が違う
  (部分適用 / 手編集)は **exit 1** ── 門なしで焼かない(`patch-lo-scripting.py` の SKIP と同じ向き)。
- **足した行は全部 `PKC3-GRIPGUARD` を含む**。原文の行は 1 行も書き換えない(足すだけ)。
"""

import sys
from pathlib import Path

SRC = "vcl/source/outdev/polygon.cxx"
MARK = "PKC3-GRIPGUARD"

# ── ① include と、印を出す回数のカウンタ(file scope)────────────────────────────────────
INC_ANCHOR = """#include <cassert>
#include <memory>
"""
INC_REPLACE = """#include <cassert>
#include <memory>
#include <cstdio> // PKC3-GRIPGUARD
#ifdef __EMSCRIPTEN__ // PKC3-GRIPGUARD
#include <emscripten/stack.h> // PKC3-GRIPGUARD
#endif // PKC3-GRIPGUARD
namespace { int g_nPkc3GripSaid = 0; } // PKC3-GRIPGUARD
"""

# ── ② `DrawPolygon(const tools::Polygon&)` の hairline の経路(`DrawPolyLine` の直前)─────────────
# 🔑 錨は `bool bSuccess(true);` から `bSuccess = mpGraphics->DrawPolyLine(` まで。原文に**1 件**。
#    足す所は 2 つ: `bSuccess(true)` の直後(印の旗)と、空行と `DrawPolyLine` の間(null 門と印)。
LINE_ANCHOR = """        bool bSuccess(true);
        if (IsLineColor())
        {
            const bool bPixelSnapHairline(mnAntialiasing & AntialiasingFlags::PixelSnapHairline);

            bSuccess = mpGraphics->DrawPolyLine(
"""
LINE_REPLACE = """        bool bSuccess(true);
        bool bPkc3Said = false; // PKC3-GRIPGUARD
        if (IsLineColor())
        {
            const bool bPixelSnapHairline(mnAntialiasing & AntialiasingFlags::PixelSnapHairline);

            // PKC3-GRIPGUARD(#1402): mpGraphics is read again here after the fill call, which hops to the main thread.
            if (!mpGraphics) // PKC3-GRIPGUARD
            { // PKC3-GRIPGUARD
                std::fputs("PKC3-GRIPGUARD: mpGraphics null after fill (line skipped)\\n", stderr); // PKC3-GRIPGUARD
                return; // PKC3-GRIPGUARD
            } // PKC3-GRIPGUARD
            if (g_nPkc3GripSaid < 100) // PKC3-GRIPGUARD
            { // PKC3-GRIPGUARD
                ++g_nPkc3GripSaid; // PKC3-GRIPGUARD
                bPkc3Said = true; // PKC3-GRIPGUARD
#ifdef __EMSCRIPTEN__ // PKC3-GRIPGUARD
                std::fprintf(stderr, "PKC3-GRIPGUARD: before gfx=%p dev=%p stackfree=%lu\\n", static_cast<void*>(mpGraphics), static_cast<const void*>(this), static_cast<unsigned long>(emscripten_stack_get_free())); // PKC3-GRIPGUARD
#else // PKC3-GRIPGUARD
                std::fprintf(stderr, "PKC3-GRIPGUARD: before gfx=%p dev=%p\\n", static_cast<void*>(mpGraphics), static_cast<const void*>(this)); // PKC3-GRIPGUARD
#endif // PKC3-GRIPGUARD
            } // PKC3-GRIPGUARD
            bSuccess = mpGraphics->DrawPolyLine(
"""

# ── ③ `DrawPolyLine` から戻った直後(`if(bSuccess)` の前)──────────────────────────────────
AFTER_ANCHOR = """        if(bSuccess)
            return;
    }

    tools::Polygon aPoly = ImplLogicToDevicePixel( rPoly );
"""
AFTER_REPLACE = """        if (bPkc3Said) std::fputs("PKC3-GRIPGUARD: after DrawPolyLine returned\\n", stderr); // PKC3-GRIPGUARD
        if(bSuccess)
            return;
    }

    tools::Polygon aPoly = ImplLogicToDevicePixel( rPoly );
"""

PARTS = (
    (INC_ANCHOR, INC_REPLACE),
    (LINE_ANCHOR, LINE_REPLACE),
    (AFTER_ANCHOR, AFTER_REPLACE),
)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-grip-guard.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")

    # 足す行は**全部**印を含む(印の無い足し行は、後で「原文」と見分けられない)
    n_expected = 0
    for anchor, replace in PARTS:
        added = _added_lines(anchor, replace)
        bare = [ln for ln in added if MARK not in ln]
        if bare:
            print(f"ERROR: 印の無い足し行が在る(この patch の書き方の誤り): {bare}", file=sys.stderr)
            return 1
        n_expected += len(added)

    # 🔑 先に「もう当たっていないか」を見る(`patch-lo-scripting.py` の SKIP と同じ向き)。file は触らない。
    # ⚠ 「印が在る」だけでは SKIP しない ── 印の行数が期待どおりのときだけ当て済みと読む。
    #    印が在るのに行数が違う(部分適用 / 手で直した)file は、門なしで焼かないために exit 1。
    if MARK in text:
        n_have = sum(1 for line in text.splitlines() if MARK in line)
        if n_have == n_expected:
            print(f"SKIP: 既に当たっている({SRC}、印 {n_have} 行)")
            return 0
        print(
            f"ERROR: 印が {n_have} 行だけ在る(期待 {n_expected})── 部分適用か手編集。{SRC} を上流の形に戻してから当て直す",
            file=sys.stderr,
        )
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

    for anchor, replace in PARTS:
        text = text.replace(anchor, replace, 1)

    # ⚠ 置換が本当に効いたか(空振りを合格と読まない)
    if (
        text.count("if (g_nPkc3GripSaid < 100)") != 1
        or text.count("bool bPkc3Said = false;") != 1
        or text.count("after DrawPolyLine returned") != 1
    ):
        print("ERROR: 門か印が 1 つ入っていない", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if MARK in line)
    if n_marks != n_expected or "mpGraphics null after fill" not in after:
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 行(期待 {n_expected})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(DrawPolygon の縁の前に null 門と印 / #1402 ── 足した行 {n_marks})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
