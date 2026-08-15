#!/usr/bin/env python3
"""文字入力に入るとき、入力パネルを要求する(#156 日本語入力ができない)。

## 症状(user 報告 2026-08-14)

> **少なくとも Mac で日本語入力はできません**

変換候補の窓すら出ない ── 文字は入るのに、IME が使えない。

## 🔴 真因(上流 Qt の実物で確定。推測ではない)

ブラウザの IME は **focus された編集可能要素**を要求する。Qt for WebAssembly は
そのための隠し `<input>`(`QWasmInputContext::m_inputElement`)を持っているが、
`qwasminputcontext.cpp` の `updateInputElement()` は **4 条件が全部真のときだけ**
`m_inputElement.call("focus")` に到達し、偽なら**能動的に `blur()` する**:

    if (!m_focusObject || !focusWindow || !m_visibleInputPanel || !m_inputMethodAccepted) {
        m_inputElement.set("value", "");
        m_inputElement.call<void>("blur");     // ← ここに落ちている
        ...
        return;
    }

- `m_inputMethodAccepted` は真になる ── LO が `QtFrame::SetInputContext` で
  `Qt::WA_InputMethodEnabled` を立てるので、focus object の `ImEnabled` が真
- `m_visibleInputPanel` は **`showInputPanel()` が呼ばれたときだけ**真になる
  (`qwasminputcontext.cpp:309-315`)。これは `QInputMethod::show()` の受け口 =
  **仮想キーボードの要求**であり、**LO は 1 度も呼んでいない**
  (`vcl/qt5/*.cxx` の全数 grep で `inputMethod()->show` は 0 件)

⇒ 隠し `<input>` は永久に focus されず、IME は候補窓を出せない。
起票時の実測(`activeElement` が常に `DIV#qt-shadow-container`)と噛み合う。

## 直し ── LO 側から入力パネルを要求する(#156 の案 B)

`QtFrame::SetInputContext` は **vcl が「ここから文字入力だ」と告げてくる唯一の
touchpoint** で、既に `WA_InputMethodEnabled` を立てている。同じ場所で
`QGuiApplication::inputMethod()->show()` を呼ぶ ── これが上流の意図した経路である。

⚠ **Qt を patch しない**(案 A)理由: qtbase を触ると Qt の cache 鍵が変わり
**Qt ごと焼き直し**になる。LO 側なら Qt は cache のままで済む。上流の意図にも近い。

⚠ **通常の打鍵は壊れない**(確認済み)── Qt は隠し `<input>` にも keydown/keyup を
張っている(`qwasmwindow.cpp:120-128` の `m_keyDownCallbackForInputContext`)ので、
focus がそちらへ移っても鍵は Qt に届く。**上流はこの状態を想定している**。

⚠ **Emscripten だけに効かせる** ── デスクトップで `show()` を呼ぶと、環境に
よっては画面上キーボードを出しうる。挙動を変えてよいのは wasm の側だけ。
"""

import sys
from pathlib import Path

SRC = "vcl/qt5/QtFrame.cxx"

INC_ANCHOR = "#include <QtGui/QDragMoveEvent>"
INC_REPLACE = "#include <QtGui/QDragMoveEvent>\n#include <QtGui/QInputMethod>"

BODY_ANCHOR = "    m_pQWidget->setAttribute(Qt::WA_InputMethodEnabled);"
BODY_REPLACE = (
    "    m_pQWidget->setAttribute(Qt::WA_InputMethodEnabled);\n"
    "\n"
    "#ifdef __EMSCRIPTEN__\n"
    "    // PKC3/#156: wasm では入力パネルを要求しないと、Qt は IME 用の隠し\n"
    "    // <input> を focus せず **blur する**(qwasminputcontext.cpp の\n"
    "    // updateInputElement)。ブラウザの IME は focus された編集可能要素を\n"
    "    // 要求するので、その状態では変換候補の窓すら出ない。\n"
    "    // ⚠ 打鍵は壊れない ── Qt はその <input> にも keydown/keyup を張っている。\n"
    "    if (QInputMethod* pInputMethod = QGuiApplication::inputMethod())\n"
    "        pInputMethod->show();\n"
    "#endif"
)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-qt-ime-show.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")

    # ⚠ 既に当たっている / 上流が自分で入れた場合は止める。
    #   🔑 錨の検査より**先**に見る(popup-focus のレビュー指摘)。
    #   🔑 コメントを剥いだ**コード行だけ**で見る(散文に満たされない)。
    code_only = "\n".join(line.split("//", 1)[0] for line in text.splitlines())
    if "inputMethod()->show" in code_only or "pInputMethod->show" in code_only:
        print(
            "ERROR: QtFrame.cxx が既に入力パネルを要求している\n"
            "  → 二重適用か、上流が自分で入れた。確かめてから外すこと",
            file=sys.stderr,
        )
        return 1
    for name, anchor in (("include", INC_ANCHOR), ("body", BODY_ANCHOR)):
        hits = text.count(anchor)
        if hits != 1:
            print(f"ERROR: {name} の錨が {hits} 件({SRC})", file=sys.stderr)
            return 1

    text = text.replace(INC_ANCHOR, INC_REPLACE)
    text = text.replace(BODY_ANCHOR, BODY_REPLACE)

    # 後条件 ── 挿入が SetInputContext の**中**に在ること(字面だけでなく位置)。
    at = text.index(BODY_REPLACE)
    fn_at = text.index("void QtFrame::SetInputContext(SalInputContext* pContext)")
    next_fn_at = text.index("void QtFrame::EndExtTextInput(")
    if not (fn_at < at < next_fn_at):
        print("ERROR: 挿入が SetInputContext の外に在る", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落とすと in-memory 検査だけ通る)
    written = path.read_text(encoding="utf-8")
    if "pInputMethod->show();" not in written:
        print(f"ERROR: 書き戻し後の {SRC} に要求コードが無い(write が落ちている)", file=sys.stderr)
        return 1
    print(f"patched: {SRC}(文字入力で入力パネルを要求 → IME の候補窓が出る /#156)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
