#!/usr/bin/env python3
"""#121 の**計装**(3 本目)。popup の「コピー」をマウスで選んだ回だけ、約 10.2 秒後に
`libc++abi: terminating`(型名の無い = JS 例外)が `SalUserEventList::DispatchUserEvents` の
`noexcept` lambda から出る。**どの user event が落ちているのか・誰が積んだのか**を割る。

🔴 **これは直しではない。** 挙動は 1 つも変えない(**足すだけ**で、原文の行は 1 行も置き換えない)。
⚠ **既定では 1 バイトも書き換えない**(`PKC3_UEV_TRACE=1` の回だけ)が、錨の検査は毎回する
(門の下に隠すと上流の変形に誰も気づけない ── `patch-lo-menu-trace.py` と同じ作法)。

## 読んで分かっていること(上流原文 sha 0c031979)

- `Application::PostUserEvent`(`svapp.cxx`)は `ImplSVEvent` を作って `PostEvent` する。戻り値の
  `pTmpEvent` は、後で `SalUserEvent::m_pData` として**同じ値**が `DispatchUserEvents` に現れる
  (`SalEvent::UserEvent` のとき `m_pData` が `ImplSVEvent*`)。⚠ つまり `a=` を突き合わせれば
  **積んだ側と処理する側が結べる**。
- `DispatchUserEvents` は `ProcessEvent` を **`noexcept` の lambda** で呼ぶ ── 中で JS 例外が出れば
  `std::terminate` になる。⚠ 落ちたら `done` は出ない(= それが「この event で落ちた」の印)。

## 読み方

    PKC3-UEV <where> a=<ImplSVEvent など> b=<pthread_self> c=<where ごと> d=<where ごと>

| where | a | c | d |
|---|---|---|---|
| `post` | 積んだ `ImplSVEvent*` | 0 | 0 |
| `dispatch` | `m_pData`(UserEvent なら `post` の `a` と同じ) | `SalEvent` の値 | UserEvent なら `mbCall`(1 / 0)、他は -1 |
| `done` | `m_pData` | `SalEvent` の値 | 0 |
| `post-stack` / `dispatch-stack` | 同上 | ── | ── |

🔑 **`dispatch` があって `done` が無い event が、落ちた event である。** その `a` を `post` /
`post-stack` の `a` と突き合わせれば、誰が積んだか(C stack)が読める。
⚠ `*-stack` は `emscripten_log(EM_LOG_C_STACK)` が出す**改行入りの 1 message**(probe は ASCII だけ残す)。
出す条件は**2 つ重ねる**: ①**最初の呼び出しから 12 秒以上**(起動時の大量の post で枠を使い切らない)
②**出した回数が上限未満**(`post-stack` 600 / `dispatch-stack` 300)。
⚠ `post` / `dispatch` / `done` の 1 行の印も**同じ 12 秒の門**を通る(`pkc3_uev_line`。回数の上限 20000 は別)。
起動時の大量の event は要らない ── 出すと probe の枠(`clipTrace`)を使い切って、肝心の popup 付近が落ちる。

## 錨の選び方 ── ⚠ `patch-lo-idles-trace.py` と重ならない

あちらは `salusereventlist.cxx` の `auto process = …;` と `process();` の 2 行(隣り合っている)を
**置き換える**。こちらは**その 2 行の外**に錨を置く: `dispatch` は直前の `/* Current policy …` の注釈の前、
`done` は `#endif` の後(`aResettableListGuard.lock();` の前)。⚠ `process();` の直前・直後へ入れる形にすると、
あちらの錨(2 行が隣り合っていること)を壊す。**どちらの順で当てても出力は同一**
(`tests/office-uev-trace-patch.test.ts` が見る)。

## #1344 の判別用 5 種(2026-10-05 に足した。⚠ 同じ patch の拡張で、新しい patch ではない)

マウスで popup を選んだ後、user event の処理が 10〜12 秒止まる。LO 側の経路(`PostUserEvent` →
`QtInstance::TriggerUserEventProcessing` → `wakeUp()` / drain は `ImplYield` の `DispatchUserEvents` だけ)は
マウスとキーボードで同じ。仮説は 3 本:①起こしが食われ、外側の `processEvents(WaitForMoreEvents)` が起きない
②main の `ImplYield` は動くが、drain する caller が別物(Qt callback の中の Yield)③LO thread 側の
`DoYield` 枝 B の `emscripten_promise_await` が resume しない。**この 5 種で 3 本が割れる**。

    PKC3-UEV <kind> tid=<pthread_self を %p> x=<> y=<> z=<> ms=<> in=<>      (-1 = 使わない欄)

| kind | file | x / y / z | ms / in | 出す条件(上限) |
|---|---|---|---|---|
| `wake` | `QtInstance.cxx` `TriggerUserEventProcessing` の `wakeUp()` の直前 | -1 / -1 / -1 | -1 / -1 | 12 秒の門(2000 行) |
| `yield-in` | 同 `ImplYield`(⚠ 入口の 4 行は idles-trace の錨なので、**`DispatchUserEvents` の直後**) | nest / bWait / bHandleAll | -1 / 入った時刻 | **nest ≥ 2** + 12 秒の門(3000 行) |
| `yield-out` | 同(RAII なので early return でも出る) | nest / bWait / bHandleAll | 滞在 ms / 入った時刻 | **nest ≥ 2 か 滞在 ≥ 1000 ms** + 12 秒の門(3000 行) |
| `wait-out` | 同 `processEvents(WaitForMoreEvents)` の前後 | bHandleAll / 返り値 / -1 | 待った ms / 入る前の時刻 | **待った ≥ 1000 ms** + 12 秒の門(600 行)。⚠ `wait-in` の行は出さない(同じ行の `in=` が対) |
| `proxy-out` | 同 `DoYield` 枝 B の `emscripten_promise_await` の前後 | -1 / -1 / -1 | 待った ms / 入る前の時刻 | **待った ≥ 1000 ms** + 12 秒の門(600 行)。⚠ `proxy-in` の行は出さない(同上) |
| `exec-ret` | `QtMenu.cxx` `ShowNativePopupMenu` の `mpQMenu->exec(...)` の直後 | -1 / -1 / -1 | -1 / -1 | 門なし(200 行 ── popup は稀で、この TU の時計は最初の呼び出しで始まるので 12 秒の門は置けない) |

⚠ **「≥ 1000 ms」「nest ≥ 2」は、行数を抑えるための門**であって、「測っていない数で断る」ための閾値ではない
(毎 loop の `yield-in/out` で枠を溢れさせない)。
⚠ **12 秒の門は TU ごとに時計を持つ**(`pkc3_uev_elapsed_ms` は `static`)── `QtInstance.cxx` の時計は最初の
`ImplYield` で始まるので起動の頭。`QtMenu.cxx` の時計は最初の呼び出しで始まるので、**`exec-ret` だけ門を置かない**。
⚠ **`exec-ret` に「戻り値が null か」は載せられない** ── 戻り値を受けるには `mpQMenu->exec(...)` の行を置き換える
必要があり、その行は `patch-lo-menu-trace.py` の錨(`EXEC_ANCHOR`)と同じ。**錨を交えない**ために、直後に挿す
だけにした。戻り値は menu-trace の `exec:return`(`d=`)が出している(同じ probe の clipTrace に並ぶ)。
⚠ **`yield-in` の位置**:`ImplYield` の入口 4 行(シグネチャ〜`DispatchUserEvents`)は idles-trace の錨
(`QT_IMPL_ANCHOR`)なので、**`DispatchUserEvents` の中で起きた入れ子はこの深さに数えない**
(Qt の callback ── popup の `exec()` の入れ子の loop ── の中の Yield は `processEvents` の中なので数える)。
⚠ **`wait-out` / `proxy-out` が出ない = 返っていない、ではない**(出す条件は ≥ 1000 ms)。
返らない回の行は出ない ── 他の印(`dispatch` があって `done` が無い形など)で読む。

## 錨の選び方(5 種)── ⚠ idles-trace / menu-trace と重ならない

- `QtInstance.cxx` の idles-trace の錨は `ImplYield` の入口 4 行 / `SolarMutexReleaser…dispatcher` の 2 行 /
  `DoYield` の入口 / 枝 B の `else if…SolarMutexReleaser release;` / 枝 C の `if (!bWasEvent && bWait)…return`。
  こちらは**その間**に置く: ヘルパーは `CreateSalSystem` の 1 行の前、`yield` は `if (!bHandleAllCurrentEvents && wasEvent)`
  の前、`wait` は `if (bWait && !wasEvent)…AllEvents…` の 4 行を**そのまま残して**前後へ、`proxy` は
  `(void)emscripten_promise_await(emscripten_proxy_promise(` の 1 行の前と、その式の最後の行の後ろ、`wake` は
  `dispatcher->wakeUp();` の前。
- `QtMenu.cxx` の menu-trace の錨は `slotMenuTriggered` / `assert(mpQMenu);` / `exec(...)` の 1 行 /
  `if (!pQItem)…` / `HandleMenuCommandEvent`。こちらのヘルパーは `ShowNativePopupMenu` のシグネチャの 1 行目の前、
  `exec-ret` は exec の次の空行以降(`return true;` の前)。
- どちらの順で当てても出力は同一(`tests/office-uev-trace-patch.test.ts` が見る)。

## 出口は libc だけ(+ `emscripten_log`)

stderr + `/tmp/pkc3-uev.log`。embind / DOM / Qt の API をここから呼ばない
(LO の文脈から `emscripten::val` を触ると `invalid handle` で abort する ── 2026-08-15)。
⚠ `emscripten_log` は `#ifdef __EMSCRIPTEN__` の中だけ(非 Emscripten の g++ 単体コンパイルは no-op)。
"""

import os
import sys
from pathlib import Path

MARK = "// PKC3-UEV"

# ⚠ **部品から組む**(`str.replace` で版を作ると同じ形が複数在って再定義になる ── 2026-08-24 に踏んだ)。
# ⚠ `check-patch-scope.py` が `namespace\n{\nvoid pkc3_uev_trace(` の形を探す ── **入口の関数を 2 つ目の塊の先頭**に置く
#   (経過時間の関数は、その前の別の塊)。
# ⚠ `check-trace-helpers-compile.py` が `pkc3_uev_trace("t:probe", 1, 2, 3)` で呼ぶ
#   (3 つの整数 → `a` / `c` / `d`。tid は menu-trace と同じく**関数の中で** `pthread_self` から取る)。
# ⚠ `#include <pthread.h>` は**無条件**(`pthread_t` が整数 / pointer のどちらでも通ることを手元の検査が当てられるように)。
HELPER = """// PKC3-UEV-HELPER-BEGIN
// ── PKC3 #121 の計装(挙動は変えない。`PKC3_UEV_TRACE=1` の回だけ入る)──
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <pthread.h>
#include <time.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif
namespace
{
// 最初の呼び出しからの経過ミリ秒(単調時計)。⚠ 最初に呼んだ回が 0 ── 起点は「最初の trace」
long long pkc3_uev_elapsed_ms()
{
    static long long nFirst = -1;
    struct timespec aTs;
    clock_gettime(CLOCK_MONOTONIC, &aTs);
    const long long nNow = static_cast<long long>(aTs.tv_sec) * 1000LL + aTs.tv_nsec / 1000000LL;
    long long nExpected = -1;
    __atomic_compare_exchange_n(&nFirst, &nExpected, nNow, false, __ATOMIC_RELAXED, __ATOMIC_RELAXED);
    return nNow - __atomic_load_n(&nFirst, __ATOMIC_RELAXED);
}

// 最初の呼び出しから 12 秒以上経ったか。⚠ 1 行の印(`pkc3_uev_line`)も C stack も同じ門を通る ──
// 起動時の大量の event を出さない(出すと probe の枠を使い切り、肝心の popup 付近が落ちる)。
bool pkc3_uev_late()
{
    return pkc3_uev_elapsed_ms() >= 12000;
}
}
namespace
{
void pkc3_uev_trace(const char* what, unsigned long long a, int c, int d)
{
    static int nSeq = 0;
    // ⚠ 上限を置く ── event は何度も来るので、置かないと log が膨らむ
    if (__atomic_add_fetch(&nSeq, 1, __ATOMIC_RELAXED) > 20000)
        return;
    // pthread_t is an integer on emscripten and a pointer elsewhere: copy the bytes, never cast.
    unsigned long long nTid = 0;
    pthread_t aSelf = pthread_self();
    std::memcpy(&nTid, &aSelf, sizeof aSelf < sizeof nTid ? sizeof aSelf : sizeof nTid);
    char line[192];
    // ⚠ 書式はリテラル(`-Wformat-nonliteral` を踏まない)
    std::snprintf(line, sizeof line, "PKC3-UEV %s a=%p b=%llu c=%d d=%d\\n", what,
                  reinterpret_cast<void*>(static_cast<std::uintptr_t>(a)), nTid, c, d);
    std::fputs(line, stderr);
    std::fflush(stderr);
    std::FILE* pLog = std::fopen("/tmp/pkc3-uev.log", "a");
    if (pLog)
    {
        std::fputs(line, pLog);
        std::fclose(pLog);
    }
}

// 呼び側が使う 1 行の印。⚠ **12 秒の門を通る**(上限 20000 は `pkc3_uev_trace` の中)。起点は**最初にここを通った回**。
// 門を `pkc3_uev_trace` の中に置かないのは、`check-trace-helpers-compile.py` が入口を直接呼んで 1 行出ることを見るため。
[[maybe_unused]] void pkc3_uev_line(const char* what, unsigned long long a, int c, int d)
{
    if (!pkc3_uev_late())
        return;
    pkc3_uev_trace(what, a, c, d);
}

// pointer を整数へ(`%p` で出すため)
[[maybe_unused]] unsigned long long pkc3_uev_ptr(const void* p)
{
    return static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(p));
}

// C stack を 1 message で出す。⚠ 条件を 2 つ重ねる: ①最初の呼び出しから 12 秒以上 ②出した回数が nMax 未満。
// 時間の判定が先 ── 先に数えると、起動時の post で枠を使い切る。
// ⚠ Emscripten 以外(g++ 単体コンパイル)では何もしない。
[[maybe_unused]] void pkc3_uev_stack([[maybe_unused]] const char* what, [[maybe_unused]] unsigned long long a,
                                     int nMax)
{
    static int nShown = 0;
    if (!pkc3_uev_late())
        return;
    if (__atomic_fetch_add(&nShown, 1, __ATOMIC_RELAXED) >= nMax)
        return;
#ifdef __EMSCRIPTEN__
    emscripten_log(EM_LOG_CONSOLE | EM_LOG_C_STACK | EM_LOG_NO_PATHS, "PKC3-UEV %s a=%p", what,
                   reinterpret_cast<void*>(static_cast<std::uintptr_t>(a)));
#endif
}

// ── #1344 の判別用(wake / yield-in / yield-out / wait-out / proxy-out / exec-ret)──
// 1 行: `PKC3-UEV <kind> tid=%p x=%d y=%d z=%d ms=%lld in=%lld`(使わない欄は -1)。
// ⚠ 上限(`nMax`)は kind ごとの counter で数える。門(12 秒 / 1000 ms / nest)は呼ぶ前に済ませる。
[[maybe_unused]] void pkc3_uev_mark(const char* what, int* pnShown, int nMax, int x, int y, int z,
                                    long long nMs, long long nInMs)
{
    if (__atomic_add_fetch(pnShown, 1, __ATOMIC_RELAXED) > nMax)
        return;
    unsigned long long nTid = 0;
    pthread_t aSelf = pthread_self();
    std::memcpy(&nTid, &aSelf, sizeof aSelf < sizeof nTid ? sizeof aSelf : sizeof nTid);
    char line[192];
    std::snprintf(line, sizeof line, "PKC3-UEV %s tid=%p x=%d y=%d z=%d ms=%lld in=%lld\\n", what,
                  reinterpret_cast<void*>(static_cast<std::uintptr_t>(nTid)), x, y, z, nMs, nInMs);
    std::fputs(line, stderr);
    std::fflush(stderr);
    std::FILE* pLog = std::fopen("/tmp/pkc3-uev.log", "a");
    if (pLog)
    {
        std::fputs(line, pLog);
        std::fclose(pLog);
    }
}

// 起こし(`wakeUp()` の直前)。12 秒の門を通る(起動時の大量の post で枠を使い切らない)。
[[maybe_unused]] void pkc3_uev_wake()
{
    static int nShown = 0;
    if (!pkc3_uev_late())
        return;
    pkc3_uev_mark("wake", &nShown, 2000, -1, -1, -1, -1, -1);
}

// 待ちの出口。nInMs(入る前の `pkc3_uev_elapsed_ms()`)から **1000 ms 以上**のときだけ 1 行(入る前の時刻を同じ行に載せる)。
// ⚠ 1000 ms は行数を抑える門で、測っていない数で断るためではない。
[[maybe_unused]] void pkc3_uev_wait_out(long long nInMs, int nAll, int nRet)
{
    static int nShown = 0;
    const long long nMs = pkc3_uev_elapsed_ms() - nInMs;
    if (nMs < 1000 || !pkc3_uev_late())
        return;
    pkc3_uev_mark("wait-out", &nShown, 600, nAll, nRet, -1, nMs, nInMs);
}

// `DoYield` 枝 B の `emscripten_promise_await` の出口。条件は `pkc3_uev_wait_out` と同じ(別枠 600)。
[[maybe_unused]] void pkc3_uev_proxy_out(long long nInMs)
{
    static int nShown = 0;
    const long long nMs = pkc3_uev_elapsed_ms() - nInMs;
    if (nMs < 1000 || !pkc3_uev_late())
        return;
    pkc3_uev_mark("proxy-out", &nShown, 600, -1, -1, -1, nMs, nInMs);
}

// `mpQMenu->exec(...)` が返った直後。⚠ 12 秒の門は置かない(popup は稀。この TU の時計は最初の呼び出しで始まる)。
[[maybe_unused]] void pkc3_uev_exec_ret()
{
    static int nShown = 0;
    pkc3_uev_mark("exec-ret", &nShown, 200, -1, -1, -1, -1, -1);
}

// `ImplYield` の入口〜出口(RAII ── early return でも出口が出る)。入れ子の深さは thread ごと。
// 入口: nest ≥ 2 のときだけ。出口: nest ≥ 2 か 滞在 ≥ 1000 ms のときだけ(毎 loop の行で枠を溢れさせない)。
struct Pkc3UevYieldScope
{
    int mnNest;
    int mnWait;
    int mnAll;
    long long mnInMs;
    static int& depth()
    {
        thread_local int nDepth = 0;
        return nDepth;
    }
    Pkc3UevYieldScope(bool bWait, bool bAll)
        : mnNest(++depth())
        , mnWait(bWait ? 1 : 0)
        , mnAll(bAll ? 1 : 0)
        , mnInMs(pkc3_uev_elapsed_ms())
    {
        static int nShown = 0;
        if (mnNest >= 2 && pkc3_uev_late())
            pkc3_uev_mark("yield-in", &nShown, 3000, mnNest, mnWait, mnAll, -1, mnInMs);
    }
    ~Pkc3UevYieldScope()
    {
        static int nShown = 0;
        const long long nMs = pkc3_uev_elapsed_ms() - mnInMs;
        --depth();
        if ((mnNest >= 2 || nMs >= 1000) && pkc3_uev_late())
            pkc3_uev_mark("yield-out", &nShown, 3000, mnNest, mnWait, mnAll, nMs, mnInMs);
    }
    Pkc3UevYieldScope(const Pkc3UevYieldScope&) = delete;
    Pkc3UevYieldScope& operator=(const Pkc3UevYieldScope&) = delete;
};
}
// PKC3-UEV-HELPER-END
"""

# ── ① vcl/source/app/svapp.cxx ──────────────────────────────────────────────
APP_SRC = "vcl/source/app/svapp.cxx"
# ヘルパーは `PostUserEvent` の直前(file scope)。使う所はその後ろ。
APP_HELPER_ANCHOR = "ImplSVEvent * Application::PostUserEvent( const Link<void*,void>& rLink, void* pCaller,\n"

# 積んだ直後(`PostEvent` に渡す前 ── `std::move` の後は `pSVEvent` を触らない)。原文の行は残す。
POST_ANCHOR = """    auto pTmpEvent = pSVEvent.get();
"""
POST_REPLACE = f"""    auto pTmpEvent = pSVEvent.get();
    pkc3_uev_line("post", pkc3_uev_ptr(pTmpEvent), 0, 0); {MARK}
    pkc3_uev_stack("post-stack", pkc3_uev_ptr(pTmpEvent), 600); {MARK}
"""

# ── ② vcl/source/app/salusereventlist.cxx ───────────────────────────────────
EVL_SRC = "vcl/source/app/salusereventlist.cxx"
# ヘルパーはコンストラクタの直前(file scope)。⚠ `patch-lo-idles-trace.py` は `DispatchUserEvents` の直前へ入れる ── 重ならない。
EVL_HELPER_ANCHOR = "SalUserEventList::SalUserEventList()\n"

# 🔑 処理する側の入口。`process();` の**前**で、`/* Current policy …` の注釈の前に置く。
# ⚠ `auto process = …; process();` の 2 行は触らない(`patch-lo-idles-trace.py` の錨)。
DISPATCH_ANCHOR = """            /*
            * Current policy is that scheduler tasks aren't allowed to throw an exception.
"""
DISPATCH_REPLACE = (
    f"""            if (aEvent.m_nEvent == SalEvent::UserEvent) {MARK}
                pkc3_uev_stack("dispatch-stack", pkc3_uev_ptr(aEvent.m_pData), 300); {MARK}
            pkc3_uev_line("dispatch", pkc3_uev_ptr(aEvent.m_pData), static_cast<int>(aEvent.m_nEvent), {MARK}
                           aEvent.m_nEvent == SalEvent::UserEvent && aEvent.m_pData {MARK}
                               ? (static_cast<ImplSVEvent*>(aEvent.m_pData)->mbCall ? 1 : 0) {MARK}
                               : -1); {MARK}
"""
    + DISPATCH_ANCHOR
)

# 🔴 決め手: `process()` が**返った**後。terminate したらここへ来ない ── `done` が無い `dispatch` が落ちた event。
# ⚠ `#endif`(`#ifdef IOS` の閉じ)の**後**に置く ── IOS の枝は触らず、両方の枝の後に 1 回だけ出る。
DONE_ANCHOR = """#endif
            aResettableListGuard.lock();
            if (!bHandleAllCurrentEvents)
                break;
"""
DONE_REPLACE = f"""#endif
            pkc3_uev_line("done", pkc3_uev_ptr(aEvent.m_pData), static_cast<int>(aEvent.m_nEvent), 0); {MARK}
            aResettableListGuard.lock();
            if (!bHandleAllCurrentEvents)
                break;
"""

# ── ③ vcl/qt5/QtInstance.cxx(#1344 の判別用)─────────────────────────────────
QTI_SRC = "vcl/qt5/QtInstance.cxx"
# ヘルパーは `CreateSalSystem` の 1 行の前(file scope)。⚠ idles-trace のヘルパーは `ImplYield` の入口(その次の関数)
# ── 錨は交わらない。使う所(`ImplYield` / `DoYield` / `TriggerUserEventProcessing`)はどれもその後ろ。
QTI_HELPER_ANCHOR = "SalSystem* QtInstance::CreateSalSystem() { return new QtSystem; }\n"

# 🔑 `ImplYield` の入口 4 行(シグネチャ〜`DispatchUserEvents`)は idles-trace の錨なので、その**次の 2 行**を錨にする。
# RAII の 1 行を前に足すだけ(原文の 2 行はそのまま)。⚠ early return でも出口が出る。
YIELD_ANCHOR = """    if (!bHandleAllCurrentEvents && wasEvent)
        return true;
"""
YIELD_REPLACE = (
    f"    Pkc3UevYieldScope aPkc3UevYield(bWait, bHandleAllCurrentEvents); {MARK}\n" + YIELD_ANCHOR
)

# `if (bWait && !wasEvent) A; else B;` の 4 行を**そのまま残し**、前に入る前の時刻、後ろに出口を足す。
# ⚠ 出口の `if` は else の文の**後**(ぶら下がらない)。
WAIT_ANCHOR = """    if (bWait && !wasEvent)
        wasEvent = dispatcher->processEvents(QEventLoop::WaitForMoreEvents);
    else
        wasEvent = dispatcher->processEvents(QEventLoop::AllEvents) || wasEvent;
"""
WAIT_REPLACE = (
    f"    const long long nPkc3UevWaitIn = (bWait && !wasEvent) ? pkc3_uev_elapsed_ms() : -1; {MARK}\n"
    + WAIT_ANCHOR
    + f"    if (nPkc3UevWaitIn >= 0) {MARK}\n"
    + f"        pkc3_uev_wait_out(nPkc3UevWaitIn, bHandleAllCurrentEvents ? 1 : 0, wasEvent ? 1 : 0); {MARK}\n"
)

# `DoYield` 枝 B。式の**前**に入る前の時刻、**後**に出口。⚠ idles-trace の錨(`else if…SolarMutexReleaser release;`)の外。
PROXY_IN_ANCHOR = """        (void)emscripten_promise_await(emscripten_proxy_promise(
"""
PROXY_IN_REPLACE = f"        const long long nPkc3UevProxyIn = pkc3_uev_elapsed_ms(); {MARK}\n" + PROXY_IN_ANCHOR
PROXY_OUT_ANCHOR = """            &o3tl::temporary<Args>({ this, bWait, bHandleAllCurrentEvents, bWasEvent })));
"""
PROXY_OUT_REPLACE = PROXY_OUT_ANCHOR + f"        pkc3_uev_proxy_out(nPkc3UevProxyIn); {MARK}\n"

# 起こし。`wakeUp()` の直前。
WAKE_ANCHOR = """    dispatcher->wakeUp();
"""
WAKE_REPLACE = f"    pkc3_uev_wake(); {MARK}\n" + WAKE_ANCHOR

# ── ④ vcl/qt5/QtMenu.cxx(#1344 の判別用)───────────────────────────────────────
QTM_SRC = "vcl/qt5/QtMenu.cxx"
# ヘルパーは `ShowNativePopupMenu` のシグネチャの 1 行目の前。⚠ menu-trace のヘルパーは `slotMenuTriggered` の前。
QTM_HELPER_ANCHOR = "bool QtMenu::ShowNativePopupMenu(FloatingWindow* pWin, const tools::Rectangle& rRect,\n"
# `exec(...)` の**直後**。⚠ exec の行そのものは menu-trace の錨(`EXEC_ANCHOR`)なので、**次の空行以降**を錨にして前へ挿す。
EXECRET_ANCHOR = """
    return true;
}
"""
EXECRET_REPLACE = f"    pkc3_uev_exec_ret(); {MARK}\n" + EXECRET_ANCHOR

# 🔑 足した行は**全部、行末が印**で、原文の行は 1 行も置き換えない
# (test が「印の行を除くと原文一致」を見る ── `tests/office-uev-trace-patch.test.ts`)。
HELPER_TARGETS = (
    (APP_SRC, APP_HELPER_ANCHOR, HELPER),
    (EVL_SRC, EVL_HELPER_ANCHOR, HELPER),
    (QTI_SRC, QTI_HELPER_ANCHOR, HELPER),
    (QTM_SRC, QTM_HELPER_ANCHOR, HELPER),
)
TARGETS = (
    (APP_SRC, POST_ANCHOR, POST_REPLACE),
    (EVL_SRC, DISPATCH_ANCHOR, DISPATCH_REPLACE),
    (EVL_SRC, DONE_ANCHOR, DONE_REPLACE),
    (QTI_SRC, WAKE_ANCHOR, WAKE_REPLACE),
    (QTI_SRC, YIELD_ANCHOR, YIELD_REPLACE),
    (QTI_SRC, WAIT_ANCHOR, WAIT_REPLACE),
    (QTI_SRC, PROXY_IN_ANCHOR, PROXY_IN_REPLACE),
    (QTI_SRC, PROXY_OUT_ANCHOR, PROXY_OUT_REPLACE),
    (QTM_SRC, EXECRET_ANCHOR, EXECRET_REPLACE),
)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-uev-trace.py <lo-core-dir>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    on = os.environ.get("PKC3_UEV_TRACE") == "1"

    # ⚠ **錨の検査は門の外でやる**(門の下に隠すと上流の変形に誰も気づけない)。
    # ⚠ 同じ file を複数回触るので、読み込みは 1 度にして in-memory で順に当てる。
    texts: dict[str, str] = {}
    for src in (APP_SRC, EVL_SRC, QTI_SRC, QTM_SRC):
        path = root / src
        if not path.exists():
            print(f"ERROR: {src} が無い({path})", file=sys.stderr)
            return 1
        texts[src] = path.read_text(encoding="utf-8")
        # ⚠ 二重当ては止める(冪等ではない ── ヘルパーが 2 つ入る)。file は触らない。
        if "pkc3_uev_trace" in texts[src]:
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
            f"skip: PKC3_UEV_TRACE!=1(錨 {len(TARGETS)} 件 + ヘルパー {len(HELPER_TARGETS)} 件を確かめた)"
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
        if "pkc3_uev_trace" not in path.read_text(encoding="utf-8"):
            print(f"ERROR: 書き戻し後の {src} に計装が無い(write が落ちている)", file=sys.stderr)
            return 1
        print(f"patched: {src}(#121 の計装)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
