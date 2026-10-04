#!/usr/bin/env python3
"""#121 の**計装**。Writer の右クリック popup で「コピー」を選んでも、LO の中で `.uno:Copy` が実行されない理由を割る。

🔴 **これは直しではない。** 挙動は 1 つも変えない(戻り値を変数で受ける 3 行の置換だけが原文の字面を動かすが、
値は同じ)。⚠ **既定では 1 バイトも書き換えない**(`PKC3_MENU_TRACE=1` の回だけ)が、
錨の検査は毎回する ── 門の下に隠すと上流の変形に誰も気づけない(`patch-lo-clip-trace.py` と同じ作法)。

## 読んで分かっていること(上流原文 sha 0c031979)

- `QtMenu::ShowNativePopupMenu`: `DoFullMenuUpdate` → `mpQMenu->exec(...)` → `return true`
  (戻り値は捨てる。⚠ 他の QMenu 操作は `RunInMainThread` で包まれているのに、ここは包まれていない)
- `QtMenu::slotMenuTriggered`: `QAction::triggered` から呼ばれ、
  `pTopLevel->GetMenu()->HandleMenuCommandEvent(pMenu, mnId)`
- `Menu::HandleMenuCommandEvent` → `Menu::ImplSelect` → **`nEventId = Application::PostUserEvent(...)`**
  (選択は user event で**後送り**)/ `ImplCallSelect` → `Select()`
- `PopupMenu::ImplFlushPendingSelect`(「Select should be called prior to leaving execute in a popup menu!」):
  `ImplFindSelectMenu()` で `nEventId` が立っていれば同期に `Select()`、**立っていなければ何もしない**
- `PopupMenu::Run`: `ShowNativePopupMenu` が true なら**即 return** → `FinishRun` → `ImplFlushPendingSelect`
- JSPI 構成では LO の user event は `eventHandlerThread` で走り、Qt のオブジェクトは main thread に居る

## 🔑 仮説(この計装で確かめる ── ⚠ まだ事実ではない)

`exec()` の中で項目を選んでも、`triggered` → `slotMenuTriggered` が **exec が戻った後**
(別 thread への queued connection か、JSPI の再開順)に届く。すると `FinishRun` →
`ImplFlushPendingSelect` の時点で `nEventId` が無く、Select が呼ばれない。その後 Writer が popup を
dispose してから遅れて `HandleMenuCommandEvent` が走り、命令は捨てられる(→ 実行されない)。

## 読み方(⚠ 対照群と一緒に)

    PKC3-MENU <where> a=<this など> b=<pthread_self> c=<where ごと> d=<where ごと>

| where | a | c | d |
|---|---|---|---|
| `show:enter` | this | IsMainThread | 0 |
| `exec:enter` / `exec:return` | this | IsMainThread | 0 / **選ばれた QAction が null でないか** |
| `slot:enter` | `mpParentMenu` | IsMainThread | `mnId` |
| `slot:handled` | `pMenu` | `HandleMenuCommandEvent` の戻り値 | `mnId` |
| `select:post` | this | **`nEventId` が立ったか**(PostUserEvent の直後) | `nSelectedId` |
| `select:call` | this | `ImplCallSelect` 入口で `nEventId` が立っていたか | 0 |
| `flush:check` | this(popup) | **`pSelect` が null でないか**(= 同期の Select を呼ぶか) | 0 |
| `popup:dtor` | this | 0 | 0 |
| `run:native` | `pMenu` | 1 | 0 |

🔑 **見るのは順番と thread である**:`exec:return` が `slot:enter` より**先**なら、仮説のとおり
選択は exec の後に届いている。`flush:check` の `c=0` で `select:post` が**その後**に出るなら、
Select は同期に呼ばれていない。

⚠ **対照群は「上のメニューバーから『コピー』を選ぶ」**(こちらは popup でなく、`exec` を通らない)
── `slot:enter` が出て `select:call` まで届く回の並びを、popup の回と比べる。
対照群が出ない回は計装が効いていないので、**その回の結果は 1 つも読まない**。

## 出口は libc だけ

stderr + `/tmp/pkc3-menu.log`。embind / DOM / Qt の API をここから呼ばない
(LO の文脈から `emscripten::val` を触ると `invalid handle` で abort する ── 2026-08-15)。
`IsMainThread()` は**呼ぶ側**で評価して整数で渡す(helper は Qt の型を知らない)。
"""

import os
import sys
from pathlib import Path

MARK = "// PKC3-MENU"

# ⚠ libc だけを使う。**部品から組む**(`str.replace` で版を作ると、同じ形が複数在るので
#   全部に当たって再定義になる ── `patch-lo-save-trace.py` で 2026-08-24 に踏んだ)。
# ⚠ `check-patch-scope.py` が `namespace\n{\nvoid pkc3_menu_trace(` の形を探す ── **入口の関数を最初に**置く。
# ⚠ `check-trace-helpers-compile.py` が `pkc3_menu_trace("t:probe", 1, 2, 3)` で呼ぶ
#   (3 つの整数 → `a` / `c` / `d`)。pointer は `pkc3_menu_ptr()` で整数へ落として渡す。
# ⚠ `#include <pthread.h>` は**無条件**に置く(`pthread_t` が整数 / pointer のどちらでも通ることを、
#   手元の検査が当てられるように。`ifdef` の下に隠すと、その検査が 1 度も `pthread_self` を通らない)。
HELPER = """// PKC3-MENU-HELPER-BEGIN
// ── PKC3 #121 の計装(挙動は変えない。`PKC3_MENU_TRACE=1` の回だけ入る)──
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <pthread.h>
namespace
{
void pkc3_menu_trace(const char* what, unsigned long long a, int c, int d)
{
    static int nSeq = 0;
    // ⚠ 上限を置く ── メニューは何度も開くので、置かないと log が膨らむ
    if (__atomic_add_fetch(&nSeq, 1, __ATOMIC_RELAXED) > 600)
        return;
    // pthread_t is an integer on emscripten and a pointer elsewhere: copy the bytes, never cast.
    unsigned long long nTid = 0;
    pthread_t aSelf = pthread_self();
    std::memcpy(&nTid, &aSelf, sizeof aSelf < sizeof nTid ? sizeof aSelf : sizeof nTid);
    char line[192];
    // ⚠ 書式はリテラル(`-Wformat-nonliteral` を踏まない)
    std::snprintf(line, sizeof line, "PKC3-MENU %s a=%p b=%llu c=%d d=%d\\n", what,
                  reinterpret_cast<void*>(static_cast<std::uintptr_t>(a)), nTid, c, d);
    std::fputs(line, stderr);
    std::fflush(stderr);
    std::FILE* pLog = std::fopen("/tmp/pkc3-menu.log", "a");
    if (pLog)
    {
        std::fputs(line, pLog);
        std::fclose(pLog);
    }
}

// pointer を整数へ(`%p` で出すため)。⚠ 使わない TU もある(`pkc3_menu_native` は menu.cxx だけ)
[[maybe_unused]] unsigned long long pkc3_menu_ptr(const void* p)
{
    return static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(p));
}

// `ShowNativePopupMenu` が true を返した事実を残し、**値はそのまま返す**。
[[maybe_unused]] bool pkc3_menu_native(const void* pMenu, bool bNative)
{
    if (bNative)
        pkc3_menu_trace("run:native", pkc3_menu_ptr(pMenu), 1, 0);
    return bNative;
}
}
// PKC3-MENU-HELPER-END
"""

# ── ① vcl/qt5/QtMenu.cxx ────────────────────────────────────────────────────
QM_SRC = "vcl/qt5/QtMenu.cxx"
# ヘルパーは `slotMenuTriggered` の直前(file scope)。使う所はどれもその後ろ(`ShowNativePopupMenu` は更に後ろ)。
QM_HELPER_ANCHOR = "void QtMenu::slotMenuTriggered(QtMenuItem* pQItem)\n"

# 入口(`assert(mpQMenu);` の直後)。
SHOW_ANCHOR = """    assert(mpQMenu);
"""
SHOW_REPLACE = f"""    assert(mpQMenu);
    pkc3_menu_trace("show:enter", pkc3_menu_ptr(this), GetQtInstance().IsMainThread() ? 1 : 0, 0); {MARK}
"""

# `exec()` の前後。⚠ 戻り値(選ばれた QAction)を受けるため、**この 1 行だけ原文の字面を置き換える**
# (値は同じ ── 受けて捨てるだけ)。
EXEC_ANCHOR = """    mpQMenu->exec(aRect.bottomLeft());
"""
EXEC_REPLACE = f"""    pkc3_menu_trace("exec:enter", pkc3_menu_ptr(this), GetQtInstance().IsMainThread() ? 1 : 0, 0); {MARK}
    QAction* const pPkc3Chosen = mpQMenu->exec(aRect.bottomLeft()); {MARK}
    pkc3_menu_trace("exec:return", pkc3_menu_ptr(this), GetQtInstance().IsMainThread() ? 1 : 0, {MARK}
                    pPkc3Chosen ? 1 : 0); {MARK}
"""

# `triggered` の lambda から呼ばれる入口(`if (!pQItem) return;` の直後)。
# ⚠ `if (!pQItem)` だけでは他の slot にも在るので、**直後の行まで含めて**一意にする。
SLOT_ANCHOR = """    if (!pQItem)
        return;

    QtMenu* pSalMenu = pQItem->mpParentMenu;
"""
SLOT_REPLACE = f"""    if (!pQItem)
        return;
    pkc3_menu_trace("slot:enter", pkc3_menu_ptr(pQItem->mpParentMenu), {MARK}
                    GetQtInstance().IsMainThread() ? 1 : 0, static_cast<int>(pQItem->mnId)); {MARK}

    QtMenu* pSalMenu = pQItem->mpParentMenu;
"""

# ⚠ 戻り値を受けるため、この 1 行も置き換える。
HANDLE_ANCHOR = """    pTopLevel->GetMenu()->HandleMenuCommandEvent(pMenu, mnId);
"""
HANDLE_REPLACE = f"""    const bool bPkc3Handled = pTopLevel->GetMenu()->HandleMenuCommandEvent(pMenu, mnId); {MARK}
    pkc3_menu_trace("slot:handled", pkc3_menu_ptr(pMenu), bPkc3Handled ? 1 : 0, {MARK}
                    static_cast<int>(mnId)); {MARK}
"""

# ── ② vcl/source/window/menu.cxx ────────────────────────────────────────────
MN_SRC = "vcl/source/window/menu.cxx"
# ヘルパーは `Menu::Menu()` の直前(file scope)。使う所はどれもその後ろ。
MN_HELPER_ANCHOR = "Menu::Menu()\n"

# 選択を後送りにした直後。
POST_ANCHOR = """    nEventId = Application::PostUserEvent( LINK( this, Menu, ImplCallSelect ) );
"""
POST_REPLACE = f"""    nEventId = Application::PostUserEvent( LINK( this, Menu, ImplCallSelect ) );
    pkc3_menu_trace("select:post", pkc3_menu_ptr(this), nEventId ? 1 : 0, static_cast<int>(nSelectedId)); {MARK}
"""

CALL_ANCHOR = """IMPL_LINK_NOARG(Menu, ImplCallSelect, void*, void)
{
"""
CALL_REPLACE = f"""IMPL_LINK_NOARG(Menu, ImplCallSelect, void*, void)
{{
    pkc3_menu_trace("select:call", pkc3_menu_ptr(this), nEventId ? 1 : 0, 0); {MARK}
"""

# 🔴 決め手: popup を出ていく直前、積まれた Select が見えているか。
FLUSH_ANCHOR = """    Menu* pSelect = ImplFindSelectMenu();
"""
FLUSH_REPLACE = f"""    Menu* pSelect = ImplFindSelectMenu();
    pkc3_menu_trace("flush:check", pkc3_menu_ptr(this), pSelect ? 1 : 0, 0); {MARK}
"""

# ⚠ `this` の値だけ出す(破棄の最中なので、メンバは読まない)。
DTOR_ANCHOR = """PopupMenu::~PopupMenu()
{
"""
DTOR_REPLACE = f"""PopupMenu::~PopupMenu()
{{
    pkc3_menu_trace("popup:dtor", pkc3_menu_ptr(this), 0, 0); {MARK}
"""

# native の popup が true を返した直後。⚠ **この 1 行を置き換える**(条件に `pkc3_menu_native` を挟む。値は同じ)。
RUN_ANCHOR = """    if (pMenu && bRealExecute && pMenu->ShowNativePopupMenu(pWin, rRect, nPopupModeFlags))
"""
RUN_REPLACE = (
    "    if (pMenu && bRealExecute && pkc3_menu_native(pMenu, "
    f"pMenu->ShowNativePopupMenu(pWin, rRect, nPopupModeFlags))) {MARK}\n"
)

# 🔑 置換行(原文の字面が動く 3 + 1 行)は、**行末が印**で、**除くと原文へ戻る形**にする ──
# test が「戻すと原文一致」を見る(`tests/office-menu-trace-patch.test.ts`)。
HELPER_TARGETS = (
    (QM_SRC, QM_HELPER_ANCHOR, HELPER),
    (MN_SRC, MN_HELPER_ANCHOR, HELPER),
)
TARGETS = (
    (QM_SRC, SHOW_ANCHOR, SHOW_REPLACE),
    (QM_SRC, EXEC_ANCHOR, EXEC_REPLACE),
    (QM_SRC, SLOT_ANCHOR, SLOT_REPLACE),
    (QM_SRC, HANDLE_ANCHOR, HANDLE_REPLACE),
    (MN_SRC, POST_ANCHOR, POST_REPLACE),
    (MN_SRC, CALL_ANCHOR, CALL_REPLACE),
    (MN_SRC, FLUSH_ANCHOR, FLUSH_REPLACE),
    (MN_SRC, DTOR_ANCHOR, DTOR_REPLACE),
    (MN_SRC, RUN_ANCHOR, RUN_REPLACE),
)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-menu-trace.py <lo-core-dir>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    on = os.environ.get("PKC3_MENU_TRACE") == "1"

    # ⚠ **錨の検査は門の外でやる**(門の下に隠すと上流の変形に誰も気づけない)。
    # ⚠ 同じ file を複数回触るので、読み込みは 1 度にして in-memory で順に当てる。
    texts: dict[str, str] = {}
    for src in (QM_SRC, MN_SRC):
        path = root / src
        if not path.exists():
            print(f"ERROR: {src} が無い({path})", file=sys.stderr)
            return 1
        texts[src] = path.read_text(encoding="utf-8")
        # ⚠ 二重当ては止める(冪等ではない ── ヘルパーが 2 つ入る)。file は触らない。
        if "pkc3_menu_trace" in texts[src]:
            print(f"ERROR: {src} に既に計装が入っている(二重当て)", file=sys.stderr)
            return 1

    # ⚠ ヘルパーの当て先も**同じ厳しさ**で見る(外れると「呼ぶ側だけ在る」= リンク不能)
    for src, anchor, _h in HELPER_TARGETS:
        hits = texts[src].count(anchor)
        if hits != 1:
            print(f"ERROR: ヘルパーの錨が {hits} 件({src})── 上流が形を変えた", file=sys.stderr)
            return 1
    for src, anchor, _replace in TARGETS:
        hits = texts[src].count(anchor)
        if hits != 1:
            print(
                f"ERROR: 錨が {hits} 件({src})── 上流が形を変えた。計装の当て先を読み直すこと:\n"
                f"{anchor[:120]}",
                file=sys.stderr,
            )
            return 1

    if not on:
        print(
            f"skip: PKC3_MENU_TRACE!=1(錨 {len(TARGETS)} 件 + ヘルパー {len(HELPER_TARGETS)} 件を確かめた)"
        )
        return 0

    # ⚠ **ヘルパーを先に**(本体の置換より前)── 「呼ぶ側だけ在る」中間状態を作らない
    for src, anchor, helper in HELPER_TARGETS:
        texts[src] = texts[src].replace(anchor, helper + "\n" + anchor, 1)
    for src, anchor, replace in TARGETS:
        texts[src] = texts[src].replace(anchor, replace, 1)
    for src, text in texts.items():
        path = root / src
        path.write_text(text, encoding="utf-8")
        # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
        if "pkc3_menu_trace" not in path.read_text(encoding="utf-8"):
            print(f"ERROR: 書き戻し後の {src} に計装が無い(write が落ちている)", file=sys.stderr)
            return 1
        print(f"patched: {src}(#121 の計装)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
