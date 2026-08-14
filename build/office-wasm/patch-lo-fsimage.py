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

## 🔴 file 名を直書きしない ── 名指しすると make が全体を止める

`.mo` の一覧は **登録済みモジュール × 頼んだ言語**から生成する:

    gb_AllLangMoTarget_LANGS      := $(filter-out qtz,$(filter-out en-US,$(gb_WITH_LANG)))
    gb_AllLangMoTarget_REGISTERED += …            # Repository.mk:1191 が登録
    gb_MoTarget_get_install_target = $(INSTROOT)/$(LIBO_SHARE_RESOURCE_FOLDER)/$(1).mo

⚠ 直書きすると、**wasm で落ちるモジュール**(`avmedia` / `basctl` / `sb` / `xsc` …)の
`.mo` を要求してしまい、規則が無いので `no rule to make target` で**ビルド全体が止まる**。
`gb_Helper_optional` で外れたものが自動で除かれるのが、生成する形の利点である。

⚠ 場所は `$(lang)` ではなく **`localestr $(lang)`**(上流と同じ式)。`ja` は `ja` だが、
`zh-CN` → `zh_CN` のように化ける言語が在るので、上流の式をそのまま使う。

⚠ **空になったら止める。** この 2 つの変数が未定義のまま展開されると、`+=` は
**何も足さずに成功する** ── 「無言で空になる」という #135 と同じ壊れ方をするので、
make 側に `$(error …)` を置く。

⚠ `cjk_ja.xcd` は**入れない**。一式は既に全言語版の `cjk.xcd` を持っている
(`registry/cjk.xcd`)ので、ja 固有版は要らない ── ⚠ ただし configmgr の読み込み経路
までは追っていない。日本語で入力できるのに変換周りが変なら、ここを疑う。

⚠ **`qtz` を外す。** これは翻訳 QA 用の**疑似ロケール**である。この構成では
`gb_WITH_LANG`(= `WITH_LANG`)に入らない ── qtz が足されるのは `WITH_LANG_LIST` の
ほうで(`configure.ac:15488`)、`gb_WITH_LANG = $(WITH_LANG)` は別物 ── が、
`--with-lang=ALL` では入りうる。入れると **LO の UI 言語の一覧に化けた言語が並ぶ**。
上流の `gb_AllLangMoTarget_LANGS` も同じ理由で `filter-out qtz` している。

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

LANG_BLOCK = """# PKC3: 日本語 UI を配る(#158)── 上流の一覧は en-US を名指しで焼いており、
# program/resource/**(.mo)を 1 行も入れていない。configure にレバーは無い
# (ENABLE_WASM_STRIP_LOCALES は死に変数 / --disable-wasm-strip は Emscripten で無効)。
# 🔴 file 名を直書きしない ── wasm で落ちるモジュールの .mo を要求すると
#    `no rule to make target` でビルド全体が止まる。登録済み × 頼んだ言語から生成する。
# ⚠ 空のまま素通りさせない ── `+=` は何も足さずに成功するので、#135 と同じ
#    「無言で空になる」壊れ方をする。
ifeq ($(strip $(gb_AllLangMoTarget_LANGS)),)
$(error PKC3/#158: gb_AllLangMoTarget_LANGS が空 ── --with-lang に en-US 以外が渡っていない)
endif
ifeq ($(strip $(gb_AllLangMoTarget_REGISTERED)),)
$(error PKC3/#158: gb_AllLangMoTarget_REGISTERED が空 ── Repository.mk より前に展開された)
endif
# ⚠ **path を行またぎで書かない** ── make は `\\` + 改行を**空白 1 個**にするので、
#    path の途中で折ると `…/program/resource/ ja/LC_MESSAGES/…` に化ける(実際に踏んだ)。
#    折ってよいのは**要素と要素の間**だけ。だから 1 行が長い。
gb_emscripten_fs_image_files += \\
    $(foreach lang,$(gb_AllLangMoTarget_LANGS),$(foreach mo,$(gb_AllLangMoTarget_REGISTERED),$(INSTROOT)/$(LIBO_SHARE_RESOURCE_FOLDER)/$(shell $(SRCDIR)/solenv/bin/localestr $(lang))/LC_MESSAGES/$(mo).mo)) \\
    $(foreach lang,$(filter-out qtz,$(filter-out en-US,$(gb_Configuration_LANGS))),$(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/Langpack-$(lang).xcd $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/res/fcfg_langpack_$(lang).xcd $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/res/registry_$(lang).xcd)
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

    # ⚠ 上流が言語を入れ始めたら止める(#158 の patch が要らなくなった合図)
    if UPSTREAM_ALREADY in text:
        print(
            f"ERROR: 上流が既に翻訳を入れている({UPSTREAM_ALREADY} が在る)\n"
            "  → #158 の分は要らなくなった可能性がある。確かめてから外すこと",
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
    text = text.replace(ANCHOR_ALL, "\n" + LANG_BLOCK + ANCHOR_ALL)

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

    # 🔴 言語のブロックの後条件 ── 「入った」だけでなく「**一覧が閉じる前に**入った」を見る。
    #    ⚠ `gb_emscripten_fs_image_all_files` より後ろに落ちると、make は通るのに
    #    file は詰まらない(#135 と同じ「無言で空」)。
    at_lang = text.index("$(gb_AllLangMoTarget_REGISTERED),$(INSTROOT)")
    at_all = text.index("\ngb_emscripten_fs_image_all_files = ")
    if not at_lang < at_all:
        print("ERROR: 言語のブロックが一覧の外(all_files より後ろ)に在る", file=sys.stderr)
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
