#!/usr/bin/env python3
"""画像を Ctrl+C したとき、ブラウザが受ける **PNG** を外のクリップボードへ渡す(#121)。

## 症状

Office の窓で画像を選んで `Ctrl+C` すると、host(`public/office/host.html` の `serveClipboard`)へ
渡る型は `application/x-openoffice-svxb;…` の **1 つだけ**で、ブラウザの `clipboard.write` は
その型を受けず(標準は `text/plain` / `text/html` / `image/png` / `image/svg+xml` だけ)、
外のクリップボードは前の物のまま ── user には「画像をコピーしたのに貼れない」としか見えない
(実測 2026-10-04、Chromium 141)。

## 🔑 原因 ── LO の Qt6-wasm 用の hack(`vcl/qt5/QtTransferable.cxx`)

`QtMimeData::formats()` は、wasm の Qt6 では **一覧に 1 つしか入れない**:

    text の flavor が在る        → "text/plain" だけ
    text が無く flavor が在る    → `aFormats[0].MimeType` **だけ**   ← 画像はここ

複数入れないのには理由が在る(同 file の注釈): Qt wasm の `writeToClipboardApi` は
**ClipboardItem を型ごとに作って** `clipboard.write` へ渡し、複数だと Chrome 131 で
`NotAllowedError`(複数の ClipboardItem は未実装)になる。**だから 1 つは守る。**

ところが Writer の画像の transferable は **SVXB → OBJECTDESCRIPTOR → PNG → GDIMETAFILE →
BITMAP** の順で flavor を足す(`sw/source/uibase/dochdl/swdtflvr.cxx` の
`AddFormat( SotClipboardFormatId::PNG )`)。**PNG は在る**のに、先頭ではないので捨てられている。

## 直し(2 か所。⚠ 片方だけでは足りない)

1. `formats()`: `aFormats` を走査して基本型(`;` の前)が `image/png` の flavor が在れば、
   **それを 1 つだけ**一覧に入れる。無ければ今までどおり `aFormats[0]`。**複数は入れない**
   (NotAllowedError の理由が残っている)。
2. `retrieveData()`: Qt wasm の `writeToClipboardApi` は、型の名前に `image` を含む物を
   **`QMimeData::imageData()` で読む**(= `retrieveData("application/x-qt-image")` を呼ぶ)。
   ところが `retrieveData` は **`hasFormat(mimeType)` が偽なら空を返す**ので、一覧が
   `image/png` だけだと **画像が空のまま** `no content found` で書かずに戻る。
   だから `application/x-qt-image` を求められたら、一覧の PNG の型で読み直した結果を
   **`QImage` にして**返す(読めなければ bytes のまま返す)。
   🔴 この 2 を入れないと、1 だけでは**一覧は直るのに host へは 0 byte も届かない**
   (原文 `qwasmclipboard.cpp`(Qt 6.9)を読んだ結論。⚠ **実ブラウザでは未確認** ──
   `PKC3_CLIP_TRACE=1` の計装(`patch-lo-clip-trace.py`)で `retrieve:request` が
   `application/x-qt-image` で出るかを見れば裏が取れる)。

## ⚠ 作法

- **毎回当たる直し**(入力で gate しない)。錨が**ちょうど 1 件**在ることを確かめてから当てる。
- 当てた後に印が在ることを確かめる / 二重当ては exit 1 で **file は 1 バイトも変わらない**。
- **足した行は全部 `PKC3-PNG` を含む**(原文の行は 1 行も書き換えない)── 足した行を除くと
  原文と一致する(test が見る)。
- ⚠ **計装 `patch-lo-clip-trace.py` と同じ行を触らない**(両方当てても、どちらの順でも出力が同一)。
"""

import sys
from pathlib import Path

SRC = "vcl/qt5/QtTransferable.cxx"
MARK = "PKC3-PNG"

# ── ① include(`QImage` を使う)────────────────────────────────────────
INC_ANCHOR = """#include <QtWidgets/QApplication>
"""
INC_REPLACE = """#include <QtWidgets/QApplication>
#include <QtGui/QImage> // PKC3-PNG
"""

# ── ② formats(): PNG が在れば、それを 1 つだけ入れる ─────────────────────
# ⚠ 原文の行(`aList << toQString(aFormats[0].MimeType);`)はそのまま残し、
#   その後ろで「PNG が在れば、それ 1 つに置き換える」。
FORMATS_ANCHOR = """        aList << toQString(aFormats[0].MimeType);
"""
FORMATS_REPLACE = """        // PKC3-PNG(#121、2026-10-04): 先頭が PNG でない画像(Writer は SVXB が先頭)は、
        // PKC3-PNG 外のクリップボードへ書ける型(`image/png`)を持っているのに捨てられていた。
        // PKC3-PNG ⚠ 入れるのは **1 つだけ**(複数だと Qt wasm が複数の ClipboardItem を作り、
        // PKC3-PNG   Chrome 131 で NotAllowedError ── 上の注釈の 1 つ目の理由はそのまま残る)。
        // PKC3-PNG ⚠ 比べるのは `;` の前(基本型)── パラメータ付きでも拾う。入れるのは原文の字のまま
        // PKC3-PNG   (`retrieveData` が LO へその字で求めるため)。
        const css::datatransfer::DataFlavor* pPkc3Png = nullptr; // PKC3-PNG
        for (const auto& rPkc3Flavor : aFormats) // PKC3-PNG
        { // PKC3-PNG
            const std::u16string_view aPkc3Mime(rPkc3Flavor.MimeType); // PKC3-PNG
            sal_Int32 nPkc3Index = 0; // PKC3-PNG
            if (o3tl::getToken(aPkc3Mime, 0, ';', nPkc3Index) == u"image/png") // PKC3-PNG
            { // PKC3-PNG
                pPkc3Png = &rPkc3Flavor; // PKC3-PNG
                break; // PKC3-PNG
            } // PKC3-PNG
        } // PKC3-PNG
        aList << toQString(aFormats[0].MimeType);
        if (pPkc3Png) // PKC3-PNG
        { // PKC3-PNG
            aList.clear(); // PKC3-PNG
            aList << toQString(pPkc3Png->MimeType); // PKC3-PNG
        } // PKC3-PNG
"""

# ── ③ retrieveData(): 画像として読まれたら、一覧の PNG で読み直す ─────────────
# 🔑 原文の `if (!hasFormat(mimeType))` の**前**へ足す(原文の行は触らない)。
RETRIEVE_ANCHOR = """    if (!hasFormat(mimeType))
        return QVariant();
"""
RETRIEVE_REPLACE = """#if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0) && defined __EMSCRIPTEN__ // PKC3-PNG
    // PKC3-PNG(#121): Qt wasm の writeToClipboardApi は、名前に `image` を含む型を
    // PKC3-PNG `QMimeData::imageData()` = `retrieveData("application/x-qt-image")` で読む。一覧には
    // PKC3-PNG その字が無いので、下の hasFormat で空になり「書く物が無い」で戻ってしまう。
    // PKC3-PNG 一覧の PNG の型で読み直し、`QImage` にして返す(Qt が `image/png` へ詰め直す)。
    if (mimeType == QLatin1String("application/x-qt-image")) // PKC3-PNG
    { // PKC3-PNG
        for (const QString& rPkc3Listed : formats()) // PKC3-PNG
        { // PKC3-PNG
            if (rPkc3Listed.section(QLatin1Char(';'), 0, 0) == QLatin1String("image/png")) // PKC3-PNG
            { // PKC3-PNG
                const QVariant aPkc3Png = retrieveData(rPkc3Listed, QMetaType()); // PKC3-PNG
                QImage aPkc3Image; // PKC3-PNG
                if (aPkc3Image.loadFromData(aPkc3Png.toByteArray(), "PNG")) // PKC3-PNG
                    return QVariant::fromValue(aPkc3Image); // PKC3-PNG
                return aPkc3Png; // PKC3-PNG
            } // PKC3-PNG
        } // PKC3-PNG
    } // PKC3-PNG
#endif // PKC3-PNG
    if (!hasFormat(mimeType))
        return QVariant();
"""

PARTS = (
    (INC_ANCHOR, INC_REPLACE),
    (FORMATS_ANCHOR, FORMATS_REPLACE),
    (RETRIEVE_ANCHOR, RETRIEVE_REPLACE),
)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-clipboard-png.py <lo-core-dir>", file=sys.stderr)
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
                f"ERROR: 錨が {hits} 件({SRC})。上流が形を変えた可能性がある:\n{anchor[:120]}...",
                file=sys.stderr,
            )
            return 1

    for anchor, replace in PARTS:
        text = text.replace(anchor, replace, 1)

    # ⚠ 置換が本当に効いたか(空振りを合格と読まない)
    if text.count("PKC3-PNG(#121") != 2:
        print("ERROR: 注釈の印が 2 つ入っていない", file=sys.stderr)
        return 1
    if text.count('o3tl::getToken(aPkc3Mime, 0, \';\', nPkc3Index) == u"image/png"') != 1:
        print("ERROR: PNG を選ぶ判定が 1 つ入っていない", file=sys.stderr)
        return 1
    # 🔴 **複数を入れない** ── PNG を入れる前に、原文が入れた先頭の 1 つを**空にする**(`clear()`)
    if text.count("aList.clear(); // PKC3-PNG") != 1 or text.count("aList << toQString(pPkc3Png->MimeType);") != 1:
        print("ERROR: 一覧を PNG 1 つへ置き換える行が 1 つずつでない", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    if MARK not in path.read_text(encoding="utf-8"):
        print(f"ERROR: 書き戻し後の {SRC} に直しが無い(write が落ちている)", file=sys.stderr)
        return 1
    print(f"patched: {SRC}(画像のコピーで PNG を外へ渡す / #121)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
