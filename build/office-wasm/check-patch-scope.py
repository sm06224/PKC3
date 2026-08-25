#!/usr/bin/env python3
"""計装 patch が入れるヘルパーが、**そのコードと同じスコープ**に在るかを検める。

🔴 **錨を変えたら必ず走らせる**(2026-08-24 に 2 度踏んだ)。

## なぜ要るか

計装 patch は「ヘルパー(名前空間スコープの関数)」+「呼ぶ側」を入れる。⚠ 錨が
**関数の中**に在るのに `HELPER + 本体` を 1 つの錨へ当てると、名前空間スコープの
関数定義が関数本体の内側へ入り、**コンパイル不能**になる。

⚠ **patch は「当たった」と報告する。** 生成された C++ を検めるまで気づけず、
焼いて 2 時間後に赤で分かる形になる ── 実際 2 件そうなっていた
(`patch-lo-idles-trace.py` の 1 稿目 / `patch-lo-save-trace.py`)。

## 何を見るか ── ⚠ 「深さ 0」ではない

🔴 **1 稿目の検査は「`void <fn>(` の位置で括弧の深さ 0」を要求した。成り立たない条件だった**
── ヘルパーは `namespace { ... }` で包むので**必ず深さ 1** になる(CLAUDE.md §1)。

🔴 **2 稿目は「`namespace` ブロックの位置で深さ 0」にしたが、これも厳しすぎた**
── `vcl/source/window/window.cxx` の `Window::ImplNewInputContext()` は
**`namespace vcl { }` の中**(深さ 1)なので、そこへ入れるヘルパーも深さ 1 が**正しい**。
⚠ この一式は 2026-08-23 に**実際に焼けている**ので、赤を信じて「直す」と製品を壊していた。

🔑 **本当の条件は「ヘルパーが、直後のコードと同じスコープに在ること」**である。
だから**自己校正する** ── ヘルパーの直後の字を元 file から探し、
**元でのその位置の深さ**と、**patch 後のヘルパーの位置の深さ**を突き合わせる。

## 空振り防止

- **対照群**: 同じ counter を、元 file の既知の file scope 位置へ当てて 0 が出ること
- ヘルパーが 1 つも見つからない patch は**失敗**にする(検査が何も見ていない)

    python3 build/office-wasm/check-patch-scope.py [<LO を clone した dir>]
"""

import os
import re
import shutil
import subprocess
import sys

LO = sys.argv[1] if len(sys.argv) > 1 else "/tmp/lo-src"


def depth_at(text: str, pos: int) -> int:
    """`pos` の時点で開いている `{` の数。⚠ 文字列 / コメント / 前処理行は数えない。"""
    d = i = 0
    n = len(text)
    while i < pos and i < n:
        c = text[i]
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            i = n if j == -1 else j
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            i = n if j == -1 else j + 2
            continue
        if c in "\"'":
            q = c
            i += 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == q:
                    i += 1
                    break
                i += 1
            continue
        if c == "#" and (i == 0 or text[i - 1] == "\n"):
            j = text.find("\n", i)
            i = n if j == -1 else j
            continue
        if c == "{":
            d += 1
        elif c == "}":
            d -= 1
        i += 1
    return d


# 🔑 対照群 ── 元 file の既知の file scope 位置(深さ 0 のはず)
CONTROLS = [
    ("vcl/qt5/QtInstance.cxx", "bool QtInstance::ImplYield("),
    ("vcl/source/app/scheduler.cxx", "Scheduler::IdlesLockGuard::IdlesLockGuard()"),
    ("vcl/source/app/svapp.cxx", "void Application::Execute()"),
    ("sfx2/source/doc/docfile.cxx", "void SfxMedium::SetError("),
    ("vcl/qt5/QtFrame.cxx", "void QtFrame::SetInputContext("),
]
# 🔑 **期待値は明示で書く。** 「ヘルパー直後の字」から自動で拾おうとして 1 度外した
#    (`namespace` の閉じ `}` から探して、元 file の無関係な `}` に当たった)。
#    ⚠ 6 対しかなく、めったに変わらない ── **推測する仕掛けより、書いたほうが正しい**。
#    各行の意味: そのヘルパーは「この関数と同じスコープ」に在らねばならない。
SPECS = [
    (
        "PKC3_IDLES_TRACE",
        "patch-lo-idles-trace.py",
        "pkc3_idles_trace",
        [
            ("vcl/source/app/scheduler.cxx", "Scheduler::IdlesLockGuard::IdlesLockGuard()"),
            ("vcl/source/app/svapp.cxx", "void Application::Execute()"),
            ("vcl/qt5/QtInstance.cxx", "bool QtInstance::ImplYield("),
            # 🔴 7 巡目(2026-08-24)── user event を配る所。⚠ ここを SPECS に
            #    足し忘れると、**新しく当てた file だけ検査の外**になる。
            (
                "vcl/source/app/salusereventlist.cxx",
                "bool SalUserEventList::DispatchUserEvents(",
            ),
            # 🔴 8 巡目(2026-08-25)── user event の Link を呼ぶ所。
            (
                "vcl/source/window/winproc.cxx",
                "static void ImplHandleUserEvent( ImplSVEvent* pSVEvent )",
            ),
        ],
    ),
    (
        "PKC3_SAVE_TRACE",
        "patch-lo-save-trace.py",
        "pkc3_save_trace",
        [
            ("sfx2/source/doc/docfile.cxx", "void SfxMedium::SetError("),
            ("sfx2/source/doc/objstor.cxx", "bool SfxObjectShell::SaveTo_Impl"),
            ("sfx2/source/doc/objmisc.cxx", "void SfxObjectShell::SetError("),
            ("sfx2/source/doc/objserv.cxx", "void SfxObjectShell::ExecFile_Impl("),
        ],
    ),
    (
        "PKC3_IME_TRACE",
        "patch-lo-ime-trace.py",
        "pkc3_ime_trace",
        [
            # ⚠ ここは **`namespace vcl { }` の中**なので、正しい深さは **1** である
            #    ── 「深さ 0」を要求した稿は、焼けている一式を赤にした
            ("vcl/source/window/window.cxx", "void Window::ImplNewInputContext()"),
            ("vcl/qt5/QtFrame.cxx", "void QtFrame::SetInputContext("),
        ],
    ),
]
HERE = os.path.dirname(os.path.abspath(__file__))
fail = 0

print("=== 対照群(counter が壊れていないか)")
for rel, needle in CONTROLS:
    src = os.path.join(LO, rel)
    if not os.path.exists(src):
        print(f"🔴 {rel}: 元 file が無い({LO} を clone したか?)")
        fail = 1
        continue
    t = open(src, encoding="utf-8").read()
    m = re.search(rf"^{re.escape(needle)}", t, re.M)
    if not m:
        print(f"🔴 {rel}: 対照群の目印が無い(検査が空振り)")
        fail = 1
        continue
    d = depth_at(t, m.start())
    print(f"  {rel}: 深さ {d} {'✅' if d == 0 else '🔴 counter が壊れている'}")
    if d != 0:
        fail = 1

print("=== 本番(ヘルパーが、仕える関数と同じスコープに在るか)")
for env, script, fn, pairs in SPECS:
    work = f"/tmp/scope-chk-{fn}"
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    for mod in ("vcl", "sfx2"):
        s_ = os.path.join(LO, mod)
        if os.path.isdir(s_):
            shutil.copytree(s_, os.path.join(work, mod))
    r = subprocess.run(
        ["python3", os.path.join(HERE, script), work],
        env={**os.environ, env: "1"},
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        print(f"🔴 {script}: 当たらなかった\n{r.stderr}")
        fail = 1
        continue
    for rel, func in pairs:
        orig = open(os.path.join(LO, rel), encoding="utf-8").read()
        m = re.search(rf"^{re.escape(func)}", orig, re.M)
        if not m:
            print(f"🔴 {script}: {rel} の目印 `{func}` が元 file に無い(検査が空振り)")
            fail = 1
            continue
        want = depth_at(orig, m.start())
        t = open(os.path.join(work, rel), encoding="utf-8").read()
        idx = t.find(f"namespace\n{{\nvoid {fn}(")
        if idx == -1:
            print(f"🔴 {script}: {rel} にヘルパーが入っていない(検査が空振り)")
            fail = 1
            continue
        # 🔴 **重複定義も見る**(2026-08-24 に踏んだ)── 1 稿目は `t.find()` で
        #    **最初の 1 件**しか見ておらず、ヘルパーが 2 回入っていても素通りした
        #    (文字列手術で組み立てたため実際に 2 回入り、**再定義エラー**になっていた)。
        n_def = len(re.findall(rf"^void {fn}\(", t, re.M))
        if n_def != 1:
            print(f"  🔴 {script}: {rel} ヘルパーの定義が {n_def} 件(1 でなければ再定義)")
            fail = 1
        got = depth_at(t, idx)
        ok = got == want
        print(
            f"  {script}: {rel} ヘルパー 深さ {got} / `{func}` 深さ {want} "
            f"{'✅ 同じスコープ' if ok else '🔴 スコープが違う(コンパイル不能)'}"
        )
        if not ok:
            fail = 1

print(f"=== fail={fail}")
sys.exit(fail)
