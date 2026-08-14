#!/usr/bin/env python3
"""popup(メニュー / コンボの dropdown)の窓に **focus を渡さない**(#157 の根)。

## 症状(実機 2/2 + headless で 100% 再現・計装済み)

コンボの popup の項目を**マウスで押すと、押した瞬間に popup が閉じて選択されない**。
キーボード(↓ + Enter)では選択できる。計装の実測(combo-popup-probe.mjs):

    pointerdown → CANVAS.qt-window-canvas(popup の canvas)
    (600ms 後)popup の rect が 0x0 ── **press で閉じている**
    pointerup   → DIV.qt-window(popup の亡骸の下の main 窓)
    さらに main のタイトルバーが**灰色**(activation が移って戻らない)

## 🔑 根 ── LO が避けた事故を、Qt wasm が別の入口から再現している

LO の Qt プラグインは popup を `Qt::ToolTip | Qt::FramelessWindowHint` で作る。
理由は当のソースに書いてある(`vcl/qt5/QtFrame.cxx:106`):

    // Can't use Qt::Popup, because it grabs the input focus and generates a
    // focus-out event, instantly auto-closing the LO's editable ComboBox popup.

ところが Qt wasm の `ClientArea::processPointer`(qtbase
`src/plugins/platforms/wasm/qwasmwindowclientarea.cpp`)は pointerdown のたびに:

    if ((flags & Qt::WindowDoesNotAcceptFocus) != Qt::WindowDoesNotAcceptFocus
        && window->isTopLevel())
            window->requestActivate();

ToolTip 窓は `WindowDoesNotAcceptFocus` を**持たない**ので、popup の中を押した
瞬間に popup 自身へ activation が移る → 親 frame が focus-out → vcl の float が
**自壊** → その後の配送は隠れた窓へ落ちて不受理 → `closeAllPopups()`(とどめ)。

## 直し ── popup の窓に `Qt::WindowDoesNotAcceptFocus` を立てる

「popup は focus を取らない」はデスクトップの意味論そのもの(WM は click で
tooltip を activate しない)。この flag が立っていれば wasm の requestActivate は
スキップされる。⚠ キーボードは元々**親の grab 経由**で popup へ届いている
(実測: focus が無い今でも ↓/Enter で選択できる)ので、失うものは無い。

⚠ Qt 側(`qwasmwindowclientarea.cpp`)を直す道もあるが、LO patch は
**Qt の再ビルドが要らない**(ccache 温存で 1 回転 ~35 分 vs Qt 込み数時間)。
上流へ報告するなら両方に言及する。
"""

import sys
from pathlib import Path

SRC = "vcl/qt5/QtFrame.cxx"  # ⚠ qt6 プラグインは qt5 のソースを include して共有する

ANCHOR = "            aWinFlags = Qt::ToolTip | Qt::FramelessWindowHint;"
REPLACE = (
    "            // PKC3/#157: wasm の ClientArea は WindowDoesNotAcceptFocus が無い\n"
    "            // top-level へ press のたびに requestActivate() する ── ToolTip の\n"
    "            // popup へ activation が移り、親の focus-out で float が自壊する\n"
    "            // (上のコメントが Qt::Popup について警告している当の事故)。\n"
    "            aWinFlags = Qt::ToolTip | Qt::FramelessWindowHint\n"
    "                        | Qt::WindowDoesNotAcceptFocus;"
)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-popup-focus.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")

    # ⚠ 錨は 1 件でなければ異常終了(TOOLTIP 分岐の `Qt::ToolTip;` とは別の字面)
    hits = text.count(ANCHOR)
    if hits != 1:
        print(f"ERROR: 錨が {hits} 件({SRC}): {ANCHOR.strip()}", file=sys.stderr)
        return 1
    # ⚠ 上流が既に直していたら止める(patch が要らなくなった合図)
    if "WindowDoesNotAcceptFocus" in text:
        print(
            "ERROR: 上流が既に WindowDoesNotAcceptFocus を扱っている\n"
            "  → 本 patch は要らなくなった可能性がある。確かめてから外すこと",
            file=sys.stderr,
        )
        return 1

    text = text.replace(ANCHOR, REPLACE)

    # 後条件 ── isPopup の分岐の中に入ったこと(字面だけでなく位置)
    at = text.index("Qt::WindowDoesNotAcceptFocus")
    popup_at = text.index("else if (isPopup())")
    tool_at = text.index("else if (nStyle & SalFrameStyleFlags::TOOLWINDOW)")
    if not (popup_at < at < tool_at):
        print("ERROR: flag が isPopup の分岐の外に在る", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    print(f"patched: {SRC}(popup の窓は focus を取らない /#157)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
