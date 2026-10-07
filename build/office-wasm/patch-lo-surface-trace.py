#!/usr/bin/env python3
"""閉じた直後に本体スレッドが落ちる件(#1402)の**計装**。cairo の surface が差し替わる瞬間を、時刻つきで出す。直しではない。

## 症状(user の身に起きること)

Office(Impress など)を閉じた直後に、`ThumbnailView::Paint` ← `createPixelProcessor2DFromOutputDevice` で
`RuntimeError: memory access out of bounds` になり「Office が停止しました」になることがある。
stack と実測: https://github.com/sm06224/PKC3/issues/1402#issuecomment-6048200059

## 🔑 読んでいること(推測。実機では未確認)

`vcl/qt5/QtSvpSalFrame.cxx`(上流 `d6226c1a`)の `QtSvpSalFrame::DoHandleResizeEvent()` は、**main で、SolarMutex を取らずに**
新しい cairo surface を作り、`m_pSvpGraphics->setSurface(...)` で差し替え、古い surface を `cairo_surface_destroy`(`UniqueCairoSurface`
の dtor)する。本体スレッドはその間、`OutputDevice::GetSystemGfxData()` → `GetGraphicsData()` で受け取った**生の `pSurface`** を
`CairoPixelProcessor2D` の ctor で `cairo_image_surface_get_width/height(pTarget)` する。差し替えと破棄が、その読みの最中に起きれば
解放済みの surface を読む = `memory access out of bounds`。

## この patch がすること(⚠ 直しではなく**印**)

`DoHandleResizeEvent` の中の、surface を差し替える所に **3 行**足す(足すだけで、原文の行は 1 行も書き換えない):

| 印 | 出す所 | 読み方 |
|---|---|---|
| `PKC3-SURFACE: resize before frame=%p gfx=%p old=%p new=%p w=%d h=%d t=%lld` | 新しい surface を作った**後**、`setSurface` の**前** | `old` はいま本体スレッドが握っているかもしれない pointer |
| `PKC3-SURFACE: resize after frame=%p gfx=%p old=%p new=%p w=%d h=%d t=%lld` | `m_pSurface.reset(pSurface)` の**直後** | ここから `GetGraphicsData()` は `new` を返す |
| `PKC3-SURFACE: resize destroy old=%p t=%lld` | `copySource` の**直後**(= この直後に `old_surface` の dtor が `cairo_surface_destroy` する) | `old` が無効になる時刻 |

- `t=` は `std::chrono::steady_clock` の ms(wasm ではページ開始からの経過)。`PKC3-SDPR` / `PKC3-GFXDATA`(同じ #1402 の計装)の `t=` と同じ時計なので、
  **`destroy old=X` の時刻より後に、`PKC3-SDPR: enter` / `PKC3-GFXDATA: surface … surface=X` が同じ X を読んでいれば**「差し替えで捨てた surface を読んだ」と言える。
- `gfx=` は `m_pSvpGraphics.get()`(`PKC3-GFXDATA` の `gfx=` と突き合わせる)。resize は頻度が低いので**毎回**出す(上限なし)。
- `frame=` は `this`(複数の frame が在るとき、どの frame の差し替えか)。

## ⚠ 言えないこと(正直に)

- 🔴 **この patch は、差し替えと読みの競合を直さない**(印だけ)。落ちる回の最後の `resize destroy` が落ちた時刻の直前にあるかを読む。
- 差し替えが**起きていない**回に落ちるなら、この仮説(resize との競合)は外れ。その場合は `PKC3-GFXDATA: gfx changed`(別の候補)を見る。
- ⚠ **本物の Qt / cairo / LO の header ではまだ compile していない**。`tests/office-surface-trace-patch.test.ts` が、当てた後の `DoHandleResizeEvent` 全体を型だけ stub に替えて
  g++(`-Wall -Wextra -Werror`)でコンパイルして走らせ、印の出る順番(before → 差し替え → after → 複写 → destroy → 実際の破棄)と pointer の対応は確かめている。

## ⚠ 作法(錨と印は `patch-lo-grip-guard.py` と同じ)

- **毎回当たる**(入力で gate しない)。錨が**ちょうど 1 件**在ることを書く前に確かめる。1 つでも外れたら何も書かない。
- 印の行数が期待どおり(= 当て済み)なら **SKIP して exit 0**(file は触らない)。印が在るのに行数が違う(部分適用 / 手編集)は **exit 1**。
- **足した行は全部 `PKC3-SURFACE` を含む**。原文の行は 1 行も書き換えない(足すだけ)。
- ヘルパー関数は作らない(`check-patch-scope.py` の SPECS の外 ── lambda を関数の中に置くだけ)。
"""

import sys
from pathlib import Path

SRC = "vcl/qt5/QtSvpSalFrame.cxx"
MARK = "PKC3-SURFACE"

# ── ① include(`std::fprintf` と `std::chrono`)── ⚠ `.moc` の include より前に置く ──────────
INC_ANCHOR = """#include <QtSvpSalFrame.hxx>
#include <QtSvpSalFrame.moc>
"""
INC_REPLACE = """#include <QtSvpSalFrame.hxx>
#include <cstdio> // PKC3-SURFACE
#include <chrono> // PKC3-SURFACE
#include <QtSvpSalFrame.moc>
"""

# ── ② 差し替えの前(`setSurface` の前)と後(`m_pSurface.reset` の後)──────────────────────
SWAP_ANCHOR = """            m_pSvpGraphics->setSurface(pSurface, basegfx::B2IVector(nWidth, nHeight));
            UniqueCairoSurface old_surface(m_pSurface.release());
            m_pSurface.reset(pSurface);
"""
SWAP_REPLACE = """            // PKC3-SURFACE(#1402): log the surface swap with a timestamp, to compare with PKC3-SDPR / PKC3-GFXDATA.
            auto const pPkc3Ms = []() -> long long // PKC3-SURFACE
            { // PKC3-SURFACE
                return std::chrono::duration_cast<std::chrono::milliseconds>( // PKC3-SURFACE
                           std::chrono::steady_clock::now().time_since_epoch()) // PKC3-SURFACE
                    .count(); // PKC3-SURFACE
            }; // PKC3-SURFACE
            std::fprintf(stderr, "PKC3-SURFACE: resize before frame=%p gfx=%p old=%p new=%p w=%d h=%d t=%lld\\n", static_cast<void*>(this), static_cast<void*>(m_pSvpGraphics.get()), static_cast<void*>(m_pSurface.get()), static_cast<void*>(pSurface), nWidth, nHeight, pPkc3Ms()); // PKC3-SURFACE
            m_pSvpGraphics->setSurface(pSurface, basegfx::B2IVector(nWidth, nHeight));
            UniqueCairoSurface old_surface(m_pSurface.release());
            m_pSurface.reset(pSurface);
            std::fprintf(stderr, "PKC3-SURFACE: resize after frame=%p gfx=%p old=%p new=%p w=%d h=%d t=%lld\\n", static_cast<void*>(this), static_cast<void*>(m_pSvpGraphics.get()), static_cast<void*>(old_surface.get()), static_cast<void*>(m_pSurface.get()), nWidth, nHeight, pPkc3Ms()); // PKC3-SURFACE
"""

# ── ③ 古い surface が捨てられる直前(`copySource` の後。この直後に `old_surface` の dtor が走る)──────
DESTROY_ANCHOR = """            m_pSvpGraphics->copySource(rect, old_surface.get());
"""
DESTROY_REPLACE = """            m_pSvpGraphics->copySource(rect, old_surface.get());
            std::fprintf(stderr, "PKC3-SURFACE: resize destroy old=%p t=%lld\\n", static_cast<void*>(old_surface.get()), pPkc3Ms()); // PKC3-SURFACE
"""

PARTS = (
    (INC_ANCHOR, INC_REPLACE),
    (SWAP_ANCHOR, SWAP_REPLACE),
    (DESTROY_ANCHOR, DESTROY_REPLACE),
)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-surface-trace.py <lo-core-dir>", file=sys.stderr)
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

    # 🔑 先に「もう当たっていないか」を見る。file は触らない。
    # ⚠ 「印が在る」だけでは SKIP しない ── 印の行数が期待どおりのときだけ当て済みと読む。
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
        text.count("PKC3-SURFACE: resize before") != 1
        or text.count("PKC3-SURFACE: resize after") != 1
        or text.count("PKC3-SURFACE: resize destroy") != 1
    ):
        print("ERROR: 印が 1 つ入っていない", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if MARK in line)
    if n_marks != n_expected or "PKC3-SURFACE: resize destroy" not in after:
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 行(期待 {n_expected})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(surface 差し替えの前後と破棄の印 / #1402 ── 足した行 {n_marks})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
