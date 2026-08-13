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
"""

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

    for anchor in (ANCHOR_WRITER, ANCHOR_CALC):
        hits = text.count(anchor)
        if hits != 1:
            print(
                f"ERROR: 錨が {hits} 件({SRC}): {anchor.strip()}",
                file=sys.stderr,
            )
            return 1

    # ⚠ 上流が既に入れていたら止める(二重に入れない / 直ったことに気づく)
    for f in WRITER_FILES + CALC_FILES:
        if f in text:
            print(
                f"ERROR: 上流が既に入れている: {f}\n"
                "  → 本 patch は要らなくなった可能性がある。確かめてから外すこと",
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

    path.write_text(text, encoding="utf-8")
    print(f"patched: {SRC}(読むのに入っていなかった share/ の 4 file / #135)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
