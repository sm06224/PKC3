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

# 🔑 足した行は**全部、行末が印**で、原文の行は 1 行も置き換えない
# (test が「印の行を除くと原文一致」を見る ── `tests/office-uev-trace-patch.test.ts`)。
HELPER_TARGETS = (
    (APP_SRC, APP_HELPER_ANCHOR, HELPER),
    (EVL_SRC, EVL_HELPER_ANCHOR, HELPER),
)
TARGETS = (
    (APP_SRC, POST_ANCHOR, POST_REPLACE),
    (EVL_SRC, DISPATCH_ANCHOR, DISPATCH_REPLACE),
    (EVL_SRC, DONE_ANCHOR, DONE_REPLACE),
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
    for src in (APP_SRC, EVL_SRC):
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
