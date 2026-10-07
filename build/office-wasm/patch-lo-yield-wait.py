#!/usr/bin/env python3
"""main スレッドが `QtYieldMutex::doAcquire` で LO スレッドの鍵(SolarMutex)を**待ち始めた所と、待ち終えた所**に印を置く(#1408 の計装)。

## 症状(user の身に起きること)

Impress を読み込んでいる最中(ページ開始から 13 秒前後)に、30 回に 1 回、**何も出さずに固まる**(「Office が停止しました」も出ない)。
#1408 の計器入りの一式で分かったこと:固まる直前まで main スレッドの timer(`QtTimer::timeoutActivated`、`patch-lo-timer-mutex.py`)は
`tryToAcquire` に失敗して skip し続け(#400 回まで)、その後 **timer の張り直し(`m_aTimer.start(1)`)自体が止まる**。
つまり **main の Qt event loop が回らなくなった**(timer の関数が返っていないのではなく、その手前で main が別の物に捕まっている)。

## 🟡 読んでいること(推測。実機では未確認)── main の別の入口が `doAcquire` の `wait` で戻らない

`vcl/qt5/QtInstance.cxx`(上流 `d6226c1a`)の `QtYieldMutex::doAcquire` は、main スレッドから呼ばれたとき次の形(原文の 142〜185 行):

    do // main thread acquire...
    {
        std::function<void()> func;
        {
            std::unique_lock<std::mutex> g(m_RunInMainMutex);
            if (m_aMutex.tryToAcquire()) { ...; break; }                 // 取れた → 抜ける
            m_InMainCondition.wait(g, [this]() { return m_isWakeUpMain; });   // ← ここ。LO スレッドが起こすまで**無期限に待つ**
            m_isWakeUpMain = false;
            std::swap(func, m_Closure);
        }
        if (func) { ...closure を main で走らせる... }
    } while (true);

- `wait` は**述語つき**(= `while (!pred) wait(lock)` と同じ)なので、spurious wakeup では戻らない。起こすのは 2 か所だけ:
  `doRelease`(LO スレッドが鍵を**手放し切った**とき `m_isWakeUpMain = true` + `notify_all`)と、`RunInMainThread`(closure を積んだとき)。
- 🔴 だから LO スレッドが**鍵を握ったまま戻らず**、closure も積まなければ、main は**ここで永久に止まる**。
  main のあらゆる入口(paint / 入力 event / ImplYield / timer)が `SolarMutexGuard` を取るので、どれもここに来うる。
- `tryToAcquire` が偽 = **他のスレッドが持っている**ので、この枝へ来た時点で `held_by_lo=1` は構成上いつも真
  (main が持っていれば、`m_bNoYieldLock` の借り状態で先に返る / `SalYieldMutex::doAcquire` の再入)。印には載せるが情報はない。
  代わりに**入った時点の `m_isWakeUpMain`(`wake=`)と `m_Closure` の有無(`closure=`)**を載せる:
  `wake=1` なら `wait` は即戻る(待たない)/ `closure=1` なら積まれた closure が先に在る。

## 足す印(足すだけ。原文の行は 1 行も書き換えない)

| 印 | 置く所 | 中身 |
|---|---|---|
| `PKC3-YIELDWAIT: enter #N t=<ms> held_by_lo=1 wake=<0/1> closure=<0/1>` | `m_InMainCondition.wait` の**直前**(`tryToAcquire` が偽だった枝) | 待ち始めた時刻 |
| `PKC3-YIELDWAIT: leave #M (enter #N) t=<ms> waited=<ms> closure=<0/1>` | `std::swap(func, m_Closure);` の**直後**(`wait` から戻り、closure を取り出した後) | 待ち終えた時刻と**待った ms**。`closure=1` は戻った理由が closure(0 なら鍵の解放) |

- 🔑 **読み方**:固まった run の最後の行が `enter #N` で、同じ N の `leave` が**無い** = **main はその `wait` で止まっている**(決め手)。
  `leave` が出た後に何も出なくなったなら、main は別の所で止まっている(この印はそこを指さない)。
- 🔑 `wait` は述語つきで loop は**内側**(標準ライブラリの中)に在る。印は `wait` の**外側の前後**に置くので、起こされるたびには出ない。
  外側の `do { } while (true)` は closure を 1 つ走らせるたびに回るので、**1 回の `doAcquire` で `enter` / `leave` が複数組**出ることがある(正常)。
- 🔑 連番は **enter / leave で別に数える**(`nPkc3In` / `nPkc3Out`)。`leave` には自分の番号 `#M` と、対応する **enter の番号**を添える
  (`(enter #N)`)── 通常 `M == N` だが、**食い違えば**どこかで `wait` が例外で抜けた / 数え落とした合図になる。
- ⚠ 頻度:**最初の 3000 回までは毎回**出し、その後は 100 回ごと。**`waited` が 100 ms を超えた `leave` は回数に関わらず必ず出す**。
  固まる場面は 1 回で終わるので `enter` は毎回出したいが、1 起動で何回通るかは**測っていない**(`wait` に来るのは「main が鍵を取りに行って LO スレッドが
  持っていた」回 = `RunInMainThread` の closure 1 つごとに 1 回以上 ── 数百〜数千と読むが、🟡 推測)。3000 は
  「毎回出せる」と「stderr を溢れさせない」の折衷。⚠ **3000 回目より後に固まれば `enter` の行は 100 回に 1 回しか出ない** ──
  そのときは最後の `leave` の `#M` と、timer の最後の行(`PKC3-TIMERMUTEX: skipped #N … t=`)の時刻を突き合わせて読む。
- 🔴 **所有者の thread id は取れない**(`patch-lo-timer-mutex.py` と同じ理由。`m_nThreadId` は private で読み出し口が無い)。足さない。
- `nPkc3In` / `nPkc3Out` は `static`。⚠ **main スレッドだけ**が触る(`doAcquire` の main の枝。非 main は先頭で返る)ので atomic にしない。
- ⚠ **この箱では compile できない**。名前と型は原文を読んだだけ(`m_isWakeUpMain` / `m_Closure` は同じ class の member、
  `std::function` は `explicit operator bool`)。`<chrono>` と `<cstdio>` は無条件に足す(`patch-lo-timer-mutex.py` と同じ)。

## ⚠ 作法(錨と印は `patch-lo-timer-mutex.py` / `patch-lo-tooltip-guard.py` と同じ)

- **毎回当たる**(入力で gate しない)。錨が**ちょうど 1 件**在ることを書く前に確かめる。1 つでも外れたら何も書かない。
- 印の行数が期待どおり(= 当て済み)なら **SKIP して exit 0**(file は触らない)。印が在るのに行数が違う(部分適用 / 手編集)は **exit 1**。
- **足した行は全部 `PKC3-YIELDWAIT` を含む**。原文の行は 1 行も書き換えない。
- 同じ file を触る他の patch(`patch-lo-uev-trace.py` / `patch-lo-idles-trace.py`)とは**錨が重ならない**(あちらは `ImplYield` 以降)。
"""

import sys
from pathlib import Path

SRC = "vcl/qt5/QtInstance.cxx"
MARK = "PKC3-YIELDWAIT"

# ── ① include(`std::chrono` と `std::fprintf`)────────────────────────────────────────
# 🔑 原文の `#include <mutex>` は 1 件。直後の `namespace {`(QtYieldMutex を包む)までを錨にして一意にする。
INC_ANCHOR = """#include <condition_variable>
#include <mutex>

namespace
{
"""
INC_REPLACE = """#include <condition_variable>
#include <mutex>
#include <chrono> // PKC3-YIELDWAIT
#include <cstdio> // PKC3-YIELDWAIT

namespace
{
"""

# ── ② `QtYieldMutex::doAcquire` の main の枝で、LO スレッドの鍵を待つ `wait` の前後 ────────
# 🔑 錨は `wait` 行から `swap` 行までの 3 行。原文に**1 件**(`doRelease` / `RunInMainThread` の `wait` は形が違う)。
#    `enter` は `wait` の**前**、`leave` は `swap` の**後**(= `wait` から戻り closure を取り出した後)。
#    ⚠ 空行を足さない(足した行は全部印を含む決まり)。
WAIT_ANCHOR = """            m_InMainCondition.wait(g, [this]() { return m_isWakeUpMain; });
            m_isWakeUpMain = false;
            std::swap(func, m_Closure);
"""
WAIT_REPLACE = """            // PKC3-YIELDWAIT: main is about to wait for the LO thread to release the SolarMutex (tryToAcquire failed above).
            // PKC3-YIELDWAIT: enter without a matching leave in the log = main is stuck in this wait. The wait is predicate-form
            // PKC3-YIELDWAIT: (its loop is inside), so these marks sit outside it and do not repeat on spurious wakeups.
            static unsigned nPkc3In = 0; // PKC3-YIELDWAIT
            static unsigned nPkc3Out = 0; // PKC3-YIELDWAIT
            auto const pPkc3Ms = []() -> long long // PKC3-YIELDWAIT
            { // PKC3-YIELDWAIT
                return std::chrono::duration_cast<std::chrono::milliseconds>( // PKC3-YIELDWAIT
                           std::chrono::steady_clock::now().time_since_epoch()) // PKC3-YIELDWAIT
                    .count(); // PKC3-YIELDWAIT
            }; // PKC3-YIELDWAIT
            unsigned const nPkc3EnterSeq = ++nPkc3In; // PKC3-YIELDWAIT
            long long const nPkc3EnterMs = pPkc3Ms(); // PKC3-YIELDWAIT
            if (nPkc3EnterSeq <= 3000 || nPkc3EnterSeq % 100 == 0) // PKC3-YIELDWAIT
                std::fprintf(stderr, "PKC3-YIELDWAIT: enter #%u t=%lld held_by_lo=1 wake=%d closure=%d\\n", nPkc3EnterSeq, nPkc3EnterMs, m_isWakeUpMain ? 1 : 0, m_Closure ? 1 : 0); // PKC3-YIELDWAIT
            m_InMainCondition.wait(g, [this]() { return m_isWakeUpMain; });
            m_isWakeUpMain = false;
            std::swap(func, m_Closure);
            // PKC3-YIELDWAIT: back from the wait (func is the closure we were woken for, empty if it was a plain release).
            unsigned const nPkc3LeaveSeq = ++nPkc3Out; // PKC3-YIELDWAIT
            long long const nPkc3LeaveMs = pPkc3Ms(); // PKC3-YIELDWAIT
            long long const nPkc3Waited = nPkc3LeaveMs - nPkc3EnterMs; // PKC3-YIELDWAIT
            if (nPkc3LeaveSeq <= 3000 || nPkc3LeaveSeq % 100 == 0 || nPkc3Waited > 100) // PKC3-YIELDWAIT
                std::fprintf(stderr, "PKC3-YIELDWAIT: leave #%u (enter #%u) t=%lld waited=%lld closure=%d\\n", nPkc3LeaveSeq, nPkc3EnterSeq, nPkc3LeaveMs, nPkc3Waited, func ? 1 : 0); // PKC3-YIELDWAIT
"""

PARTS = (
    (INC_ANCHOR, INC_REPLACE),
    (WAIT_ANCHOR, WAIT_REPLACE),
)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-yield-wait.py <lo-core-dir>", file=sys.stderr)
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
    if text.count("PKC3-YIELDWAIT: enter #") != 1 or text.count("PKC3-YIELDWAIT: leave #") != 1:
        print("ERROR: 印が 1 組入っていない", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if MARK in line)
    if (
        n_marks != n_expected
        or after.count("PKC3-YIELDWAIT: enter #") != 1
        or after.count("PKC3-YIELDWAIT: leave #") != 1
    ):
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 行(期待 {n_expected})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(main の SolarMutex 待ちの前後に印 / #1408 ── 足した行 {n_marks})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
