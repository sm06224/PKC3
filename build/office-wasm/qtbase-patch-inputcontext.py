#!/usr/bin/env python3
"""Qt 6.9 の `QWasmInputContext::setFocusObject` が**破棄中に死ぬ**のを直す(#134)。

## 🔴 これは LibreOffice ではなく **Qt for WebAssembly の不具合**である

検証レポート #5 が「**モードレスダイアログを閉じると `memory access out of
bounds` で停止**」を 5/5 で報告し、`build/office-wasm/dialog-crash-probe.mjs` で
**手元でも 1/1 で再現**した。⚠ 出荷 wasm には name section が無いので当初は
「10 段のスタックが全部ただの整数」だったが、`--profiling-funcs` で焼き直したら
**そのまま犯人が出た**(下から読む):

    QtExpander::~QtExpander()                       ← LO の widget が壊れる
    QWidget::~QWidget()
    QWidget::clearFocus()                           ← デストラクタが focus を外し
    QWindow::focusObjectChanged(QObject*)           ← シグナルが飛び
    QMetaObject::activate(...)
    void doActivate<false>(...)
    QGuiApplication::qt_static_metacall(...)
    QWasmInputContext::setFocusObject(QObject*)     ← ⚠ ここが受ける
    QCoreApplication::sendEvent(QObject*, QEvent*)
    QCoreApplicationPrivate::notify_helper(...)     ← 💥 範囲外アクセス

`qwasminputcontext.cpp:397-405`(6.9)は、渡された `object` を**何も検めずに**
`QInputMethodQueryEvent` を送っている:

    QInputMethodQueryEvent query(...ImEnabled | ImHints);
    QCoreApplication::sendEvent(object, &query);     // ⚠ object を検めない

⚠ `QWidget::clearFocus()` は破棄の途中で **focus を外す**ので、ここへ来る
`object` は **null(または壊れかけ)**である。wasm では null 参照が
そのまま「範囲外アクセス」のトラップになる ── 観測された症状と一致する。

## 🔑 直し方は上流が出している ── 6.10 で**この送信ごと消えた**

`setFocusObject` から query を取り除き、password 判定は
`updateInputElement()` の**既存の null ガードより内側**へ移してある
(6.10 / 6.11 / dev で確認、3 枝とも同じ形)。本パッチはそれを 6.9 へ**移植**する。

⚠ **6.9 へそのまま持ってこられる**ことは確かめた ── 6.9 の
`updateInputElement()` は既に

    if (!m_focusObject || !focusWindow || !m_visibleInputPanel || !m_inputMethodAccepted)
        return;

を持ち、`Q_ASSERT(m_focusObject)` の後で `m_focusObject` へ query を送っている。
つまり**受け入れ先は同じ形で存在する**。

⚠ 1 点だけ挙動が変わる: 6.9 の早期 return には `!m_visibleInputPanel` が
在るので、**入力パネルが出ていないときは password 種別を設定しなくなる**。
実害は無い ── `type=password` は IME 用の `<input>` を実際に使うときにしか
効かないためである(6.10 はこの条件自体を落としている)。

## ⚠ なぜ Qt を上げないのか

**6.9 から動けない。** LO の Qt6 モードは `qstdweb::EventListener` の embind
登録を名指しで export するが、それは **6.9 にしか無い**(6.10 で
`QWasmSuspendResumeControl` へ置き換わった)。一方 `-feature-wasm-jspi` は
**6.9 で新設**された ── 上下から挟まれて 6.9 で一意に決まる
(`.github/workflows/office-wasm-build.yml` の `qt_ref` の注記)。
だから**移植するしかない**。

## ⚠ 名前が `patch-*.py` でないのは、当てる先が違うから

既存の `patch-qt6-*.py` は名前に反して **LibreOffice の makefile** を直す
(Qt6 経路の取りこぼしを LO 側で埋めるもの)。本 file は **qtbase そのもの**を
書き換えるので、`patch-*.py` の一括ループに巻き込まれないよう接頭辞を分けてある。
⚠ 巻き込むと `~/lo-core` を渡されて「`src/plugins/...` が無い」で落ちる。

🔴 **当てるのは Qt をビルドする前**であり、**Qt の cache 鍵に本 file を含める**
必要がある ── 含めないと**パッチ前の Qt が復元されて、当てたのに効かない**
(workflow が既に同じ罠を注記している)。

## ⚠ 当たったことを確かめてから当てる

錨が 1 つでも見つからなければ**異常終了する**。上流が形を変えたときに、
黙って素通り(= 効いていないのに緑)になるのを防ぐ。
"""

import sys
from pathlib import Path

SRC = "src/plugins/platforms/wasm/qwasminputcontext.cpp"

# 🔴 `setFocusObject` から取り除く塊(6.9 の 397-405)。
# ⚠ 空白・改行まで上流と一致させる ── ずれたら気づきたい
ANCHOR_QUERY = """    QInputMethodQueryEvent query(Qt::InputMethodQueries(Qt::ImEnabled | Qt::ImHints));
    QCoreApplication::sendEvent(object, &query);
    if (query.value(Qt::ImEnabled).toBool()
        && Qt::InputMethodHints(query.value(Qt::ImHints).toInt()).testFlag(Qt::ImhHiddenText)) {
        m_inputElement.set("type", "password");
    } else {
        if (m_inputElement["type"].as<std::string>() != std::string("text"))
            m_inputElement.set("type", "text");
    }

"""

REPLACE_QUERY = """    // PKC3(#134): 上流 6.10 と同じく、ここでは query を送らない。
    // ⚠ `QWidget::~QWidget()` → `clearFocus()` から来る `object` は破棄中(null)で、
    //    `sendEvent` が範囲外アクセスで停止する。password 判定は
    //    `updateInputElement()` の null ガードの内側へ移した。
"""

# 🔴 password 判定の受け入れ先(`updateInputElement` の末尾、focus を当てる直前)。
ANCHOR_TYPE = """    m_inputElement.set("selectionEnd", queryEvent.value(Qt::ImCursorPosition).toUInt());

    m_inputElement.call<void>("focus");
"""

REPLACE_TYPE = """    m_inputElement.set("selectionEnd", queryEvent.value(Qt::ImCursorPosition).toUInt());

    // PKC3(#134): 上流 6.10 がここへ移した password 判定。
    // 🔑 上の早期 return を抜けているので `m_focusObject` は非 null である
    //    (`Q_ASSERT(m_focusObject)` 済み)── setFocusObject と違って安全。
    {
        QInputMethodQueryEvent hintQuery((Qt::InputMethodQueries(Qt::ImHints)));
        QCoreApplication::sendEvent(m_focusObject, &hintQuery);
        if (Qt::InputMethodHints(hintQuery.value(Qt::ImHints).toInt())
                .testFlag(Qt::ImhHiddenText))
            m_inputElement.set("type", "password");
        else
            m_inputElement.set("type", "text");
    }

    m_inputElement.call<void>("focus");
"""


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: qtbase-patch-inputcontext.py <qtbase-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")

    for anchor in (ANCHOR_QUERY, ANCHOR_TYPE):
        hits = text.count(anchor)
        if hits != 1:
            print(
                f"ERROR: 錨が {hits} 件({SRC})。上流が形を変えた可能性がある:\n"
                f"{anchor[:120]}...",
                file=sys.stderr,
            )
            return 1

    text = text.replace(ANCHOR_QUERY, REPLACE_QUERY)
    text = text.replace(ANCHOR_TYPE, REPLACE_TYPE)

    # ⚠ 置換が本当に効いたか(空振りを合格と読まない)
    if "sendEvent(object, &query)" in text:
        print("ERROR: 危ない sendEvent が残っている", file=sys.stderr)
        return 1
    if "hintQuery" not in text:
        print("ERROR: password 判定を移せていない", file=sys.stderr)
        return 1
    # 🔴 **移した先が「ガードの内側」であること**を字面で確かめる ──
    #    受け入れ先を取り違えると、直したつもりで同じ場所へ戻る
    body = text[text.index("void QWasmInputContext::updateInputElement()") :]
    guard = body.index("Q_ASSERT(m_focusObject);")
    if body.index("hintQuery") < guard:
        print("ERROR: password 判定が null ガードの外に在る", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    print(f"patched: {SRC}(setFocusObject の破棄中 sendEvent を除去 / #134)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
