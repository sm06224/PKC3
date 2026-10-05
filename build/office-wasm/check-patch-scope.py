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
    PKC3_SCOPE_ONLY=fixes python3 build/office-wasm/check-patch-scope.py <dir>   # FIXES だけ
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile

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
        "PKC3_SCHEDULER_TRACE",
        "patch-lo-scheduler-trace.py",
        "pkc3_sched_trace",
        [
            # 🔴 #117(2026-10-04)── ヘルパーを入れる所は `DropSchedulerData` の直前で、
            #    使う所(`CallbackTaskScheduling` / ctor / dtor)はどれもその後ろ。
            #    ⚠ ここを SPECS に足し忘れると、**この file だけ検査の外**になる。
            (
                "vcl/source/app/scheduler.cxx",
                "static ImplSchedulerData* DropSchedulerData(",
            ),
        ],
    ),
    (
        "PKC3_CLIP_TRACE",
        "patch-lo-clip-trace.py",
        "pkc3_clip_trace",
        [
            # 🔴 #121(2026-10-04)── ヘルパーは `formats()` / `setContents()` の直前で、
            #    使う所(`retrieveData` / `setContents` の中)はどれもその後ろ。
            #    ⚠ ここを SPECS に足し忘れると、**この 2 file だけ検査の外**になる。
            ("vcl/qt5/QtTransferable.cxx", "QStringList QtMimeData::formats() const"),
            ("vcl/qt5/QtClipboard.cxx", "void QtClipboard::setContents("),
        ],
    ),
    (
        "PKC3_MENU_TRACE",
        "patch-lo-menu-trace.py",
        "pkc3_menu_trace",
        [
            # 🔴 #121(2026-10-04)── ヘルパーは `slotMenuTriggered` / `Menu::Menu()` の直前で、
            #    使う所(`ShowNativePopupMenu` / `ImplSelect` / `ImplFlushPendingSelect` / `Run` など)は
            #    どれもその後ろ。⚠ ここを SPECS に足し忘れると、**この 2 file だけ検査の外**になる。
            ("vcl/qt5/QtMenu.cxx", "void QtMenu::slotMenuTriggered("),
            ("vcl/source/window/menu.cxx", "Menu::Menu()"),
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
    (
        "PKC3_UEV_TRACE",
        "patch-lo-uev-trace.py",
        "pkc3_uev_trace",
        [
            # 🔴 #121(2026-10-04)── ヘルパーは `PostUserEvent` / コンストラクタの直前で、
            #    使う所(`PostUserEvent` の中 / `DispatchUserEvents` の中)はどちらもその後ろ。
            #    ⚠ ここを SPECS に足し忘れると、**この 2 file だけ検査の外**になる。
            ("vcl/source/app/svapp.cxx", "ImplSVEvent * Application::PostUserEvent("),
            ("vcl/source/app/salusereventlist.cxx", "SalUserEventList::SalUserEventList()"),
            # 🔴 #1344(2026-10-05)── 判別用の 5 種を足した 2 file。ヘルパーは `CreateSalSystem` /
            #    `ShowNativePopupMenu` の直前で、使う所(`ImplYield` / `DoYield` / `TriggerUserEventProcessing` /
            #    `ShowNativePopupMenu` の中)はどれもその後ろ。⚠ ここを足し忘れると、**この 2 file だけ検査の外**になる。
            ("vcl/qt5/QtInstance.cxx", "SalSystem* QtInstance::CreateSalSystem()"),
            ("vcl/qt5/QtMenu.cxx", "bool QtMenu::ShowNativePopupMenu("),
        ],
    ),
]
# 🔑 #117(2026-10-04)── `PKC3_SCOPE_ONLY=fixes` で、対照群と SPECS を飛ばして**下の FIXES だけ**を走らせる
#    (LO の全体を clone していなくても、`vcl/source/app/scheduler.cxx` 1 つで足りる)。
#    ⚠ 絞るのは**走らせる一覧**だけで、判定は 1 行も変えない(未設定なら従来どおり全部走る)。
#    用途: `tests/office-scheduler-task-gone-patch.test.ts` が抜粋 fixture に対して走らせる。
ONLY = os.environ.get("PKC3_SCOPE_ONLY", "")
if ONLY == "fixes":
    CONTROLS = []
    SPECS = []
elif ONLY:
    print(f"ERROR: PKC3_SCOPE_ONLY={ONLY!r} は未知(使えるのは fixes だけ)", file=sys.stderr)
    sys.exit(2)

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

# 🔴 #117(2026-10-04)── **ヘルパーを持たない直し**(関数の中へ数行を足すだけ)。
#    ⚠ 上の SPECS は「`namespace { void <fn>( ... }` が入ること」を前提にするので、
#    ヘルパーの無い直しは載せられない(載せると「ヘルパーが入っていない」で必ず落ちる)。
#    だから別の一覧にする ── 見るのは「**足した行が、置き換えた原文と同じスコープ**に在ること」
#    (= 関数の外へ漏れていない / `#include` が file scope に在る)。
#    各行: (patch, file, 原文の目印, 当てた後の目印, 何を見るか, 足した `#include` の行)
FIXES = [
    (
        "patch-lo-scheduler-task-gone.py",
        "vcl/source/app/scheduler.cxx",
        # 原文: JSPI の枝の 16 字下げの 2 行(置き換える `pTask->Invoke();` を含む)
        "                SolarMutexGuard g;\n                pTask->Invoke();\n            }\n#else\n",
        "Task* const pLiveTask = pMostUrgent->mpTask;",
        "CallbackTaskScheduling の JSPI の枝",
        "#include <cstdio> // PKC3-TASKGONE",
    ),
    (
        "patch-lo-menu-popup-sync.py",
        "framework/source/uielement/menubarmanager.cxx",
        # 原文: `Select` の末尾で、popup の命令を後回しにしている 1 行(8 字下げ = `if` の `{` の中。
        #       足す `if (!m_bHasMenuBar)` も同じ `{` の中に入る)
        "        Application::PostUserEvent(LINK_NONMEMBER(nullptr, AsyncMenuExecute), pData.release());\n",
        "if (!m_bHasMenuBar) // PKC3-POPUPSYNC",
        "MenuBarManager::Select の popup の分岐",
        "#include <cstdio> // PKC3-POPUPSYNC",
    ),
    # 🔴 #121(2026-10-04)── `patch-lo-ime-nowait.py`。`ImplHandleExtTextInput` の while の中の 1 か所。
    (
        "patch-lo-ime-nowait.py",
        "vcl/source/window/winproc.cxx",
        # 原文: LOK の 5 行 + 待つ `Application::Yield();`(`Yield` は file 内に複数在るので LOK の塊で一意にする。
        #       8 字下げ = while の `{` の中。足す `if (g_nPkc3ImeNoWaitSaid < 20)` も同じ `{` の中に入る)
        '        if (comphelper::LibreOfficeKit::isActive())\n        {\n            SAL_WARN("vcl", "Failed to get ext text input context");\n            break;\n        }\n        Application::Yield();\n',
        "if (g_nPkc3ImeNoWaitSaid < 20) // PKC3-IMENOWAIT",
        "ImplHandleExtTextInput の待ちの分岐",
        "#include <cstdio> // PKC3-IMENOWAIT",
    ),
    # 🔴 #1344(2026-10-05)── `patch-lo-popup-wake.py`。`ShowNativePopupMenu` の `exec` の前に 1 か所
    #    (局所 struct)。⚠ 同じ file を menu-trace / uev-trace も触る(計装は SPECS 側)が、この検査は
    #    **この直し 1 本だけ**を原文へ当てる(足した行が原文と同じスコープに在るか)。
    (
        "patch-lo-popup-wake.py",
        "vcl/qt5/QtMenu.cxx",
        # 原文: `exec` の直前の行(4 字下げ = 関数本体の `{` の中。足す局所 struct も同じ `{` の中に入る)
        "    const QRect aRect = toQRect(aFloatRect, 1 / pFrame->devicePixelRatioF());\n",
        "struct Pkc3PopupWake // PKC3-POPUPWAKE",
        "ShowNativePopupMenu の exec の後始末",
        "#include <cstdio> // PKC3-POPUPWAKE",
    ),
]

print("=== 本番(ヘルパーを持たない直し: 足した行が原文と同じスコープに在るか)")
for script, rel, orig_mark, new_mark, what, inc_line in FIXES:
    src = os.path.join(LO, rel)
    if not os.path.exists(src):
        print(f"🔴 {script}: {rel} の元 file が無い")
        fail = 1
        continue
    orig = open(src, encoding="utf-8").read()
    if orig.count(orig_mark) != 1:
        print(f"🔴 {script}: {rel} の原文の目印が {orig.count(orig_mark)} 件(検査が空振り)")
        fail = 1
        continue
    # 🔑 作業 dir は**毎回別**にする(固定名だと、FIXES を走らせる test 2 本が並列に走ったとき
    #    互いの木を消し合う ── 2 本目の直しを足した日に実際に踏んだ)
    work = tempfile.mkdtemp(prefix=f"scope-chk-fix-{script}-")
    os.makedirs(os.path.dirname(os.path.join(work, rel)))
    shutil.copy(src, os.path.join(work, rel))
    r = subprocess.run(["python3", os.path.join(HERE, script), work], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"🔴 {script}: 当たらなかった\n{r.stderr}")
        fail = 1
        continue
    t = open(os.path.join(work, rel), encoding="utf-8").read()
    shutil.rmtree(work, ignore_errors=True)
    if t.count(new_mark) != 1:
        print(f"🔴 {script}: 当てた後の目印が {t.count(new_mark)} 件(検査が空振り)")
        fail = 1
        continue
    want = depth_at(orig, orig.index(orig_mark))
    got = depth_at(t, t.index(new_mark))
    # `#include` は file scope(深さ 0)に在ること。⚠ depth_at は前処理行を数えないので、
    # 「直前までの深さ」が 0 であることを見る(include を関数の中へ入れる誤りを拾う)
    inc_at = t.find(inc_line)
    inc_depth = depth_at(t, inc_at) if inc_at != -1 else -1
    ok = got == want and want > 0 and inc_depth == 0
    print(
        f"  {script}: {what} 深さ {got} / 原文 {want} / include 深さ {inc_depth} "
        f"{'✅ 同じスコープ' if ok else '🔴 スコープが違う(コンパイル不能)'}"
    )
    if not ok:
        fail = 1

print(f"=== fail={fail}")
sys.exit(fail)
