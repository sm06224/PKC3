#!/usr/bin/env python3
"""Qt 6.9 wasm で **IME の入力要素が一度も focus されない**のを直す(#156)。

## 何が起きているか(実測 `build/office-wasm/ime-probe.mjs`)

`<input>` は在るのに **一度も focus されない** ── ブラウザの IME は
**focus された編集可能要素**を要求するので、変換窓すら出ない(user 報告
「少なくとも Mac で日本語入力はできません」と一致)。

## 根(上流を読んで確定 ── 推測ではない)

`qwasminputcontext.cpp:358` の早期 return:

    if (!m_focusObject || !focusWindow || !m_visibleInputPanel || !m_inputMethodAccepted)
        return;      // ← ここで blur() して戻る

`m_visibleInputPanel` は **`showInputPanel()` が呼ばれたときだけ真**になる
(`qwasminputcontext.cpp:309-312`)。これは**仮想キーボードの要求**であり、
デスクトップのブラウザでは誰も呼ばない ── よって `focus()` に到達しない。

## 直し方: 既定を `true` にする(1 行)

`qwasminputcontext.h:54` の初期値を反転させる。以後は
`m_inputMethodAccepted`(= 実際に文字を編集できる相手に focus が在る)だけが
条件になり、実測と噛み合う。

⚠ **`hideInputPanel()` は生きたまま**(仮想キーボードを畳む経路は壊さない)。
⚠ `Q_ASSERT(m_visibleInputPanel)` は release ビルドで no-op、かつ真になる側なので
   どちらにせよ発火しない。

## 🔴 なぜ LO 側から `QInputMethod::show()` を呼ぶ案を捨てたか(2026-08-15)

最初はそちらを焼いて配ってしまった(`patch-lo-qt-ime-show.py`、run31886407625)。
結果は **文書を開いた瞬間に wasm が abort**:

    Aborted(Assertion failed: invalid handle: 12)   /   RuntimeError: unreachable

同じ対照文書で 3 つの一式を比べて確定した ── 当該ビルドだけ 14 秒で落ち、
run31858851265 / run31793231364 は落ちない。`SetInputContext` は LO 側の
スレッド文脈で走るので、そこから embind 越しに Qt の `val` を触るのが不正だった。
🔑 **入力の配管は Qt の中で閉じる。** 外から呼ばない。
"""
import sys
from pathlib import Path

HEADER = "src/plugins/platforms/wasm/qwasminputcontext.h"
ANCHOR = "    bool m_visibleInputPanel = false;"
REPLACE = (
    "    // PKC3 #156: デスクトップのブラウザでは showInputPanel() が呼ばれないので、\n"
    "    // 既定を true にして updateInputElement() の早期 return を通す。\n"
    "    bool m_visibleInputPanel = true;"
)

# ── 🔴 診断(2026-08-15。1 回目の直しが効かなかったので足す)──────────────
#
# `m_visibleInputPanel` を true にしても **`<input>` は一度も focus されなかった**
# (`ime-probe` 実測)。早期 return の条件は 4 つあるので、**どれで落ちているか**を
# 名指しできないと、次の一手が推測になる ── 1 ビルド ≒ 4 時間なので推測は高い。
#
# ⚠ CLAUDE.md「未確認は assert ではなく診断で出す」。値を**画面から読める所**へ置く:
#   `<input>` 自身の data 属性に 4 条件を書き、probe が読む。
# ⚠ 挙動は変えない(属性を足すだけ)。
SRC = "src/plugins/platforms/wasm/qwasminputcontext.cpp"
DIAG_ANCHOR = """    const QWindow *focusWindow = QGuiApplication::focusWindow();
    if (!m_focusObject || !focusWindow || !m_visibleInputPanel || !m_inputMethodAccepted) {"""
DIAG_REPLACE = """    const QWindow *focusWindow = QGuiApplication::focusWindow();
    // PKC3 #156 診断: 早期 return の 4 条件を DOM から読めるようにする(挙動は変えない)
    m_inputElement.call<void>("setAttribute", std::string("data-pkc-ime"),
        std::string((m_focusObject ? "obj1" : "obj0"))
        + (focusWindow ? "-win1" : "-win0")
        + (m_visibleInputPanel ? "-panel1" : "-panel0")
        + (m_inputMethodAccepted ? "-accept1" : "-accept0"));
    if (!m_focusObject || !focusWindow || !m_visibleInputPanel || !m_inputMethodAccepted) {"""


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: qtbase-patch-ime-panel.py <qtbase-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / HEADER
    # ⚠ **無ければ落とす。** 「無ければ skip」は当たらなかったことを
    #   成功と見分けられなくする(§3 の NOT-APPLIED を合格と読む型)。
    if not path.exists():
        print(f"ERROR: {HEADER} が無い({path})", file=sys.stderr)
        return 1
    src = path.read_text(encoding="utf-8")
    if REPLACE not in src:
        n = src.count(ANCHOR)
        if n != 1:
            print(f"ERROR: 目印が {n} 件(1 件でなければ当てない)", file=sys.stderr)
            return 1
        path.write_text(src.replace(ANCHOR, REPLACE), encoding="utf-8")
        after = path.read_text(encoding="utf-8")
        if REPLACE not in after or ANCHOR in after:
            print("ERROR: 書き換えが残っていない", file=sys.stderr)
            return 1
        print(f"patched {path}")

    # 診断の側(別 file)
    cpp = Path(sys.argv[1]) / SRC
    if not cpp.exists():
        print(f"ERROR: {SRC} が無い({cpp})", file=sys.stderr)
        return 1
    csrc = cpp.read_text(encoding="utf-8")
    if DIAG_REPLACE in csrc:
        print("diag already patched")
        return 0
    m = csrc.count(DIAG_ANCHOR)
    if m != 1:
        print(f"ERROR: 診断の目印が {m} 件(1 件でなければ当てない)", file=sys.stderr)
        return 1
    cpp.write_text(csrc.replace(DIAG_ANCHOR, DIAG_REPLACE), encoding="utf-8")
    if DIAG_REPLACE not in cpp.read_text(encoding="utf-8"):
        print("ERROR: 診断の書き換えが残っていない", file=sys.stderr)
        return 1
    print(f"patched {cpp}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
