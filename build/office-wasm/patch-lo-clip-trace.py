#!/usr/bin/env python3
"""#121 の**計装**。Office の窓の `Ctrl+C` / 右クリックの「コピー」が、どの層で外へ届かなくなるかを割る。

🔴 **これは直しではない。** 一覧の組み替え・型の変換は 1 つも入れない(それは
`patch-lo-clipboard-png.py` の仕事で、**同じ行を触らない**)。
⚠ **既定では 1 バイトも書き換えない**(`PKC3_CLIP_TRACE=1` の回だけ)が、
錨の検査は毎回する ── 門の下に隠すと上流の変形に誰も気づけない
(`patch-lo-save-trace.py` と同じ作法)。

## 分かっていること(実測。2026-10-04)

- 画像を `Ctrl+C` すると host(`public/office/host.html` の `serveClipboard`)へ渡る型は
  `application/x-openoffice-svxb;…` の **1 つだけ**(= `QtMimeData::formats()` が先頭の
  flavor だけを一覧に入れる、LO の Qt6-wasm 用の hack)。
- 一方 **右クリックの「コピー」では、host への依頼が 0 件**だった(#121)。

## 🔴 なぜ計装が要るか ── 2 つの問いを割る

| 問い | 割る印 |
|---|---|
| **メニュー経由で LO は `QtClipboard::setContents` を呼んでいるか**(出れば Qt 側、出なければ LO 側で止まっている) | `setContents:enter` |
| `setContents` はどのスレッドで呼ばれたか | 同じ行の `a=`(1 = Qt のメインスレッド / 0 = 別 / -1 = wasm でない) |
| 画像の flavor は何が、どの順で在るか / 一覧には何を入れたか | `formats:flavor` / `formats:list` / `formats:done` |
| Qt は**何の型で**中身を求めてくるか / 何 byte を返したか | `retrieve:request` / `retrieve:got` / `retrieve:return` / `retrieve:catch` |

⚠ `retrieve:request` が **`application/x-qt-image`** で出れば、`patch-lo-clipboard-png.py` の
2 つ目の直し(画像として読まれたら PNG で読み直す)が**要る**という裏が取れる
(出なければ、その直しは**効かない枝**である)。

## 読み方(⚠ 対照群と一緒に)

    PKC3-CLIP n setContents:enter a=<main> b=<flavor 数> c=<owner 有無>
    PKC3-CLIP n formats:done a=<flavor 数> b=<一覧の件数> c=<UTF-8 の text が在るか>
    PKC3-CLIP n msg formats:flavor [<MimeType>]
    PKC3-CLIP n msg formats:list [<MimeType>]
    PKC3-CLIP n msg retrieve:request [<型>]
    PKC3-CLIP n retrieve:got a=<ValueTypeClass> b=<値が在るか>
    PKC3-CLIP n retrieve:return a=<bytes>

⚠ **対照群は「Ctrl+C で字をコピー」**(text/plain が出る)── これが出ない回は
計装が効いていないので、**その回の結果は 1 つも読まない**。

## 出口は libc だけ

stderr + `/tmp/pkc3-clip.log`。embind / DOM / Qt の API をここから呼ばない
(LO の文脈から `emscripten::val` を触ると `invalid handle` で abort する ── 2026-08-15)。
MIME 型は ASCII のはずだが、**非 ASCII は `?` へ落とす**(本文らしき物を log に出さない)。
"""

import os
import sys
from pathlib import Path

MARK = "// PKC3-CLIP"

# ⚠ libc だけを使う。**部品から組む**(`str.replace` で版を作ると、同じ形が複数在るので
#   全部に当たって再定義になる ── `patch-lo-save-trace.py` で 2026-08-24 に踏んだ)。
HELPER_OPEN = """// PKC3-CLIP-HELPER-BEGIN
// ── PKC3 #121 の計装(挙動は変えない。`PKC3_CLIP_TRACE=1` の回だけ入る)──
#include <cstdio>
#ifdef __EMSCRIPTEN__
#include <pthread.h>
#include <emscripten/threading.h>
#endif
namespace
{
"""
HELPER_TRACE_FN = """void pkc3_clip_trace(const char* what, int a, int b, int c)
{
    static int nSeq = 0;
    // ⚠ 上限を置く ── コピーは何度も走るので、置かないと log が膨らむ
    if (nSeq >= 300)
        return;
    ++nSeq;
    char line[192];
    // ⚠ 書式はリテラル(`-Wformat-nonliteral` を踏まない)
    std::snprintf(line, sizeof line, "PKC3-CLIP %d %s a=%d b=%d c=%d\\n", nSeq, what, a, b, c);
    std::fputs(line, stderr);
    std::fflush(stderr);
    std::FILE* pLog = std::fopen("/tmp/pkc3-clip.log", "a");
    if (pLog)
    {
        std::fputs(line, pLog);
        std::fclose(pLog);
    }
}
"""
# 🔴 **message を出すのは、使う TU にだけ**(呼ばない file で `-Wunused-function` を踏む)。
# ⚠ `OUString::toUtf8()` は `rtl/ustring.hxx` のメンバなので**必ず在る**(推測で API を渡さない)。
HELPER_MSG_FN = """void pkc3_clip_msg(const char* what, const OUString& rMsg)
{
    static int nMsg = 0;
    // ⚠ こちらも上限を置く(数字つきの行とは別の counter ── 通し番号は `pkc3_clip_trace` の物)
    if (nMsg >= 300)
        return;
    ++nMsg;
    const OString aUtf8 = rMsg.toUtf8();
    char safe[160];
    const char* p = aUtf8.getStr();
    std::size_t k = 0;
    for (; k + 1 < sizeof safe && p[k] != '\\0'; ++k)
    {
        const unsigned char u = static_cast<unsigned char>(p[k]);
        safe[k] = (u >= 0x20 && u < 0x7f) ? p[k] : '?';
    }
    safe[k] = '\\0';
    char line[256];
    std::snprintf(line, sizeof line, "PKC3-CLIP msg %s [%s]\\n", what, safe);
    std::fputs(line, stderr);
    std::fflush(stderr);
    std::FILE* pLog = std::fopen("/tmp/pkc3-clip.log", "a");
    if (pLog)
    {
        std::fputs(line, pLog);
        std::fclose(pLog);
    }
}
"""
HELPER_CLOSE = """}
// PKC3-CLIP-HELPER-END
"""
# ⚠ `check-trace-helpers-compile.py` が module 直下の `HELPER` を単体で g++ へ通す ──
#   Qt / LO の型を使う msg 版はここに入れない(別名)。
HELPER = HELPER_OPEN + HELPER_TRACE_FN + HELPER_CLOSE
HELPER_MSG = HELPER_OPEN + HELPER_TRACE_FN + HELPER_MSG_FN + HELPER_CLOSE

# ── ① QtTransferable.cxx(一覧と中身の取り出し)────────────────────────────
TR_SRC = "vcl/qt5/QtTransferable.cxx"
# ヘルパーは `formats()` の直前(file scope)。使う所はどれもその後ろ。
TR_HELPER_ANCHOR = "QStringList QtMimeData::formats() const\n"

# 一覧を確定した直後(原文の `m_aMimeTypeList = aList;` の前)。
# ⚠ `aFormats`(LO が持つ flavor の全部)と `aList`(Qt へ渡す一覧)の**両方**を出す。
FORMATS_ANCHOR = """    m_aMimeTypeList = aList;
    return m_aMimeTypeList;
"""
FORMATS_REPLACE = f"""    for (const auto& rPkc3Flavor : aFormats) {MARK}
        pkc3_clip_msg("formats:flavor", rPkc3Flavor.MimeType); {MARK}
    for (const QString& rPkc3Listed : aList) {MARK}
        pkc3_clip_msg("formats:list", toOUString(rPkc3Listed)); {MARK}
    pkc3_clip_trace("formats:done", static_cast<int>(aFormats.getLength()), {MARK}
                    static_cast<int>(aList.size()), m_bHaveUTF8 ? 1 : 0); {MARK}
    m_aMimeTypeList = aList;
    return m_aMimeTypeList;
"""

# 求められた型(⚠ 原文の `hasFormat` の**前**に出す ── 断られた要求こそ見たい)。
# ⚠ `{` は `#if QT_VERSION` の `#endif` の直後に在る(Qt5 / Qt6 で宣言が違う)。
REQUEST_ANCHOR = """QVariant QtMimeData::retrieveData(const QString& mimeType, QMetaType) const
#endif
{
"""
REQUEST_REPLACE = f"""QVariant QtMimeData::retrieveData(const QString& mimeType, QMetaType) const
#endif
{{
    pkc3_clip_msg("retrieve:request", toOUString(mimeType)); {MARK}
"""

GOT_ANCHOR = """        aValue = xCurrentContents->getTransferData(aFlavor);
"""
GOT_REPLACE = f"""        aValue = xCurrentContents->getTransferData(aFlavor);
        pkc3_clip_trace("retrieve:got", static_cast<int>(aValue.getValueTypeClass()), {MARK}
                        aValue.hasValue() ? 1 : 0, 0); {MARK}
"""

# 🔑 `catch (...)` は**黙って空を返す**(host の 0 byte の部品の出どころ)── 入ったことを残す。
CATCH_ANCHOR = """    catch (...)
    {
"""
CATCH_REPLACE = f"""    catch (...)
    {{
        pkc3_clip_trace("retrieve:catch", 1, 0, 0); {MARK}
"""

RETURN_ANCHOR = """    return QVariant::fromValue(aByteArray);
"""
RETURN_REPLACE = f"""    pkc3_clip_trace("retrieve:return", static_cast<int>(aByteArray.size()), 0, 0); {MARK}
    return QVariant::fromValue(aByteArray);
"""

# ── ② QtClipboard.cxx(コピーが LO から Qt へ渡る入口)──────────────────────
CB_SRC = "vcl/qt5/QtClipboard.cxx"
CB_HELPER_ANCHOR = "void QtClipboard::setContents(\n"
# ⚠ **メニュー経由で呼ばれるか**が #121 の決め手 ── 入口の最初に印を置く。
ENTER_ANCHOR = """    // it's actually possible to get a non-empty xTrans and an empty xClipboardOwner!
"""
ENTER_REPLACE = f"""#ifdef __EMSCRIPTEN__ {MARK}
    const int nPkc3Main = pthread_self() == emscripten_main_runtime_thread_id() ? 1 : 0; {MARK}
#else {MARK}
    const int nPkc3Main = -1; {MARK}
#endif {MARK}
    pkc3_clip_trace("setContents:enter", nPkc3Main, {MARK}
                    xTrans.is() ? static_cast<int>(xTrans->getTransferDataFlavors().getLength()) {MARK}
                                : -1, {MARK}
                    xClipboardOwner.is() ? 1 : 0); {MARK}
    // it's actually possible to get a non-empty xTrans and an empty xClipboardOwner!
"""

# (file, 錨, 置換) の全部。⚠ 同じ file の中では、ヘルパーを入れる側を先に当てる。
HELPER_TARGETS = (
    (TR_SRC, TR_HELPER_ANCHOR, HELPER_MSG),
    (CB_SRC, CB_HELPER_ANCHOR, HELPER),
)
TARGETS = (
    (TR_SRC, FORMATS_ANCHOR, FORMATS_REPLACE),
    (TR_SRC, REQUEST_ANCHOR, REQUEST_REPLACE),
    (TR_SRC, GOT_ANCHOR, GOT_REPLACE),
    (TR_SRC, CATCH_ANCHOR, CATCH_REPLACE),
    (TR_SRC, RETURN_ANCHOR, RETURN_REPLACE),
    (CB_SRC, ENTER_ANCHOR, ENTER_REPLACE),
)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-clip-trace.py <lo-core-dir>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    on = os.environ.get("PKC3_CLIP_TRACE") == "1"

    # ⚠ **錨の検査は門の外でやる**(門の下に隠すと上流の変形に誰も気づけない)。
    # ⚠ 同じ file を複数回触るので、読み込みは 1 度にして in-memory で順に当てる。
    texts: dict[str, str] = {}
    for src in (TR_SRC, CB_SRC):
        path = root / src
        if not path.exists():
            print(f"ERROR: {src} が無い({path})", file=sys.stderr)
            return 1
        texts[src] = path.read_text(encoding="utf-8")
        # ⚠ 二重当ては止める(冪等ではない ── ヘルパーが 2 つ入る)。file は触らない。
        if "pkc3_clip_trace" in texts[src]:
            print(f"ERROR: {src} に既に計装が入っている(二重当て)", file=sys.stderr)
            return 1

    # ⚠ ヘルパーの当て先も**同じ厳しさ**で見る(外れると「呼ぶ側だけ在る」= リンク不能)
    for src, anchor, _h in HELPER_TARGETS:
        hits = texts[src].count(anchor)
        if hits != 1:
            print(f"ERROR: ヘルパーの錨が {hits} 件({src})── 上流が形を変えた", file=sys.stderr)
            return 1
    for src, anchor, _replace in TARGETS:
        hits = texts[src].count(anchor)
        if hits != 1:
            print(
                f"ERROR: 錨が {hits} 件({src})── 上流が形を変えた。計装の当て先を読み直すこと:\n"
                f"{anchor[:120]}",
                file=sys.stderr,
            )
            return 1

    if not on:
        print(
            f"skip: PKC3_CLIP_TRACE!=1(錨 {len(TARGETS)} 件 + ヘルパー {len(HELPER_TARGETS)} 件を確かめた)"
        )
        return 0

    # ⚠ **ヘルパーを先に**(本体の置換より前)── 「呼ぶ側だけ在る」中間状態を作らない
    for src, anchor, helper in HELPER_TARGETS:
        texts[src] = texts[src].replace(anchor, helper + "\n" + anchor, 1)
    for src, anchor, replace in TARGETS:
        texts[src] = texts[src].replace(anchor, replace, 1)
    for src, text in texts.items():
        path = root / src
        path.write_text(text, encoding="utf-8")
        # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
        if "pkc3_clip_trace" not in path.read_text(encoding="utf-8"):
            print(f"ERROR: 書き戻し後の {src} に計装が無い(write が落ちている)", file=sys.stderr)
            return 1
        print(f"patched: {src}(#121 の計装)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
