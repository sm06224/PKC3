#!/usr/bin/env python3
"""Qt 6.9 wasm で **IME の入力要素が一度も focus されない**のを直す(#156)。

🔴 **これは上流 Qt 6.10 の修正の backport である**(2026-08-15 に方針を差し替えた)。
自前の思いつきではない ── 上流が同じ症状を同じ原因で直しており、
その課題名は **QTBUG-136687「Wasm LibreOffice no longer gets keyboard input events」**、
commit は **`a89ac4b88`「wasm: handle changes in inputMethodAccepted()」**(2025-05-12)。
6.10 / 6.11 / 6.12 / dev に入っており、**6.9 には backport されていない**。

## 何が起きているか(実測 `build/office-wasm/ime-probe.mjs`)

`<input>` は在るのに **一度も focus されない**。ブラウザの IME は
**focus された編集可能要素**を要求する(W3C UI Events: composition の target は
"focused element")ので、変換窓すら出ない ── user 報告「Mac で日本語入力ができない」と一致。

## 根(上流を clone して読んで確定 ── 推測ではない)

`qwasminputcontext.cpp` の `updateInputElement()` は **4 項の AND** で早期 return する:

    if (!m_focusObject || !focusWindow || !m_visibleInputPanel || !m_inputMethodAccepted)
        ... blur(); focusWindow->handle()->focus();  return;   // canvas へ focus が戻る

このうち **2 つが 6.9 では恒久的に false** になる:

1. `m_visibleInputPanel` ── 立てるのは `showInputPanel()` だけで、その唯一の呼び手は
   `QInputMethod::show()`。さらにそれを呼ぶのは `QLineEdit` / `QTextEdit` /
   `QPlainTextEdit` / `QGraphicsItem` の mouse/key release だけである。
   **LibreOffice は自前描画のウィジェットなのでどれにも当たらない。**
2. 🔴 `m_inputMethodAccepted` ── **`setFocusObject()` の中でしか代入されない**。
   LO は `QtFrame::SetInputContext()` で `WA_InputMethodEnabled` を後から立てるので、
   `QWidget::setAttribute()` → `QInputMethod::update(Qt::ImEnabled)` が走るが、
   **6.9 の `QWasmInputContext::update()` は基底を呼ぶだけで member を取り直さない** ──
   グローバルの `inputMethodAccepted()` は true になったのに、member は false のまま
   取り残される。⚠ LO が毎キー呼ぶ `update(Qt::ImQueryInput)` は
   **`ImEnabled` を含まない**ので、この経路でも絶対に発火しない。

⚠ **1 稿目はここを取り違えた** ── ① だけ直して焼き、効かなかった。
② が本命であり、上流もそう直している。

## 直し方(上流 6.10 の形にする)

1. `update()` が `Qt::ImEnabled` の変化を拾い、`updateInputElement()` を呼ぶ
2. `updateInputElement()` の先頭で `m_inputMethodAccepted` を**毎回取り直す**
3. `m_visibleInputPanel` の門を**外す**(上流はメンバごと削除した。ここでは
   既定値を true にして門を無効化する ── `hideInputPanel()` の経路を壊さないため、
   メンバ自体は残す)

上流のコメント(6.10)がこの判断そのものを書いている:

    // Note: showInputPanel not necessarily called, we shall
    // still accept input if we have a focus object and inputMethodAccepted().

## 🔴 なぜ LO 側から `QInputMethod::show()` を呼ぶ案を捨てたか(2026-08-15)

最初はそちらを焼いて配ってしまった(`patch-lo-qt-ime-show.py`、run31886407625)。
結果は **文書を開いた瞬間に wasm が abort**:

    Aborted(Assertion failed: invalid handle: 12)   /   RuntimeError: unreachable

同じ対照文書で 3 つの一式を比べて確定した。`SetInputContext` は LO 側のスレッド文脈で
走るので、そこから embind 越しに Qt の `val` を触るのが不正だった。
🔑 **入力の配管は Qt の中で閉じる。** 外から呼ばない ── 上流も同じ向きへ倒している。
"""
import sys
from pathlib import Path

HEADER = "src/plugins/platforms/wasm/qwasminputcontext.h"
SRC = "src/plugins/platforms/wasm/qwasminputcontext.cpp"

# ── ③ 仮想キーボードの門を無効化する(上流はメンバごと削除) ────────────
HEAD_ANCHOR = "    bool m_visibleInputPanel = false;"
HEAD_REPLACE = (
    "    // PKC3 #156(上流 6.10 の a89ac4b88 に相当): showInputPanel() は\n"
    "    // デスクトップのブラウザでは呼ばれない。上流はこのメンバごと削除したが、\n"
    "    // ここでは hideInputPanel() の経路を壊さないため既定値だけ反転させる。\n"
    "    bool m_visibleInputPanel = true;"
)

# ── ② 早期 return の直前で `m_inputMethodAccepted` を取り直す ────────────
#
# ⚠ **ここが本命**。1 稿目はこれを入れずに ③ だけ入れて効かなかった。
# あわせて診断(4 条件を DOM に書く)も残す ── 直っていなければ、どの項が 0 かが
# **同じ焼きで**分かる(1 ビルド ≒ 4 時間なので、2 度焼かない)。
DIAG_ANCHOR = """    const QWindow *focusWindow = QGuiApplication::focusWindow();
    if (!m_focusObject || !focusWindow || !m_visibleInputPanel || !m_inputMethodAccepted) {"""
DIAG_REPLACE = """    const QWindow *focusWindow = QGuiApplication::focusWindow();
    // PKC3 #156(上流 6.10 の a89ac4b88 に相当): inputMethodAccepted() は
    // setFocusObject() の後に変わりうる(LO は WA_InputMethodEnabled を後から立てる)。
    // 6.9 は update() でそれを拾わないので、ここで毎回取り直す。
    m_inputMethodAccepted = inputMethodAccepted();
    // PKC3 #156 診断: 早期 return の 4 条件を DOM から読めるようにする(挙動は変えない)
    m_inputElement.call<void>("setAttribute", std::string("data-pkc-ime"),
        std::string((m_focusObject ? "obj1" : "obj0"))
        + (focusWindow ? "-win1" : "-win0")
        + (m_visibleInputPanel ? "-panel1" : "-panel0")
        + (m_inputMethodAccepted ? "-accept1" : "-accept0"));
    if (!m_focusObject || !focusWindow || !m_visibleInputPanel || !m_inputMethodAccepted) {"""

# ── ① `update()` が ImEnabled の変化を拾う ──────────────────────────────
#
# 🔴 **2026-08-16: この hunk を外した。文書を開くと固まる退行の原因だからである。**
#
# 実測(対照群つき・決定的):
#   pack lo-fb02e9d1fc62-run31890208793(**同じ LO sha・この patch 無し**) → 全段完走
#   pack lo-fb02e9d1fc62-run31909586934(**同じ LO sha・この patch 有り**) → 文書を開くと固まる
#   差は Qt patch だけなので、原因はここに在る。
#
# 症状: Start Center は健全。**文書を開いた瞬間**に CPU 100% で戻らなくなる
#   (RSS は増えない = 割当ループではなく「戻ってこない」)。console は
#   `Aborted(Assertion failed: invalid handle: 12)` / `RuntimeError: unreachable`。
#
# 🔑 **`invalid handle` は embind の handle を別スレッドから触ったときの形**である。
#   ⚠ そして**同じ assert が、以前 LO 側から `QInputMethod::show()` を呼んで
#   abort したとき**にも出ている(`patch-lo-qt-ime-show.py`、run31886407625)──
#   「Qt の外の文脈から embind の val を触ると落ちる」という**同じ顔**である。
#   LO は `update(Qt::ImQueryInput)` を**自分のスレッド文脈から毎キー**呼ぶので、
#   そこから `updateInputElement()`(= `m_inputElement` という `emscripten::val`)を
#   直接触るのが不正だった、というのが仮説。
#   ⚠ **仮説である**(一致は因果の証拠ではない)── だからこの焼きで**この hunk だけ**を外す。
#
# 🔑 **外しても直る可能性は残っている**: `updateInputElement()` は `setFocusObject()`
#   からも呼ばれるので、LO が `WA_InputMethodEnabled` を立てた**後の焦点移動**で
#   ② の再取得が効けば、門を通れる。② と ③ はそのまま残す。
#
# 戻す条件: 「メインスレッドのときだけ DOM を触る」ガードを足した版で、
#   文書が開けることを確かめてから。
UNUSED_UPDATE_ANCHOR = """void QWasmInputContext::update(Qt::InputMethodQueries queries)""" 
UPDATE_ANCHOR = """void QWasmInputContext::update(Qt::InputMethodQueries queries)
{
    qCDebug(qLcQpaWasmInputContext) << Q_FUNC_INFO << queries;

    QPlatformInputContext::update(queries);
}"""
UPDATE_REPLACE = """void QWasmInputContext::update(Qt::InputMethodQueries queries)
{
    qCDebug(qLcQpaWasmInputContext) << Q_FUNC_INFO << queries;

    // PKC3 #156(上流 6.10 の a89ac4b88 に相当): 受け付けの可否は
    // setFocusObject() の後に変わりうる。変わったら入力要素を作り直す ──
    // これが無いと、LO のように「focus が定まってから WA_InputMethodEnabled を
    // 立てる」作りでは **永久に false のまま**になり、<input> が focus されない。
    if ((queries & Qt::ImEnabled) && (inputMethodAccepted() != m_inputMethodAccepted)) {
        if (m_focusObject && !preeditString().isEmpty())
            commitPreeditAndClear();
        updateInputElement();
    }
    QPlatformInputContext::update(queries);
}"""


def patch(path: Path, anchor: str, replace: str, what: str) -> int:
    """1 か所だけ書き換える。⚠ **当たったことを確かめる**(空振りを成功と読まない)。"""
    if not path.exists():
        print(f"ERROR: {what}: {path} が無い", file=sys.stderr)
        return 1
    src = path.read_text(encoding="utf-8")
    if replace in src:
        print(f"{what}: already patched")
        return 0
    n = src.count(anchor)
    if n != 1:
        print(f"ERROR: {what}: 目印が {n} 件(1 件でなければ当てない)", file=sys.stderr)
        return 1
    path.write_text(src.replace(anchor, replace), encoding="utf-8")
    after = path.read_text(encoding="utf-8")
    if replace not in after:
        print(f"ERROR: {what}: 書き換えが残っていない", file=sys.stderr)
        return 1
    print(f"{what}: patched {path}")
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: qtbase-patch-ime-panel.py <qtbase-dir>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    rc = patch(root / HEADER, HEAD_ANCHOR, HEAD_REPLACE, "panel-gate")
    if rc != 0:
        return rc
    # ⚠ ① は外してある(上の注記 ── 文書を開くと固まる退行の原因)。
    #    ② の再取得と ③ の門の無効化だけを当てる。
    return patch(root / SRC, DIAG_ANCHOR, DIAG_REPLACE, "reread+diag")


if __name__ == "__main__":
    raise SystemExit(main())
