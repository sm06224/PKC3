#!/usr/bin/env python3
"""閉じた直後に本体スレッドが落ちる件(#1402)の**計装**。`createPixelProcessor2DFromOutputDevice` の入口と出口を、時刻つきで出す。直しではない。

## 症状(user の身に起きること)

Office を閉じた直後に、本体スレッドが `ThumbnailView::Paint` ← `createPixelProcessor2DFromOutputDevice` で
`RuntimeError: memory access out of bounds` になり「Office が停止しました」になることがある。
stack と実測: https://github.com/sm06224/PKC3/issues/1402#issuecomment-6048200059

## 🔑 読んでいること(推測。実機では未確認)

`drawinglayer/source/processor2d/processor2dtools.cxx`(上流 `d6226c1a`)の `createPixelProcessor2DFromOutputDevice()`(`USE_HEADLESS_CODE` の枝)は、
`rTargetOutDev.HasMirroredGraphics()` を呼び、そのあと `CairoPixelProcessor2D` の ctor が `mpTargetOutputDevice->GetSystemGfxData()` の
`pSurface` を `cairo_image_surface_get_width/height()` で読む。**落ちる場所が `HasMirroredGraphics()` の中か、ctor の中か**、
**そのとき `rTargetOutDev` が何か(アドレスと種類)** が、いま分かっていない。

## この patch がすること(⚠ 直しではなく**印**)

関数の `if (bUsePrimitiveRenderer)` の先頭と、`CairoPixelProcessor2D` を作った直後に足す(足すだけで、原文の行は 1 行も書き換えない):

| 印 | 出す所 | 読み方 |
|---|---|---|
| `PKC3-SDPR: enter #%d outdev=%p type=%d t=%lld` | **`HasMirroredGraphics()` を呼ぶ前** | `type` は `OutDevType`(0=window 1=printer 2=virdev 3=pdf)。**enter があって made が無いまま落ちれば、落ちたのは `HasMirroredGraphics()` か ctor の中** |
| `PKC3-SDPR: made #%d outdev=%p valid=%d t=%lld` | `CairoPixelProcessor2D` を作った**直後**(`valid()` の検査の前) | `made` まで出ていれば ctor は戻った |

- 連番 `#N` は `createPixelProcessor2DFromOutputDevice` の呼び出し通し番号(enter と made で同じ N)。
- 頻度: **最初の 300 回は毎回、以後 50 回ごと**。加えて次のどれかなら**必ず出す**(落ちるのは閉じた直後 = 起動から 30 秒ほど後。
  それまでに何回呼ばれるか分からず、閉じた直後は同じ窓への連続描画になるので、「描画の塊の先頭」と「相手が変わった所」を拾う):
  ① `&rTargetOutDev` が**前回出した値と変わった**(`static const void* nPkc3LastDev` を 1 つ。出したときだけ更新する)
  ② **前の呼び出しから 100 ms 以上空いた**(`nPkc3PrevMs` は出した出さないに関わらず毎回更新 = 描画の塊の先頭)
  ③ **前回の出力から 2 秒以上空いた**(塊が途切れず続いても、最低 2 秒に 1 回は出る)。
  made は enter を出した回だけ出す(対で読める)。
- `t=` は `std::chrono::steady_clock` の ms(wasm ではページ開始からの経過)。`PKC3-SURFACE` / `PKC3-GFXDATA` と同じ時計。

## ⚠ 言えないこと(正直に)

- 🔴 **この patch は何も直さない**。落ちるのは変わらない。
- ⚠ **それでも出ない形が 1 つある**: 同じ `OutputDevice` への呼び出しが 100 ms 未満の間隔で続く塊の**途中**(50 回の倍数でも、前回の出力から 2 秒未満でもない回)。
  その回で落ちると enter は無い。「最後の enter の `t=` と落ちた時刻の差」と、`PKC3-SURFACE: resize destroy` の `t=` との前後で読む。
- ⚠ 静的な通し番号と最終出力時刻は**排他しない**(診断用の素の変数)。複数 thread から呼ばれれば `#N` が飛ぶことはあるが、値は壊れない。
- ⚠ **本物の LO の header ではまだ compile していない**。`tests/office-sdpr-trace-patch.test.ts` が、当てた後の関数全体を型だけ stub に替えて g++(`-Wall -Wextra -Werror`)で
  コンパイルして走らせ、順番・頻度・値は確かめている。名前と型は宣言を読んだだけ(`OutputDevice::GetOutDevType()` は `include/vcl/outdev.hxx:386`)。

## ⚠ 作法(錨と印は `patch-lo-grip-guard.py` と同じ)

- **毎回当たる**(入力で gate しない)。錨が**ちょうど 1 件**在ることを書く前に確かめる。1 つでも外れたら何も書かない。
- 印の行数が期待どおり(= 当て済み)なら **SKIP して exit 0**(file は触らない)。印が在るのに行数が違う(部分適用 / 手編集)は **exit 1**。
- **足した行は全部 `PKC3-SDPR` を含む**。原文の行は 1 行も書き換えない(足すだけ)。
- 足す所は `#if USE_HEADLESS_CODE` の**中**だけ(`<cstdio>` / `<chrono>` もその中)── それ以外の build(Windows の D2D など)は 1 バイトも変わらない。
- ヘルパー関数は作らない(lambda を関数の中に置くだけ)。
"""

import sys
from pathlib import Path

SRC = "drawinglayer/source/processor2d/processor2dtools.cxx"
MARK = "PKC3-SDPR"

# ── ① include(`USE_HEADLESS_CODE` の中だけ)──────────────────────────────────────────
INC_ANCHOR = """#if USE_HEADLESS_CODE
#include <drawinglayer/processor2d/cairopixelprocessor2d.hxx>
#elif defined(_WIN32)
"""
INC_REPLACE = """#if USE_HEADLESS_CODE
#include <drawinglayer/processor2d/cairopixelprocessor2d.hxx>
#include <cstdio> // PKC3-SDPR
#include <chrono> // PKC3-SDPR
#elif defined(_WIN32)
"""

# ── ② 入口(`HasMirroredGraphics()` を呼ぶ前)────────────────────────────────────────
# 🔑 錨は `if (bUsePrimitiveRenderer)` の `{` と、その直後の tdf#165061 の注釈の 1 行。FromScratch 側には注釈が無いので原文に**1 件**。
ENTER_ANCHOR = """    if (bUsePrimitiveRenderer)
    {
        // tdf#165061 do not use SDPR when RTL is enabled, SDPR is designed
"""
ENTER_REPLACE = """    if (bUsePrimitiveRenderer)
    {
        // PKC3-SDPR(#1402): log before HasMirroredGraphics() / the CairoPixelProcessor2D ctor, which may be where main crashes.
        static int nPkc3Calls = 0; // PKC3-SDPR
        static long long nPkc3LastMs = 0; // PKC3-SDPR
        static long long nPkc3PrevMs = 0; // PKC3-SDPR
        static const void* pPkc3LastDev = nullptr; // PKC3-SDPR
        auto const pPkc3Ms = []() -> long long // PKC3-SDPR
        { // PKC3-SDPR
            return std::chrono::duration_cast<std::chrono::milliseconds>( // PKC3-SDPR
                       std::chrono::steady_clock::now().time_since_epoch()) // PKC3-SDPR
                .count(); // PKC3-SDPR
        }; // PKC3-SDPR
        const int nPkc3N = ++nPkc3Calls; // PKC3-SDPR
        const long long nPkc3Now = pPkc3Ms(); // PKC3-SDPR
        const void* const pPkc3Dev = static_cast<const void*>(&rTargetOutDev); // PKC3-SDPR
        const bool bPkc3Say = nPkc3N <= 300 || nPkc3N % 50 == 0 || nPkc3Now - nPkc3LastMs >= 2000 || pPkc3Dev != pPkc3LastDev || nPkc3Now - nPkc3PrevMs >= 100; // PKC3-SDPR
        nPkc3PrevMs = nPkc3Now; // PKC3-SDPR
        if (bPkc3Say) // PKC3-SDPR
        { // PKC3-SDPR
            nPkc3LastMs = nPkc3Now; // PKC3-SDPR
            pPkc3LastDev = pPkc3Dev; // PKC3-SDPR
            std::fprintf(stderr, "PKC3-SDPR: enter #%d outdev=%p type=%d t=%lld\\n", nPkc3N, static_cast<const void*>(&rTargetOutDev), static_cast<int>(rTargetOutDev.GetOutDevType()), nPkc3Now); // PKC3-SDPR
        } // PKC3-SDPR
        // tdf#165061 do not use SDPR when RTL is enabled, SDPR is designed
"""

# ── ③ `CairoPixelProcessor2D` を作った直後(`valid()` の検査の前)───────────────────────────
MADE_ANCHOR = """                    rViewInformation2D));

            if (aRetval->valid())
            {
                return aRetval;
"""
MADE_REPLACE = """                    rViewInformation2D));

            if (bPkc3Say) // PKC3-SDPR
                std::fprintf(stderr, "PKC3-SDPR: made #%d outdev=%p valid=%d t=%lld\\n", nPkc3N, static_cast<const void*>(&rTargetOutDev), aRetval->valid() ? 1 : 0, pPkc3Ms()); // PKC3-SDPR
            if (aRetval->valid())
            {
                return aRetval;
"""

PARTS = (
    (INC_ANCHOR, INC_REPLACE),
    (ENTER_ANCHOR, ENTER_REPLACE),
    (MADE_ANCHOR, MADE_REPLACE),
)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-sdpr-trace.py <lo-core-dir>", file=sys.stderr)
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
    if text.count("PKC3-SDPR: enter #") != 1 or text.count("PKC3-SDPR: made #") != 1:
        print("ERROR: 印が 1 つ入っていない", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if MARK in line)
    if n_marks != n_expected or "PKC3-SDPR: made #" not in after:
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 行(期待 {n_expected})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(createPixelProcessor2DFromOutputDevice の入口と出口の印 / #1402 ── 足した行 {n_marks})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
