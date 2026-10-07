#!/usr/bin/env python3
"""文書を開いた直後に「Office が停止しました」になることがある件(#1396)の**直し**。

## 症状(user の身に起きること)

Impress(`.odp`)を開くと、開いた直後(約 9〜20 秒)に何もしていないのに「Office が停止しました」になることがある
(`RuntimeError: memory access out of bounds`。headless で 3/7 や 2/3)。出ない回は正常に使える。Writer では出ない。
stack の最上段は `SvTreeListBox::getPreferredDimensions` ← `IconView::GetOptimalSize`(Impress のサイドバー)。

## 🔑 原因 ── model には在るが view data が無い entry を読む

`vcl/source/treelist/treelistbox.cxx`(上流 `7f96a38cf750`、`libreoffice-26-8`):

- `getPreferredDimensions`(:3353-3380)は各 entry の `rItem.GetWidth(*this, pEntry)`(:3367)を呼ぶ。
  これは `GetViewDataItem`(:1118-1125)→ `GetViewData(pEntry)`(:831-838)を引く。`m_DataTable.find` が end なら
  assert のあと **nullptr** を返し、`pEntryData->GetItem(n)`(`viewdataentry.cxx:66-69`)は null 起点の `maItems[n]`。
  release では assert が消えるので、**範囲外を読んで落ちる**。
- 🟡 view data が無い瞬間(推測。コードで裏づくが実機では未確認):
  ① `SvTreeList::Insert` は model に入れて(`treelist.cxx:750/753`)から Broadcast(:761)し、view data はその
  Broadcast の中(`treelistbox.cxx:702-715`)で作る。② `SvTreeList::Clear`(`treelist.cxx:83-89`)は `Reset()` で
  view data を全部消した後に `ClearChildren()` する。この間に `InterimItemWindow` のレイアウト Idle が
  main スレッドから割り込む(機構は #1393 と同じ)と当たる。

## 直し(最小。印を数える門)

`getPreferredDimensions` に 2 つの門を足す。足すだけで、原文の行は 1 行も書き換えない。

1. `rWidths.clear();` の直後: `m_pModel` が無ければ 0 を返す(`First()` が `m_pModel` を読むので、その前)。
2. `while (pEntry)` の直後: `m_DataTable` に無い entry は飛ばして `Next(pEntry)` へ進む。
   当たった回の寸法は 1 回だけ小さくなるが、`INSERTED` の `queue_resize()`(:3693-3694)が次の Layout を
   予約するので直る。

- `std::fputs`(libc だけ)の行が、probe が当たった回数を数える印を兼ねる(`PKC3-VIEWDATAGONE:`)。
- `m_DataTable` は `SvTreeListBox` の member(`treelistbox.hxx:208`)、`Next()` は const member
  (:447)── const の `getPreferredDimensions` から呼べる。
- 🔴 触らない: `GetOptimalSize` / `m_aTabs` / `GetWidth`。

## 覆る条件

焼いて停止の回に `PKC3-VIEWDATAGONE` が **0 回**のまま落ちる → 「view data が無い」ではなく
`m_pModel` null(`First()` :847)か `m_pImpl` null(`iconview.cxx:144`)側 → そこへ門を足す。
⚠ `SplitWindow::Paint` の別形 2 回はこの案の外。⚠ #1393 の入口の門(`patch-lo-layout-guard.py`)は
**構築中・破棄中**にだけ効くので、entry 操作の最中(開いた直後)はこちらが要る。

## ⚠ 作法(`patch-lo-scheduler-task-gone.py` と同じ)

- **毎回当たる直し**(入力で gate しない)。錨が**ちょうど 1 件**在ることを確かめてから当てる。
- 当てた後に印が在ることを確かめる / 二重当ては exit 1 で **file は 1 バイトも変わらない**。
- **足した行は全部 `PKC3-VIEWDATAGONE` を含む**。原文の行は 1 行も書き換えない(足すだけ)。
- ⚠ **この箱では compile できない**。**焼いて**、Impress を開く probe で `PKC3-VIEWDATAGONE:` が出て
  停止が消える(または 0 回のまま落ちて覆る)まで確かめる。
"""

import sys
from pathlib import Path

SRC = "vcl/source/treelist/treelistbox.cxx"
MARK = "PKC3-VIEWDATAGONE"

# ── ① include(`std::fputs`)────────────────────────────────────────────
# 🔑 無条件に足して印を付ける(在るかを見ない ── 当てる順で出力が変わるのを避ける)
INC_ANCHOR = """#include <vcl/toolkit/treelistbox.hxx>
"""
INC_REPLACE = """#include <vcl/toolkit/treelistbox.hxx>
#include <cstdio> // PKC3-VIEWDATAGONE
"""

# ── ② `getPreferredDimensions` の冒頭の 2 つの門 ──────────────────────────────
# 🔑 錨は冒頭の塊(`rWidths.clear();` から `sal_uInt16 nCount = …;` まで)。`while (pEntry)` は file 内に
#    他にも在りうるので、関数の頭ごと錨にして一意にする。原文に**1 件**。
#    ⚠ 足す行は**全部**印を含む。原文の行は 1 字も変えない。
PREF_ANCHOR = """    rWidths.clear();
    SvTreeListEntry* pEntry = First();
    while (pEntry)
    {
        sal_uInt16 nCount = pEntry->ItemCount();
"""
PREF_REPLACE = """    rWidths.clear();
    // PKC3-VIEWDATAGONE(#1396): the layout Idle can run between SvTreeList::Insert (entry already in the model,
    // PKC3-VIEWDATAGONE view data not yet made in the Broadcast) or in SvTreeList::Clear (view data reset before
    // PKC3-VIEWDATAGONE the entries). GetWidth() then reads a null view data. Skip what has no view data:
    // PKC3-VIEWDATAGONE the INSERTED queue_resize() asks for the next layout, so the size is right a moment later.
    if (!m_pModel) return 0; // PKC3-VIEWDATAGONE
    SvTreeListEntry* pEntry = First();
    while (pEntry)
    {
        if (m_DataTable.find(pEntry) == m_DataTable.end()) { std::fputs("PKC3-VIEWDATAGONE: entry without view data skipped\\n", stderr); pEntry = Next(pEntry); continue; } // PKC3-VIEWDATAGONE
        sal_uInt16 nCount = pEntry->ItemCount();
"""

PARTS = (
    (INC_ANCHOR, INC_REPLACE),
    (PREF_ANCHOR, PREF_REPLACE),
)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-viewdata-gone.py <lo-core-dir>", file=sys.stderr)
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

    n_while_before = text.count("while (pEntry)")
    for anchor, replace in PARTS:
        text = text.replace(anchor, replace, 1)

    # ⚠ 置換が本当に効いたか(空振りを合格と読まない)
    if text.count("if (!m_pModel) return 0; // PKC3-VIEWDATAGONE") != 1:
        print("ERROR: `m_pModel` の門が 1 つ入っていない", file=sys.stderr)
        return 1
    if text.count("if (m_DataTable.find(pEntry) == m_DataTable.end())") != 1:
        print("ERROR: view data の門が 1 つ入っていない", file=sys.stderr)
        return 1
    # 🔴 view data の門は `while (pEntry)` の**直後**(= 全 entry が通る所)に在る
    if text.count("    while (pEntry)\n    {\n        if (m_DataTable.find(pEntry)") != 1:
        print("ERROR: view data の門が `while (pEntry)` の直後に入っていない(錨の取り違え)", file=sys.stderr)
        return 1
    # 🔴 足しただけ ── `while (pEntry)` は 1 行も減らない
    if text.count("while (pEntry)") != n_while_before:
        print("ERROR: `while (pEntry)` が増減している(足すだけの直しのはず)", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if MARK in line)
    if n_marks != n_expected or "entry without view data skipped" not in after:
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 行(期待 {n_expected})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(view data の無い entry を飛ばす / #1396 ── 足した行 {n_marks})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
