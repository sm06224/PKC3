#!/usr/bin/env python3
"""Format メニューなど縦に長いメニューが **2 列に割れて下端で切れる**件(#126 項目、#774)の**直し**。

## 症状(user の身に起きること)

Writer で「書式(Format)」を開くと、項目が 1 列に収まらず **2 列に割れ**、右の列に「回転と反転 / オブジェクトのグループ化」
だけが離れて出る。メニューは画面の上端(メニューバーの上)から下端まで伸びて、下の項目が切れる
(この箱の headless で再現: 1280x720 の画面で Format = 約 30 項目。`dialog-crash-probe.mjs` の `format-menu` suite)。

## 🔑 原因 ── メニューは VCL ではなく **Qt の `QMenu`**(`QtMenu.cxx`)で、この style では「スクロールしない」

- 上のメニューバーも右クリックのメニューも、`QtMenu`(`vcl/qt5/QtMenu.cxx`)が `new QMenu(aText, nullptr)` で作る Qt 製。
  VCL 製の `PopupMenu` なら `nMaxHeight` を超えると `EnableScrollMenu(true)` で上下の矢印つきにスクロールする
  (`menu.cxx:2984`)が、native menu(`ShowNativePopupMenu`)はその前に Qt へ渡る。
- Qt の `QMenu` は `QStyle::SH_Menu_Scrollable` が **偽**の style では、画面に収まらないとき**列を足して割る**
  (`qmenu.cpp:170` は真のときだけ `QMenuScroller` を作る。`qcommonstyle.cpp:5445` の既定は偽)。wasm の既定 style は偽。

## 直し(最小)

`SH_Menu_Scrollable` だけを真にする `QProxyStyle`(それ以外は元の style にそのまま渡す)を作り、`QtMenu` が作る **全部の `QMenu`**
(3 か所の `new QMenu` はどれも `connectHelpSignalSlots(QMenu*, …)` を通る)に付ける。足すのはこの 2 か所だけ:

1. file scope に `PkcScrollableMenuStyle`(`styleHint` で `SH_Menu_Scrollable` を 1 にする)と `<QtWidgets/QProxyStyle>`
2. `connectHelpSignalSlots` の末尾(`setToolTipsVisible(true)` の直後)で、メニューの子として style を作って付ける

- `setParent(pMenu)` にしておく ── `QWidget::setStyle` は所有権を取らないので、親にしないと漏れる。
- `QMenu::changeEvent(StyleChange)` が `QMenuScroller` を作る(`qmenu.cpp:2964`)ので、付けた後に別の呼び出しは要らない。
- スクロールは上下の矢印 / ホイール / 矢印キーで動く(デスクトップ版 LO と同じ)。

## 覆る条件 / 言えないこと

- ⚠ **この箱では compile できない**(Qt / LO の header が無い)。`QProxyStyle` の `styleHint` の署名は Qt 6.9 の
  `qproxystyle.h` のとおり。**焼いて**、`format-menu` suite の画像で 1 列になり下に矢印が出ることを見る。
- 焼いても 2 列のまま → メニューの高さの上限を Qt が別の経路(`QMenuPrivate::popupGeometry`)で決めている。
  そのときは `QMenu::setMaximumHeight` 側を検討する。
- ⚠ 基の style は `QProxyStyle` が `QApplication::style()` の名前から作り直す。LO が `QApplication` の style を後から
  差し替えていると、メニューだけ別の style の見た目になる(見た目の差は焼いた後の画像で見る)。

## ⚠ 作法(`patch-lo-viewdata-gone.py` と同じ)

- **毎回当たる直し**。錨は**ちょうど 1 件**(原文)。1 つでも外れたら何も書かない / 二重当ては exit 1 で file は不変。
- **足した行は全部 `PKC3-MENUSCROLL` を含む**。原文の行は 1 行も書き換えない(足すだけ)。
- 同じ file の `patch-lo-menu-trace.py` / `patch-lo-uev-trace.py` と**錨は重ならない**(`slotMenuTriggered` / `ShowNativePopupMenu` 側)。
"""

import sys
from pathlib import Path

SRC = "vcl/qt5/QtMenu.cxx"
MARK = "PKC3-MENUSCROLL"

# ── ① include と style(file scope)───────────────────────────────────────────
INC_ANCHOR = """#include <QtWidgets/QStyle>
"""
INC_REPLACE = """#include <QtWidgets/QStyle>
#include <QtWidgets/QProxyStyle> // PKC3-MENUSCROLL
"""

CLASS_ANCHOR = """const QString gButtonGroupKey("QtMenu::ButtonGroup");
"""
CLASS_REPLACE = """const QString gButtonGroupKey("QtMenu::ButtonGroup");

// PKC3-MENUSCROLL(#126): QMenu splits a menu that does not fit the screen into columns unless the style says
// PKC3-MENUSCROLL SH_Menu_Scrollable. Say it for the menus QtMenu makes; everything else goes to the real style.
namespace // PKC3-MENUSCROLL
{ // PKC3-MENUSCROLL
class PkcScrollableMenuStyle : public QProxyStyle // PKC3-MENUSCROLL
{ // PKC3-MENUSCROLL
public: // PKC3-MENUSCROLL
    int styleHint(StyleHint eHint, const QStyleOption* pOption = nullptr, // PKC3-MENUSCROLL
                  const QWidget* pWidget = nullptr, // PKC3-MENUSCROLL
                  QStyleHintReturn* pReturn = nullptr) const override // PKC3-MENUSCROLL
    { // PKC3-MENUSCROLL
        if (eHint == SH_Menu_Scrollable) // PKC3-MENUSCROLL
            return 1; // PKC3-MENUSCROLL
        return QProxyStyle::styleHint(eHint, pOption, pWidget, pReturn); // PKC3-MENUSCROLL
    } // PKC3-MENUSCROLL
}; // PKC3-MENUSCROLL
} // PKC3-MENUSCROLL
"""

# ── ② 全部の QMenu が通る所の末尾 ──────────────────────────────────────────
HOOK_ANCHOR = """    // enable tooltips, Qt doesn't show them for menu entries by default
    pMenu->setToolTipsVisible(true);
"""
HOOK_REPLACE = """    // enable tooltips, Qt doesn't show them for menu entries by default
    pMenu->setToolTipsVisible(true);

    // PKC3-MENUSCROLL(#126): scroll a menu that is taller than the screen instead of splitting it into columns.
    // PKC3-MENUSCROLL The style is a child of the menu (QWidget::setStyle does not take ownership).
    auto* pPkcStyle = new PkcScrollableMenuStyle; // PKC3-MENUSCROLL
    pPkcStyle->setParent(pMenu); // PKC3-MENUSCROLL
    pMenu->setStyle(pPkcStyle); // PKC3-MENUSCROLL
"""

PARTS = (
    (INC_ANCHOR, INC_REPLACE),
    (CLASS_ANCHOR, CLASS_REPLACE),
    (HOOK_ANCHOR, HOOK_REPLACE),
)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 空行は数えない。全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig and ln.strip() != ""]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-qt-menu-scroll.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")

    # ⚠ 二重当ては止める(冪等ではない)。file は触らない。
    if MARK in text:
        print(f"ERROR: {SRC} に既に {MARK} が入っている(二重当て)", file=sys.stderr)
        return 1

    # ⚠ 錨は全部**ちょうど 1 件**。1 つでも外れたら何も書かない
    for anchor, _replace in PARTS:
        hits = text.count(anchor)
        if hits != 1:
            print(
                f"ERROR: 錨が {hits} 件({SRC})。上流が形を変えた可能性がある:\n{anchor[:160]}...",
                file=sys.stderr,
            )
            return 1

    for anchor, replace in PARTS:
        bare = [ln for ln in _added_lines(anchor, replace) if MARK not in ln]
        if bare:
            print(f"ERROR: 印の無い足し行が在る(この patch の書き方の誤り): {bare}", file=sys.stderr)
            return 1

    for anchor, replace in PARTS:
        text = text.replace(anchor, replace, 1)

    # ⚠ 置換が本当に効いたか(空振りを合格と読まない)
    for needle in ("class PkcScrollableMenuStyle", "pMenu->setStyle(pPkcStyle); // PKC3-MENUSCROLL", "<QtWidgets/QProxyStyle>"):
        if text.count(needle) != 1:
            print(f"ERROR: {needle!r} が 1 件でない", file=sys.stderr)
            return 1

    path.write_text(text, encoding="utf-8")
    print(f"OK: {SRC} に QMenu をスクロールさせる style を足した(#126)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
