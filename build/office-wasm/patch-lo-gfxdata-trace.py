#!/usr/bin/env python3
"""閉じた直後に本体スレッドが落ちる件(#1402)の**印と null 門**。`GetSystemGfxData` の `mpGraphics` の読み直しを見る。

## 症状(user の身に起きること)

Office を閉じた直後に、本体スレッドが `ThumbnailView::Paint` ← `createPixelProcessor2DFromOutputDevice` で
`RuntimeError: memory access out of bounds` になり「Office が停止しました」になることがある。
stack と実測: https://github.com/sm06224/PKC3/issues/1402#issuecomment-6048200059

## 🔑 読んでいること(推測。実機では未確認)

`vcl/source/outdev/outdev.cxx`(上流 `d6226c1a`)の `OutputDevice::GetSystemGfxData()`:

    if (!mpGraphics && !AcquireGraphics())  return SystemGraphicsData();
    assert(mpGraphics);
    #if USE_HEADLESS_CODE
        if (OUTDEV_WINDOW == GetOutDevType())
            mpGraphics->ApplyFullDamage();
    #endif
    return mpGraphics->GetGraphicsData();

`ApplyFullDamage()` は(Qt6 wasm の JSPI では)SolarMutex を手放す hop を含みうる。その間に別の経路
(`WindowOutputDevice::AcquireGraphics` の奪取 = `vcl/source/window/window.cxx`)が `mpGraphics` を null にする、
または別の物へ差し替えると、`return` の行は**読み直した `mpGraphics`** を使う = null なら `this == nullptr` で `GetGraphicsData()` に入る。
もう 1 つ、`GetGraphicsData()` が返す `pSurface` が、`QtSvpSalFrame::DoHandleResizeEvent` で差し替えられて捨てられた物だった可能性がある
(→ `patch-lo-surface-trace.py`)。

## この patch がすること(足すだけで、原文の行は 1 行も書き換えない。⚠ 全部 `#if USE_HEADLESS_CODE` の中)

| 何を | 内容 |
|---|---|
| **印** | `ApplyFullDamage()` の**前**に `mpGraphics` を控え、**後**に読み直す。**変わっていたとき(null になった / 別の pointer)だけ** `PKC3-GFXDATA: gfx changed outdev=%p before=%p after=%p t=%lld` を出す。変わらなければ **0 行** |
| 🔴 **null 門(直しの一部)** | 読み直した `mpGraphics` が null なら、**空の `SystemGraphicsData()` を返して落ちない**(`patch-lo-grip-guard.py` と同じ作法)。呼び出し側(`CairoPixelProcessor2D` の ctor)は `pSurface == nullptr` で `valid()` が偽になり、`VclPixelProcessor2D` に落ちる |
| **印** | 返す直前に `GetGraphicsData()` の `pSurface` を読み、`PKC3-GFXDATA: surface outdev=%p gfx=%p surface=%p t=%lld` を出す。**最初の 300 回は毎回、以後 50 回ごと、前回の出力から 2 秒以上空いたら必ず、`pSurface` が前回出した値と変わったら必ず**(`static const void* pPkc3LastSurface` を 1 つ。出したときだけ更新)|

- `t=` は `std::chrono::steady_clock` の ms(wasm ではページ開始からの経過)。`PKC3-SDPR` / `PKC3-SURFACE` と同じ時計。
- 🔑 **次の焼きの読み方**:`gfx changed … after=(nil)` が出る → 奪取の仮説が当たり、null 門が効いた(落ちる回が減る)/
  `PKC3-SDPR: enter` の直後に `surface … surface=X` が出ず落ちる → `GetGraphicsData()` の中 /
  `surface=X` の `X` が `PKC3-SURFACE: resize destroy old=X` の `t=` より**後**に読まれている → 捨てた surface を読んだ(差し替えとの競合)。

## ⚠ 言えないこと(正直に)

- 🔴 **この patch は、`pSurface` が差し替えで捨てられた物を指す競合を直さない**(null 門は null のときだけ)。解放済みの物を指しているだけなら素通りする。
- ⚠ **それでも出ない形が 1 つある**: 同じ `pSurface` を返し続ける呼び出しの途中(50 回の倍数でも、前回の出力から 2 秒未満でもない回)で落ちる場合。resize の直後の最初の読みは
  `pSurface` が変わるので**必ず出る**(`PKC3-SURFACE: resize after` の `new=` と突き合わせる)。surface が複数の frame で入れ替わり続ける間は、変わるたびに出る(出力は増える)。
- 🔴 **`mpGraphics` が null でなく、別の pointer へ変わった**ときは、印は出すが**そのまま新しい pointer で続ける**(止めない ── それが現在の正しい `mpGraphics` のはず)。
- ⚠ **本物の LO の header ではまだ compile していない**。`tests/office-gfxdata-trace-patch.test.ts` が、当てた後の関数全体を型だけ stub に替えて g++(`-Wall -Wextra -Werror`)で
  コンパイルして走らせ、changed / null 門 / 頻度 / headless でない build の無音は確かめている(門を外すと stub が `this` を読んで本当に落ちる)。
  `SystemGraphicsData::pSurface` は `include/vcl/sysdata.hxx:150`(`USE_HEADLESS_CODE` の中だけ)── 足した行も同じ `#if` の中。

## ⚠ 作法(錨と印は `patch-lo-grip-guard.py` と同じ)

- **毎回当たる**(入力で gate しない)。錨が**ちょうど 1 件**在ることを書く前に確かめる。1 つでも外れたら何も書かない。
- 印の行数が期待どおり(= 当て済み)なら **SKIP して exit 0**(file は触らない)。印が在るのに行数が違う(部分適用 / 手編集)は **exit 1**。
- **足した行は全部 `PKC3-GFXDATA` を含む**。原文の行は 1 行も書き換えない(足すだけ。空行も足さない ── 足し行と原文の行を区別できなくなる)。
- ヘルパー関数は作らない(lambda を関数の中に置くだけ)。
"""

import sys
from pathlib import Path

SRC = "vcl/source/outdev/outdev.cxx"
MARK = "PKC3-GFXDATA"

# ── ① include ─────────────────────────────────────────────────────────────────────
INC_ANCHOR = """#include <com/sun/star/rendering/XSpriteCanvas.hpp>
"""
INC_REPLACE = """#include <com/sun/star/rendering/XSpriteCanvas.hpp>
#include <cstdio> // PKC3-GFXDATA
#include <chrono> // PKC3-GFXDATA
"""

# ── ② `GetSystemGfxData` の `ApplyFullDamage` の前後と、返す直前 ──────────────────────────
# 🔑 錨は `#if USE_HEADLESS_CODE` から `return mpGraphics->GetGraphicsData();` まで。原文に**1 件**
#    (`GetGraphicsData()` を返す行は他に無い)。足す所は 3 つ: `#if` の直後(控えと lambda)/ `ApplyFullDamage` の直後(読み直しと門)/
#    `return` の直前(`pSurface` の印と、headless のときの早期 return)。
GFX_ANCHOR = """#if USE_HEADLESS_CODE
    if (OUTDEV_WINDOW == GetOutDevType())
        mpGraphics->ApplyFullDamage();
#endif

    return mpGraphics->GetGraphicsData();
"""
GFX_REPLACE = """#if USE_HEADLESS_CODE
    // PKC3-GFXDATA(#1402): keep mpGraphics before ApplyFullDamage (it may drop the SolarMutex) and read it again after.
    const void* const pPkc3Before = static_cast<const void*>(mpGraphics); // PKC3-GFXDATA
    static int nPkc3Calls = 0; // PKC3-GFXDATA
    static long long nPkc3LastMs = 0; // PKC3-GFXDATA
    static const void* pPkc3LastSurface = nullptr; // PKC3-GFXDATA
    auto const pPkc3Ms = []() -> long long // PKC3-GFXDATA
    { // PKC3-GFXDATA
        return std::chrono::duration_cast<std::chrono::milliseconds>( // PKC3-GFXDATA
                   std::chrono::steady_clock::now().time_since_epoch()) // PKC3-GFXDATA
            .count(); // PKC3-GFXDATA
    }; // PKC3-GFXDATA
    if (OUTDEV_WINDOW == GetOutDevType())
        mpGraphics->ApplyFullDamage();
    if (static_cast<const void*>(mpGraphics) != pPkc3Before) // PKC3-GFXDATA
    { // PKC3-GFXDATA
        std::fprintf(stderr, "PKC3-GFXDATA: gfx changed outdev=%p before=%p after=%p t=%lld\\n", static_cast<const void*>(this), pPkc3Before, static_cast<const void*>(mpGraphics), pPkc3Ms()); // PKC3-GFXDATA
        if (!mpGraphics) // PKC3-GFXDATA
            return SystemGraphicsData(); // PKC3-GFXDATA
    } // PKC3-GFXDATA
#endif
#if USE_HEADLESS_CODE // PKC3-GFXDATA
    SystemGraphicsData aPkc3Data(mpGraphics->GetGraphicsData()); // PKC3-GFXDATA
    const int nPkc3N = ++nPkc3Calls; // PKC3-GFXDATA
    const long long nPkc3Now = pPkc3Ms(); // PKC3-GFXDATA
    if (nPkc3N <= 300 || nPkc3N % 50 == 0 || nPkc3Now - nPkc3LastMs >= 2000 || aPkc3Data.pSurface != pPkc3LastSurface) // PKC3-GFXDATA
    { // PKC3-GFXDATA
        nPkc3LastMs = nPkc3Now; // PKC3-GFXDATA
        pPkc3LastSurface = aPkc3Data.pSurface; // PKC3-GFXDATA
        std::fprintf(stderr, "PKC3-GFXDATA: surface outdev=%p gfx=%p surface=%p t=%lld\\n", static_cast<const void*>(this), static_cast<const void*>(mpGraphics), aPkc3Data.pSurface, nPkc3Now); // PKC3-GFXDATA
    } // PKC3-GFXDATA
    return aPkc3Data; // PKC3-GFXDATA
#endif // PKC3-GFXDATA

    return mpGraphics->GetGraphicsData();
"""

PARTS = (
    (INC_ANCHOR, INC_REPLACE),
    (GFX_ANCHOR, GFX_REPLACE),
)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-gfxdata-trace.py <lo-core-dir>", file=sys.stderr)
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
        text.count("PKC3-GFXDATA: gfx changed") != 1
        or text.count("PKC3-GFXDATA: surface outdev") != 1
        or text.count("return SystemGraphicsData(); // PKC3-GFXDATA") != 1
    ):
        print("ERROR: 門か印が 1 つ入っていない", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if MARK in line)
    if n_marks != n_expected or "return SystemGraphicsData(); // PKC3-GFXDATA" not in after:
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 行(期待 {n_expected})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(GetSystemGfxData の mpGraphics 読み直しの印と null 門 / #1402 ── 足した行 {n_marks})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
