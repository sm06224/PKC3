#!/usr/bin/env python3
"""wasm の一式に、**コードが実際に読む `share/` の file** を入れる(#135 の根)。

## 何が起きていたか

`Ctrl+T`(表の挿入)の自動書式の一覧が**空**だった。空だから添字 `-1` が返り、
`patch-lo-instable.py` が止めている範囲外アクセスに落ちていた。
⚠ **ガードは落ちるのを止めるだけで、一覧は空のまま**である ── 本 patch が
「なぜ空なのか」の側を直す。

## 🔑 根 ── 上流の一覧が、上流自身の変更に追いついていない

LibreOffice は GSoC 2025(`svx/source/table/tablestylesparser.cxx` 冒頭)で
表の自動書式の出どころを **`autotbl.fmt` → `tablestyles.xml`** へ移した。
ところが wasm の詰め込み一覧 `static/CustomTarget_emscripten_fs_image.mk` は
**古いほうの `autotbl.fmt` を入れたまま**で、新しい `tablestyles.xml` を入れていない。

    svx/source/table/tableautofmt.cxx  SvxAutoFormat::Load(bWriter)
      → "$BRAND_BASE_DIR/" LIBO_SHARE_FOLDER + "/svx/tablestyles.xml"
      → 開けなければ SAL_WARN して return false      # ⚠ 一覧は空のまま、無言

⚠ **無言で空になる**ので、症状が「落ちる」としてしか現れない。

## ⚠ 数えたら 4 件だった ── 1 件だけ直さない

「コードが読む `share/` 配下の literal path」を全数走査して配布物 1599 file と
突き合わせた(`LIBO_SHARE_FOLDER "` の grep + `soffice.data.js.metadata`):

| 読む場所 | path | 一式に |
|---|---|---|
| `svx/…/tableautofmt.cxx` `Load(true)` | `share/svx/tablestyles.xml` | ❌ |
| `svx/…/tableautofmt.cxx` `Load(false)` | `share/calc/tablestyles.xml` | ❌ |
| `sc/…/docsh2.cxx` `docsh.cxx` | `share/calc/styles.xml` | ❌ |
| `sw/…/labelcfg.cxx` | `share/labels/labels.xml` | ❌ |
| `oox/…` ×2 / `vmlexport.cxx` | `share/filter/…` | ✅ |

🔑 **`share/svx/` と `share/calc/` は、ディレクトリごと 1 file も入っていなかった。**

## 入れる場所は「読む側」に合わせる

- Writer が読むもの(`svx/tablestyles.xml` / `labels/labels.xml`)
  → `ENABLE_WASM_STRIP_WRITER` の中
- Calc が読むもの(`calc/tablestyles.xml` / `calc/styles.xml`)
  → `ENABLE_WASM_STRIP_CALC` の中

⚠ どの file も **INSTROOT に必ず出来る**ことを確かめてある(`Repository.mk` の
`svx_xml` / `extras_labels` = `ooo` 群、`sc_res_xml` = `calc` 群)。
出来ない file を一覧に足すと make が止まるので、ここは確認が要る。

## ⚠ 当たったことを確かめてから当てる

錨が 1 つでなければ異常終了する。⚠ **上流が同じ行を足したときも止める** ──
黙って二重に入れない。

## 🔴 同じ根で、日本語 UI も配れていなかった(#158)

user 報告「そもそも UI が日本語ではないから、操作がしにくい」。原因は**まったく同型**で、
`static/CustomTarget_emscripten_fs_image.mk` が言語成果物を **`en-US` で名指し**している:

    registry/Langpack-en-US.xcd / res/fcfg_langpack_en-US.xcd / res/registry_en-US.xcd

そして **`program/resource/**`(= `.mo` 翻訳)は 1 行も入っていない**。自動収集の口も
塞がっている(`filelists` は liblangtag / fontconfig のみ、`autoinstall` は ooo_fonts のみ)。

⚠ **`--with-lang=en-US ja` は instdir に ja を作るが、`soffice.data` には 1 バイトも入らない。**

⚠ configure にレバーは無い(2026-08-14 に上流 `4a810c46` を checkout して確定):
`ENABLE_WASM_STRIP_LOCALES` は**死に変数**(上流全体で一致 1 件、誰も読まない)、
`--disable-wasm-strip` は `configure.ac:1301` が `enable_wasm_strip=yes` を無条件に
上書きするので **Emscripten では効かない**。**詰め込み一覧しか経路が無い。**

## 🔴 `.mo` は名簿から予言しない ── 建てさせてから、届いた物を拾う

1 稿目は `gb_AllLangMoTarget_REGISTERED` × 言語の直積で `.mo` の path を**予言**した。
⚠ **REGISTERED は「名前として許される一覧」であって「この構成で建つ一覧」ではない**
(2026-08-14、run 31777661606 で実際に落ちた)── `Repository.mk` は `cnr` を無条件で
登録するが、`connectivity/Module_connectivity.mk:17` が
`ifneq (,$(filter DBCONNECTIVITY,$(BUILD_TYPE)))` で **l10n target ごと**包んでおり、
wasm(DBACCESS 剥がし)では `cnr.mo` の install 規則が**生成されない**。規則の無い
file を要求すると `Package.mk` の catch-all が `$<` 空で
`gb_Deliver_deliver: file does not exist in instdir` を出して**ビルド全体が止まる**。

🔑 上流自身が答えを持っている ── `AllLangMoTarget.mk:91` が**実体化した mo target
だけ**を postprocess **`AllResources`** に登録する。だから:

1. **`soffice.data.filelist` の前提に `AllResources` を足す**
   (この構成で建つ全 `.mo` が INSTROOT へ**配られてから**詰め込みが走る)
2. **詰める一覧は `$(shell find $(INSTROOT)/…/ -name '*.mo')` で拾う**
   ── `gb_emscripten_fs_image_all_files` は**再帰変数で、recipe の実行時に展開**
   されるので、1 の前提が済んだ後の実在 file が入る

🔴 **`$(wildcard)` を使ってはいけない**(レビューが GNU Make 4.3 で実測)── make は
**最初にその dir を読んだ時点の内容をキャッシュ**するので、上流の誰かが同じ dir を
解析時に一度でも読むと、recipe 時の wildcard は**自分が作った file を見ない**
(= 翻訳 0 件を黙って出荷)。`$(shell find)` はキャッシュを通らない。

⚠ find は「在るものを拾う」ので **0 件でも黙って通る** ── その口は
workflow 側の後条件(`soffice.data.js.metadata` の `.mo` を数えて `-gt 0`)が塞ぐ。

⚠ 言語の**登録**(`Langpack-$(lang).xcd` ほか registry 3 種)は逆に**名指しの前提の
まま**にする ── `postprocess/Package_registry.mk` が `gb_Configuration_LANGS` の全言語分を
**無条件に**作るので規則は必ず在り、名指しなら**欠けたとき大声で落ちる**(wildcard に
すると欠けても黙る)。⚠ **`.mo` と registry で向きが逆**なのは、規則の在り方が違うから。

⚠ **空になったら止める。** 言語の変数が空のまま展開されると `+=` は**何も足さずに
成功する**(#135 と同じ「無言で空」)ので、make 側に `$(error …)` を置く。

⚠ `cjk_ja.xcd` は**入れない**。一式は既に全言語版の `cjk.xcd` を持っている
(`registry/cjk.xcd`)ので、ja 固有版は要らない ── ⚠ ただし configmgr の読み込み経路
までは追っていない。日本語で入力できるのに変換周りが変なら、ここを疑う。

🔴 **`qtz` を外す ── これは現役のガードである**(2026-08-14 のレビューで訂正。
当初「この構成では入らない」と書いたが**事実と逆**だった)。`langlist.mk:159-161` が
`WITH_LANG_LIST` に qtz が居れば **`gb_WITH_LANG += qtz`** し、PKC3 は
`--enable-release-build` を渡していないので `configure.ac:15487-15489` が qtz を足す
── つまり**この構成の `gb_Configuration_LANGS` は `en-US ja qtz` である**。
`filter-out qtz` は、いままさに `Langpack-qtz.xcd`(翻訳 QA 用の疑似ロケール)の
出荷を止めている。消すと **LO の UI 言語の一覧に化けた言語が並ぶ**。

⚠ **この block は `make` を実際に走らせて展開を確かめてある**(下の「検算」)。
読むだけでは分からない罠が 2 つ出た ── path の行またぎ、と qtz の混入である。
"""

import re
import sys
from pathlib import Path

SRC = "static/CustomTarget_emscripten_fs_image.mk"

# ⚠ 各ブロックの閉じ ── 一覧の最後の entry と `endif` の間に差し込む
ANCHOR_WRITER = "\nendif # !ENABLE_WASM_STRIP_WRITER"
ANCHOR_CALC = "\nendif # !ENABLE_WASM_STRIP_CALC"

WRITER_FILES = (
    "$(INSTROOT)/$(LIBO_SHARE_FOLDER)/labels/labels.xml",
    "$(INSTROOT)/$(LIBO_SHARE_FOLDER)/svx/tablestyles.xml",
)
CALC_FILES = (
    "$(INSTROOT)/$(LIBO_SHARE_FOLDER)/calc/styles.xml",
    "$(INSTROOT)/$(LIBO_SHARE_FOLDER)/calc/tablestyles.xml",
)

# ⚠ 言語のブロックは**条件ブロックの外**へ置く ── en-US の registry 行も無条件の
#    一覧に在る(`registry/Langpack-en-US.xcd`)。錨は一覧が閉じた直後の 1 行。
ANCHOR_ALL = "\ngb_emscripten_fs_image_all_files = "

# 🔴 上流が既に言語を入れたら止める(二重に入れない / 直ったことに気づく)
UPSTREAM_ALREADY = "LC_MESSAGES"

# 🔴 **Basic IDE(ツール → マクロ → マクロの編集)の設定一式**(#431 段④)。
#
# ## なぜ要るか ── 押しても無言で何も起きない
#
# 手元の 26.8 の一式に `dialog-crash-probe.mjs` の `macro` suite を当てた実測:
#
# | 押したもの | 結果 |
# |---|---|
# | ツール → マクロ | 🟢 子メニューが開く(面 2 → 3 枚) |
# | Run Macro… | 🟢 Macro Selector が開く(面 3 → 2 枚) |
# | 🔴 Edit Macros… | 🔴 **何も起きない**(面 3 → 1 枚 / fault 0 件) |
#
# ⚠ 対照群(`macro-run` suite)で「子メニューの項目は押せている」ことを確かめてある
# ので、これは**計器の話ではない**。
#
# ## 原因 ── コードは在るのに、その面が読む設定が配られていない
#
# | 見たもの | 結果 |
# |---|---|
# | 配った目録の `soffice.cfg/modules/` | `swriter` / `scalc` / `simpress` … **12 個**。🔴 `BasicIDE` は **0 件** |
# | 上流 `CustomTarget_emscripten_fs_image.mk`(1,828 行) | 🔴 `BasicIDE` の一致 **0 件** |
# | `soffice.wasm` | 🟢 **コードは在る**(`basctl` 133 件 / `ModulWindow` 3 件) |
#
# 🔑 上流の一覧は **wasm で scripting を切っていた時代**に書かれている ──
# こちらが `PKC3_WASM_SCRIPTING=yes` で開けても、**設定だけが付いてこない**。
# LO は開けなければ `SAL_WARN` して `return false` するので、**無言**で終わる
# (#135 / #144 / #145 / #225 と同じ型)。
#
# ## ⚠ 条件は `Module_basctl.mk` と**同じ物**にする
#
# あちらは `ifneq ($(filter SCRIPTING,$(BUILD_TYPE)),)` の中で
# `Library_basctl` と `UIConfig_basicide` を積む ── つまり **scripting を切った焼きでは
# instdir に file が無い**。⚠ 条件を揃えないと
# `gb_Deliver_deliver: file does not exist in instdir` で **make ごと止まる**
# (#225 の 1 稿目で実際に 1 本潰した)。
#
# ⚠ 一覧は `basctl/UIConfig_basicide.mk` の**登録**から採った ── file システムの
# 実在で数えない(CLAUDE.md §8)。登録に条件は 1 つも付いていない。
BASICIDE_UI = (
    "basicmacrodialog", "breakpointmenus", "codecomplete", "colorscheme",
    "combobox", "defaultlanguage", "deletelangdialog", "dialogpage",
    "dockingorganizer", "dockingstack", "dockingwatch", "exportdialog",
    "gotolinedialog", "importlibdialog", "libpage", "managebreakpoints",
    "managelanguages", "modulepage", "newlibdialog", "objectbrowser",
    "organizedialog", "sortmenu",
)
BASICIDE_XML = (
    ("popupmenu", ("dialog", "tabbar")),
    ("menubar", ("menubar",)),
    ("statusbar", ("statusbar",)),
    ("toolbar", (
        "dialogbar", "findbar", "fullscreenbar", "insertcontrolsbar",
        "formcontrolsbar", "macrobar", "standardbar", "translationbar",
    )),
)
_CFG = "$(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/modules/BasicIDE"
BASICIDE_FILES = tuple(
    f"{_CFG}/{sub}/{n}.xml" for sub, names in BASICIDE_XML for n in names
) + tuple(f"{_CFG}/ui/{n}.ui" for n in BASICIDE_UI)

# 🔴 上流が入れ始めたら止める(二重に入れない / 直ったことに気づく)
BASICIDE_ALREADY = "modules/BasicIDE"

LANG_BLOCK = """# PKC3: 日本語 UI の「言語の登録」を配る(#158)── 上流の一覧は en-US を名指しで
# 焼いており、他言語の registry を 1 行も入れていない。configure にレバーは無い
# (ENABLE_WASM_STRIP_LOCALES は死に変数 / --disable-wasm-strip は Emscripten で無効)。
# ⚠ registry は**名指しの前提のまま**にする ── Package_registry.mk が
#    gb_Configuration_LANGS の全言語分を無条件に作るので規則は必ず在り、
#    名指しなら欠けたとき大声で落ちる(.mo とは規則の在り方が違う ── そちらは下の
#    AllResources + wildcard の側)。
# ⚠ 空のまま素通りさせない ── `+=` は何も足さずに成功するので、#135 と同じ
#    「無言で空になる」壊れ方をする。
ifeq ($(strip $(filter-out qtz en-US,$(gb_Configuration_LANGS))),)
$(error PKC3/#158: 配る言語が無い ── --with-lang に en-US 以外が渡っていない)
endif
# ⚠ **path を行またぎで書かない** ── make は `\\` + 改行を**空白 1 個**にするので、
#    path の途中で折ると `…/registry/ Langpack-…` に化ける(実際に踏んだ)。
#    折ってよいのは**要素と要素の間**だけ。だから 1 行が長い。
gb_emscripten_fs_image_files += \\
    $(foreach lang,$(filter-out qtz,$(filter-out en-US,$(gb_Configuration_LANGS))),$(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/Langpack-$(lang).xcd $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/res/fcfg_langpack_$(lang).xcd $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/res/registry_$(lang).xcd)
"""

# .mo の側 ── `gb_emscripten_fs_image_all_files = ` の**後ろ**に入れる
# (`+=` なので、`=` の定義より前に置くと上書きされて消える)
MO_BLOCK = """# PKC3: 翻訳(.mo)を配る(#158)── 名簿(REGISTERED)から予言しない。
# 「この構成で建つ .mo」は構成条件で変わる(cnr / dba / rpt / frm は DBCONNECTIVITY
# 落ちで建たない ── Module_connectivity.mk:17)。上流が実体化した mo だけを
# AllResources に登録する(AllLangMoTarget.mk:91)ので、**建てさせてから、INSTROOT に
# 届いた物を拾う**:
#   前提 = AllResources(全 .mo が配られてから詰め込みが走る)
#   中身 = shell find(all_files は再帰変数 ── recipe 実行時に展開される)
# 🔴 wildcard を使ってはいけない ── make は**最初にその dir を読んだ時点の内容を
#    キャッシュ**するので、同じ run の中で自分が作った file が見えないことがある
#    (レビューが GNU Make 4.3 で実際に再現した)。`$(shell find …)` はキャッシュを
#    通らない。⚠ find も 0 件で黙って通る ── その口は workflow の後条件
#    (metadata の .mo を数える)が塞ぐ。
$(emscripten_fs_image_WORKDIR)/soffice.data.filelist: $(call gb_Postprocess_get_target,AllResources)
gb_emscripten_fs_image_all_files += $(shell find $(INSTROOT)/$(LIBO_SHARE_RESOURCE_FOLDER) -name '*.mo' 2>/dev/null | LC_ALL=C sort)
"""


def _block(files: tuple[str, ...], why: str) -> str:
    """🔴 **独立した `+=` 文として足す。既存の一覧の末尾に混ぜない。**

    最初にそう書いて壊した ── 一覧の最後の entry と `endif` の間には**空行**が在り、
    make の変数代入は**そこで終わる**。空行の後ろに `    …xml \\` を置くと、
    代入の外に落ちて `missing separator` になる(= ビルドが止まる)。
    ⚠ 継続行の中にコメントも置けない。だから **`+=` を 1 つ新設する**。
    """
    lines = [f"# PKC3: {why}", "gb_emscripten_fs_image_files += \\"]
    lines += [f"    {f} \\" for f in files]
    return "\n".join(lines) + "\n"


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-fsimage.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")

    for anchor in (ANCHOR_WRITER, ANCHOR_CALC, ANCHOR_ALL):
        hits = text.count(anchor)
        if hits != 1:
            print(
                f"ERROR: 錨が {hits} 件({SRC}): {anchor.strip()}",
                file=sys.stderr,
            )
            return 1

    # ⚠ 上流が既に入れていたら止める(二重に入れない / 直ったことに気づく)
    # 🔑 **#135 の検査を先に置く。** 2 回目の適用ではどちらも真になるので、
    #    順序を入れ替えると「二重適用」の報せが #158 側の文言に化ける
    #    (実際に入れ替えて test を 1 件落とした)。
    for f in WRITER_FILES + CALC_FILES:
        if f in text:
            print(
                f"ERROR: 上流が既に入れている: {f}\n"
                "  → 本 patch は要らなくなった可能性がある。確かめてから外すこと",
                file=sys.stderr,
            )
            return 1

    # ⚠ 上流が言語を入れ始めたら止める(#158 の patch が要らなくなった合図)。
    # 🔴 **コメント行を外してから探す** ── file 全体で問うと、上流が
    #    `# TODO: add LC_MESSAGES here` のような散文を 1 行足しただけで
    #    焼くたびに落ちる(CLAUDE.md §1「範囲が広すぎて散文に満たされる」の同型。
    #    レビュー指摘 G)。見るのは**実行される行**である。
    code_only = "\n".join(
        l for l in text.splitlines() if not l.lstrip().startswith("#")
    )
    if UPSTREAM_ALREADY in code_only:
        print(
            f"ERROR: 上流が既に翻訳を入れている({UPSTREAM_ALREADY} が実行行に在る)\n"
            "  → #158 の分は要らなくなった可能性がある。確かめてから外すこと",
            file=sys.stderr,
        )
        return 1

    # ⚠ 上流が Basic IDE を入れ始めたら止める(#431 の分が要らなくなった合図)。
    # 🔑 コメントを外した**実行行**で見る ── file 全体で問うと、上流が
    #    `# BasicIDE is stripped for wasm` のような散文を 1 行足しただけで
    #    焼くたびに落ちる(§1「範囲が広すぎて散文に満たされる」)。
    if BASICIDE_ALREADY in code_only:
        print(
            f"ERROR: 上流が既に Basic IDE を入れている({BASICIDE_ALREADY} が実行行に在る)\n"
            "  → #431 の分は要らなくなった可能性がある。確かめてから外すこと",
            file=sys.stderr,
        )
        return 1

    text = text.replace(
        ANCHOR_WRITER,
        "\n" + _block(WRITER_FILES, "Writer が読むのに入っていなかった(#135)") + ANCHOR_WRITER,
    )
    text = text.replace(
        ANCHOR_CALC,
        "\n" + _block(CALC_FILES, "Calc が読むのに入っていなかった(#135)") + ANCHOR_CALC,
    )
    # 🔴 Basic IDE は `Module_basctl.mk` と**同じ条件**で囲む(#431 段④)。
    #    ⚠ 囲まないと scripting を切った焼きで
    #      `gb_Deliver_deliver: file does not exist in instdir` が出て make ごと止まる。
    basicide = (
        "ifneq ($(filter SCRIPTING,$(BUILD_TYPE)),)\n"
        + _block(
            BASICIDE_FILES,
            "Basic IDE の設定一式(#431 段④)── 上流の一覧に 1 件も無く、"
            "「マクロの編集」が無言で開かなかった",
        )
        + "\nendif # SCRIPTING ── Basic IDE(#431)\n"
    )
    text = text.replace(ANCHOR_ALL, "\n" + basicide + "\n" + LANG_BLOCK + ANCHOR_ALL)
    # .mo のブロックは all_files の**定義行の直後**へ(`+=` なので前に置くと上書きで消える)
    all_line_start = text.index(ANCHOR_ALL) + 1
    all_line_end = text.index("\n", all_line_start)
    text = text[: all_line_end + 1] + "\n" + MO_BLOCK + text[all_line_end + 1 :]

    # 🔴 後条件 ── 「入った」だけでなく「**正しいブロックの中に**入った」を見る。
    #    ⚠ 一覧の外へ落ちると、make は通るのに file は詰まらない(無言で元の症状に戻る)
    w_open = text.index("ifneq ($(ENABLE_WASM_STRIP_WRITER),TRUE)")
    w_close = text.index("endif # !ENABLE_WASM_STRIP_WRITER")
    c_open = text.index("ifneq ($(ENABLE_WASM_STRIP_CALC),TRUE)")
    c_close = text.index("endif # !ENABLE_WASM_STRIP_CALC")
    for files, lo, hi, who in (
        (WRITER_FILES, w_open, w_close, "Writer"),
        (CALC_FILES, c_open, c_close, "Calc"),
    ):
        for f in files:
            if text.count(f) != 1:
                print(f"ERROR: {f} が 1 件でない", file=sys.stderr)
                return 1
            at = text.index(f)
            if not (lo < at < hi):
                print(f"ERROR: {f} が {who} のブロックの外に在る", file=sys.stderr)
                return 1

    # 🔴 言語のブロックの後条件 ── 「入った」だけでなく「**正しい側に**入った」を見る。
    #    ⚠ registry(前提の側)は all_files の**前**、.mo(`+=` の側)は all_files の
    #    **後ろ**でなければならない ── 逆だと make は通るのに file は詰まらない
    #    (#135 と同じ「無言で空」)。
    at_lang = text.index("registry/Langpack-$(lang).xcd")
    at_all = text.index("\ngb_emscripten_fs_image_all_files = ")
    # 🔴 Basic IDE の後条件 ── ①一覧の中(all_files より前)②**条件の中**。
    #    ⚠ ②を見ないと、条件の外に落ちても make は通り、scripting を切った焼きで
    #      初めて止まる(気づくのが 30 分後になる)。
    at_bi_open = text.index("ifneq ($(filter SCRIPTING,$(BUILD_TYPE)),)")
    at_bi_close = text.index("endif # SCRIPTING ── Basic IDE(#431)")
    if not at_bi_close < at_all:
        print("ERROR: Basic IDE のブロックが一覧の外(all_files より後ろ)に在る", file=sys.stderr)
        return 1
    for f in BASICIDE_FILES:
        if text.count(f) != 1:
            print(f"ERROR: {f} が 1 件でない", file=sys.stderr)
            return 1
        at = text.index(f)
        if not (at_bi_open < at < at_bi_close):
            print(f"ERROR: {f} が SCRIPTING のブロックの外に在る", file=sys.stderr)
            return 1
    at_mo_dep = text.index(": $(call gb_Postprocess_get_target,AllResources)")
    at_mo_add = text.index("gb_emscripten_fs_image_all_files += $(shell find ")
    if not at_lang < at_all:
        print("ERROR: registry のブロックが一覧の外(all_files より後ろ)に在る", file=sys.stderr)
        return 1
    if not (at_all < at_mo_dep and at_all < at_mo_add):
        print("ERROR: .mo のブロックが all_files の定義より前に在る(上書きで消える)", file=sys.stderr)
        return 1
    # ⚠ `=` の定義が 1 つだけで、`+=` がその後に居ること(定義の 2 重化を検出)
    if text.count("\ngb_emscripten_fs_image_all_files = ") != 1:
        print("ERROR: all_files の定義が 1 件でない", file=sys.stderr)
        return 1
    # 🔴 MO_BLOCK の前提行は `$(emscripten_fs_image_WORKDIR)` を**その場で**展開する。
    #    定義(`:=`)が挿入点より後ろへ動くと、空に展開されて**別の target**
    #    (`/soffice.data.filelist`)へ前提を張り、AllResources が走らない ──
    #    「無言で英語のまま」に戻る(fixture の順序違いで実際に観測した壊れ方)。
    at_wd = text.index("\nemscripten_fs_image_WORKDIR := ")
    if not at_wd < at_mo_dep:
        print(
            "ERROR: emscripten_fs_image_WORKDIR の定義が MO_BLOCK より後ろに在る"
            "(前提が空 target に化ける)",
            file=sys.stderr,
        )
        return 1
    # ⚠ path を行またぎで折っていないこと ── make は `\` + 改行を**空白 1 個**にするので、
    #    path の途中で折ると `…/program/resource/ ja/LC_MESSAGES/…` に化ける。
    # 🔑 「行末が `\`」で見てはいけない ── 要素と要素の間の継続は**正しい**
    #    (最初そう書いて、正しい行を弾いた)。**畳んでから token を見る**のが実害の形。
    # ⚠ **コメント行を外してから見る。** 最初これを file の一部だけ切り出して見たら、
    #    「`…/program/resource/ ja/…` に化ける」と書いた**自分の解説コメントに当たって**
    #    必ず落ちた ── 検査は「自分が書いた**実行される行**」に限る。
    stmt: list[str] = []
    for line in text[at_lang - 600 : at_all].splitlines():
        if line.lstrip().startswith("#"):
            continue
        stmt.append(line)
    folded = re.sub(r"\\\n\s*", " ", "\n".join(stmt))
    for tok in folded.split():
        if tok.startswith("$(INSTROOT)") and tok.endswith("/"):
            print(f"ERROR: path が途中で切れている(行またぎで折った): {tok}", file=sys.stderr)
            return 1
    if "/ " in folded:
        print("ERROR: 畳んだあとの path に空白が入っている(行またぎ)", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    print(
        f"patched: {SRC}"
        "(share/ の 4 file /#135 + 翻訳と registry の言語版 /#158)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
