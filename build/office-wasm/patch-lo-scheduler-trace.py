#!/usr/bin/env python3
"""#117 の**計装**。`Scheduler::CallbackTaskScheduling()` の中で何が起きて wasm が落ちるかを数える。

🔴 **これは直しではない。** 鍵を取る / null を飛ばす等は 1 つも入れない。
⚠ **既定では 1 バイトも書き換えない**(`PKC3_SCHEDULER_TRACE=1` の回だけ)が、
錨の検査は毎回する ── 門の下に隠すと上流の変形に誰も気づけない。

## 分かっていること(実測。2026-10-04)

配布一式 `lo-0c031979e70b` で、文書を閉じる(Ctrl+W)と **6 回中 6 回**
`RuntimeError: null function or function signature mismatch`。名前つきの一式で読んだ stack
(3 回とも同じ):

    1. Scheduler::CallbackTaskScheduling()   ← 🔴 fault はこの frame の中
    2. QtTimer::timeoutActivated()           (SolarMutex を取らない = JSPI / !PROXY_TO_PTHREAD)
    3. QCallableObject<...>::impl
    4. doActivate<false> / QMetaObject::activate / QTimer::timerEvent / sendEvent

つまり**この関数の中の間接呼び出し**(vtable 経由 = `call_indirect`)が、null か型違いの
関数へ飛んだ。この関数の中で vtable を引くのは:

| 呼び出し | 備考 |
|---|---|
| `mpTask->UpdateMinPeriod()` | virtual(ループ内 / 実行後) |
| `pTask->SetDeletionFlags()` | virtual |
| `pTask->DecideTransferredExecution()` | virtual(JSPI 分岐) |
| `pTask->Invoke()` | virtual |
| `mpSalTimer->Start()/Stop()` | virtual(`UpdateSystemTimer` / `ImplStartTimer` が畳み込まれると**この frame に入る**) |
| `mpDefInst->AnyInput()` | virtual(`Application::AnyInput` が畳み込まれると入る) |
| `IsActive()` | ⚠ 非 virtual(`include/vcl/task.hxx` で確認 ── `mbActive` を読むだけ) |

## 仮説 2 つ(⚠ 仮説である。計装は**どちらが起きているかを数で言う**)

- **A: 破棄後の `mpTask`** ── `Task` が破棄されたのに `ImplSchedulerData::mpTask` が残り、
  解放済みの vtable を読む。`Task::~Task()` は **`!IsStatic()` のときだけ**
  `mpSchedulerData->mpTask = nullptr` にする(静的な Task は残る)。
- **B: 再入** ── `Invoke()` の中で JSPI が中断し、Qt の event loop が回って `QTimer` が
  もう一度発火する(`QtTimer::timeoutActivated` は SolarMutex を取らない)。
  内側が外側の握っている `pSchedulerData` / `pPrevSchedulerData` を `DropSchedulerData` で
  消す / **JSPI の再開が入れ子の順(LIFO)でない**ときは、実行後の
  `rSchedCtx.mpSchedulerStack` の pop が別の要素を外す。

⚠ **`maMutex` の型は、この patch を書いた時点で確かめられていない**
(`schedulerimpl.hxx` は `Scheduler::Lock()` を呼ぶだけで、型は `svdata.hxx` に在る)。
再入できる mutex なら、同じ thread の再入は**待たずに素通りする**(= B が成り立つ)。
焼く前に `vcl/inc/svdata.hxx` の `maMutex` を読むこと。

## 出る印(接頭は全部 `PKC3-SCHED`。`grep PKC3-SCHED` で引ける)

| 印 | いつ出るか | どちらの仮説を言うか |
|---|---|---|
| `REENTER depth=N` + `FRAME[i] ...` | `CallbackTaskScheduling` に**深さ 2 以上で入った** | **B**。`FRAME[1]` が「外側がどの task の `Invoke` の中で止まっているか」を名指しする |
| `LEAVE a=N b=M` / `LEAVE-NON-LIFO a=N b=M` | 出口(深さ 2 以上、または LIFO でないとき)。`a` = 入ったときの深さ、`b` = 出る直前の生きている数。**違えば `LEAVE-NON-LIFO`** | **B**(再開が LIFO でない) |
| `STACK-MISMATCH top=.. mostUrgent=..` | 実行後の pop で、スタックの頂が自分でない(release では assert が無い) | **B**(別の要素を外し、解放済みを指す) |
| `USE-AFTER-FREE data=.. task=.. name=.. depth=.. where=.. via=data/task` | ループで握った `ImplSchedulerData` / `Task` が、**直近 64 件の解放の環**に在った | **A**(`via=task` かつ `static=1` なら「静的 Task の破棄で `mpTask` が残った」) |
| `USE-AFTER-FREE ... where=stack / stack-top` | `mpSchedulerStack` / `mpSchedulerStackTop` が解放済み | **B**(pop の取り違えの結果) |
| `STEP <call> data=.. task=.. depth=.. live=..` | 各 virtual 呼び出しの直前。**深さ 2 以上、または一度でも再入があった後** | どちらでもない(**どの呼び出しで落ちたか**を最後の 1 行で言う) |
| `NULL-DEPS timer=.. defInst=..` | 入口で `mpSalTimer` / `mpDefInst` が null | どちらでもない(vtable を null の `this` から引く別の線) |
| `STATE ...` | 深さ 2 以上 / 再入後の入口 | — |

⚠ **何も出ずに落ちた回は「A でも B でもない」ではなく「計装が届いていない」**
(`fprintf(stderr)` が wasm の console に出るかは焼かないと分からない。
`/tmp/pkc3-sched.log` にも書く = `pkc3-idles.log` と同じ作り)。
🔑 対照群 = **文書を開いて閉じない回**でも `STATE` / `STEP` が 1 行も出なければ、
計装が効いていない ── その回は 1 つも読まない。

## 計装の作り

- ⚠ **libc だけを使う**(embind / DOM / Qt の API は LO の文脈から呼べない)。
- ⚠ **足した行は全部 `// PKC3-SCHED` で終わる**。その行と helper の塊を取り除くと
  **原文と 1 バイトも違わない**(= 挙動を変えていない。`tests/office-scheduler-trace-patch.test.ts`)。
- ⚠ 解放の環は**確保されたら消す**(`new ImplSchedulerData` / `Task` の ctor)── 消さないと、
  同じ番地に作り直された正常な物を「解放済み」と誤報する。
- ⚠ 解放後の物の `GetDebugName()` は**呼ばない**(解放時に控えた名前を使う)。
- ⚠ `patch-lo-idles-deadlock.py`(`IdlesLockGuard`)と**同じ行を触らない**
  (触る行は `CallbackTaskScheduling` / `Task::~Task` / ctor / `Task::Start` の確保 1 行だけ)。
"""

import os
import sys
from pathlib import Path
from typing import NamedTuple

# ⚠ 先頭の `void pkc3_` が **`check-trace-helpers-compile.py` の入口**として拾われる
#    (`void pkc3_sched_trace(const char*, int, int, int)`)。それより前に
#    `void pkc3_…` で始まる行を置かない(置くと、入口を取り違えて落ちる)。
# ⚠ `namespace\n{\nvoid pkc3_sched_trace(` の字面は `check-patch-scope.py` が探す。
#    塊は 2 つの namespace に分け、入口は 2 つ目の先頭に置く。
HELPER = r"""// PKC3-SCHED-HELPER-BEGIN
// ── PKC3 #117 instrumentation (builds with PKC3_SCHEDULER_TRACE=1 only) ──
// It counts. It never changes behavior: no fix is applied here.
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <pthread.h>
namespace
{
const int PKC3_SCHED_RING = 64;
const int PKC3_SCHED_FRAMES = 8;

struct Pkc3SchedRec
{
    const void* pFreedData; // a freed ImplSchedulerData, or null
    const void* pFreedTask; // a freed Task, or null
    char aName[48];         // debug name copied when it was freed (never read afterwards)
    int nStatic;            // the Task was IsStatic() when freed
    int nSeq;               // order of release
};

struct Pkc3SchedFrame
{
    const char* pStep;
    const void* pData;
    const void* pTask;
    const char* pName;
};

Pkc3SchedRec g_aPkc3SchedRing[PKC3_SCHED_RING];
unsigned g_nPkc3SchedPut = 0;
int g_nPkc3SchedFreedSeq = 0;
char g_bPkc3SchedLock = 0;
int g_nPkc3SchedLine = 0;
int g_nPkc3SchedDepth = 0;
int g_nPkc3SchedReenter = 0;
Pkc3SchedFrame g_aPkc3SchedFrames[PKC3_SCHED_FRAMES];

[[maybe_unused]] void pkc3_sched_lock()
{
    while (__atomic_test_and_set(&g_bPkc3SchedLock, __ATOMIC_ACQUIRE))
    {
    }
}

[[maybe_unused]] void pkc3_sched_unlock() { __atomic_clear(&g_bPkc3SchedLock, __ATOMIC_RELEASE); }

// pthread_t is an integer on emscripten and a pointer elsewhere: copy the bytes, never cast.
[[maybe_unused]] unsigned long long pkc3_sched_tid()
{
    unsigned long long nTid = 0;
    pthread_t aSelf = pthread_self();
    std::memcpy(&nTid, &aSelf, sizeof aSelf < sizeof nTid ? sizeof aSelf : sizeof nTid);
    return nTid;
}

// Every line goes through here: stderr (the browser console) and /tmp/pkc3-sched.log.
__attribute__((format(printf, 1, 2))) void pkc3_sched_say(const char* fmt, ...)
{
    // The whole log is capped; high-frequency marks also have their own budget below.
    int nLine = __atomic_add_fetch(&g_nPkc3SchedLine, 1, __ATOMIC_RELAXED);
    if (nLine > 800)
        return;
    char aMsg[300];
    std::va_list aArgs;
    va_start(aArgs, fmt);
    std::vsnprintf(aMsg, sizeof aMsg, fmt, aArgs);
    va_end(aArgs);
    char aLine[400];
    std::snprintf(aLine, sizeof aLine, "PKC3-SCHED %s t=%llu #%d\n", aMsg, pkc3_sched_tid(), nLine);
    std::fputs(aLine, stderr);
    std::fflush(stderr);
    std::FILE* pLog = std::fopen("/tmp/pkc3-sched.log", "a");
    if (pLog)
    {
        std::fputs(aLine, pLog);
        std::fclose(pLog);
    }
}

// Categories: 0 reenter/leave, 1 use-after-free, 2 step, 3 stack, 4 state, 5 null-deps.
[[maybe_unused]] bool pkc3_sched_budget(int nCat, int nMax)
{
    static int aUsed[8];
    return __atomic_fetch_add(&aUsed[nCat & 7], 1, __ATOMIC_RELAXED) < nMax;
}

[[maybe_unused]] void pkc3_sched_put(const void* pFreedData, const void* pFreedTask,
                                     const char* pName, int nStatic)
{
    char aName[48];
    aName[0] = '?';
    aName[1] = '\0';
    if (pName)
        std::snprintf(aName, sizeof aName, "%.47s", pName);
    pkc3_sched_lock();
    Pkc3SchedRec& r = g_aPkc3SchedRing[g_nPkc3SchedPut++ % static_cast<unsigned>(PKC3_SCHED_RING)];
    std::memcpy(r.aName, aName, sizeof r.aName);
    r.nStatic = nStatic;
    r.nSeq = ++g_nPkc3SchedFreedSeq;
    r.pFreedData = pFreedData;
    r.pFreedTask = pFreedTask;
    pkc3_sched_unlock();
}

[[maybe_unused]] bool pkc3_sched_task_known_freed(const void* pTask)
{
    if (!pTask)
        return false;
    bool bKnown = false;
    pkc3_sched_lock();
    for (int i = 0; i < PKC3_SCHED_RING; ++i)
        if (g_aPkc3SchedRing[i].pFreedTask == pTask)
            bKnown = true;
    pkc3_sched_unlock();
    return bKnown;
}

// ~Task: noted for static tasks too (that branch does not clear mpSchedulerData->mpTask).
[[maybe_unused]] void pkc3_sched_note_task_freed(const void* pTask, const void* pData,
                                                 const char* pName, int nStatic)
{
    (void)pData;
    pkc3_sched_put(nullptr, pTask, pName, nStatic);
}

// delete of an ImplSchedulerData. Its Task's name is only read while that Task is not known freed.
[[maybe_unused]] void pkc3_sched_note_data_freed(const void* pData, const void* pTask,
                                                 const char* pName)
{
    pkc3_sched_put(pData, nullptr, pkc3_sched_task_known_freed(pTask) ? nullptr : pName, 0);
}

// A new ImplSchedulerData / Task at this address: it is no longer "freed".
[[maybe_unused]] void pkc3_sched_note_alloc(const void* p)
{
    pkc3_sched_lock();
    for (int i = 0; i < PKC3_SCHED_RING; ++i)
    {
        if (g_aPkc3SchedRing[i].pFreedData == p)
            g_aPkc3SchedRing[i].pFreedData = nullptr;
        if (g_aPkc3SchedRing[i].pFreedTask == p)
            g_aPkc3SchedRing[i].pFreedTask = nullptr;
    }
    pkc3_sched_unlock();
}

[[maybe_unused]] void pkc3_sched_dump(const char* pWhy)
{
    int nLive = __atomic_load_n(&g_nPkc3SchedDepth, __ATOMIC_RELAXED);
    for (int i = 1; i <= nLive && i < PKC3_SCHED_FRAMES; ++i)
    {
        const Pkc3SchedFrame& f = g_aPkc3SchedFrames[i];
        pkc3_sched_say("FRAME[%d] why=%s step=%s data=%p task=%p name=%s", i, pWhy,
                       f.pStep ? f.pStep : "-", f.pData, f.pTask, f.pName ? f.pName : "?");
    }
}

// Is what the loop holds a released ImplSchedulerData / Task? (hypothesis A)
[[maybe_unused]] bool pkc3_sched_check(const char* pWhere, int nDepth, const void* pData,
                                       const void* pTask)
{
    if (!pData && !pTask)
        return false;
    char aName[48];
    aName[0] = '\0';
    const char* pVia = nullptr;
    int nStatic = 0;
    int nFreedSeq = 0;
    pkc3_sched_lock();
    for (int i = 0; i < PKC3_SCHED_RING; ++i)
    {
        const Pkc3SchedRec& r = g_aPkc3SchedRing[i];
        const char* pHit = nullptr;
        if (pData && r.pFreedData == pData)
            pHit = "data";
        else if (pTask && r.pFreedTask == pTask)
            pHit = "task";
        if (pHit && (!pVia || r.nSeq > nFreedSeq)) // keep the most recent release
        {
            pVia = pHit;
            nStatic = r.nStatic;
            nFreedSeq = r.nSeq;
            std::memcpy(aName, r.aName, sizeof aName);
        }
    }
    pkc3_sched_unlock();
    if (!pVia)
        return false;
    if (pkc3_sched_budget(1, 200))
    {
        pkc3_sched_say("USE-AFTER-FREE data=%p task=%p name=%s depth=%d where=%s via=%s static=%d "
                       "freed#=%d",
                       pData, pTask, aName, nDepth, pWhere, pVia, nStatic, nFreedSeq);
        pkc3_sched_dump(pWhere);
    }
    return true;
}

// A breadcrumb before each virtual call. It is printed only while nested or after a re-entry.
[[maybe_unused]] void pkc3_sched_step(int nMy, const char* pStep, const void* pData,
                                      const void* pTask, const char* pName)
{
    Pkc3SchedFrame& f = g_aPkc3SchedFrames[nMy < 0 ? 0 : (nMy >= PKC3_SCHED_FRAMES ? PKC3_SCHED_FRAMES - 1 : nMy)];
    f.pStep = pStep;
    f.pData = pData;
    f.pTask = pTask;
    f.pName = pName;
    if ((nMy >= 2 || __atomic_load_n(&g_nPkc3SchedReenter, __ATOMIC_RELAXED) > 0)
        && pkc3_sched_budget(2, 300))
        pkc3_sched_say("STEP %s data=%p task=%p name=%s depth=%d live=%d", pStep, pData, pTask,
                       pName ? pName : "?", nMy,
                       __atomic_load_n(&g_nPkc3SchedDepth, __ATOMIC_RELAXED));
}

[[maybe_unused]] void pkc3_sched_state(int nDepth, const void* pTimer, const void* pInst,
                                       const void* pStack, const void* pTop)
{
    if ((!pTimer || !pInst) && pkc3_sched_budget(5, 20))
        pkc3_sched_say("NULL-DEPS timer=%p defInst=%p depth=%d", pTimer, pInst, nDepth);
    pkc3_sched_check("stack", nDepth, pStack, nullptr);
    pkc3_sched_check("stack-top", nDepth, pTop, nullptr);
    if ((nDepth >= 2 || __atomic_load_n(&g_nPkc3SchedReenter, __ATOMIC_RELAXED) > 0)
        && pkc3_sched_budget(4, 100))
        pkc3_sched_say("STATE timer=%p defInst=%p stack=%p top=%p depth=%d", pTimer, pInst, pStack,
                       pTop, nDepth);
}

// After Invoke(): the stack top must be our own entry (release builds have no assert for this).
[[maybe_unused]] void pkc3_sched_stack_pop(int nMy, const void* pTop, const void* pMostUrgent)
{
    if (pTop != pMostUrgent && pkc3_sched_budget(3, 100))
    {
        pkc3_sched_say("STACK-MISMATCH top=%p mostUrgent=%p depth=%d live=%d", pTop, pMostUrgent,
                       nMy, __atomic_load_n(&g_nPkc3SchedDepth, __ATOMIC_RELAXED));
        pkc3_sched_dump("STACK-MISMATCH");
    }
}
}

namespace
{
void pkc3_sched_trace(const char* what, int a, int b, int c)
{
    pkc3_sched_say("%s a=%d b=%d c=%d", what, a, b, c);
}

// Re-entry depth of CallbackTaskScheduling (hypothesis B).
struct Pkc3SchedDepth
{
    int nMy;
    Pkc3SchedDepth()
    {
        nMy = __atomic_add_fetch(&g_nPkc3SchedDepth, 1, __ATOMIC_SEQ_CST);
        Pkc3SchedFrame& f = g_aPkc3SchedFrames[nMy >= PKC3_SCHED_FRAMES ? PKC3_SCHED_FRAMES - 1 : nMy];
        f.pStep = "enter";
        f.pData = nullptr;
        f.pTask = nullptr;
        f.pName = nullptr;
        if (nMy >= 2)
        {
            int nReenter = __atomic_add_fetch(&g_nPkc3SchedReenter, 1, __ATOMIC_RELAXED);
            if (pkc3_sched_budget(0, 100))
            {
                pkc3_sched_say("REENTER depth=%d reenters=%d", nMy, nReenter);
                pkc3_sched_dump("REENTER");
            }
        }
    }
    ~Pkc3SchedDepth()
    {
        int nLive = __atomic_load_n(&g_nPkc3SchedDepth, __ATOMIC_SEQ_CST);
        bool bNonLifo = nLive != nMy;
        if ((nMy >= 2 || bNonLifo) && pkc3_sched_budget(0, 100))
            // a = depth at entry, b = live activations just before leaving.
            // (This is also what keeps the entry point used: an unused function is a warning.)
            pkc3_sched_trace(bNonLifo ? "LEAVE-NON-LIFO" : "LEAVE", nMy, nLive, 0);
        __atomic_sub_fetch(&g_nPkc3SchedDepth, 1, __ATOMIC_SEQ_CST);
    }
};
}
// PKC3-SCHED-HELPER-END
"""

SRC = "vcl/source/app/scheduler.cxx"
MARK = "// PKC3-SCHED"


class Add(NamedTuple):
    """足す 1 行。⚠ **足すだけ**(原文の行は 1 つも書き換えない)。行末に印を付ける。"""

    indent: int
    code: str


def _anchor(parts) -> str:
    return "".join(p for p in parts if isinstance(p, str))


def _render(parts) -> str:
    out = []
    for p in parts:
        out.append(f"{' ' * p.indent}{p.code}  {MARK}\n" if isinstance(p, Add) else p)
    return "".join(out)


# 🔑 各 target は「原文の断片」と「足す行」を交互に並べる。
#    錨 = 原文の断片をつないだもの / 置換 = そこへ足す行を差し込んだもの。
#    ⚠ 足すだけなので、足した行(行末が `// PKC3-SCHED`)を除けば原文と一致する。
D = "aPkc3Depth.nMy"
PARTS = [
    # ── 入口: 再入の深さ(仮説 B)+ 依存の状態
    [
        Add(4, "Pkc3SchedDepth aPkc3Depth;"),
        "    SchedulerGuard aSchedulerGuard;\n"
        "    if ( !rSchedCtx.mbActive || InfiniteTimeoutMs == rSchedCtx.mnTimerPeriod )\n"
        "        return;\n",
        Add(
            4,
            f"pkc3_sched_state({D}, rSchedCtx.mpSalTimer, pSVData->mpDefInst, "
            "rSchedCtx.mpSchedulerStack, rSchedCtx.mpSchedulerStackTop);",
        ),
    ],
    # ── 早い戻り(タイマーを張り直す。⚠ 畳み込まれると mpSalTimer->Start がこの frame に入る)
    [
        Add(8, f'pkc3_sched_step({D}, "SalTimer(early)", rSchedCtx.mpSalTimer, nullptr, nullptr);'),
        "        UpdateSystemTimer(rSchedCtx, nSleep, true, nTime);\n        return;\n",
    ],
    # ── ループ: 握った data / task が解放済みか(仮説 A)。⚠ dynamic_cast(RTTI 読み)より前
    [
        "            ++nTasks;\n",
        Add(12, f'pkc3_sched_check("loop", {D}, pSchedulerData, pSchedulerData->mpTask);'),
        "            const Timer *timer = dynamic_cast<Timer*>( pSchedulerData->mpTask );\n",
    ],
    # ── ループ: data を delete する所(解放の環へ控える)
    [
        "                if ( pSchedulerData->mpTask )\n"
        "                    pSchedulerData->mpTask->mpSchedulerData = nullptr;\n",
        Add(
            16,
            "pkc3_sched_note_data_freed(pSchedulerData, pSchedulerData->mpTask, "
            "pSchedulerData->mpTask ? pSchedulerData->mpTask->GetDebugName() : nullptr);",
        ),
        "                delete pSchedulerData;\n",
    ],
    # ── ループ: virtual UpdateMinPeriod の直前
    [
        Add(
            16,
            f'pkc3_sched_step({D}, "UpdateMinPeriod", pSchedulerData, pSchedulerData->mpTask, nullptr);',
        ),
        "                nReadyPeriod = pSchedulerData->mpTask->UpdateMinPeriod( nTime );\n",
    ],
    # ── ループの後: virtual SalTimer の直前
    [
        Add(4, f'pkc3_sched_step({D}, "SalTimer(loop-end)", rSchedCtx.mpSalTimer, nullptr, nullptr);'),
        "    UpdateSystemTimer(rSchedCtx, nMinPeriod, true, nTime);\n",
    ],
    # ── 実行の直前: 握った物が解放済みか
    [
        "    Task *pTask = pMostUrgent->mpTask;\n",
        Add(4, f'pkc3_sched_check("pre-invoke", {D}, pMostUrgent, pTask);'),
        Add(4, f'pkc3_sched_step({D}, "pre-invoke", pMostUrgent, pTask, pTask->GetDebugName());'),
    ],
    # ── Unlock の直後(AnyInput は idle のときだけ呼ばれる)
    [
        "    // invoke the task\n    Unlock();\n",
        Add(4, f'pkc3_sched_step({D}, "Unlock/AnyInput", pMostUrgent, pTask, nullptr);'),
    ],
    # ── virtual 3 つ(SetDeletionFlags / DecideTransferredExecution / Invoke の proxy 側)
    [
        "            // prepare Scheduler object for deletion after handling\n",
        Add(12, f'pkc3_sched_step({D}, "SetDeletionFlags", pMostUrgent, pTask, nullptr);'),
        "            pTask->SetDeletionFlags();\n"
        "#if defined __EMSCRIPTEN__ && ENABLE_QT6 && HAVE_EMSCRIPTEN_JSPI && !HAVE_EMSCRIPTEN_PROXY_TO_PTHREAD\n",
        Add(12, f'pkc3_sched_step({D}, "DecideTransferredExecution", pMostUrgent, pTask, nullptr);'),
        "            if (pTask->DecideTransferredExecution())\n            {\n",
        Add(
            16,
            f'pkc3_sched_step({D}, "Invoke(proxy)", pMostUrgent, pTask, pTask->GetDebugName());',
        ),
        "                auto & data = comphelper::emscriptenthreading::getData();\n",
    ],
    # ── Invoke(同じ thread)。⚠ ここで JSPI が中断する = 外側の frame の印になる
    [
        "            else\n"
        "            {\n",
        Add(16, f'pkc3_sched_step({D}, "Invoke", pMostUrgent, pTask, pTask->GetDebugName());'),
        "                SolarMutexGuard g;\n"
        "                pTask->Invoke();\n"
        "            }\n"
        "#else\n",
        Add(12, f'pkc3_sched_step({D}, "Invoke", pMostUrgent, pTask, pTask->GetDebugName());'),
        "            pTask->Invoke();\n"
        "#endif\n",
    ],
    # ── 実行から戻った直後(JSPI で再開した後)。握っている物が解放済みでないか
    [
        "    Lock();\n",
        Add(4, f'pkc3_sched_check("post-invoke", {D}, pMostUrgent, pMostUrgent->mpTask);'),
        Add(4, f'pkc3_sched_step({D}, "post-Invoke", pMostUrgent, pMostUrgent->mpTask, nullptr);'),
        "\n    assert(pMostUrgent->mbInScheduler);\n    pMostUrgent->mbInScheduler = false;\n",
    ],
    # ── スタックの pop(release には assert が無い)
    [
        "    // pop the scheduler stack\n"
        "    pSchedulerData = rSchedCtx.mpSchedulerStack;\n"
        "    assert(pSchedulerData == pMostUrgent);\n",
        Add(4, f"pkc3_sched_stack_pop({D}, pSchedulerData, pMostUrgent);"),
    ],
    # ── 実行後: data を delete する所
    [
        "        if (pMostUrgent->mpTask)\n"
        "            pMostUrgent->mpTask->mpSchedulerData = nullptr;\n",
        Add(
            8,
            "pkc3_sched_note_data_freed(pMostUrgent, pMostUrgent->mpTask, "
            "pMostUrgent->mpTask ? pMostUrgent->mpTask->GetDebugName() : nullptr);",
        ),
        "        delete pMostUrgent;\n",
    ],
    # ── 入れ子で張り直す所(mpSalTimer->Start)
    [
        Add(8, f'pkc3_sched_step({D}, "SalTimer(nested)", rSchedCtx.mpSalTimer, nullptr, nullptr);'),
        "        UpdateSystemTimer( rSchedCtx, ImmediateTimeoutMs, true,\n"
        "                           tools::Time::GetSystemTicks() );\n",
    ],
    # ── 実行後の virtual UpdateMinPeriod と最後の SalTimer
    [
        "        pMostUrgent->mnUpdateTime = nTime;\n",
        Add(
            8,
            f'pkc3_sched_step({D}, "UpdateMinPeriod(post)", pMostUrgent, pMostUrgent->mpTask, nullptr);',
        ),
        "        nReadyPeriod = pMostUrgent->mpTask->UpdateMinPeriod( nTime );\n"
        "        if ( nMinPeriod > nReadyPeriod )\n"
        "            nMinPeriod = nReadyPeriod;\n",
        Add(8, f'pkc3_sched_step({D}, "SalTimer(tail)", rSchedCtx.mpSalTimer, nullptr, nullptr);'),
        "        UpdateSystemTimer( rSchedCtx, nMinPeriod, false, nTime );\n",
    ],
    # ── 確保(環から外す = 同じ番地の新しい物を「解放済み」と誤報しない)
    [
        "        ImplSchedulerData* pSchedulerData = new ImplSchedulerData;\n",
        Add(8, "pkc3_sched_note_alloc(pSchedulerData);"),
    ],
    [
        "    , mbStatic( false )\n{\n    assert(mpDebugName);\n",
        Add(4, "pkc3_sched_note_alloc(this);"),
        "}\n\nTask::Task( const Task& rTask )\n",
    ],
    [
        "    assert(mpDebugName);\n",
        Add(4, "pkc3_sched_note_alloc(this);"),
        "    if ( rTask.IsActive() )\n        Start();\n}\n",
    ],
    # ── 破棄(⚠ IsStatic() の枝でも控える。そちらは mpTask を消さない)
    [
        "Task::~Task()\n{\n",
        Add(4, "pkc3_sched_note_task_freed(this, mpSchedulerData, mpDebugName, IsStatic() ? 1 : 0);"),
        "    if ( !IsStatic() )\n",
    ],
]

# ヘルパーは **関数定義の直前**(file scope)へ入れる。⚠ 関数の中に入れるとコンパイル不能になる。
#   使う所(`Task::Start` / ctor / dtor / `CallbackTaskScheduling`)はどれもこの後ろに在る。
HELPER_ANCHOR = "static ImplSchedulerData* DropSchedulerData(\n"


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-scheduler-trace.py <lo-core-dir>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    on = os.environ.get("PKC3_SCHEDULER_TRACE") == "1"

    path = root / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")

    # ⚠ **錨の検査は門の外でやる**(門の下に隠すと上流の変形に誰も気づけない)。
    if "pkc3_sched_trace" in text or MARK in text:
        print(f"ERROR: {SRC} に既に計装が入っている(二重当て)", file=sys.stderr)
        return 1
    if text.count(HELPER_ANCHOR) != 1:
        print(
            f"ERROR: ヘルパーの錨が {text.count(HELPER_ANCHOR)} 件({SRC})── 上流が形を変えた",
            file=sys.stderr,
        )
        return 1
    spans = []
    for parts in PARTS:
        anchor = _anchor(parts)
        hits = text.count(anchor)
        if hits != 1:
            print(
                f"ERROR: 錨が {hits} 件({SRC})── 上流が形を変えた。当て先を読み直すこと\n{anchor}",
                file=sys.stderr,
            )
            return 1
        start = text.index(anchor)
        spans.append((start, start + len(anchor)))
    # ⚠ 錨どうしが重なると、先に当てた置換が後の錨を壊す(当てる順で結果が変わる)
    spans.sort()
    for (_, e1), (s2, _) in zip(spans, spans[1:]):
        if s2 < e1:
            print("ERROR: 錨どうしが重なっている(この patch の書き方の誤り)", file=sys.stderr)
            return 1

    if not on:
        print(
            f"skip: PKC3_SCHEDULER_TRACE!=1"
            f"(錨は 1 + {len(PARTS)} 件とも在ることを確かめた)"
        )
        return 0

    # ⚠ ヘルパーを先に(本体の置換より前)── 「呼ぶ側だけ入ってヘルパーが無い」中間状態を作らない
    new = text.replace(HELPER_ANCHOR, HELPER + "\n" + HELPER_ANCHOR, 1)
    for parts in PARTS:
        anchor = _anchor(parts)
        # 置換のたびに「いまの字」で 1 件であることを見直す(先の置換が後の錨を増やしていないか)
        if new.count(anchor) != 1:
            print("ERROR: 置換の途中で錨が 1 件でなくなった(この patch の書き方の誤り)", file=sys.stderr)
            return 1
        new = new.replace(anchor, _render(parts), 1)

    path.write_text(new, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通り、
    #    CI 全緑のまま計装が artifact に 1 バイトも入らない)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if line.rstrip().endswith(MARK))
    n_adds = sum(1 for parts in PARTS for p in parts if isinstance(p, Add))
    if "pkc3_sched_trace" not in after or n_marks != n_adds:
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 本(期待 {n_adds})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(#117 の計装 ── 足した行 {n_adds} + helper)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
