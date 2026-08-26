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
  - **殺されても戻す** ── `finally` だけでは足りない(timeout の `SIGTERM` で
    走らない)。`atexit` と signal からも戻す
  - スイープの後は **`git status` と字面を目視する**(緑だけ見て commit しない)
"""

import atexit
import shutil
import signal
import subprocess
import sys
from pathlib import Path

ROOT = Path("/home/user/PKC3")

# 🔴 **殺されても戻す**(2026-08-22、#178 で実際に踏んだ)。timeout で `SIGTERM` を
#    受けると `finally` は走らない ── **変異が作業ツリーに残る**。しかも次の走りは
#    その版を `orig` として読むので、以後の変異は全部 `NOT-APPLIED` と出て、
#    **復元は変異入りの版を書き戻す**(スイープ全体が無意味になる)。
# 🔑 だから戻しを「手順」ではなく**ハーネスの仕掛け**に閉じ込める:
#    生きているバックアップを表に持ち、`atexit` と signal の両方から戻す。
_LIVE: dict[Path, Path] = {}


def _restore_all(*_args) -> None:
    for target, backup in list(_LIVE.items()):
        try:
            shutil.move(str(backup), str(target))
        except OSError:
            pass
        _LIVE.pop(target, None)


atexit.register(_restore_all)
for _sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    try:
        signal.signal(_sig, lambda *_a: (_restore_all(), sys.exit(130)))
    except (ValueError, OSError):
        pass  # 対話でない環境では張れないことがある ── atexit が受け皿

# unit を回すときのコマンド(絞ると速い。広げると取りこぼしが減る)
UNIT_CMD = "npx vitest run tests/"
# smoke を回すときの絞り。
# 🔴 **これは playwright の「位置引数」= spec の path の絞りである**(2026-08-27、
#    #444 で溶かした)。⚠ **test の題名を書いてはいけない** ── 位置引数は
#    **空白で割られて file 名の部分一致**になるので、`"添付から読んだ mermaid"` は
#    `mermaid.smoke.spec.ts` に当たり、**狙っていない spec が緑で通って SURVIVED**
#    と出た(手で当て直したら KILLED だった)。
# 🔑 **spec の path をそのまま書く**(`tests/smoke/attach.smoke.spec.ts`)。
#    題名で絞りたいなら `-g '…'` を含めて書く。
# ⚠ 走った件数は結果行に出る ── **狙った数と合っているか毎回見る**
#    (0 件は下の `ran_count` が NOT-APPLIED として止めるが、
#    「別の spec が走った」は数を見るしかない)。
SMOKE_GREP = "tests/smoke/your-spec.smoke.spec.ts"
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


def ran_count(out: str) -> int:
    """走った test の件数を読む。**読めなければ -1**(= 判定を止めない)。

    🔴 **0 件で緑になるのを止めるため**に在る(2026-08-27、#444)。playwright も
    vitest も「絞りに 1 件も当たらなかった」を **exit 0** で返すので、
    件数を見ないと**空振りが SURVIVED に化ける**。
    ⚠ 読めない書式のときは `-1` を返して**素通りさせる** ── 判定できないことを
    理由に、走った回まで捨てない。
    """
    import re as _re
    m = _re.findall(r"(\d+)\s+(?:passed|failed|flaky|skipped)", out)
    if m:
        return sum(int(x) for x in m)
    # vitest の「Tests  N passed」/ playwright の「Running N tests」も拾う
    m2 = _re.search(r"Running (\d+) tests?", out)
    if m2:
        return int(m2.group(1))
    return -1


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
        # ⚠ バックアップは**変異を当てる直前に取り直す**(使い回さない)──
        #    使い回すと、スイープの最後に「修正前のコピー」が書き戻される
        #    (2026-08-10 に実際に踏み、その状態で commit して CI を赤くした)
        shutil.copy2(target, backup)
        _LIVE[target] = backup
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
            ran = ran_count(r.stdout + r.stderr)
            ran_note = "" if ran < 0 else f"(走った test {ran} 件)"
            if ran == 0:
                # 🔴 **1 件も走らなかった回を「生き延びた」と読まない**
                #    (2026-08-27、#444 で実際に踏んだ)。`SMOKE_GREP` は
                #    playwright の**位置引数**(= spec の path 絞り)なので、
                #    そこへ test の**題名**を書くと **0 件一致 → exit 0** になり、
                #    ハーネスは「SURVIVED」と出す ── 手で当て直したら KILLED だった。
                #    ⚠ 「走らなかった」は 3 値の**外**である(CLAUDE.md §3)。
                results.append((mid, "NOT-APPLIED", "test が 1 件も走っていない(絞りが 0 件一致)"))
                continue
            verdict = "SURVIVED" if r.returncode == 0 else "KILLED"
            # ⚠ **件数を必ず出す** ── 「別の spec が走っていた」は数でしか見えない
            results.append((mid, verdict, (first_reason(r.stdout + r.stderr) + " " + ran_note).strip()))
        except TimedOut as e:
            # ⚠ 3 値の**外** ── 「殺せた」とも「生き延びた」とも書かない
            results.append((mid, "TIMEOUT", str(e)))
        finally:
            # ⚠ test が落ちても例外でも**必ず**戻す。
            #    ⚠ `finally` **だけでは足りない**(殺されると走らない)ので、
            #      上の `_LIVE` / `atexit` / signal と対で使う
            shutil.move(str(backup), str(target))
            _LIVE.pop(target, None)

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
