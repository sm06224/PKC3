#!/usr/bin/env python3
"""🔴 **Backspace 1 回で 2 文字消えるのを直す**(#433)。

> user 報告 2026-08-26:「**あと、バックスペース１回でなぜか２文字消える**」
> user 追加 2026-08-26:「**A: Office の窓です / 日本語入力していて気づきました /
> そのときは半角文字が２文字いっぺんに消えてびっくりしました**」

## 🔴 実機のログで**確定した**(2026-08-28。推測ではない)

user が `office.inputLog` を ON にして踏んだ console(1 回の打鍵ぶん):

    Key callback "Backspace" 9                                  ← ① keydown が来た
    processKey as KeyEvent                                      ← ① 早期 return しなかった
    bool QWasmWindow::processKeyForInputContext(const KeyEvent &) ← ① **LO へ 1 回目**
    virtual void QWasmInputContext::update(...)
    void inputCallback(emscripten::val) isComposing :  false
    void inputCallback(emscripten::val) inputType :  "deleteContentBackward"  ← ② **LO へ 2 回目**

🔑 **`input` が飛んでいる**ことが決定打である ── ①が `preventDefault()` を
呼んでいれば、ブラウザは隠し `<input>` を削らないので `input` は飛ばない。
飛んでいる = **`processKeyForInputContext` が false を返した**(LO がその打鍵を
「受理した」と返していない)。それでも**①は既に `handleKeyEvent` を撃っている**。

## なぜ Backspace だけ起きるか(上流 6.9 の構造)

`qwasmwindow.cpp` の `handleKeyForInputContextEvent` は、IME 受理中なら
早期 return する枝を持つ ── ⚠ **ただし条件は「1 文字のキーであること」**:

    } else if (keyString.size() != 1) {
        // This is like; 'Shift','ArrowRight','AltGraph', ...
        ; // fallthrough          ←🔴 "Backspace" は 9 文字なので**必ずここ**
    } else if (wasmInput->inputMethodAccepted()) {
        return;                   //  ここへは来ない
    }

🔑 そして隠し `<input>` に焦点が当たるのは **IME を使っている間だけ**なので、
**日本語入力中だけ** `input` が飛ぶ = **日本語入力中だけ 2 文字消える**。
user の報告条件と完全に一致する。

## ⚠ 素朴な直し 2 つは、どちらも退行する(**ログが両方を否定した**)

| 案 | 何をする | なぜ駄目か |
|---|---|---|
| A | ①で Backspace も早期 return し、②に任せる | 🔴 **`input` が飛ばない回がある** ── 同じログの**2 打鍵目**は `Key callback "Backspace"` だけで `inputCallback` が**無い**(隠し `<input>` が空)。A だと**その回は 0 文字消える** |
| B | ②の合成を丸ごと消す | 🔴 ①が早期 return する経路(`isComposing` / Android の `"Unidentified"`)では**②だけが届いている** ── 消すとそこが効かなくなる |

## 🔑 直し ── **①が届けた回だけ、②を黙らせる**

①(keydown)で削除キーを LO へ渡したことを印に残し、②(input)は
**その印が立っていたら合成せずに帰る**。印は打鍵ごとに立て直す。

- ①が早期 return した回(composing / Android)は印が立たないので、②は**従来どおり**動く
- ①が届けた回は②が黙るので、**ちょうど 1 文字**になる
- `Delete`(`deleteContentForward`)も**同じ構造**なので同時に直す
  (⚠ 片側だけ直すのは CLAUDE.md「片側を直したら対称の反対側を必ず疑う」に反する)

⚠ **Qt を上げる道は無い**(`office-wasm-build.yml` に実測つきで 6.9 固定の理由が
書いてある:上限 ≤ 6.9 / 下限 ≥ 6.9)。だから #156 と同じく **6.9 に当てる**。

## ⚠ この箱では compile も実行もできない

emsdk も Qt ツリーもこの箱に無い。**当たることと、当たった字**しか確かめられない
── 効いたかどうかは**焼いて、実機で 1 回踏む**まで分からない(#433 段③)。
🔑 だから錨は**厳密に 1 件**にし、当たらなければ**落ちる**(黙って素通りしない)。
"""

from __future__ import annotations

import sys
from pathlib import Path

WIN = "src/plugins/platforms/wasm/qwasmwindow.cpp"
CTX = "src/plugins/platforms/wasm/qwasminputcontext.cpp"
HDR = "src/plugins/platforms/wasm/qwasminputcontext.h"

# ── ① 印を持つ場所(ヘッダ)
#    ⚠ 既存の公開メンバの並びを崩さない ── `usingTextInput()` の直後へ足す
HDR_ANCHOR = """    bool usingTextInput() const { return m_inputMethodAccepted; }
"""
HDR_REPLACE = """    bool usingTextInput() const { return m_inputMethodAccepted; }

    // PKC3(#433): Backspace / Delete が keydown と input の 2 経路で届き、
    // 1 打鍵で 2 文字消えるのを止める。keydown 側で LO へ渡したことを印に残し、
    // input 側はその印が立っていたら合成せずに帰る。印は打鍵ごとに立て直す。
    void pkc3NoteDeleteKeySent() { m_pkc3DeleteKeySent = true; }
    void pkc3ResetDeleteKeySent() { m_pkc3DeleteKeySent = false; }
    bool pkc3TakeDeleteKeySent()
    {
        const bool sent = m_pkc3DeleteKeySent;
        m_pkc3DeleteKeySent = false;
        return sent;
    }
"""

HDR_MEMBER_ANCHOR = """    bool m_inputMethodAccepted = false;
"""
HDR_MEMBER_REPLACE = """    bool m_inputMethodAccepted = false;
    // PKC3(#433): 直前の keydown で削除キーを LO へ渡したか
    bool m_pkc3DeleteKeySent = false;
"""

# ── ② keydown 側:印を立て直し、渡したときだけ立てる
#    ⚠ 錨は**この関数の末尾 3 行**(`processKey as KeyEvent` の直後)── 一意である
WIN_ANCHOR = """    qCDebug(qLcQpaWasmInputContext) << "processKey as KeyEvent";
    if (processKeyForInputContext(*KeyEvent::fromWebWithDeadKeyTranslation(event, m_deadKeySupport)))
        event.call<void>("preventDefault");
    event.call<void>("stopImmediatePropagation");
"""
WIN_REPLACE = """    qCDebug(qLcQpaWasmInputContext) << "processKey as KeyEvent";
    // PKC3(#433): 削除キーをここから LO へ渡す回は、input 側の合成を黙らせる。
    // ⚠ keydown のときだけ触る(keyup で立て直すと、input より後になって効かない)。
    if (QWasmInputContext *pkc3Input = QWasmIntegration::get()->wasmInputContext()) {
        if (event["type"].as<std::string>() == "keydown") {
            pkc3Input->pkc3ResetDeleteKeySent();
            const auto pkc3Key = QString::fromStdString(event["key"].as<std::string>());
            // ⚠ 比べ方は同じ file の `keyString == "Unidentified"` に揃える
            if (pkc3Key == "Backspace" || pkc3Key == "Delete")
                pkc3Input->pkc3NoteDeleteKeySent();
        }
    }
    if (processKeyForInputContext(*KeyEvent::fromWebWithDeadKeyTranslation(event, m_deadKeySupport)))
        event.call<void>("preventDefault");
    event.call<void>("stopImmediatePropagation");
"""

# ── ③ input 側:印が立っていたら合成しない(2 経路とも Backspace / Delete)
CTX_BACK_ANCHOR = """        if (!inputTypeString.compare("deleteContentBackward")) {
            QWindowSystemInterface::handleKeyEvent(0,
"""
CTX_BACK_REPLACE = """        if (!inputTypeString.compare("deleteContentBackward")) {
            // PKC3(#433): keydown 側が既に LO へ渡していれば、ここで合成しない
            // (合成すると 1 打鍵で 2 文字消える)。渡していない回は従来どおり。
            if (wasmInput && wasmInput->pkc3TakeDeleteKeySent()) {
                event.call<void>("stopImmediatePropagation");
                return;
            }
            QWindowSystemInterface::handleKeyEvent(0,
"""

CTX_FWD_ANCHOR = """        } else if (!inputTypeString.compare("deleteContentForward")) {
            QWindowSystemInterface::handleKeyEvent(0,
"""
CTX_FWD_REPLACE = """        } else if (!inputTypeString.compare("deleteContentForward")) {
            // PKC3(#433): Backspace と同じ構造(`"Delete"` も 1 文字ではないので
            // keydown 側の早期 return に到達しない)。片側だけ直さない。
            if (wasmInput && wasmInput->pkc3TakeDeleteKeySent()) {
                event.call<void>("stopImmediatePropagation");
                return;
            }
            QWindowSystemInterface::handleKeyEvent(0,
"""

MARK = "pkc3TakeDeleteKeySent"


def patch(root: Path, rel: str, pairs: list[tuple[str, str]]) -> int:
    path = root / rel
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        print(f"ERROR: {rel} を読めない: {e}", file=sys.stderr)
        return 1
    # 🔑 **先に「もう当たっていないか」を見る**(他の qtbase patch と同じ作法)
    if MARK in text or "pkc3NoteDeleteKeySent" in text or "m_pkc3DeleteKeySent" in text:
        print(f"SKIP: 既に当たっている({rel})")
        return 0
    for anchor, replace in pairs:
        hits = text.count(anchor)
        if hits != 1:
            head = anchor.strip().splitlines()[0][:70]
            print(f"ERROR: 錨が {hits} 件({rel}) ── 上流が形を変えた: {head}", file=sys.stderr)
            return 1
        text = text.replace(anchor, replace, 1)
    path.write_text(text, encoding="utf-8")
    print(f"patched: {rel}(#433 の直し ── 削除キーの二重配送を止める)")
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <qtbase root>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    rc = 0
    rc |= patch(root, HDR, [(HDR_ANCHOR, HDR_REPLACE), (HDR_MEMBER_ANCHOR, HDR_MEMBER_REPLACE)])
    rc |= patch(root, WIN, [(WIN_ANCHOR, WIN_REPLACE)])
    rc |= patch(root, CTX, [(CTX_BACK_ANCHOR, CTX_BACK_REPLACE), (CTX_FWD_ANCHOR, CTX_FWD_REPLACE)])
    return rc


if __name__ == "__main__":
    sys.exit(main())
