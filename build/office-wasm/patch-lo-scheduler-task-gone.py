#!/usr/bin/env python3
"""文書を閉じると `null function or function signature mismatch` で止まる件(#117)の**直し**。

## 症状

Office の文書を閉じる(Ctrl+W)と、6 回中 6 回
`RuntimeError: null function or function signature mismatch`。fault の最上段は
`Scheduler::CallbackTaskScheduling()` か `Timer::Invoke()` の 2 種に割れた(3 / 3)。
計装(`patch-lo-scheduler-trace.py`)を 2 回 × 6 走で読んだ事実が下の原因である(推測ではない)。

## 🔑 原因 ── 破棄済みの Task を Invoke している

`vcl/source/app/scheduler.cxx` の `Scheduler::CallbackTaskScheduling()`(JSPI の枝):

    Task *pTask = pMostUrgent->mpTask;     ← 先に読んだ**生ポインタ**
    ...
    SolarMutexGuard g;                     ← ここで JSPI が**中断**しうる
    pTask->Invoke();

- 外側の frame が `InterimItemWindow` の `m_aLayoutIdle` を Invoke する直前の
  `SolarMutexGuard` で中断し、その間に Qt の timer が同じ関数へ再入して別の task を回す
  (77 回。全部 LIFO で正常に出ていく)。
- その間に文書が閉じられ、`InterimItemWindow` ごと `m_aLayoutIdle`(Timer = Task)が破棄される。
  `Task::~Task()` は `mpSchedulerData->mpTask = nullptr` にするが、**外側の局所変数 `pTask` は
  破棄済みの番地を指したまま**である。
- 外側が再開すると `pTask->Invoke()` を**破棄済みのメモリへ**呼ぶ。vtable が壊れていれば
  `CallbackTaskScheduling` の frame で、残っていれば `Timer::Invoke()`(Link の関数ポインタ)で
  `null function or function signature mismatch` になる。

## 直し(最小。JSPI の枝だけ)

`SolarMutexGuard g;` を取った**後**で `pMostUrgent->mpTask` を**読み直し**、null
(= 待っている間に破棄された)なら Invoke しない。

- `pMostUrgent`(`ImplSchedulerData`)はスタックに積まれていて、この関数の後半の pop まで生きている
  (内側の再入は全部 LIFO で出ていくので、外側が再開した時点で生きている ── 観測済み)。
- `std::fputs` は「直しが効いた回数」を probe(`dialog-crash-probe.mjs` の `taskGone`)が数えるための印でもある
  (計装を切った焼きでも出る)。⚠ libc だけを使う(embind / Qt は LO の文脈から呼べない)。
- 🔴 触らない: `#else`(非 JSPI)の枝 / `emscripten_proxy_promise` の枝(証拠が無い)/
  `pTask` の宣言 / `SetDeletionFlags()` / `DecideTransferredExecution()`(中断の前に済んでいる)。

## ⚠ 作法

- **毎回当たる直し**(入力で gate しない)。錨が**ちょうど 1 件**在ることを確かめてから当てる。
- 当てた後に印が在ることを確かめる / 二重当ては exit 1 で **file は 1 バイトも変わらない**。
- **足した行は全部 `PKC3-TASKGONE` を含む**。原文の行で変わるのは `pTask->Invoke();` の 1 行
  (JSPI の枝の分)だけで、足した行を除いてその 1 行を戻すと原文と一致する(test が見る)。
- ⚠ **計装 `patch-lo-scheduler-trace.py` と同じ行を触らない** ── 両方当てても、どちらの順でも
  出力が同一(計装の錨は `SolarMutexGuard g;` の**前**で切ってある)。
"""

import sys
from pathlib import Path

SRC = "vcl/source/app/scheduler.cxx"
MARK = "PKC3-TASKGONE"

# ── ① include(`std::fputs`)────────────────────────────────────────────
INC_ANCHOR = """#include <cstdlib>
"""
INC_REPLACE = """#include <cstdlib>
#include <cstdio> // PKC3-TASKGONE
"""

# ── ② JSPI の枝: 錠を取った後で mpTask を読み直す ───────────────────────────
# 🔑 錨は **置き換える 1 行 + 閉じ括弧**だけにする。計装(`patch-lo-scheduler-trace.py`)の錨は
#    `SolarMutexGuard g;` の行で終わる物と `#else` の行で始まる物なので、**1 字も重ならない**
#    (重なると当てる順で結果が変わる ── test が両順で同一を見る)。
#    ⚠ 16 字下げの `pTask->Invoke();` + `}` だけを探す(`emscripten_proxy_promise` の lambda は
#    24 字下げ / `#else` の枝は 12 字下げ ── どちらにも当たらない)。
#    ⚠ 直前が `SolarMutexGuard g;` であることは、当てた後に見る(下の `GUARD_THEN_FIX`)。
INVOKE_ANCHOR = """                pTask->Invoke();
            }
"""
INVOKE_REPLACE = """                // PKC3-TASKGONE(#117): the JSPI suspension at the SolarMutex above can last while
                // PKC3-TASKGONE the document is closed and this Task destroyed (Task::~Task() sets
                // PKC3-TASKGONE pMostUrgent->mpTask = nullptr). pTask is a raw copy read before the
                // PKC3-TASKGONE suspension and would dangle: read it again after taking the lock.
                Task* const pLiveTask = pMostUrgent->mpTask; // PKC3-TASKGONE
                if (pLiveTask) // PKC3-TASKGONE
                    pLiveTask->Invoke(); // PKC3-TASKGONE
                else // PKC3-TASKGONE
                    std::fputs("PKC3-TASKGONE: task destroyed while waiting for the SolarMutex; Invoke skipped\\n", stderr); // PKC3-TASKGONE
            }
"""

# 直しの直前が、錠を取る行であること(= 錠を取った**後**で読み直している)
GUARD_THEN_FIX = "                SolarMutexGuard g;\n                // PKC3-TASKGONE(#117)"

PARTS = (
    (INC_ANCHOR, INC_REPLACE),
    (INVOKE_ANCHOR, INVOKE_REPLACE),
)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-scheduler-task-gone.py <lo-core-dir>", file=sys.stderr)
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

    n_invoke_before = text.count("pTask->Invoke();")
    for anchor, replace in PARTS:
        text = text.replace(anchor, replace, 1)

    # ⚠ 置換が本当に効いたか(空振りを合格と読まない)
    if text.count("pLiveTask->Invoke();") != 1:
        print("ERROR: 読み直した Task の Invoke が 1 つ入っていない", file=sys.stderr)
        return 1
    if text.count(GUARD_THEN_FIX) != 1:
        print("ERROR: 錠を取る行の直後に直しが入っていない(錨の取り違え)", file=sys.stderr)
        return 1
    # 🔴 置き換えたのは JSPI の枝の 1 行だけ(`#else` 側と proxy の lambda の分は残る)
    if text.count("pTask->Invoke();") != n_invoke_before - 1:
        print("ERROR: `pTask->Invoke();` が 1 行だけ減っていない", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if MARK in line)
    if n_marks != n_expected or "pLiveTask->Invoke();" not in after:
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 行(期待 {n_expected})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(破棄済みの Task を Invoke しない / #117 ── 足した行 {n_marks})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
