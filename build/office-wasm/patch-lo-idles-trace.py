#!/usr/bin/env python3
"""#199 の**計装**。`IdlesLockGuard` の待ちが、なぜ返らないのかを測る。

🔴 **これは直しではない。** 直前まで同じ場所に「直し」(`patch-lo-idles-lock.py`)を
置いていたが、**焼いて回したら no-op だった**ので取り下げた。経緯は下の「取り下げた理由」。

## 分かっていること(stack を撮って確定。対照群つき)

自作 1,782 バイトの docx(DrawingML の画像 1 枚)を渡すと、worker 15 が止まったまま戻らない:

    $emscripten_futex_wait
    $osl_waitCondition
    $Scheduler::IdlesLockGuard::IdlesLockGuard()          <- ここ
    $sw::DocumentLayoutManager::DelLayoutFormat(SwFrameFormat*)
    $SwXShape::dispose()
    $writerfilter::dmapper::GraphicImport::lcl_attribute(...)

🔑 **対照群**(同じ一式で `.odt`)では、この worker に stack が**無い**。差はちょうど 1 本。

## 🔴 取り下げた理由 ── 前提を 1 つ読み落としていた

取り下げた直しは、`IdlesLockGuard` の待ちを
`if (!Application::IsUseSystemEventLoop())` で畳むものだった。根拠は
「Emscripten の Qt6 は `m_bUseSystemLoop=true` を無条件で立てる」── ⚠ **これが誤り**。

`vcl/qt5/QtInstance.cxx` の実物はこう書いてある:

    #ifndef __EMSCRIPTEN__
        m_bSupportsOpenGL = true;
    #elif !HAVE_EMSCRIPTEN_JSPI                          <- 🔴 ここを読み落とした
        ImplGetSVData()->maAppData.m_bUseSystemLoop = true;
    #endif

そして PKC3 の焼きは **`--enable-emscripten-jspi` を渡している**
(`.github/workflows/office-wasm-build.yml`。検品 `grep -q '^export ENABLE_EMSCRIPTEN_JSPI=TRUE'`
も通っている)。⇒ `HAVE_EMSCRIPTEN_JSPI` は定義済み ⇒ **その行は compile out される**
⇒ `m_bUseSystemLoop` は false のまま ⇒ `IsUseSystemEventLoop()` は **false**
⇒ 取り下げた直しの `if (!...)` は**常に真** ⇒ **待ちはそのまま走る = no-op**。

🔑 実際、この直しを入れた焼き(run 32712089791)で測ったら
**`opened` は付かなかった**(対照群 `.odt` は 11 秒で開く = 読める回)。

⚠ **そして機構の説明も裏返る**: `IsUseSystemEventLoop()` が false なら
`DoExecute()` は false を返すので、`Application::Execute()` は
`if (!DoExecute(...))` の枝に**入る** ── つまり `m_inExecuteCondtion.set()` は
**呼ばれるはず**である。「一度も set されない」という説明は**成り立たない**。

## だから測る(推測しない)

| 出る行 | 何が分かるか |
|---|---|
| `idles:wait a=<IsUseSystemEventLoop> b=<IsMainThread> c=<IsInExecute>` | 待ちに入った |
| 🔴 `idles:who a=<Application::IsMainThread> b=<mpDefInst->IsMainThread> c=<mnIdlesLockCount>` | **2 つの「メインスレッド」判定が食い違っているか**(6 巡目)── 食い違っていれば **import は自分で自分を待っている**(直すのは述語)/ 一致していれば本当に別スレッド(握手を作り直す) |
| 🔴 どの行にも付く `t=<pthread_self()>` | **誰が書いたか**(6 巡目)── `yield:enter` と `idles:wait` の `t=` を突き合わせれば「同じスレッドか」が**推測なしで**出る |
| `idles:woke` | 待ちが返った(出なければ、そこで永久に止まっている) |
| `execute:call` | 🔑 **対照群** ── `Application::Execute()` に入った。**これが 0 件の回は計装が効いていないので、その回は 1 つも読まない** |
| `execute:doexec a=<返り値>` | `DoExecute()` が**返ってきた**。⚠ **出ないこと自体が答え**(中で回り続けている) |
| `execute:loop` | vcl 側の待ちループが回った(先頭 5 回まで) |
| `execute:set` | そのループが条件を立てた(先頭 5 回まで) |
| `yield:enter a=<Qt スレッドか> b=<待つか>` | `QtInstance::DoYield` に入った(先頭 5 回まで) |
| `yield:proxy` | 枝 B ── 主スレッドへ proxy して promise を待つ |
| `yield:wait` / `yield:woke` | 枝 C ── `m_aWaitingYieldCond` で待つ / 起きた |
| `yield:ret a=<返り値>` | `DoYield` が返った(先頭 5 回まで) |

## 🔴 3 巡目の結果と、4 巡目で割ること

3 巡目(run 32742692542)の実測 ── **読み②が確定**した:

| | 画像入り `.docx` | 対照群 `.odt` |
|---|---|---|
| `execute:call` / `execute:doexec` | 1 / `a=0` | 1 / `a=0` |
| `execute:loop` | 🔴 **1 回だけ** | **5 回** |
| `execute:set` | 🔴 **0 件** | **5 件**(loop と交互) |

⇒ vcl の待ちループには**入っている**が、最初の `Application::Yield()` から
**戻ってこない**。だから条件を立てる者が居ない。

🔑 **手元の stack とも噛み合う**(`PKC3_STACKS=1`、対照群つき):

| | 詰まった `.docx` | 対照群 `.odt`(開く) |
|---|---|---|
| ブラウザ主スレッド | `alive`(**暇**) | `alive`(暇) |
| 止まっている worker | **2 本** | **1 本** |

⚠ **主スレッドは塞がっていない。** そして **1 本は正常な回でも止まっている**
── LO の main が `DoYield` で待つのは**普通のこと**である。
🔑 だから問いは「main が待つこと」ではなく、
**`IdlesLockGuard` が投げた `Application::PostUserEvent({})` がなぜ main を
起こさないのか**である。

4 巡目はそれを枝で割る:

| 出るもの | 直す場所 |
|---|---|
| `yield:proxy` が出て `yield:ret` が出ない | 枝 B ── 主スレッドへの proxy が返らない |
| `yield:wait` が出て `yield:woke` が出ない | 枝 C ── `m_aWaitingYieldCond` を誰も set しない |
| `yield:enter a=1` しか出ない | Qt スレッド自身で回っている(前提が違う) |

## 🔴 2 巡目の結果と、3 巡目で割ること

2 巡目(run 32712089791)の実測: `idles:wait a=0 b=0 c=1` / `idles:woke` **0 件** /
`execute:set` は docx で **0 件**・対照群 `.odt` で **1 件**。

⚠ **`execute:set` が 0 件**は 2 通りに読める ── ①`DoExecute()` が Qt 自身のループを
回して**返ってこない**ので、vcl 側の while に**そもそも到達していない**
②到達しているが `Yield()` が返らない。**どちらかで直す場所がまるで違う**。

| 読み | 何が出るか | 直す場所 |
|---|---|---|
| ① | `execute:call` ✓ / `execute:doexec` ✗ / `execute:loop` ✗ | 条件を立てる者が居ない → `IdlesLockGuard` 側(待たない or 別経路で起こす) |
| ② | `execute:call` ✓ / `execute:doexec` ✓ / `execute:loop` ✓ / `execute:set` ✗ | `Yield()` が返らない → そちらを追う |
| ③ | `execute:set` ✓ なのに `idles:woke` ✗ | 立てているのに待ちが返らない(条件オブジェクトの対応付け / スレッド間の伝播) |

⚠ どれに転んでも**次に直す場所が変わる**ので、ここを測らずに 2 度目の直しを焼かない
(1 度目は前提を決め打ちして焼き 1 回を無駄にした)。
"""

import os
import sys
from pathlib import Path

# ⚠ libc だけを使う。embind / DOM / Qt の API をここから呼んではいけない
#    (LO の文脈から `emscripten::val` を触ると `invalid handle` で abort する ── 2026-08-15)。
HELPER = """
// ── PKC3 #199 の計装(挙動は変えない。`PKC3_IDLES_TRACE=1` の回だけ入る)──
#include <cstdio>
#include <pthread.h>
namespace
{
void pkc3_idles_trace(const char* what, int a, int b, int c)
{
    static int nSeq = 0;
    // ⚠ 上限を置く ── `execute:set` は毎ループ走るので、置かないと log が膨らむ
    if (nSeq >= 300)
        return;
    ++nSeq;
    // 🔴 **6 巡目(2026-08-24)── どの行も「誰が書いたか」を持つ。**
    //    5 巡目で残った問いは 1 つだけだった:**待っているのと `Yield()` しているのは
    //    同じスレッドか**。⚠ `yield:enter` の判定は **Qt の**メインスレッド
    //    (`qApp->thread() == QThread::currentThread()`)で、`idles:wait` の判定は
    //    **osl の**メインスレッド(`mnMainThreadId`)── **別の述語**なので、
    //    真偽を 2 つ並べても「同じスレッドか」は出ない。
    //    🔑 だから **id そのもの**を出す ── 突合すれば推測が要らない。
    //    ⚠ `pthread_self()` は libc なので、この計装の「libc だけ」の規律を崩さない
    //    (`osl::Thread` を引くと header 依存が増え、当てる場所を選ぶ)。
    //    ⚠ `%p` で出す ── emscripten の `pthread_t` は `struct __pthread*` なので
    //    整数へ落とす cast を書かずに済む(header も増えない)。
    char line[200];
    std::snprintf(line, sizeof line, "PKC3-IDLES %d %s a=%d b=%d c=%d t=%p\\n", nSeq, what, a, b, c,
                  static_cast<void*>(pthread_self()));
    std::fputs(line, stderr);
    std::fflush(stderr);
    std::FILE* pLog = std::fopen("/tmp/pkc3-idles.log", "a");
    if (pLog)
    {
        std::fputs(line, pLog);
        std::fclose(pLog);
    }
}
}
"""

SCHED_SRC = "vcl/source/app/scheduler.cxx"
SCHED_ANCHOR = """        pSVData->m_inExecuteCondtion.reset();
        // Put an empty event to the application's queue, to make sure that it loops through the
        // code that sets the condition, even when there's no other events in the queue
        Application::PostUserEvent({});
        SolarMutexReleaser releaser;
        pSVData->m_inExecuteCondtion.wait();
"""
SCHED_REPLACE = """        pSVData->m_inExecuteCondtion.reset();
        // Put an empty event to the application's queue, to make sure that it loops through the
        // code that sets the condition, even when there's no other events in the queue
        Application::PostUserEvent({});
        // 🔑 **前提を実測で出す**(#199)── a は `IsUseSystemEventLoop()`。
        //    ⚠ ここを「true のはず」と決めつけた直しを 1 度焼いて no-op だった。
        // 🔴 **c が本命**(2026-08-24 の 2 巡目)── `Application::IsInExecute()` は
        //    「`Application::Execute()` がスタックに在るか」(`svdata.hxx:174` の
        //    `mbInAppExecute`、公開の accessor は `svapp.hxx:571`)。
        //    ⚠ **c=0 なら、待っている条件を立てる者がまだ走っていない**ことが確定する
        //    ── 1 巡目で `execute:set` が 0 件だった理由が、これで名前で言える。
        //    🔑 前回は述語を**決め打ちして**焼き 1 回を無駄にした。今度は**測ってから**書く。
        pkc3_idles_trace("idles:wait", Application::IsUseSystemEventLoop() ? 1 : 0,
                         Application::IsMainThread() ? 1 : 0,
                         Application::IsInExecute() ? 1 : 0);
        // 🔴 **6 巡目(2026-08-24)── 2 つの「メインスレッド」判定を並べる。**
        //    ⚠ `Application::IsMainThread()`(`svapp.cxx:522`)は **osl の id**
        //    (`mnMainThreadId` = `InitVCL` を走らせたスレッド)で判定するが、
        //    `DoYield` が枝 A を選ぶのは **Qt の** thread(`QtInstance::IsMainThread()`,
        //    `QtInstance.cxx:538` = `qApp->thread() == QThread::currentThread()`)である。
        //    🔑 **この 2 つが食い違っていれば、import は自分で自分を待っている**
        //    (= 直すのは述語であって握手ではない)。⚠ 一致していれば本当に別スレッドで、
        //    そのときは握手そのものを作り直す ── **直し方が正反対なので、測ってから書く**。
        //    ⚠ `mpDefInst` 経由で呼ぶ(`SalInstance::IsMainThread()` は virtual で、
        //    Qt 版がその実体である)。
        pkc3_idles_trace("idles:who", Application::IsMainThread() ? 1 : 0,
                         pSVData->mpDefInst->IsMainThread() ? 1 : 0,
                         rSchedCtx.mnIdlesLockCount);
        {
            SolarMutexReleaser releaser;
            pSVData->m_inExecuteCondtion.wait();
        }
        // ⚠ この行が**出なければ**、待ちはそこで永久に止まっている
        pkc3_idles_trace("idles:woke", -1, -1, -1);
"""

APP_SRC = "vcl/source/app/svapp.cxx"
# 🔴 **3 巡目は `DoExecute()` の前後を割る**(2026-08-24)。
#    2 巡目は `execute:set` が 0 件だったが、それは 2 通りに読める ──
#    ①`DoExecute()` が **Qt 自身のループを回して返ってこない**ので、下の while に
#    そもそも到達していない ②到達しているが `Yield()` が返らない。
#    ⚠ **どちらかで直す場所がまるで違う**ので、ここを割らずに直しを焼かない。
#    🔑 だから **呼ぶ直前**にも印を置く ── `execute:call` が出て `execute:doexec` が
#    出なければ、①が確定する(返っていないのだから)。
#    ⚠ **`execute:call` は対照群でもある** ── これが 1 件も出ない回は
#    「計装が効いていない」ので、**その回の結果は 1 つも読まない**。
APP_ANCHOR = """    int nExitCode = 0;
    if (!pSVData->mpDefInst->DoExecute(nExitCode))
    {
        if (Application::IsUseSystemEventLoop())
        {
            SAL_WARN("vcl.schedule", "Can\'t omit DoExecute when running on system event loop!");
            std::abort();
        }
        while (!pSVData->maAppData.mbAppQuit)
        {
            Application::Yield();
            SolarMutexReleaser releaser; // Give a chance for the waiting threads to lock the mutex
            pSVData->m_inExecuteCondtion.set();
"""
APP_REPLACE = """    int nExitCode = 0;
    // 🔑 **呼ぶ前**に 1 本(#199 3 巡目)── これが出ない回は計装が効いていない
    pkc3_idles_trace("execute:call", -1, -1, -1);
    const bool bPkc3DoExecuted = pSVData->mpDefInst->DoExecute(nExitCode);
    // 🔴 **返ってきたことそのものが情報である** ── 出なければ `DoExecute()` の中で
    //    回り続けている = 下の while には永久に来ない = 条件を立てる者が居ない。
    pkc3_idles_trace("execute:doexec", bPkc3DoExecuted ? 1 : 0, -1, -1);
    if (!bPkc3DoExecuted)
    {
        if (Application::IsUseSystemEventLoop())
        {
            SAL_WARN("vcl.schedule", "Can\'t omit DoExecute when running on system event loop!");
            std::abort();
        }
        while (!pSVData->maAppData.mbAppQuit)
        {
            // ⚠ **高頻度の印は自前の上限を持つ** ── 共有の 300 を食い潰すと
            //    後から来る `idles:wait` が押し出され、「出ていない」と
            //    「採らなかった」が見分けられなくなる(観測点の器の問題)。
            {
                static int nPkc3Loop = 0;
                if (nPkc3Loop < 5)
                {
                    ++nPkc3Loop;
                    pkc3_idles_trace("execute:loop", nPkc3Loop, -1, -1);
                }
            }
            Application::Yield();
            SolarMutexReleaser releaser; // Give a chance for the waiting threads to lock the mutex
            pSVData->m_inExecuteCondtion.set();
            // 🔑 **立てた回数を数える**(#199)── 0 件なら、メインスレッドは
            //    このループに一度も到達していない(= 直す場所はそちら側)。
            {
                static int nPkc3Set = 0;
                if (nPkc3Set < 5)
                {
                    ++nPkc3Set;
                    pkc3_idles_trace("execute:set", nPkc3Set, -1, -1);
                }
            }
"""

# 🔴 **ヘルパーは file scope へ入れる。関数の中に入れてはいけない**(2026-08-24 に踏んだ)。
#
# ⚠ 1 稿目は `HELPER + 本体の置換` を 1 つの錨に当てたが、**その錨は関数の中**に在るので
#   名前空間スコープの関数定義が関数本体の内側へ入り、**コンパイル不能**になった。
#   ⚠ patch は「当たった」と報告するので、**生成された C++ を目視するまで気づけない**
#   (焼いて 2 時間後に赤で分かる形だった)。
# 🔑 だから錨を **2 段**に分ける ── ヘルパーは**関数定義の直前**、本体は中。
QT_SRC = "vcl/qt5/QtInstance.cxx"
# 🔴 **4 巡目は `DoYield()` の枝を割る**(2026-08-24)。
#    3 巡目で「vcl の待ちループには入っているが `Application::Yield()` から戻ってこない」
#    ところまで確定した(`execute:loop` が 1 回で止まり `execute:set` が 0 件 /
#    対照群は 5 往復)。⚠ `QtInstance::DoYield` は**呼ぶスレッドで 3 つに分かれる**:
#      A. `qApp->thread()` 自身 → `ImplYield()` を回し、event があれば
#         `m_aWaitingYieldCond.set()` する(= **他の枝を起こす唯一の場所**)
#      B. emscripten の eventHandlerThread → 主スレッドへ proxy して promise を待つ
#      C. それ以外 → `ImplYieldSignal` を投げ、event が無ければ
#         `m_aWaitingYieldCond.wait()` で**待つ**
#    🔑 B と C は**どちらも「主スレッドが動くこと」に依存する**ので、どの枝に居るかで
#    直す場所が変わる。⚠ 割らずに直しは焼かない。
#    🔑 手元で撮った stack とも噛み合う ── 詰まった回は **worker が 2 本**止まって
#    おり(片方は #199 の `IdlesLockGuard`)、**ブラウザの主スレッドは暇**だった
#    (`Debugger.pause` が頁の `alive` で止まった = wasm を実行していない)。
QT_IMPL_ANCHOR = """bool QtInstance::ImplYield(bool bWait, bool bHandleAllCurrentEvents)
{
    // Re-acquire the guard for user events when called via Q_EMIT ImplYieldSignal
    SolarMutexGuard aGuard;
    bool wasEvent = DispatchUserEvents(bHandleAllCurrentEvents);
"""
QT_IMPL_REPLACE = """bool QtInstance::ImplYield(bool bWait, bool bHandleAllCurrentEvents)
{
    // 🔴 **5 巡目**(2026-08-24)。4 巡目で「枝 A に入り `ImplYield()` から戻らない」
    //    ところまで確定し、**外から本物の入力を入れても動かない**ことも測った
    //    (頁の DOM は keydown 1 / mousemove 3 を受け取っている)。
    //    ⚠ つまり「event が来ないだけ」ではない。残るのは**何かを掴んで動けない**側。
    // 🔑 いちばん疑わしいのは**この直後の `SolarMutexGuard`** である ── ここで
    //    止まると、user event を配る前に固まるので、外からの入力も一切効かない。
    //    ⚠ `yield:impl` が出て `yield:guard` が出なければ、**それが答え**である。
    {
        static int nPkc3Impl = 0;
        if (nPkc3Impl < 5)
        {
            ++nPkc3Impl;
            pkc3_idles_trace("yield:impl", bWait ? 1 : 0, -1, nPkc3Impl);
        }
    }
    // Re-acquire the guard for user events when called via Q_EMIT ImplYieldSignal
    SolarMutexGuard aGuard;
    {
        static int nPkc3Guard = 0;
        if (nPkc3Guard < 5)
        {
            ++nPkc3Guard;
            pkc3_idles_trace("yield:guard", -1, -1, nPkc3Guard);
        }
    }
    bool wasEvent = DispatchUserEvents(bHandleAllCurrentEvents);
    {
        // ⚠ 配れたか(`PostUserEvent` で積まれたものが、ここで捌かれる)
        static int nPkc3Disp = 0;
        if (nPkc3Disp < 5)
        {
            ++nPkc3Disp;
            pkc3_idles_trace("yield:disp", wasEvent ? 1 : 0, -1, nPkc3Disp);
        }
    }
"""
QT_PROC_ANCHOR = """    SolarMutexReleaser aReleaser;
    QAbstractEventDispatcher* dispatcher = QAbstractEventDispatcher::instance(qApp->thread());
"""
QT_PROC_REPLACE = """    SolarMutexReleaser aReleaser;
    {
        // ⚠ ここまで来ていれば、止まっているのは Qt の event 待ちのほうである
        static int nPkc3Proc = 0;
        if (nPkc3Proc < 5)
        {
            ++nPkc3Proc;
            pkc3_idles_trace("yield:proc", -1, -1, nPkc3Proc);
        }
    }
    QAbstractEventDispatcher* dispatcher = QAbstractEventDispatcher::instance(qApp->thread());
"""

QT_ENTER_ANCHOR = """bool QtInstance::DoYield(bool bWait, bool bHandleAllCurrentEvents)
{
    bool bWasEvent = false;
"""
QT_ENTER_REPLACE = """bool QtInstance::DoYield(bool bWait, bool bHandleAllCurrentEvents)
{
    {
        // ⚠ 高頻度なので自前の上限を持つ(共有の 300 を食い潰さない)
        static int nPkc3Yield = 0;
        if (nPkc3Yield < 5)
        {
            ++nPkc3Yield;
            pkc3_idles_trace("yield:enter",
                             qApp->thread() == QThread::currentThread() ? 1 : 0,
                             bWait ? 1 : 0, nPkc3Yield);
        }
    }
    bool bWasEvent = false;
"""
QT_PROXY_ANCHOR = """    else if (pthread_self() == m_emscriptenThreadingData->eventHandlerThread)
    {
        SolarMutexReleaser release;
"""
QT_PROXY_REPLACE = """    else if (pthread_self() == m_emscriptenThreadingData->eventHandlerThread)
    {
        // 🔑 枝 B ── 主スレッドへ proxy して promise を待つ。**返らなければここ**
        pkc3_idles_trace("yield:proxy", -1, -1, -1);
        SolarMutexReleaser release;
"""
QT_WAIT_ANCHOR = """        if (!bWasEvent && bWait)
        {
            m_aWaitingYieldCond.reset();
            SolarMutexReleaser aReleaser;
            m_aWaitingYieldCond.wait();
            bWasEvent = true;
        }
    }
    return bWasEvent;
}
"""
QT_WAIT_REPLACE = """        if (!bWasEvent && bWait)
        {
            // 🔑 枝 C ── `m_aWaitingYieldCond` は枝 A でしか set されない。
            //    ⚠ `yield:wait` が出て `yield:woke` が出なければ、**ここで止まっている**
            pkc3_idles_trace("yield:wait", -1, -1, -1);
            m_aWaitingYieldCond.reset();
            SolarMutexReleaser aReleaser;
            m_aWaitingYieldCond.wait();
            pkc3_idles_trace("yield:woke", -1, -1, -1);
            bWasEvent = true;
        }
    }
    {
        static int nPkc3Ret = 0;
        if (nPkc3Ret < 5)
        {
            ++nPkc3Ret;
            pkc3_idles_trace("yield:ret", bWasEvent ? 1 : 0, -1, nPkc3Ret);
        }
    }
    return bWasEvent;
}
"""

HELPER_TARGETS = (
    (SCHED_SRC, "Scheduler::IdlesLockGuard::IdlesLockGuard()\n{\n"),
    (APP_SRC, "void Application::Execute()\n{\n"),
    # 🔴 **`ImplYield` は `DoYield` より前に在る**(454 行 vs 475 行)。
    #    ⚠ ヘルパーを `DoYield` の直前へ入れると、`ImplYield` から呼べない
    #    (宣言より前で使うことになる)。**先に在るほうへ入れる。**
    (QT_SRC, "bool QtInstance::ImplYield(bool bWait, bool bHandleAllCurrentEvents)\n{\n"),
)
# ⚠ ヘルパーは TU ごとに 1 つ要る ── 当てる先が 2 file なので 2 つ入る。
TARGETS = (
    (SCHED_SRC, SCHED_ANCHOR, SCHED_REPLACE),
    (APP_SRC, APP_ANCHOR, APP_REPLACE),
    (QT_SRC, QT_ENTER_ANCHOR, QT_ENTER_REPLACE),
    (QT_SRC, QT_PROXY_ANCHOR, QT_PROXY_REPLACE),
    (QT_SRC, QT_WAIT_ANCHOR, QT_WAIT_REPLACE),
    (QT_SRC, QT_IMPL_ANCHOR, QT_IMPL_REPLACE),
    (QT_SRC, QT_PROC_ANCHOR, QT_PROC_REPLACE),
)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-idles-trace.py <lo-core-dir>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    on = os.environ.get("PKC3_IDLES_TRACE") == "1"

    # ⚠ **錨の検査は門の外でやる**(門の下に隠すと上流の変形に誰も気づけない)。
    # ⚠ ヘルパーの当て先も**同じ厳しさ**で見る(こちらが外れると compile out ではなく
    #    「ヘルパーが無いのに呼ぶ」= リンク不能になる)。
    for src, anchor in HELPER_TARGETS:
        path = root / src
        if not path.exists():
            print(f"ERROR: {src} が無い({path})", file=sys.stderr)
            return 1
        hits = path.read_text(encoding="utf-8").count(anchor)
        if hits != 1:
            print(
                f"ERROR: ヘルパーの錨が {hits} 件({src})── 上流が形を変えた",
                file=sys.stderr,
            )
            return 1
    for src, anchor, _replace in TARGETS:
        path = root / src
        if not path.exists():
            print(f"ERROR: {src} が無い({path})", file=sys.stderr)
            return 1
        text = path.read_text(encoding="utf-8")
        if "pkc3_idles_trace" in text:
            print(f"ERROR: {src} に既に計装が入っている(二重当て)", file=sys.stderr)
            return 1
        hits = text.count(anchor)
        if hits != 1:
            print(
                f"ERROR: 錨が {hits} 件({src})── 上流が形を変えた。当て先を読み直すこと",
                file=sys.stderr,
            )
            return 1

    if not on:
        print(
            f"skip: PKC3_IDLES_TRACE!=1"
            f"(錨は {len(HELPER_TARGETS)} + {len(TARGETS)} 件とも在ることを確かめた)"
        )
        return 0

    # ⚠ **ヘルパーを先に**(本体の置換より前)── 順が逆でも結果は同じだが、
    #    「呼ぶ側だけ入ってヘルパーが無い」中間状態を作らない。
    for src, anchor in HELPER_TARGETS:
        path = root / src
        path.write_text(
            path.read_text(encoding="utf-8").replace(anchor, HELPER + "\n" + anchor, 1),
            encoding="utf-8",
        )
    for src, anchor, replace in TARGETS:
        path = root / src
        path.write_text(
            path.read_text(encoding="utf-8").replace(anchor, replace, 1), encoding="utf-8"
        )
        # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は
        #    全部通り、CI 全緑のまま計装が artifact に 1 バイトも入らない)
        if "pkc3_idles_trace" not in path.read_text(encoding="utf-8"):
            print(f"ERROR: 書き戻し後の {src} に計装が無い(write が落ちている)", file=sys.stderr)
            return 1
        print(f"patched: {src}(#199 の計装)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
