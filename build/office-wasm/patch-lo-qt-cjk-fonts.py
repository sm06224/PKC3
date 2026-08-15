#!/usr/bin/env python3
"""instdir のフォントを Qt の font DB にも登録する(#169 メニュー豆腐の根)。

## 症状(実機スクリーンショット + 報告 #11)

日本語 UI(#158)にしたら、**上のメニューバーだけ**日本語が豆腐になる。
文書の本文・ダイアログの中身は日本語で描けている。日によって出たり出なかったり
(非決定的)。

## 🔑 根 ── 描く側が 2 系統あり、フォントの台帳が別々

- **vcl が描く面**(文書 canvas / LO 自前のウィジェット)は fontconfig 経由で
  `/instdir/share/fonts/truetype` を読む。ここには host.html が起動前に
  BIZ UD(CJK)を MEMFS へ書き込む(public/office/host.html の font staging)
  ── だから本文は日本語が出る。
- **Qt が描く面**(QMenuBar = 上のメニューバー。QtMenu.cxx が native menubar を
  使う)は **Qt 自身の font DB** で描く。Qt wasm の DB は Qt 同梱の
  DejaVu Sans/Mono だけで **CJK が 1 本も無い** ── fontconfig は読まない。
  よってメニューの日本語は決定的に豆腐。
- **非決定性の出どころ**: Qt wasm は Local Font Access API(許可制・非同期)で
  実機のローカルフォントを後から足す。許可と到着のタイミングで、実機では
  たまに CJK が入って直って見える ── 競争であって修理ではない。

## 直し ── QApplication 構築直後に instdir のフォントを Qt へ登録する

`QtInstance::CreateQApplication()`(vcl/qt5/QtInstance.cxx)で QApplication を
作った直後に、`/instdir/share/fonts/truetype` の全フォントを
`QFontDatabase::addApplicationFont` で登録する。

- ⚠ **順序は成立している**: host.html は `noInitialRun: true` で qtLoad し、
  フォントを MEMFS へ書いて**から** `inst.callMain(args)` を呼ぶ。
  CreateQApplication は main() の中(VCL init)なので、この時点で
  フォントは必ず在る。
- ⚠ 読むのは MEMFS(メモリ上)なので I/O は安い。登録は起動 1 回きり。
  起動コストは許容(user 指示 2026-08-03「初回起動が遅くとも、そこは許容」)。
- ⚠ Qt 側(QWasmFontDatabase)を直す道もあるが、LO patch は **Qt の再ビルドが
  要らない**(ccache 温存)。qtbase-patch-*.py に足すと Qt cache 鍵も変わる。
"""

import sys
from pathlib import Path

SRC = "vcl/qt5/QtInstance.cxx"

# 挿入 1: include(既存の QtGui include 群の末尾に足す)
INC_ANCHOR = "#include <QtGui/QStyleHints>"
INC_REPLACE = (
    "#include <QtGui/QStyleHints>\n"
    "#include <QtGui/QFontDatabase>\n"
    "#include <QtCore/QDir>\n"
    "#include <QtCore/QFileInfo>"
)

# 挿入 2: CreateQApplication の末尾(QApplication 構築後・return 前)
BODY_ANCHOR = (
    "    QApplication::setQuitOnLastWindowClosed(false);\n"
    "    return pQApp;"
)
BODY_REPLACE = (
    "    QApplication::setQuitOnLastWindowClosed(false);\n"
    "\n"
    "#ifdef __EMSCRIPTEN__\n"
    "    // PKC3/#169: Qt wasm の font DB は Qt 同梱の DejaVu しか知らず、\n"
    "    // fontconfig は読まない ── QMenuBar などネイティブ Qt が描く面だけ\n"
    "    // CJK が豆腐になる。vcl が読む instdir のフォント(host が起動前に\n"
    "    // MEMFS へ書く BIZ UD を含む)を Qt にも登録して、台帳を揃える。\n"
    "    {\n"
    "        const QDir aFontDir(QStringLiteral(\"/instdir/share/fonts/truetype\"));\n"
    "        const QStringList aFontFilters{ QStringLiteral(\"*.ttf\"),\n"
    "                                        QStringLiteral(\"*.otf\"),\n"
    "                                        QStringLiteral(\"*.ttc\") };\n"
    "        for (const QFileInfo& rFontFile :\n"
    "             aFontDir.entryInfoList(aFontFilters, QDir::Files))\n"
    "            QFontDatabase::addApplicationFont(rFontFile.absoluteFilePath());\n"
    "    }\n"
    "#endif\n"
    "    return pQApp;"
)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-qt-cjk-fonts.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")

    # ⚠ 既に当たっていたら(または上流が自分で登録を入れたら)止める。
    #    🔑 錨の検査より**先**に見る ── 上流が入れた場合は錨の字面も変わりうるので、
    #    後に置くと「錨が 0 件」という誤った説明で落ちる(popup-focus のレビュー指摘)。
    #    🔑 コメントを剥いだ**コード行だけ**で見る ── 上流がこの語をコメントに
    #    書いただけで偽の停止になる(CLAUDE.md §1「検査が散文に満たされる」)。
    code_only = "\n".join(line.split("//", 1)[0] for line in text.splitlines())
    if "addApplicationFont" in code_only:
        print(
            "ERROR: QtInstance.cxx が既に addApplicationFont をコードで呼んでいる\n"
            "  → 二重適用か、上流が自分で入れた。確かめてから外すこと",
            file=sys.stderr,
        )
        return 1
    for name, anchor in (("include", INC_ANCHOR), ("body", BODY_ANCHOR)):
        hits = text.count(anchor)
        if hits != 1:
            print(f"ERROR: {name} の錨が {hits} 件({SRC})", file=sys.stderr)
            return 1

    text = text.replace(INC_ANCHOR, INC_REPLACE)
    text = text.replace(BODY_ANCHOR, BODY_REPLACE)

    # 後条件 ── 挿入が CreateQApplication の中に入ったこと(字面だけでなく位置)。
    # ⚠ 単語で探さない ── 挿入した BODY_REPLACE ブロック丸ごとで位置を採る
    #    (散文・別関数の部分一致に刺さらない)。
    at = text.index(BODY_REPLACE)
    fn_at = text.index("std::unique_ptr<QApplication> QtInstance::CreateQApplication()")
    next_fn_at = text.index("bool QtInstance::DoExecute(")
    if not (fn_at < at < next_fn_at):
        print("ERROR: 挿入が CreateQApplication の外に在る", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落とすと in-memory 検査だけ通り、
    #    artifact に 1 バイトも入らない ── popup-focus の変異 M-1 と同型)。
    written = path.read_text(encoding="utf-8")
    if "QFontDatabase::addApplicationFont(rFontFile.absoluteFilePath());" not in written:
        print(f"ERROR: 書き戻し後の {SRC} に登録コードが無い(write が落ちている)", file=sys.stderr)
        return 1
    print(f"patched: {SRC}(instdir のフォントを Qt の font DB へ登録 /#169)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
