#!/usr/bin/env python3
"""表の挿入ダイアログが**空の一覧を添字 -1 で読む**のを止める(#135)。

## 症状 ── タブごと固まって文書を失う

`Table → Insert Table…`(`Ctrl+T`)で **`memory access out of bounds` が 2 回**出て、
そのあと**タブが応答しなくなる**(screenshot も JS も通らない)。検証レポート #5 は
「3 分 30 秒以上、タブを閉じるまで復帰せず」と記録している。⚠ **停止画面すら出ない** ──
JS が動かないので、こちらの検知の仕掛けが全部止まる唯一の症状である。

⚠ **#134(Qt の `QWasmInputContext`)とは別の根**である。#134 の直しを入れた一式でも
**同じように落ちる**ことを実測した(有効な回で 1/1。手元の `dialog-crash-probe.mjs`)。

## 🔑 落ちる形(名前つきビルドのスタック + 上流ソース)

    SwBaseShell::InsertTable → CreateInsTableDlg → SwInsTableDlg::SwInsTableDlg
      → SwInsTableDlg::InitAutoTableFormat()
        → (境界検査の無い 1 行の添字アクセサ)   💥 memory access out of bounds

`sw/source/ui/table/instable.cxx` の `InitAutoTableFormat()` は、
**一覧が空でも** `select(0)` と `SelFormatHdl()` を呼ぶ。呼ばれた側は:

    int styleIdx = m_xLbFormat->get_selected_index();   // 空なら -1
    assert(styleIdx != -1 && "nothing selected");       // 🔴 release では消える
    … m_xTableTable->GetData(styleIdx) …                // 💥 添字 -1 の読み出し

⚠ **`assert` は NDEBUG で消える**(消えていることは症状が証明している ──
消えていなければ abort の綺麗なメッセージが出るはずで、範囲外アクセスにはならない)。

## ⚠ 直すのは 2 か所。**片側だけでは足りない**

`OKHdl` が**まったく同じ形**を持っている:

    int styleIdx = m_xLbFormat->get_selected_index();
    assert(styleIdx != -1 && "nothing selected");
    … (*m_xTableTable)[styleIdx] …

つまり「開くとき」を直しても、**OK を押した瞬間に同じ場所で落ちる**。
🔑 CLAUDE.md「片側を直したら、対称の反対側を必ず疑う」。

## 🔴 空のときの正しい振る舞い

- `SelFormatHdl`: **何もしない**(見本を描かないだけ)
- `OKHdl`: **自動書式を当てずに OK を返す** ── ⚠ `response(RET_OK)` の**手前で
  return しない**。そこで抜けると **OK が無反応のボタン**になる(この repo が
  繰り返し踏んできた形)

つまり自動書式が選べないだけで、**ダイアログは開き、表は挿入できる**。
いまはタブごと固まって文書を失うので、比べるまでもない。

## なぜ一覧が空だったか ── 別の patch が直す

上流は表の自動書式を **`autotbl.fmt` → `tablestyles.xml`** へ移した(GSoC 2025、
`svx/source/table/tablestylesparser.cxx` 冒頭)のに、wasm の詰め込み一覧は
**古いほうを入れたまま**だった。`SvxAutoFormat::Load()` は開けなければ
`SAL_WARN` して `return false` ── **無言で空**になる。
→ `patch-lo-fsimage.py` が入れる。

🔑 **本パッチはそれとは独立に必要である。**
`SwTableAutoFormatTable::GetData(size_t)` の実体は
`return &*m_pImpl->m_AutoFormats[nIndex];`(`std::vector::operator[]` 素通り)で、
`int` の `-1` は **`SIZE_MAX` に化ける**。`assert` が消える以上、
`-1` を渡さない保証はどこにも無い。

## ⚠ 当たったことを確かめてから当てる

錨が 1 つでも見つからなければ**異常終了する**。上流が形を変えたときに、
黙って素通り(= 効いていないのに緑)になるのを防ぐ。
"""

import sys
from pathlib import Path

SRC = "sw/source/ui/table/instable.cxx"

# ⚠ 空白・改行まで上流と一致させる ── ずれたら気づきたい
ANCHOR_SEL = """    // Get index of selected item from the listbox
    int styleIdx = m_xLbFormat->get_selected_index();
    assert(styleIdx != -1 && "nothing selected");
    m_aWndPreview.NotifyChange(m_xTableTable->GetResolvedStyle(m_xTableTable->GetData(styleIdx)));
"""

REPLACE_SEL = """    // Get index of selected item from the listbox
    int styleIdx = m_xLbFormat->get_selected_index();
    // PKC3(#135): 一覧が空だと -1 が返る。assert は NDEBUG で消えるので、
    // ⚠ そのまま GetData(-1) に落ちて範囲外アクセスになる(wasm でタブごと固まる)。
    // 見本を描かないだけで、ダイアログは開いてよい。
    if (styleIdx < 0)
        return;
    m_aWndPreview.NotifyChange(m_xTableTable->GetResolvedStyle(m_xTableTable->GetData(styleIdx)));
"""

ANCHOR_OK = """    int styleIdx = m_xLbFormat->get_selected_index();
    assert(styleIdx != -1 && "nothing selected");

    if( m_xTAutoFormat )
        *m_xTAutoFormat = (*m_xTableTable)[styleIdx];
    else
        m_xTAutoFormat.reset(new SwTableAutoFormat((*m_xTableTable)[styleIdx]));

    m_xDialog->response(RET_OK);
"""

REPLACE_OK = """    int styleIdx = m_xLbFormat->get_selected_index();
    // PKC3(#135): 上と同じ ── 空の一覧では -1 が返る。
    // ⚠ ここで return してはいけない。response(RET_OK) へ届かなくなり、
    //    **OK が無反応のボタン**になる。自動書式を当てずに通す。
    if (styleIdx >= 0)
    {
        if( m_xTAutoFormat )
            *m_xTAutoFormat = (*m_xTableTable)[styleIdx];
        else
            m_xTAutoFormat.reset(new SwTableAutoFormat((*m_xTableTable)[styleIdx]));
    }

    m_xDialog->response(RET_OK);
"""


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-instable.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")

    for anchor in (ANCHOR_SEL, ANCHOR_OK):
        hits = text.count(anchor)
        if hits != 1:
            print(
                f"ERROR: 錨が {hits} 件({SRC})。上流が形を変えた可能性がある:\n"
                f"{anchor[:120]}...",
                file=sys.stderr,
            )
            return 1

    text = text.replace(ANCHOR_SEL, REPLACE_SEL)
    text = text.replace(ANCHOR_OK, REPLACE_OK)

    # ⚠ 置換が本当に効いたか(空振りを合格と読まない)
    if text.count("styleIdx < 0") != 1 or text.count("styleIdx >= 0") != 1:
        print("ERROR: ガードが 1 つずつ入っていない", file=sys.stderr)
        return 1
    # 🔴 **危ない assert が消えていること** ── 残すと debug ビルドで abort するだけで、
    #    release では何も守らない(いま落ちているのがその証拠)
    if 'assert(styleIdx != -1' in text:
        print("ERROR: 守らない assert が残っている", file=sys.stderr)
        return 1
    # 🔴 **OK が無反応にならないこと** ── ガードの外に response が在る
    ok_at = text.index("IMPL_LINK_NOARG(SwInsTableDlg, OKHdl")
    body = text[ok_at : text.index("\n}\n", ok_at)]
    if body.index("styleIdx >= 0") > body.index("m_xDialog->response(RET_OK)"):
        print("ERROR: response(RET_OK) がガードより前に在る", file=sys.stderr)
        return 1
    if body.count("m_xDialog->response(RET_OK)") != 1:
        print("ERROR: OK の返しが 1 つでない", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    print(f"patched: {SRC}(空の自動書式一覧で -1 を読まない / #135)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
