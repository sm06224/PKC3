#!/usr/bin/env python3
"""#156 の**直し**。IME の受付可否を、属性を立てた直後に Qt へ取り直させる。

🔴 **これは計装ではない。既定で当たる**(`patch-lo-ime-trace.py` と対になる後段である)。

## なぜ 1 行で足りるのか(2026-08-24 の実測で (b) が確定した)

段③ の計装入り一式で、**対照群が両方届いた回**(文書が開き `landed` / `caretInBody`
がどちらも真)の trace は次のとおりだった:

    PKC3-IME 1 vcl:send     a=3 b=-1 c=-1
    PKC3-IME 1 frame:enable a=3 b=0  c=1
    PKC3-IME 2 vcl:same     a=3 b=-1 c=-1     ← 以降 7 行すべて same

| 途切れうる点 | 実測 |
|---|---|
| ① 焦点窓が無い | `vcl:nofocus` **0 件** |
| ② 変わらないので送らない | 初回だけ `send`、以後 `same` ×7 |
| ③ 送る opts | `a=3` = `Text｜ExtText`(`include/vcl/inputctx.hxx:28-33`) |
| ④ Text ビットが無い | `frame:notext` **0 件** |
| ⑤ 立てる | 🔴 **到達している**(`b=0` = まだ立っていなかった / `c=1` = **既に焦点が在る**) |

ところが**同じ回**の Qt 側の診断は、押す前も打った後も `obj1-win1-panel1-accept0`。
つまり **LO は `WA_InputMethodEnabled` を立てているのに、Qt の
`m_inputMethodAccepted` が偽のまま**である ── これが (b) であり、
(a)(LO が呼んでいない)は `frame:enable` の存在で**反証された**。

## なぜ取り直されないか(上流の実物を読んだ。推測ではない)

`QPlatformInputContextPrivate::setInputMethodAccepted()` の呼び元は Qt 全体で **2 か所**:

  1. `QGuiApplicationPrivate::_q_updateFocusObject()`  qguiapplication.cpp:4405-4412
     ← **焦点オブジェクトが変わった瞬間だけ**
  2. `QInputMethod::update(Qt::ImEnabled)`             qinputmethod.cpp:283-287
     ← 明示的に頼まれたとき

`c=1` は「⑤ に来た時点で既に焦点が在った」ということなので **1 は済んだ後**である
(そのときはまだ `b=0` = 属性が立っていないので、Qt は正しく「偽」を記録して去った)。
2 は**誰も呼んでいない** ── だから偽が居座る。

🔑 だから直しは **2 を呼ぶ 1 行**である。**Qt には手を入れない**
(Qt 側を触る patch は 2026-08-15 / 08-16 に 2 度 abort させている ──
`patch-lo-ime-trace.py` の「観測点」の節)。

## ⚠ include は足さない

`QGuiApplication::inputMethod()` は `QInputMethod*` を返すので完全型が要るが、
`qguiapplication.h:10` が `qinputmethod.h` を**直に include している**ので、
`QtFrame.cxx` は既に持っている(`#include <QtWidgets/QApplication>` 経由)。
🔑 同じ綴りが **LO 自身の中で既に通っている** ── `vcl/qt5/QtWidget.cxx:349` の
`QGuiApplication::inputMethod()->update(Qt::ImQueryInput);`(include は
`<QtGui/QGuiApplication>` 1 本だけ)。**新しい書き方を持ち込んでいない。**

## ⚠ 錨は「実行する行そのもの」で採る

関数まるごとを錨にすると `patch-lo-ime-trace.py`(同じ関数を書き換える)と
**当てる順で壊れる**。1 行だけを錨にすれば、計装が入っていても入っていなくても
同じ場所に当たる ── 2 つの patch が**互いを知らずに済む**。

⚠ ただし**逆は成り立たない** ── `patch-lo-ime-trace.py` は関数まるごとを錨にするので、
こちらを**先に**当てると計装側が「錨が 0 件」で落ちる。workflow のループは
`patch-*.py` を glob の順で回すので **`trace` < `update`** で正しい順に当たる(実測済み)。
🔑 逆順になっても**黙って通らず、大声で落ちる**(不良物を焼かない)。

## 🔑 効いたことをどう確かめるか

Qt 側の診断属性(`qtbase-patch-ime-panel.py` が書く `data-pkc-ime`)が
`accept0` → **`accept1`** になること。手順は `build/office-wasm/open-doc-probe.mjs`
に `PKC3_IME=1` を渡す(⚠ **対照群 `landed` / `caretInBody` が両方真の回だけ読む**)。

⚠ **`accept1` になっても、そこから先(候補窓が出るか)は実 IME でしか確かめられない。**
"""

import sys
from pathlib import Path

SRC = "vcl/qt5/QtFrame.cxx"

# ⚠ 錨は**実行する行**(前後の空白ごと)。関数まるごとにしない ── 上の「錨」の節。
ANCHOR = "    m_pQWidget->setAttribute(Qt::WA_InputMethodEnabled);\n"

REPLACE = """    m_pQWidget->setAttribute(Qt::WA_InputMethodEnabled);
    // ── PKC3 #156: 立てた**直後**に受付可否を取り直させる ──
    // Qt が m_inputMethodAccepted を計算するのは (1) 焦点オブジェクトが変わった瞬間
    // (2) ここで呼ぶ update(ImEnabled) の 2 か所だけである。ここへ来る時点で
    // widget には既に焦点が在る(実測 c=1)ので (1) は済んだ後 ── 頼まないと
    // 「属性は立っているのに受け付けない」が居座る。
    QGuiApplication::inputMethod()->update(Qt::ImEnabled);
"""

MARK = "QGuiApplication::inputMethod()->update(Qt::ImEnabled);"


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-ime-update.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")
    # ⚠ 二重当てを止める(冪等ではない ── 呼び出しが 2 つ入る)
    if MARK in text:
        print(f"ERROR: {SRC} に既に直しが入っている(二重当て)", file=sys.stderr)
        return 1
    hits = text.count(ANCHOR)
    if hits != 1:
        print(
            f"ERROR: 錨が {hits} 件({SRC})── 上流が形を変えた。当て先を読み直すこと",
            file=sys.stderr,
        )
        return 1
    path.write_text(text.replace(ANCHOR, REPLACE), encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は
    #    全部通り、CI 全緑のまま直しが artifact に 1 バイトも入らない)
    if MARK not in path.read_text(encoding="utf-8"):
        print(f"ERROR: 書き戻し後の {SRC} に直しが無い(write が落ちている)", file=sys.stderr)
        return 1
    print(f"patched: {SRC}(#156 の直し ── 受付可否を取り直させる)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
