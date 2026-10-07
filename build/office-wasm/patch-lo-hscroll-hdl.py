#!/usr/bin/env python3
"""Impress で枠を Tab → Enter → Esc で操作した後に「ファイル → 閉じる」を押すと Office が停止する件(#1393)の**直し(落ちた先)**。

## 症状(user の身に起きること)

`patch-lo-layout-guard.py` と同じ(#1393)。Impress の文書を閉じると「Office が停止しました」になることがあり、
fault は `table index is out of bounds`。stack は「**縦のスクロールでは落ちず、横でだけ落ちる**」非対称な形。

## 🔑 原因 ── 上流の戻し忘れ: dtor が縦の handler しか元へ戻さない

`vcl/source/app/salvtables.cxx`(上流 `7f96a38cf750`、`libreoffice-26-8`):

- ctor(:2190-2196)は縦・横の**両方**の `ScrollHdl` を自分の `VscrollHdl` / `HscrollHdl` に差し替え、
  元の Link を `m_aOrigVScrollHdl` / `m_aOrigHScrollHdl` に退避する。
- dtor(:2391-2395)は**縦だけ**戻す(`rVertScrollBar.SetScrollHdl(m_aOrigVScrollHdl)`)。
- → wrapper が破棄された後も、横のスクロールバーの Link は**解放済みの wrapper を指したまま**。
  `VclScrolledWindow::doSetAllocation` の末尾(`layout.cxx:2043-2044` → `InitScrollBars` :1938-1939)が
  `m_pHScroll->Scroll()` を呼ぶと、解放済みの `HscrollHdl` へ飛んで `table index is out of bounds`。
- ⚠ 対になる読み方: ctor が 2 つ差し替え(縦・横)、dtor が 1 つ戻す(縦)── 非対称は ctor と並べれば 1 目で読める。

## 直し(最小)

dtor に、横のスクロールバーの handler も元へ戻す 2 行を足す(ctor の :2194-2195 と対になる形)。
上流の戻し忘れの訂正なので、`patch-lo-layout-guard.py`(入口の門)と**独立に正しい**。

- 🔴 触らない: ctor / 縦の戻し / `VscrollHdl` / `HscrollHdl`。足すだけで、原文の行は 1 行も書き換えない。
- include は要らない(`std::fputs` を使わない ── 戻すだけで、効いた回数は数えない)。

## 覆る条件

焼いて A(`patch-lo-layout-guard.py`)+ これでも停止が消えない → 割り込み先が dispose の窓ではない。
`layout-guard` の docstring の「覆る条件」と同じ。

## ⚠ 作法(`patch-lo-scheduler-task-gone.py` と同じ)

- **毎回当たる直し**(入力で gate しない)。錨が**ちょうど 1 件**在ることを確かめてから当てる。
  ⚠ `getVertScrollBar()` の字は ctor にも在るので、**dtor の塊ごと**錨にする。
- 当てた後に印が在ることを確かめる / 二重当ては exit 1 で **file は 1 バイトも変わらない**。
- **足した行は全部 `PKC3-HSCROLLHDL` を含む**。原文の行は 1 行も書き換えない(足すだけ)。
- ⚠ **この箱では compile できない**。**焼いて**、Impress の閉じる probe で停止が消えるまで確かめる
  (効いた回数を数える印は無い ── 戻すだけの直しは、停止の有無で見る)。
"""

import sys
from pathlib import Path

SRC = "vcl/source/app/salvtables.cxx"
MARK = "PKC3-HSCROLLHDL"

# ── dtor: 縦の戻しの直後に、横も戻す ─────────────────────────────────────────
# 🔑 錨は dtor の 5 行の塊(`ScrollBar& rVertScrollBar = …getVertScrollBar();` は ctor にも在るので
#    宣言の行から閉じ括弧までを丸ごと錨にする)。原文に**1 件**。
DTOR_ANCHOR = """SalInstanceScrolledWindow::~SalInstanceScrolledWindow()
{
    ScrollBar& rVertScrollBar = m_xScrolledWindow->getVertScrollBar();
    rVertScrollBar.SetScrollHdl(m_aOrigVScrollHdl);
}
"""
DTOR_REPLACE = """SalInstanceScrolledWindow::~SalInstanceScrolledWindow()
{
    ScrollBar& rVertScrollBar = m_xScrolledWindow->getVertScrollBar();
    rVertScrollBar.SetScrollHdl(m_aOrigVScrollHdl);
    ScrollBar& rHorzScrollBar = m_xScrolledWindow->getHorzScrollBar(); // PKC3-HSCROLLHDL
    rHorzScrollBar.SetScrollHdl(m_aOrigHScrollHdl); // PKC3-HSCROLLHDL
}
"""

PARTS = ((DTOR_ANCHOR, DTOR_REPLACE),)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-hscroll-hdl.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")

    # ⚠ 二重当ては止める(冪等ではない ── 行が 2 組入る)。file は触らない。
    if MARK in text:
        print(f"ERROR: {SRC} に既に {MARK} が入っている(二重当て)", file=sys.stderr)
        return 1

    # ⚠ 錨は全部**ちょうど 1 件**。1 つでも外れたら何も書かない(「半分だけ当たる」を作らない)。
    for anchor, _replace in PARTS:
        hits = text.count(anchor)
        if hits != 1:
            print(
                f"ERROR: 錨が {hits} 件({SRC})。上流が形を変えた可能性がある:\n{anchor[:160]}...",
                file=sys.stderr,
            )
            return 1

    # 足す行は**全部**印を含む(印の無い足し行は、後で「原文」と見分けられない)
    n_expected = 0
    for anchor, replace in PARTS:
        added = _added_lines(anchor, replace)
        bare = [ln for ln in added if MARK not in ln]
        if bare:
            print(f"ERROR: 印の無い足し行が在る(この patch の書き方の誤り): {bare}", file=sys.stderr)
            return 1
        n_expected += len(added)

    n_vert_before = text.count("SetScrollHdl(m_aOrigVScrollHdl);")
    n_horz_before = text.count("SetScrollHdl(m_aOrigHScrollHdl);")
    for anchor, replace in PARTS:
        text = text.replace(anchor, replace, 1)

    # ⚠ 置換が本当に効いたか(空振りを合格と読まない)
    if text.count("rHorzScrollBar.SetScrollHdl(m_aOrigHScrollHdl); // PKC3-HSCROLLHDL") != 1:
        print("ERROR: 横の戻しが 1 つ入っていない", file=sys.stderr)
        return 1
    # 🔴 足しただけ ── 縦の戻しは 1 行も減らず、横の戻しは 1 行だけ増える
    if text.count("SetScrollHdl(m_aOrigVScrollHdl);") != n_vert_before:
        print("ERROR: 縦の戻しが増減している(足すだけの直しのはず)", file=sys.stderr)
        return 1
    if text.count("SetScrollHdl(m_aOrigHScrollHdl);") != n_horz_before + 1:
        print("ERROR: 横の戻しが 1 行だけ増えていない", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if MARK in line)
    if n_marks != n_expected:
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 行(期待 {n_expected})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(dtor で横の scroll handler も戻す / #1393 ── 足した行 {n_marks})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
