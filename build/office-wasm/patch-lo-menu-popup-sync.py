#!/usr/bin/env python3
"""Writer の右クリック popup から「コピー」を選んでも `.uno:Copy` が実行されない件(#121)の**直し**。

## 症状

Writer の右クリックメニュー(popup)で「コピー」を選んでも、clipboard に何も入らない。
Ctrl+C(キー入力の callback の中で**同期に** `.uno:Copy` を dispatch する経路)は成功する。

## 🔑 原因 ── popup の命令だけが「後回し」にされ、その後回しが走らない

計装(`patch-lo-menu-trace.py` の焼き run 37222907850)で割れた事実(推測ではない):

1. popup でも `QAction::triggered` → `QtMenu::slotMenuTriggered` → `Menu::HandleMenuCommandEvent`
   → `ImplSelect`(PostUserEvent)は `QMenu::exec` の**中**で届き、`PopupMenu::FinishRun` →
   `ImplFlushPendingSelect` が同期に `Select()` を呼ぶところまで**正常**。
2. その `Select()` の先、`framework::MenuBarManager::Select`
   (`framework/source/uielement/menubarmanager.cxx`)が
   `Application::PostUserEvent(LINK_NONMEMBER(nullptr, AsyncMenuExecute), …)` で命令を**後回し**にする。
3. menubar 経由ではこの user event が 7 ms 後に走って `.uno:Copy` が実行される。
   ところが popup(入れ子の `QMenu::exec` の後)では **10 秒間走らず**、走った回は
   `libc++abi: terminating`(型名の無い = JS 例外。JSPI の `emscripten_promise_await` が
   中断できない stack から呼ばれた形)で落ちる。

## 直し(最小。Emscripten の popup だけ)

popup(`!m_bHasMenuBar`)の命令だけ後回しにせず、その場で dispatch する(Ctrl+C と同じ形)。
menubar 側は `PostUserEvent` のまま **1 行も触らない**。

- `try / catch` は `css::uno::Exception` だけ。dispatch が投げても menu の後始末
  (`m_bActive = false`)へ戻れるようにする(UNO の例外を C++ の外へ漏らさない)。
- `std::fputs` は「直しが効いた回数」を probe が数えるための印でもある(libc だけを使う)。
- 🔴 触らない: menubar の経路 / `AsyncMenuExecute` / 錠の取り方(`SolarMutexGuard` のブロック)/
  `m_bActive = false` の分岐。

## ⚠ 作法(`patch-lo-scheduler-task-gone.py` と同じ)

- **毎回当たる直し**(入力で gate しない)。錨が**ちょうど 1 件**在ることを確かめてから当てる。
- 当てた後に印が在ることを確かめる / 二重当ては exit 1 で **file は 1 バイトも変わらない**。
- **足した行は全部 `PKC3-POPUPSYNC` を含む**(`#if` / `#endif` / 括弧 / 注釈の続きの行も)。
  原文の行は 1 行も書き換えない(足すだけ)ので、印の行を全部除くと原文と一致する(test が見る)。
- ⚠ 直しの C++ は Qt / LO の header が無い箱ではコンパイルできない ── **焼いて**、popup の「コピー」が
  `PKC3-POPUPSYNC: popup command dispatched synchronously` を出して clipboard へ届くまで確かめる。
"""

import sys
from pathlib import Path

SRC = "framework/source/uielement/menubarmanager.cxx"
MARK = "PKC3-POPUPSYNC"

# ── ① include(`std::fputs`)────────────────────────────────────────────
INC_ANCHOR = """#include <uielement/menubarmanager.hxx>
"""
INC_REPLACE = """#include <uielement/menubarmanager.hxx>
#include <cstdio> // PKC3-POPUPSYNC
"""

# ── ② `Select` の末尾: popup の命令をその場で dispatch する ──────────────────
# 🔑 錨は 4 字下げの `if (pData->xDispatch.is())` の塊(4 行)。原文に**1 件**。
#    ⚠ 足す行は**全部**印を含む(`#if` / `#endif` / `{` / `}` / 注釈の続きの行も)。
#    原文の行(`if` / `{` / `Application::PostUserEvent(…)` / `}`)は 1 字も変えない。
DISPATCH_ANCHOR = """    if (pData->xDispatch.is())
    {
        Application::PostUserEvent(LINK_NONMEMBER(nullptr, AsyncMenuExecute), pData.release());
    }
"""
DISPATCH_REPLACE = """    if (pData->xDispatch.is())
    {
#if defined __EMSCRIPTEN__ // PKC3-POPUPSYNC
        // PKC3-POPUPSYNC(#121): a popup's command used to be deferred with PostUserEvent,
        // PKC3-POPUPSYNC but after a nested QMenu::exec on wasm/JSPI that user event does not run for seconds
        // PKC3-POPUPSYNC and, when it finally runs from a non-suspendable stack, terminates the process.
        // PKC3-POPUPSYNC Ctrl+C dispatches the same command synchronously from an input callback and works,
        // PKC3-POPUPSYNC so do the same for popups here. The menubar keeps the deferred path.
        if (!m_bHasMenuBar) // PKC3-POPUPSYNC
        { // PKC3-POPUPSYNC
            std::fputs("PKC3-POPUPSYNC: popup command dispatched synchronously\\n", stderr); // PKC3-POPUPSYNC
            try // PKC3-POPUPSYNC
            { // PKC3-POPUPSYNC
                pData->xDispatch->dispatch(pData->aTargetURL, comphelper::containerToSequence(pData->aArgs)); // PKC3-POPUPSYNC
            } // PKC3-POPUPSYNC
            catch (const css::uno::Exception&) // PKC3-POPUPSYNC
            { // PKC3-POPUPSYNC
                std::fputs("PKC3-POPUPSYNC: dispatch threw; swallowed\\n", stderr); // PKC3-POPUPSYNC
            } // PKC3-POPUPSYNC
        } // PKC3-POPUPSYNC
        else // PKC3-POPUPSYNC
#endif // PKC3-POPUPSYNC
        Application::PostUserEvent(LINK_NONMEMBER(nullptr, AsyncMenuExecute), pData.release());
    }
"""

PARTS = (
    (INC_ANCHOR, INC_REPLACE),
    (DISPATCH_ANCHOR, DISPATCH_REPLACE),
)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-menu-popup-sync.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")

    # ⚠ 二重当ては止める(冪等ではない ── 行が 2 組入る)。file は触らない。
    if MARK in text:
        print(f"ERROR: {SRC} に既に {MARK} が入っている(二重当て)", file=sys.stderr)
        return 1

    # ⚠ 錨は全部**ちょうど 1 件**。1 つでも外れたら何も書かない(「半分だけ当たる」を作らない)。
    for anchor, _replace in PARTS:
        hits = text.count(anchor)
        if hits != 1:
            print(
                f"ERROR: 錨が {hits} 件({SRC})。上流が形を変えた可能性がある:\n{anchor[:160]}...",
                file=sys.stderr,
            )
            return 1

    # 足す行は**全部**印を含む(印の無い足し行は、後で「原文」と見分けられない)
    n_expected = 0
    for anchor, replace in PARTS:
        added = _added_lines(anchor, replace)
        bare = [ln for ln in added if MARK not in ln]
        if bare:
            print(f"ERROR: 印の無い足し行が在る(この patch の書き方の誤り): {bare}", file=sys.stderr)
            return 1
        n_expected += len(added)

    n_post_before = text.count("Application::PostUserEvent(LINK_NONMEMBER(nullptr, AsyncMenuExecute)")
    for anchor, replace in PARTS:
        text = text.replace(anchor, replace, 1)

    # ⚠ 置換が本当に効いたか(空振りを合格と読まない)
    if text.count("if (!m_bHasMenuBar) // PKC3-POPUPSYNC") != 1:
        print("ERROR: popup の分岐が 1 つ入っていない", file=sys.stderr)
        return 1
    # 🔴 menubar の経路(後回し)は消えていない ── 足しただけで、PostUserEvent は 1 行も減らない
    if text.count("Application::PostUserEvent(LINK_NONMEMBER(nullptr, AsyncMenuExecute)") != n_post_before:
        print("ERROR: menubar 側の PostUserEvent が減っている(足すだけの直しのはず)", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if MARK in line)
    if n_marks != n_expected or "popup command dispatched synchronously" not in after:
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 行(期待 {n_expected})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(popup の命令をその場で dispatch / #121 ── 足した行 {n_marks})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
