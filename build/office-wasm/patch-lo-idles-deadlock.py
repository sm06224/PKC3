#!/usr/bin/env python3
"""#199 の**直し** ── `IdlesLockGuard` の待ちで固まらないようにする。

⚠ **これは計装ではない。配る一式に入る**(既定で当たる)。

## 何が起きていたか(9 巡分の計装で確定)

画像入りの Word 文書(`.docx` / `.rtf`)が**永久に開かなかった**。輪はこうだった:

    disp:ev a=19  t=<main>    メインが SalEvent::UserEvent を配り始める
    uev:in        t=<worker>  🔴 Link は **proxy されて別スレッド**で走る
    idles:wait    t=<worker>  その Link(docx の取込)が IdlesLockGuard に入る
    (以後どちらも進まない)

- **メイン**は proxy した Link の戻りを待つ
- **Link のスレッド**は `IdlesLockGuard` で「メインが `Application::Execute` へ
  戻ること」を待つ(= `m_inExecuteCondtion`)
- ⚠ **メインは戻れない**(Link を待っているので)── 互いに相手の前進を待つ

🔑 決め手は `uev:in` の `t=`(スレッド id)だった ── `ImplHandleUserEvent` は
メインの `ProcessEvent` から呼ばれるのに、**別スレッドの id で印が出た**。

## 直し

上流のコメント自身が待ちの目的を書いている:「**走っているアイドルが無いことを
保証するため**」。そこで:

1. 🔑 **走っているタスクが 1 つも無ければ、待たない。**
   `mpSchedulerStack` は**いま実行中のタスクのスタック**(`scheduler.cxx` の
   `:531` で push / `:646` で pop ── タスクの呼び出しを挟んでいる)。
   空なら**欲しい保証は既に成り立っている**。
   ⚠ 上流が待つ理由は**入れ子**(アイドルの中から `Yield` が呼ばれ、その
   アイドルが SolarMutex を放して待っている場合)で、そのときは**空でない**
   ── だからこの述語で見分けられる。読むのは SolarMutex を持っている間である。
2. 🔧 **待つ場合も時限を切る(100ms)。**
   本当にアイドルが終わるならループ 1 周(ミリ秒未満)なので、100ms でも
   100 倍の余裕がある。⚠ **失うのは「既に走っているアイドルが終わったこと」の
   保証だけ** ── 「これからアイドルを遅らせる」ほうは `mnIdlesLockCount` が
   待ちの前に増えており(すぐ上の `osl_atomic_increment`)、その数の唯一の用途は
   `scheduler.cxx` の `bDelayInvoking` なので、時限では失われない。

## 実測(自作の対照群。⚠ user の資料には触れていない)

| 文書 | 時限 2 秒 | **100ms + 述語**(この patch) |
|---|---|---|
| 画像 1 枚の .docx | 11 秒 | 11 秒 |
| 画像 **20 枚**の .docx | 🔴 **51 秒** | ✅ **10 秒** |
| 対照群 .odt | 18 秒 | 13 秒(⚠ `IdlesLockGuard` に 1 度も入らない) |

⚠ 待ちの**回数は変わらない**(17 回)── 変わったのは 1 回あたりの費用である。
`idles:woke` の内訳は **16 件すべて timeout** で、この筋では条件が
**原理的に立たない**ことが裏づけられている(= 時限の長さはまるごと損だった)。

⚠ `mpSchedulerStack == nullptr` で抜けたのは 17 回中 **1 回**だけ ── 効いている
のは主に時限のほうである。**述語は「要らない待ちを 1 つ減らす」効果**であって、
これ単独では直らない(measured)。
"""

import sys
from pathlib import Path

SRC = "vcl/source/app/scheduler.cxx"

ANCHOR = """        pSVData->m_inExecuteCondtion.reset();
        // Put an empty event to the application's queue, to make sure that it loops through the
        // code that sets the condition, even when there's no other events in the queue
        Application::PostUserEvent({});
        SolarMutexReleaser releaser;
        pSVData->m_inExecuteCondtion.wait();
"""

REPLACE = """        // PKC3 #199: skip the round-trip when no task is being invoked at all.
        // mpSchedulerStack is the stack of *invoked* tasks (pushed around the
        // invocation below), so an empty stack already means "no idle is
        // executing" -- which is exactly what this wait is here to guarantee.
        // The nested case the comment above warns about keeps the stack
        // non-empty, so it still takes the wait.
        if (rSchedCtx.mpSchedulerStack != nullptr)
        {
            pSVData->m_inExecuteCondtion.reset();
            // Put an empty event to the application's queue, to make sure that it loops through the
            // code that sets the condition, even when there's no other events in the queue
            Application::PostUserEvent({});
            SolarMutexReleaser releaser;
            // PKC3 #199: bound the wait. Under emscripten the main thread can be
            // blocked inside a proxied user-event callback that is itself waiting
            // for *this* thread, so the condition may never be set. A document
            // import hits this once per imported shape, so the timeout has to be
            // short: 100ms is still ~100x a healthy main-loop turn.
            TimeValue aPkc3Timeout;
            aPkc3Timeout.Seconds = 0;
            aPkc3Timeout.Nanosec = 100 * 1000 * 1000;
            if (pSVData->m_inExecuteCondtion.wait(&aPkc3Timeout) != osl::Condition::result_ok)
                SAL_WARN("vcl.schedule",
                         "PKC3 #199: idles lock gave up waiting for the main loop");
        }
"""


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-idles-deadlock.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    if not path.exists():
        print(f"ERROR: {SRC} が無い({path})", file=sys.stderr)
        return 1
    text = path.read_text(encoding="utf-8")
    # ⚠ **二重当てを黙って通さない** ── 当たった後の字面が在れば、それは 2 回目である
    if "PKC3 #199" in text:
        print(f"ERROR: {SRC} に既に当たっている(二重当て)", file=sys.stderr)
        return 1
    hits = text.count(ANCHOR)
    if hits != 1:
        print(
            f"ERROR: 錨が {hits} 件({SRC})── 上流が形を変えた",
            file=sys.stderr,
        )
        return 1
    path.write_text(text.replace(ANCHOR, REPLACE, 1), encoding="utf-8")
    print(f"patched: {SRC}(#199 の直し ── IdlesLockGuard の待ち)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
