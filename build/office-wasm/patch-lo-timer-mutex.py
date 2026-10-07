#!/usr/bin/env python3
"""Qt の timer が発火したとき、SolarMutex を**待たずに取りに行き**、LO 側が持っていれば 1 ms 後に張り直す(#1393 / #1396 / #117 の原因側の直し)。

## 症状(user の身に起きること)

Impress / Calc を開く・閉じる・操作する最中に、まれに「Office が停止しました」(`null function or function signature mismatch` /
`memory access out of bounds`)になる。stack の最上段はどれも別々で、同じ原因の顔違いに見える:
解放済みの ToolBox の Idle が `UpdateMinPeriod` で呼ばれる(#1393)/ 破棄中の `InterimItemWindow::Layout`(#1393)/
スライド一覧を dispose した後のツールチップの timer(#1393 形 B)/ #1396 / #117。
stack と実測は PKC3 の issue #1393 のコメントに在る。

## 🔑 読んでいること(🟡 推測。実機では未確認)── scheduler の走査と選択が、SolarMutex なしで走っている

`vcl/qt5/QtTimer.cxx`(上流 `d6226c1a`)の `QtTimer::timeoutActivated()` は、JSPI かつ PROXY_TO_PTHREAD でない wasm では
**SolarMutex を取らない**。上流自身がそう書いている(前処理の条件と TODO。原文の 45-51 行):

    #if !(defined __EMSCRIPTEN__ && ENABLE_QT6 && HAVE_EMSCRIPTEN_JSPI                                 \\
          && !HAVE_EMSCRIPTEN_PROXY_TO_PTHREAD)
        //TODO: While the special Emscripten Qt6 JSPI/non-PROXY_TO_PTHREAD mode doesn't lock the
        // SolarMutex here, but only when calling pTask->Invoke() in Scheduler::CallbackTaskScheduling,
        // that looks too brittle in general, so treat that special mode specially here.
        SolarMutexGuard aGuard;
    #endif

つまり PKC3 の構成(`#if` が偽 = `SolarMutexGuard` の行が**ない**側)では、main スレッド上の
`Scheduler::CallbackTaskScheduling` が task の一覧を走査し、`UpdateMinPeriod()` を呼び、`pTask` を選ぶ所まで
**mutex なしで**進み、`pTask->Invoke()` の周りでだけ mutex を取る(`scheduler.cxx` の 407-417 / 522-533 / 611 付近)。
その間、LO のスレッドは mutex を持って窓を dispose し、Task を delete する。
走査と選択の最中に消された Task / 窓を触れば、上の停止の顔になる。

## 直し(足すだけ。原文の行は 1 行も書き換えない)

① include 2 行(`<comphelper/solarmutex.hxx>` と `<cstdio>`)。
② `timeoutActivated()` の `#endif` の直前に `#else` を足し(= 上の `#if` が**偽**の側にだけ入る)、
   その先頭で mutex を**待たずに**試す:

| 状態 | することと理由 |
|---|---|
| `IsCurrentThread()` が真(main が既に持っている) | 何もせず今まで通り走る。⚠ `QtYieldMutex` の「借りている」状態では真になるので、**最初に**見る |
| `tryToAcquire()` が偽(LO のスレッドが持っている) | `m_aTimer.start(1)` で 1 ms 後に張り直して**返る**(待たない ── 待つと main が固まる) |
| `tryToAcquire()` が真 | 取れたので走る。関数を出るとき RAII(`Pkc3Held` の dtor)で `release()` する |

- 印(`PKC3-TIMERMUTEX: skipped …` / `ran under mutex`)は **20 回まで**(`nPkc3Skipped` / `nPkc3Ran`。⚠ 上限は**印だけ**)。
- 🟡 `SolarMutex::tryToAcquire` は `comphelper::SolarMutex` の virtual(`QtYieldMutex` は上書きしない。`solarmutex.cxx:87-97`)、
  `release()` は public、`m_aTimer` は `QtTimer` の QTimer の member、と宣言と原文を読んで確かめただけ。

## ⚠ 言えないこと(正直に)

- 🔴 **塞ぐのは「走査と選択 → `Invoke`」の窓だけ**である。LO のスレッド自身が mutex を**手放す**所
  (`EmscriptenLightweightRunInMainThread` / `QtInstance.cxx` の `DoYield` の枝 B)で main の timer が割り込む窓は塞がない。
- 次の焼きの印の回数で、どちらが主因かが分かる: `PKC3-TASKGONE` / `PKC3-LAYOUTGUARD` / `PKC3-TOOLTIPGUARD` / `PKC3-VIEWDATAGONE` が
  **0 に近づく** → 原因は走査から `Invoke` の間だった(この直しが効いた)/ **減らない** → LO のスレッド自身が手放す所が残っている。
  `PKC3-TIMERMUTEX: skipped` が 1 回も出ないなら、この直しは**1 度も効く場面に入っていない**。
- ⚠ **この箱では compile できない**。名前と型は宣言を読んだだけ。

## ⚠ 作法(錨と印は `patch-lo-tooltip-guard.py` と同じ)

- **毎回当たる直し**(入力で gate しない)。錨が**ちょうど 1 件**在ることを書く前に確かめる。1 つでも外れたら何も書かない。
- 印の行数が期待どおり(= 当て済み)なら **SKIP して exit 0**(file は触らない)。印が在るのに行数が違う
  (部分適用 / 手編集)は **exit 1** ── 直しなしで焼かない。
- **足した行は全部 `PKC3-TIMERMUTEX` を含む**。原文の行は 1 行も書き換えない(足すだけ)。
"""

import sys
from pathlib import Path

SRC = "vcl/qt5/QtTimer.cxx"
MARK = "PKC3-TIMERMUTEX"

# ── ① include(`SolarMutex` の型と `std::fputs`)────────────────────────────────────
INC_ANCHOR = """#include <svdata.hxx>

#include <vcl/svapp.hxx>
"""
INC_REPLACE = """#include <svdata.hxx>

#include <vcl/svapp.hxx>
#include <comphelper/solarmutex.hxx> // PKC3-TIMERMUTEX
#include <cstdio> // PKC3-TIMERMUTEX
"""

# ── ② `QtTimer::timeoutActivated()` の `#else`(JSPI の枝 = `SolarMutexGuard` の行が無い側)────
# 🔑 錨は 3 行。原文に**1 件**。`#else` は直前の `#if !(defined __EMSCRIPTEN__ …` に対応する。
GATE_ANCHOR = """    SolarMutexGuard aGuard;
#endif
    if (Application::IsUseSystemEventLoop())
"""
GATE_REPLACE = """    SolarMutexGuard aGuard;
#else // PKC3-TIMERMUTEX
    // PKC3-TIMERMUTEX: this build runs scheduler selection without the SolarMutex, so a task can be
    // PKC3-TIMERMUTEX: stopped/destroyed between selection and Invoke. Try (never wait) for the mutex
    // PKC3-TIMERMUTEX: here; if the LO thread holds it, retry in 1 ms. Skip when main already owns it
    // PKC3-TIMERMUTEX: (QtYieldMutex borrowed state: IsCurrentThread() is true there).
    struct Pkc3Held // PKC3-TIMERMUTEX
    { // PKC3-TIMERMUTEX
        comphelper::SolarMutex* m_pMutex = nullptr; // PKC3-TIMERMUTEX
        ~Pkc3Held() // PKC3-TIMERMUTEX
        { // PKC3-TIMERMUTEX
            if (m_pMutex) // PKC3-TIMERMUTEX
                m_pMutex->release(); // PKC3-TIMERMUTEX
        } // PKC3-TIMERMUTEX
    } aPkc3Held; // PKC3-TIMERMUTEX
    comphelper::SolarMutex* const pPkc3Mutex = comphelper::SolarMutex::get(); // PKC3-TIMERMUTEX
    static int nPkc3Skipped = 0; // PKC3-TIMERMUTEX
    static int nPkc3Ran = 0; // PKC3-TIMERMUTEX
    if (pPkc3Mutex && !pPkc3Mutex->IsCurrentThread()) // PKC3-TIMERMUTEX
    { // PKC3-TIMERMUTEX
        if (!pPkc3Mutex->tryToAcquire()) // PKC3-TIMERMUTEX
        { // PKC3-TIMERMUTEX
            if (nPkc3Skipped++ < 20) // PKC3-TIMERMUTEX
                std::fputs("PKC3-TIMERMUTEX: skipped (LO thread holds SolarMutex)\\n", stderr); // PKC3-TIMERMUTEX
            m_aTimer.start(1); // PKC3-TIMERMUTEX
            return; // PKC3-TIMERMUTEX
        } // PKC3-TIMERMUTEX
        aPkc3Held.m_pMutex = pPkc3Mutex; // PKC3-TIMERMUTEX
        if (nPkc3Ran++ < 20) // PKC3-TIMERMUTEX
            std::fputs("PKC3-TIMERMUTEX: ran under mutex\\n", stderr); // PKC3-TIMERMUTEX
    } // PKC3-TIMERMUTEX
#endif
    if (Application::IsUseSystemEventLoop())
"""

PARTS = (
    (INC_ANCHOR, INC_REPLACE),
    (GATE_ANCHOR, GATE_REPLACE),
)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-timer-mutex.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")

    # 足す行は**全部**印を含む(印の無い足し行は、後で「原文」と見分けられない)
    n_expected = 0
    for anchor, replace in PARTS:
        added = _added_lines(anchor, replace)
        bare = [ln for ln in added if MARK not in ln]
        if bare:
            print(f"ERROR: 印の無い足し行が在る(この patch の書き方の誤り): {bare}", file=sys.stderr)
            return 1
        n_expected += len(added)

    # 🔑 先に「もう当たっていないか」を見る。file は触らない。
    # ⚠ 「印が在る」だけでは SKIP しない ── 印の行数が期待どおりのときだけ当て済みと読む。
    #    印が在るのに行数が違う(部分適用 / 手で直した)file は、直しなしで焼かないために exit 1。
    if MARK in text:
        n_have = sum(1 for line in text.splitlines() if MARK in line)
        if n_have == n_expected:
            print(f"SKIP: 既に当たっている({SRC}、印 {n_have} 行)")
            return 0
        print(
            f"ERROR: 印が {n_have} 行だけ在る(期待 {n_expected})── 部分適用か手編集。{SRC} を上流の形に戻してから当て直す",
            file=sys.stderr,
        )
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

    for anchor, replace in PARTS:
        text = text.replace(anchor, replace, 1)

    # ⚠ 置換が本当に効いたか(空振りを合格と読まない)
    if text.count("#else // PKC3-TIMERMUTEX") != 1 or text.count("tryToAcquire()") != 1:
        print("ERROR: 門が 1 つ入っていない", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if MARK in line)
    if (
        n_marks != n_expected
        or after.count("#else // PKC3-TIMERMUTEX") != 1
        or after.count("tryToAcquire()") != 1
    ):
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 行(期待 {n_expected})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(timer の SolarMutex 試行 / #1393 #1396 #117 ── 足した行 {n_marks})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
