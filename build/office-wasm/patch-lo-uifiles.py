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
**1 件ずつ手書きした一覧**を持っており、**上流の追加に遅れる**
(CLAUDE.md §8「上流の『入れる物の一覧』は、上流自身の変更に遅れる」)。

## 🔴 1 稿目は「上流」の数え方を間違えて、ビルドを落とした(2026-08-24)

⚠ 1 稿目は上流を **`<mod>/uiconfig/**/*.ui` の実在**で数え、**57 件**足して焼いた。
結果は `gb_Deliver_deliver: file does not exist in instdir, and cannot be delivered:
.../cui/ui/fileextcheckdialog.ui` で**ビルドが停止**した(run 32734107620)。

🔑 **「上流のソースに在る」は「instdir へ配られる」ではない。**
配られるのは `<mod>/UIConfig_*.mk` が `gb_UIConfig_add_uifiles` で
**登録したものだけ**である。`fileextcheckdialog` は
`ifeq ($(OS),WNT)` の中に在る ── **Windows だけ**の登録なので、wasm には配られない。

⚠ 誤りは 2 つ重なっていた:

1. **登録を見ずに実在で数えた**(上記)
2. **モジュール名 → cfg 上の綴りを手書きの表で当てていた**(`MODULE_MAP`)──
   ⚠ `sw` は `modules/swriter` だけではないし、`sd` は `modules/simpress` と
   `modules/sdraw` の**両方**を持つ。表で潰すと**実在しない path** を作る

🔑 **どちらも「登録を読む」だけで消える** ── `gb_UIConfig_add_uifiles,<cfg>,` の
**第 1 引数がそのまま cfg 上の綴り**であり(`solenv/gbuild/UIConfig.mk` の
`gb_UIConfig_INSTDIR := $(LIBO_SHARE_FOLDER)/config/soffice.cfg` +
`$(cfg)/ui/$(notdir <登録>).ui`)、**推測する余地が無い**。

実測(2026-08-24、LO fb02e9d1): 登録(条件なし)**1,090** / 一覧 **1,053** ──
**37 件の取りこぼし**。⚠ 一覧にしか無いものは **0 件**なので、純粋な遅れである。
⚠ 1 稿目の「57 件」は上の誤りぶんが混ざった数で、**20 件は配られない file** だった。

## 🔑 直し方 ── **件数を書き写さない。毎回その場で突き合わせる**

⚠ 数字を patch に焼き込むと、**次に上流が足したときまた遅れる**(この一覧は
すでに 3 回遅れている)。だから **patch 自身が登録を読んで差分を埋める**。

🔑 **置き場所は「同じディレクトリの隣」** ── 一覧は
`ENABLE_WASM_STRIP_WRITER` などの条件ブロックに分かれているので、
末尾へまとめて足すと**畳んだはずのモジュールまで入る**。
同じ `soffice.cfg/<dir>/` の既存行の**直後**へ挿せば、条件は自動的に揃う。

🔑 **足すのは「既に兄弟が居るディレクトリ」だけ** ── 配られるかどうかは
**UIConfig の package 単位**で決まるので(`gb_Package_add_file` は同じ package へ
積まれる)、兄弟が 1 件でも配られていれば残りも配られる。逆に 1 件も居ない
ディレクトリは**そのモジュールを積んでいない**ということなので、触らない。

## ⚠ 条件つきの登録は足さない

`ifeq` / `ifneq` の中の登録は、その条件がこの焼きで真かどうかを**この script は
知らない**(`config_host.mk` は configure の後にしかできず、patch はその前に走る)。
🔑 **知らないものは足さない** ── 足りなければ次の症状で分かるが、
足しすぎると**ビルドが止まる**(1 稿目がそれ)。実測では条件つきは 2 件だけで、
どちらも wasm には来ない(`fileextcheckdialog` = Windows 限定 /
`tipofthedaydialog` = `ENABLE_WASM_STRIP_PINGUSER`)。

## ⚠ wildcard を使わなかった理由

`$(wildcard $(INSTROOT)/…/*.ui)` のほうが短いが、**評価の時期**が問題になる ──
一覧は `gb_emscripten_fs_image_files :=`(単純展開)なので make の**読み込み時**に
評価され、その時点で instdir はまだ空である。

## 🔴 tripwire ── 遅れたら**名前を挙げて落ちる**

3 つ置く。どれも「足した」で終わらせないためのものである。

1. **一覧にしか無い `.ui` が 1 件でもあれば落ちる**(`stray`)── ⚠ これが
   **空振り防止の本体**である。登録の読み方が上流の変形についていけなくなると、
   まず「一覧に在るのに登録に無い」という形で出る。⚠ ここを黙って通すと、
   読めていない登録のぶんだけ**静かに足りなくなる**
2. 当てた後に**もう一度突き合わせ**、埋め残しがあれば名前を並べて落ちる
3. **件数の突き合わせ**(前 + 足した = 後)
"""

import re
import sys
from pathlib import Path

MK = "static/CustomTarget_emscripten_fs_image.mk"
MARK = "PKC3 #225"

# 一覧の 1 行。⚠ 末尾の ` \` まで含めて見る(継続行でないものを拾わない)
LINE_RE = re.compile(
    r"^(\s*)\$\(INSTROOT\)/\$\(LIBO_SHARE_FOLDER\)/config/soffice\.cfg/(.+?\.ui) \\$"
)
# 登録の呼び出し。第 1 引数が **cfg 上の綴りそのもの**(`cui` / `modules/swriter`)
CALL_RE = re.compile(r"^\$\(eval \$\(call gb_UIConfig_add_uifiles,\s*([A-Za-z0-9_/]+),\s*\\$")
# 登録の項目。上流は拡張子を書かない(`cui/uiconfig/ui/querydialog`)
ITEM_RE = re.compile(r"^([A-Za-z0-9_./-]+)\s*\\?$")
COND_RE = re.compile(r"^(ifeq|ifneq|ifdef|ifndef)\b")
# 空振り防止の下限。⚠ 「1 件でもあれば」にすると、読み方が壊れても気づけない
FLOOR = 900


def bundled(text: str) -> dict[str, list[int]]:
    """cfg 上の相対 path → その行番号。⚠ 行番号は「隣へ挿す」ために要る。"""
    out: dict[str, list[int]] = {}
    for i, line in enumerate(text.splitlines()):
        m = LINE_RE.match(line)
        if m:
            out.setdefault(m.group(2), []).append(i)
    return out


def registered(root: Path) -> tuple[dict[str, str], set[str]]:
    """`*/UIConfig_*.mk` を読む → (条件なしの登録 {rel: mk}, 条件つきの登録 {rel})。"""
    uncond: dict[str, str] = {}
    cond: set[str] = set()
    for mk in sorted(root.glob("*/UIConfig_*.mk")):
        lines = mk.read_text(encoding="utf-8").splitlines()
        depth = 0
        i = 0
        while i < len(lines):
            s = lines[i].strip()
            if COND_RE.match(s):
                depth += 1
            elif s.startswith("endif"):
                depth = max(0, depth - 1)
            call = CALL_RE.match(s)
            if call:
                cfg = call.group(1)
                j = i + 1
                while j < len(lines):
                    t = lines[j].strip()
                    if t.startswith("))"):
                        break
                    item = ITEM_RE.match(t.rstrip("\\").strip()) if t else None
                    if item:
                        rel = f"{cfg}/ui/{item.group(1).rsplit('/', 1)[-1]}.ui"
                        if depth:
                            cond.add(rel)
                        else:
                            uncond.setdefault(rel, str(mk))
                    j += 1
                i = j
            i += 1
    return uncond, cond


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
    if MARK in text:
        print(f"ERROR: {MK} に既に当たっている(二重当て)", file=sys.stderr)
        return 1

    have = bundled(text)
    if len(have) < FLOOR:
        print(
            f"ERROR: 一覧から読めた .ui が {len(have)} 件しかない(下限 {FLOOR})── "
            "上流が一覧の形を変えた。`LINE_RE` を読み直すこと",
            file=sys.stderr,
        )
        return 1
    reg, cond = registered(root)
    if len(reg) < FLOOR:
        print(
            f"ERROR: 登録から読めた .ui が {len(reg)} 件しかない(下限 {FLOOR})── "
            "clone が浅いか、上流が `gb_UIConfig_add_uifiles` の書き方を変えた",
            file=sys.stderr,
        )
        return 1

    # 🔴 tripwire ①(空振り防止の本体)── 一覧にしか無いものは在ってはならない。
    #    ⚠ 出たら「登録を読めていない」合図である。**足りない側は静かなので、
    #    ここで鳴らないと以後の全数比較が意味を失う**
    stray = sorted(set(have) - set(reg))
    if stray:
        print(
            f"ERROR: 一覧に在るのに登録から読めない .ui が {len(stray)} 件ある ── "
            "登録の読み方(`CALL_RE` / `ITEM_RE` / 条件の数え方)が上流に "
            "追いついていない。**この状態では欠けを数えられない**:\n  "
            + "\n  ".join(stray[:20])
            + ("\n  …" if len(stray) > 20 else ""),
            file=sys.stderr,
        )
        return 1

    dirs_have = {rel.rsplit("/", 1)[0] for rel in have}
    missing_all = sorted(set(reg) - set(have))
    # 兄弟が 1 件も居ないディレクトリ = そのモジュールを積んでいない。触らない
    skipped = [r for r in missing_all if r.rsplit("/", 1)[0] not in dirs_have]
    missing = [r for r in missing_all if r.rsplit("/", 1)[0] in dirs_have]
    print(f"登録(条件なし) {len(reg)} / 一覧 {len(have)} / 欠け {len(missing)}")
    print(f"  条件つきの登録(足さない): {len(cond - set(reg))}")
    if skipped:
        # ⚠ 黙って落とさない ── 「積んでいないモジュール」なのか
        #    「置き場所を見つけられなかった」のかは、次に読む人には区別できない
        dirs = sorted({r.rsplit("/", 1)[0] for r in skipped})
        print(f"  一覧に兄弟が 1 件も無いので足さない: {len(skipped)} 件 {dirs}")
    if not missing:
        print("skip: 欠けなし(一覧が登録に追いついている)")
        return 0

    lines = text.splitlines()
    # 🔑 **同じディレクトリの最後の既存行の直後へ挿す**(条件ブロックが自動的に揃う)
    inserts: dict[int, list[str]] = {}
    for rel in missing:
        d = rel.rsplit("/", 1)[0] + "/"
        siblings = [i for k, idxs in have.items() if k.startswith(d) for i in idxs]
        at = max(siblings)
        indent = LINE_RE.match(lines[at]).group(1)
        inserts.setdefault(at, []).append(
            f"{indent}$(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/{rel} \\"
        )

    out: list[str] = []
    for i, line in enumerate(lines):
        out.append(line)
        if i in inserts:
            out.extend(sorted(inserts[i]))
    # ⚠ 印を 1 つ残す(二重当ての門が見る)
    out.insert(0, f"# {MARK}: ダイアログの .ui を登録と突き合わせて {len(missing)} 件補った")
    path.write_text("\n".join(out) + "\n", encoding="utf-8")

    # 🔴 tripwire ②③ ── **書いたあとに再読して突き合わせ直す**
    after = bundled(path.read_text(encoding="utf-8"))
    still = sorted(set(missing) - set(after))
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
