#!/usr/bin/env python3
"""#156 段③ の**計装**。IME の配管が LO 側のどこで途切れるかを 1 行ずつ出す。

🔴 **これは直しではない。測るためだけの patch である**(既定では 1 バイトも書かない)。

## いま分かっていること(2026-08-23、段② の実測)

文書を開いた状態で門を読むところまでは**前提が全部揃った**:

| 前提 | 結果 |
|---|---|
| 文書が開いた | ✅ 10 秒 |
| 打鍵が版面に届いた | ✅ `landed: true` |
| キャレットが本文に在る | ✅ `caretInBody: true` |
| **IME の門** | 🔴 **`obj1-win1-panel1-accept0`** |

`accept0` は `qtbase-patch-ime-panel.py` が書く診断である。⚠ **そこから先が読めない** ──
`QPlatformInputContext::inputMethodAccepted()` は `_q_updateFocusObject()` が
更新する**キャッシュ**なので、`accept0` は次の**どちらでも**同じ顔になる:

  (a) LO が `SetInputContext` を呼んでいない = `WA_InputMethodEnabled` が立っていない
  (b) 立っているが、Qt が焦点移動の**後**に取り直さないので古い偽が残っている

⚠ **(a) と (b) では直す場所が正反対である**(LO 側 / Qt 側)。
だから**当てずっぽうで直しを焼かない** ── 先にどちらかを確定させる。

## 上流を読んで数え上げた「途切れうる 4 点」(`/tmp/lo-src` を clone して全数)

`vcl/source/window/window.cxx` `Window::ImplNewInputContext()`(呼び元は
`mouse.cxx:400` の焦点移動と `window.cxx:2073` の `SetInputContext`):

  ① `mpFocusWin` が無い / 破棄中          → 何も送らずに返る
  ② `rInputContext == maOldInputContext`  → **変わっていないので送らない**
                                             (⚠ 一度送った後は二度と送らない)
  ③ 送る(`aNewContext.mnOptions = rInputContext.GetOptions()`)

`vcl/qt5/QtFrame.cxx` `QtFrame::SetInputContext()`(⚠ qt6 プラグインは qt5 の
ソースを include して共有する):

  ④ `mnOptions & InputContextFlags::Text` が偽 → **何もしない**
  ⑤ `m_pQWidget->setAttribute(Qt::WA_InputMethodEnabled)` を立てる

🔑 **①〜④ のどれかで止まっていれば (a)、⑤ まで来ていれば (b) である。**
⚠ ④ は特に効く ── `opts=0x0`(= `InputContextFlags::NONE`)ばかりなら、
Writer の版面が**そもそも「ここは文字を入れる場所だ」と言っていない**ことになり、
Qt をいくら直しても届かない。

## 観測点 ── **DOM を触らない**(2026-08-16 に焼き切った教訓)

🔴 **LO 側の文脈から `emscripten::val` を触ってはいけない。**
`patch-lo-qt-ime-show.py`(run31886407625)と Qt patch の hunk ①(run31909586934)は
どちらも `Aborted(Assertion failed: invalid handle: 12)` で**文書を開いた瞬間に固まった**。
`qtbase-patch-ime-panel.py` の注記どおり **入力の配管は Qt の中で閉じる**。

🔑 だからここは **libc だけ**を使う ── embind も DOM も Qt の API も呼ばない:

  1. `stderr` へ 1 行(emscripten は `err()` = console へ流す。probe が拾う)
  2. `/tmp/pkc3-ime.log`(MEMFS)へ追記 ── ⚠ **こちらが本命**。
     console の取りこぼし(probe 側の上限 / 起動時の洪水)に左右されず、
     probe が `window.__lo.FS.readFile()` で**最後にまとめて**読める

⚠ 書式文字列は**必ずリテラル**にする(`-Wformat-nonliteral` は `-Werror` で落ちる)。
可変長引数を使わず `int` 3 つ固定にしてあるのはそのためである ── 350 分焼いてから
警告で落ちるのが、この件でいちばん高い失敗である。

## 出力の読み方

    PKC3-IME <seq> <what> a=<opts> b=<attr> c=<focus>

| `what` | 意味 | a / b / c |
|---|---|---|
| `vcl:nofocus` | ① 焦点窓が無い | `-1` |
| `vcl:same`    | ② 変わっていないので送らない | a = 今の opts |
| `vcl:send`    | ③ 送る | a = 送る opts |
| `frame:null`  | `pContext` が null | `-1` |
| `frame:notext`| ④ Text ビットが無い | a = 来た opts |
| `frame:enable`| ⑤ 立てる | a = opts / b = **既に立っていたか** / c = **その widget に焦点が在るか** |

🔑 **c(焦点)が要る理由**: Qt が `m_inputMethodAccepted` を計算するのは
**焦点オブジェクトが変わった瞬間**だけである。`c=1`(既に焦点が在る)で ⑤ に来ていれば、
Qt はもう計算を済ませた後なので**取り直さない** = (b) が確定する。

⚠ `seq` は **TU ごとの連番**である(`vcl:` と `frame:` で別々に増える)。
順序を読むときは log の**行の並び**を見る ── seq を突き合わせない。

## ⚠ 既定では何も書き換えない

`PKC3_IME_TRACE=1` を渡した回だけ当てる。⚠ ただし**錨の検査は毎回する** ──
門の下に隠すと、上流が形を変えたことに**誰も気づけなくなる**(気づくのは次に
測ろうとした人で、そのときには 350 分を捨てた後である)。

🔑 **役目が済んだら消す**(CLAUDE.md「理由が消えた仕掛けは、消えた時点で外す」)。
(a) か (b) が確定した時点で、この file は要らない。
"""

import os
import sys
from pathlib import Path

# ── 共通の計装ヘルパー ────────────────────────────────────────────────
#
# ⚠ `static` なので TU ごとに 1 つずつ持つ(counter も別々)。
# ⚠ 上限を置く ── 焦点移動は起動中に何度も起きるので、置かないと log が膨らむ。
HELPER = """
// ── PKC3 #156 段③ の計装(挙動は変えない。`PKC3_IME_TRACE=1` の回だけ入る)──
// ⚠ libc だけを使う。embind / DOM / Qt の API をここから呼んではいけない
//   (LO の文脈から `emscripten::val` を触ると `invalid handle` で abort する)。
#include <cstdio>
namespace
{
void pkc3_ime_trace(const char* what, int a, int b, int c)
{
    static int nSeq = 0;
    if (nSeq >= 400)
        return;
    ++nSeq;
    char line[192];
    // ⚠ 書式はリテラル(`-Wformat-nonliteral` を踏まない)
    std::snprintf(line, sizeof line, "PKC3-IME %d %s a=%d b=%d c=%d\\n", nSeq, what, a, b, c);
    std::fputs(line, stderr);
    std::fflush(stderr);
    // 🔑 本命の出口 ── probe が `window.__lo.FS.readFile()` でまとめて読む
    std::FILE* pLog = std::fopen("/tmp/pkc3-ime.log", "a");
    if (pLog)
    {
        std::fputs(line, pLog);
        std::fclose(pLog);
    }
}
}
"""

# ── ① / ② / ③ ── vcl 側 ──────────────────────────────────────────────
WIN_SRC = "vcl/source/window/window.cxx"
WIN_ANCHOR = """void Window::ImplNewInputContext()
{
    ImplSVData* pSVData = ImplGetSVData();
    vcl::Window* pFocusWin = pSVData->mpWinData->mpFocusWin;
    if ( !pFocusWin || !pFocusWin->mpWindowImpl || pFocusWin->isDisposed() )
        return;

    // Is InputContext changed?
    const InputContext& rInputContext = pFocusWin->GetInputContext();
    if ( rInputContext == pFocusWin->mpWindowImpl->mpFrameData->maOldInputContext )
        return;
"""
WIN_REPLACE = (
    HELPER
    + """
void Window::ImplNewInputContext()
{
    ImplSVData* pSVData = ImplGetSVData();
    vcl::Window* pFocusWin = pSVData->mpWinData->mpFocusWin;
    if ( !pFocusWin || !pFocusWin->mpWindowImpl || pFocusWin->isDisposed() )
    {
        pkc3_ime_trace("vcl:nofocus", -1, -1, -1);
        return;
    }

    // Is InputContext changed?
    const InputContext& rInputContext = pFocusWin->GetInputContext();
    if ( rInputContext == pFocusWin->mpWindowImpl->mpFrameData->maOldInputContext )
    {
        pkc3_ime_trace("vcl:same", static_cast<int>(rInputContext.GetOptions()), -1, -1);
        return;
    }
    pkc3_ime_trace("vcl:send", static_cast<int>(rInputContext.GetOptions()), -1, -1);
"""
)

# ── ④ / ⑤ ── Qt プラグイン側(⚠ qtbase ではなく LO の中である)───────────
FRAME_SRC = "vcl/qt5/QtFrame.cxx"
FRAME_ANCHOR = """void QtFrame::SetInputContext(SalInputContext* pContext)
{
    if (!pContext)
        return;

    if (!(pContext->mnOptions & InputContextFlags::Text))
        return;

    m_pQWidget->setAttribute(Qt::WA_InputMethodEnabled);
}
"""
FRAME_REPLACE = (
    HELPER
    + """
void QtFrame::SetInputContext(SalInputContext* pContext)
{
    if (!pContext)
    {
        pkc3_ime_trace("frame:null", -1, -1, -1);
        return;
    }

    if (!(pContext->mnOptions & InputContextFlags::Text))
    {
        pkc3_ime_trace("frame:notext", static_cast<int>(pContext->mnOptions), -1, -1);
        return;
    }

    // 🔑 立てる**前**に読む ── b=1 なら「既に立っていた」、c=1 なら「もう焦点が在る」。
    //    c=1 で来ていれば Qt は受付可否を計算し終えた後なので取り直さない(= 上の (b))。
    pkc3_ime_trace("frame:enable", static_cast<int>(pContext->mnOptions),
                   m_pQWidget->testAttribute(Qt::WA_InputMethodEnabled) ? 1 : 0,
                   m_pQWidget->hasFocus() ? 1 : 0);
    m_pQWidget->setAttribute(Qt::WA_InputMethodEnabled);
    // 🔴 **立てた後を読む**(#156、2026-08-24)。⚠ ここが要る理由:
    //    診断属性 `data-pkc-ime` は `QWasmInputContext::updateInputElement()` の中でしか
    //    書かれず、そこを呼ぶ hunk は 2026-08-16 に外してある。だから DOM の `accept0` は
    //    **古い値**であって、「いまも偽」の証拠にならない(2 つの読みが分けられない):
    //      (a) 直しの後に updateInputElement() が一度も走っていない
    //      (b) 走ったが inputMethodAccepted() がまだ偽
    // 🔑 ここは **DOM を通らない**ので、その曖昧さが消える ── b=1 なら
    //    setInputMethodAccepted(true) は済んでいる(= (a) が答え)。
    // ⚠ 直しの patch(`patch-lo-ime-update.py`)は上の setAttribute 行を錨にして
    //    その**直後**へ update(ImEnabled) を挿すので、この読み出しは**必ず直しの後**に来る
    //    (glob の順で trace < update。逆順なら update 側が「錨 0 件」で大声で落ちる)。
    // ⚠ 新しい型を持ち込まない ── `queryFocusObject` は QInputMethod の公開メソッドで、
    //    QInputMethodQueryEvent を自分で組むのと同じことを内部でやる(include を足さずに済む)。
    {
        QObject* pFocus = QGuiApplication::focusObject();
        const bool bEnabled
            = QGuiApplication::inputMethod()->queryFocusObject(Qt::ImEnabled, QVariant()).toBool();
        pkc3_ime_trace("frame:after", pFocus ? 1 : 0, bEnabled ? 1 : 0,
                       pFocus == static_cast<QObject*>(m_pQWidget) ? 1 : 0);
    }
}
"""
)

TARGETS = (
    (WIN_SRC, WIN_ANCHOR, WIN_REPLACE, "vcl:nofocus"),
    (FRAME_SRC, FRAME_ANCHOR, FRAME_REPLACE, "frame:enable"),
)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-ime-trace.py <lo-core-dir>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    on = os.environ.get("PKC3_IME_TRACE") == "1"

    # ⚠ **錨の検査は門の外でやる**(門の下に隠すと上流の変形に誰も気づけない)。
    loaded: list[tuple[Path, str, str, str]] = []
    for src, anchor, replace, mark in TARGETS:
        path = root / src
        if not path.exists():
            print(f"ERROR: {src} が無い({path})", file=sys.stderr)
            return 1
        text = path.read_text(encoding="utf-8")
        # ⚠ 二重当ては止める(冪等ではない ── ヘルパーが 2 つ入る)
        if "pkc3_ime_trace" in text:
            print(f"ERROR: {src} に既に計装が入っている(二重当て)", file=sys.stderr)
            return 1
        hits = text.count(anchor)
        if hits != 1:
            print(
                f"ERROR: 錨が {hits} 件({src})── 上流が形を変えた。"
                "計装の当て先を読み直すこと",
                file=sys.stderr,
            )
            return 1
        loaded.append((path, text.replace(anchor, replace), mark, src))

    if not on:
        # 🔑 既定は**測らない** ── 配る一式に計装を混ぜない。錨だけ確かめて抜ける
        print("skip: PKC3_IME_TRACE=1 ではないので計装しない(錨は 2 件とも在る)")
        return 0

    for path, patched, mark, src in loaded:
        path.write_text(patched, encoding="utf-8")
        # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は
        #    全部通り、CI 全緑のまま計装が artifact に 1 バイトも入らない)
        written = path.read_text(encoding="utf-8")
        if mark not in written or "pkc3_ime_trace(" not in written:
            print(f"ERROR: 書き戻し後の {src} に計装が無い(write が落ちている)", file=sys.stderr)
            return 1
        print(f"patched: {src}(#156 段③ の計装)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
