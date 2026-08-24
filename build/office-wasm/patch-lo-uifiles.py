#!/usr/bin/env python3
"""#225 の**直し**。ダイアログの `.ui` の取りこぼしを、上流と突き合わせて埋める。

🔴 **これは計装ではない。既定で当たる。**

## 何が起きていたか(2026-08-24 に計装で確定)

非 ODF(`.docx` / `.rtf` / `.doc` / `.xlsx` / `.pptx`)で保存すると、LO は必ず
「この形式のままにしますか」と訊く。⚠ **そのダイアログの `.ui` が一式に入っていない**
ので例外が飛び、`sfx2/source/doc/objserv.cxx` の `catch(Exception&)` で
`ERRCODE_IO_GENERAL`(=「一般的な I/O エラー」)に化けていた。

計装(`patch-lo-save-trace.py` の `serv:catch`)が拾った例外の message:

    file:///instdir/program/../share/config/soffice.cfg/cui/ui/querydialog.ui

⇒ `SfxObjectShell::SaveTo_Impl` は**一度も呼ばれていない**(`saveto:enter` 0 件)。
フィルタでも一時ファイルでも zip でもなく、**訊く段**で終わっていた。

## 🔴 これは #135 / #144 / #145 と同じ型である

`static/CustomTarget_emscripten_fs_image.mk` は、詰め込む `.ui` を
**1 件ずつ手書きした一覧(1,053 行)**を持っており、**上流の追加に遅れる**
(CLAUDE.md §8「上流の『入れる物の一覧』は、上流自身の変更に遅れる」)。

実測(2026-08-24): 上流 **1,088** に対し配布 **1,031** ── **57 件の取りこぼし**。
⚠ 配布側にしか無いものは **0 件**なので、純粋な遅れである。

| cfg 上の場所 | 上流 | 配布 | 欠け |
|---|---|---|---|
| `modules/simpress/ui` | 85 | 67 | **18** |
| `cui/ui` | 210 | 199 | **11**(`querydialog.ui` を含む) |
| `modules/swriter/ui` | 232 | 223 | **9** |
| `svx/ui` | 143 | 137 | **6** |
| `modules/scalc/ui` | 188 | 183 | **5** |
| `sfx/ui` / `modules/schart/ui` | | | 3 / 3 |
| `vcl/ui` / `modules/smath/ui` | | | 1 / 1 |

## 🔑 直し方 ── **57 件を書き写さない。毎回その場で突き合わせる**

⚠ 数字を patch に焼き込むと、**次に上流が足したときまた遅れる**(この一覧は
すでに 3 回遅れている)。だから **patch 自身が上流を読んで差分を埋める**。

🔑 **置き場所は「同じディレクトリの隣」** ── 一覧は
`ENABLE_WASM_STRIP_WRITER` などの条件ブロックに分かれているので、
末尾へまとめて足すと**畳んだはずのモジュールまで入る**。
同じ `soffice.cfg/<dir>/` の既存行の**直後**へ挿せば、条件は自動的に揃う。

## ⚠ wildcard を使わなかった理由

`$(wildcard $(INSTROOT)/…/*.ui)` のほうが短いが、**評価の時期**が問題になる ──
make が この .mk を読む時点で INSTROOT が埋まっていなければ**黙って 0 件**になり、
「直したのに何も入っていない」という**いちばん気づけない形**で失敗する。
⚠ そこを手元で確かめる術が無いので採らない(CLAUDE.md §1「未確認は assert ではなく
診断で出す」の判断版)。

## 🔴 tripwire ── 遅れたら**名前を挙げて落ちる**

この patch は当てた後に**もう一度突き合わせ**、まだ欠けがあれば
**その名前を並べて exit 1** する。⚠ 「足した」で終わらせない ──
置き場所(同じディレクトリの既存行)が見つからないものは**挿せない**ので、
そこで黙ると取りこぼしが復活する。
"""

import os
import re
import sys
from pathlib import Path

MK = "static/CustomTarget_emscripten_fs_image.mk"

# 🔑 上流のモジュール名 → `soffice.cfg` 上の綴り。⚠ **推測しない** ── 一覧に実在する
#    綴りを実物から数えて作った(`grep -o "soffice.cfg/[a-z0-9/]*/ui/"`)。
MODULE_MAP = {
    "cui": "cui/ui",
    "sfx2": "sfx/ui",
    "svx": "svx/ui",
    "vcl": "vcl/ui",
    "svtools": "svt/ui",
    "uui": "uui/ui",
    "filter": "filter/ui",
    "desktop": "desktop/ui",
    "formula": "formula/ui",
    "xmlsecurity": "xmlsec/ui",
    "editeng": "editeng/ui",
    "writerperfect": "writerperfect/ui",
    "fpicker": "fps/ui",
    "sw": "modules/swriter/ui",
    "sc": "modules/scalc/ui",
    "sd": "modules/simpress/ui",
    "starmath": "modules/smath/ui",
    "chart2": "modules/schart/ui",
}
LINE_RE = re.compile(r"^(\s*)\$\(INSTROOT\)/\$\(LIBO_SHARE_FOLDER\)/config/soffice\.cfg/(.+?\.ui) \\$")


def bundled(text: str) -> dict[str, list[int]]:
    """cfg 上の相対 path → その行番号。⚠ 行番号は「隣へ挿す」ために要る。"""
    out: dict[str, list[int]] = {}
    for i, line in enumerate(text.splitlines()):
        m = LINE_RE.match(line)
        if m:
            out.setdefault(m.group(2), []).append(i)
    return out


def upstream(root: Path) -> dict[str, str]:
    """cfg 上の相対 path → 上流での実体(存在確認のため)。"""
    out: dict[str, str] = {}
    for mod, pref in MODULE_MAP.items():
        base = root / mod / "uiconfig"
        if not base.is_dir():
            continue
        for p in base.rglob("*.ui"):
            out[f"{pref}/{p.name}"] = str(p)
    return out


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-uifiles.py <lo-core-dir>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    path = root / MK
    if not path.exists():
        print(f"ERROR: {MK} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")
    if "PKC3 #225" in text:
        print(f"ERROR: {MK} に既に当たっている(二重当て)", file=sys.stderr)
        return 1

    have = bundled(text)
    # ⚠ **空振り防止** ── 一覧を 1 行も読めていないなら、上流が形を変えている
    if len(have) < 500:
        print(
            f"ERROR: 一覧から読めた .ui が {len(have)} 件しかない ── "
            "上流が形を変えた。`LINE_RE` を読み直すこと",
            file=sys.stderr,
        )
        return 1
    up = upstream(root)
    if len(up) < 500:
        print(
            f"ERROR: 上流の .ui が {len(up)} 件しかない ── clone が浅いか "
            "`MODULE_MAP` が古い(モジュールが増えた?)",
            file=sys.stderr,
        )
        return 1

    missing = sorted(set(up) - set(have))
    print(f"上流 {len(up)} / 一覧 {len(have)} / 欠け {len(missing)}")
    if not missing:
        print("skip: 欠けなし(一覧が上流に追いついている)")
        return 0

    lines = text.splitlines()
    # 🔑 **同じディレクトリの最後の既存行の直後へ挿す**(条件ブロックが自動的に揃う)
    inserts: dict[int, list[str]] = {}
    unplaceable: list[str] = []
    for rel in missing:
        d = rel.rsplit("/", 1)[0] + "/"
        siblings = [i for k, idxs in have.items() if k.startswith(d) for i in idxs]
        if not siblings:
            unplaceable.append(rel)
            continue
        at = max(siblings)
        indent = LINE_RE.match(lines[at]).group(1)
        inserts.setdefault(at, []).append(
            f"{indent}$(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/{rel} \\"
        )
    # 🔴 置き場所が無いものは**黙って落とさない**(取りこぼしが復活する)
    if unplaceable:
        print(
            "ERROR: 同じディレクトリの既存行が無くて挿せない:\n  "
            + "\n  ".join(unplaceable),
            file=sys.stderr,
        )
        return 1

    out: list[str] = []
    for i, line in enumerate(lines):
        out.append(line)
        if i in inserts:
            out.extend(sorted(inserts[i]))
    # ⚠ 印を 1 つ残す(二重当ての門が見る)
    out.insert(
        0, f"# PKC3 #225: ダイアログの .ui を上流と突き合わせて {len(missing)} 件補った"
    )
    path.write_text("\n".join(out) + "\n", encoding="utf-8")

    # 🔴 **書いたあとに再読して突き合わせ直す**(tripwire)
    after = bundled(path.read_text(encoding="utf-8"))
    still = sorted(set(up) - set(after))
    if still:
        print(
            f"ERROR: 当てた後もまだ {len(still)} 件欠けている:\n  " + "\n  ".join(still),
            file=sys.stderr,
        )
        return 1
    if len(after) != len(have) + len(missing):
        print(
            f"ERROR: 件数が合わない(前 {len(have)} + 足した {len(missing)} "
            f"≠ 後 {len(after)})",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {MK}(#225 の直し ── .ui を {len(missing)} 件補った)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
