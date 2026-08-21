#!/usr/bin/env python3
"""変異試験のハーネス(PKC3)。`/tmp` へコピーして MUTATIONS を編集して使う。

    cp .claude/skills/mutation-testing/templates/mutate.py /tmp/mut-<主題>.py
    python3 /tmp/mut-<主題>.py           # 全件
    python3 /tmp/mut-<主題>.py M1 M3     # id を指定

このハーネスが守っている規律(CLAUDE.md「検証の規律」):
  - **file に出す** ── その場の shell に書くと引用で変異が当たらない
  - 置換前に「元の文字列がちょうど 1 件」を assert し、置換後に**当たったこと**を確かめる
  - 結果は KILLED / SURVIVED / **NOT-APPLIED** の 3 値(空振りを合格と読まない)
  - smoke は `dist/` を配信するので、**build を挟んで生成物に届いたことを確かめる**
  - 戻しは `cp` のバックアップ。`git checkout` は使わない(他の変更ごと消える)
"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path("/home/user/PKC3")

# unit を回すときのコマンド(絞ると速い。広げると取りこぼしが減る)
UNIT_CMD = "npx vitest run tests/"
# smoke を回すときの grep(playwright の位置引数)
SMOKE_GREP = "your-spec-name"
# smoke の変異が生成物に届いたかを確かめる目印。
# ⚠ **変異で消える / 現れる字面**にする。無関係な字面だと空振りを検出できない
# 🔴 **CSS の目印を「コメント」にしない**(2026-08-14 実測)── minify が消すので
#    dist に 1 つも残らず、**当たっているのに永久に NOT-APPLIED** になる
#    (出荷 css のコメントは 0 件、custom property は残る)。印は `--mut-a: 1` のような
#    **custom property** を足して、それを探す。
# ⚠ **規則ごと消す変異にも印を残す** ── 消すだけだと「当たったこと」を dist から
#    確かめられない。消した規則の代わりに `--mut-x: 1` を置くと、当たりが見える。
DIST_MARKER = "put-a-string-that-the-mutation-changes-here"
# DIST_MARKER が「変異後に消える」なら True、「変異後に現れる」なら False
DIST_MARKER_DISAPPEARS = True

# (id, 対象 file, 元の文字列, 変異後, "unit" | "smoke")
# ⚠ 元の文字列は**前後を含めて一意**にする(短い断片は必ず別行に刺さる)
# ⚠ 全角の括弧を含むコメント行はアンカーにしない(照合に失敗して NOT-APPLIED になる)
MUTATIONS = [
    (
        "M1 例: 判定を緩める",
        "src/features/example.ts",
        "  return parts.every(isGood);",
        "  return parts.some(isGood);",
        "unit",
    ),
]


class TimedOut(Exception):
    """時間で切れた ── **落ちたのではない**。判定不能として出す(§4 値)。"""


def run(cmd, timeout=1800):
    """命令を回す。

    🔴 **時間切れは「落ちた」ではない**(2026-08-20 に誤読した)。変異が
    無限ループを作ると test は止まったまま返らない ── それを KILLED と読むと
    「守られている」という**嘘の合格**が残る。ここで例外に変え、呼び側が
    `TIMEOUT(判定不能)` として出す。
    """
    try:
        return subprocess.run(
            cmd, cwd=ROOT, shell=True, capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired as e:
        raise TimedOut(f"{timeout}s で返らなかった: {cmd}") from e


def dist_assets() -> str:
    """出荷される生成物を全部つないで返す。

    🔴 **`*.js` だけを読むと CSS の変異が永久に NOT-APPLIED になる。**
    `src/styles/app.css` は `dist/assets/*.css` へ**別 file** で出る
    (2026-08-14 実測: js 105 件 / css 1 件)。目印を js の中だけ探していたので、
    CSS を壊す変異は「dist に印が無い」で必ず弾かれていた。
    """
    assets = ROOT / "dist" / "assets"
    files = sorted(assets.glob("*.js")) + sorted(assets.glob("*.css"))
    return "\n".join(p.read_text(encoding="utf-8", errors="replace") for p in files)


def first_reason(out: str) -> str:
    for line in out.splitlines():
        if "×" in line or "Error:" in line or "error TS" in line:
            return line.strip()[:140]
    return ""


def main() -> int:
    only = sys.argv[1:] or None
    results = []
    for mid, rel, old, new, kind in MUTATIONS:
        if only and mid.split()[0] not in only:
            continue
        target = ROOT / rel
        backup = target.with_suffix(target.suffix + ".mutbak")
        shutil.copy2(target, backup)
        try:
            src = target.read_text(encoding="utf-8")
            hits = src.count(old)
            if hits != 1:
                results.append((mid, "NOT-APPLIED", f"元の文字列が {hits} 件(1 件でない)"))
                continue
            target.write_text(src.replace(old, new, 1), encoding="utf-8")
            if new not in target.read_text(encoding="utf-8"):
                results.append((mid, "NOT-APPLIED", "書き換えが成立していない"))
                continue

            if kind == "smoke":
                # 🔴 smoke は dist を配信する ── build を挟まないと変異が届かない
                b = run("npm run build")
                if b.returncode != 0:
                    # 下限 tripwire(検品)が止めた形 ── これは守られている
                    results.append((mid, "KILLED", "build が落ちた(検品 tripwire)"))
                    continue
                present = DIST_MARKER in dist_assets()
                if DIST_MARKER_DISAPPEARS and present:
                    results.append((mid, "NOT-APPLIED", "目印が dist に残っている"))
                    continue
                if not DIST_MARKER_DISAPPEARS and not present:
                    results.append((mid, "NOT-APPLIED", "目印が dist に現れていない"))
                    continue
                r = run(
                    "npx playwright test --config tests/smoke/playwright.config.ts "
                    f"{SMOKE_GREP}"
                )
            else:
                r = run(UNIT_CMD)
            verdict = "SURVIVED" if r.returncode == 0 else "KILLED"
            results.append((mid, verdict, first_reason(r.stdout + r.stderr)))
        except TimedOut as e:
            # ⚠ 3 値の**外** ── 「殺せた」とも「生き延びた」とも書かない
            results.append((mid, "TIMEOUT", str(e)))
        finally:
            # ⚠ test が落ちても例外でも**必ず**戻す
            shutil.move(str(backup), str(target))

    mark = {"KILLED": "○", "SURVIVED": "🔴", "NOT-APPLIED": "⚠", "TIMEOUT": "⏱"}
    print("\n=== 変異試験の結果 ===")
    for mid, verdict, why in results:
        print(f"{mark[verdict]} {verdict:12} {mid}")
        if why:
            print(f"    {why}")
    bad = [r for r in results if r[1] != "KILLED"]
    print(f"\nKILLED {len(results) - len(bad)} / {len(results)}")
    if bad:
        print("⚠ SURVIVED は test を書き直す。NOT-APPLIED はアンカーを直して**やり直す**")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
