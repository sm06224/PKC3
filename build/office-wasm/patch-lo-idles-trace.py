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
| `idles:wait a=<IsUseSystemEventLoop> b=<IsMainThread>` | 待ちに入った。⚠ **前提を assert ではなく実測で出す** |
| `idles:woke` | 待ちが返った(出なければ、そこで永久に止まっている) |
| `execute:set` | `Application::Execute()` のループが条件を立てた |

- **`execute:set` が 0 件** → メインスレッドがそのループに**到達していない**
- **`execute:set` が非 0 なのに `idles:woke` が出ない** → 立てているのに待ちが返らない
  (条件オブジェクトの対応付け / スレッド間の伝播)

⚠ どちらに転んでも**次に直す場所が変わる**ので、ここを測らずに 2 度目の直しを焼かない。
"""

import os
import sys
from pathlib import Path

# ⚠ libc だけを使う。embind / DOM / Qt の API をここから呼んではいけない
#    (LO の文脈から `emscripten::val` を触ると `invalid handle` で abort する ── 2026-08-15)。
HELPER = """
// ── PKC3 #199 の計装(挙動は変えない。`PKC3_IDLES_TRACE=1` の回だけ入る)──
#include <cstdio>
namespace
{
void pkc3_idles_trace(const char* what, int a, int b)
{
    static int nSeq = 0;
    // ⚠ 上限を置く ── `execute:set` は毎ループ走るので、置かないと log が膨らむ
    if (nSeq >= 300)
        return;
    ++nSeq;
    char line[160];
    std::snprintf(line, sizeof line, "PKC3-IDLES %d %s a=%d b=%d\\n", nSeq, what, a, b);
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
        pkc3_idles_trace("idles:wait", Application::IsUseSystemEventLoop() ? 1 : 0,
                         Application::IsMainThread() ? 1 : 0);
        {
            SolarMutexReleaser releaser;
            pSVData->m_inExecuteCondtion.wait();
        }
        // ⚠ この行が**出なければ**、待ちはそこで永久に止まっている
        pkc3_idles_trace("idles:woke", -1, -1);
"""

APP_SRC = "vcl/source/app/svapp.cxx"
APP_ANCHOR = """            Application::Yield();
            SolarMutexReleaser releaser; // Give a chance for the waiting threads to lock the mutex
            pSVData->m_inExecuteCondtion.set();
"""
APP_REPLACE = """            Application::Yield();
            SolarMutexReleaser releaser; // Give a chance for the waiting threads to lock the mutex
            pSVData->m_inExecuteCondtion.set();
            // 🔑 **立てた回数を数える**(#199)── 0 件なら、メインスレッドは
            //    このループに一度も到達していない(= 直す場所はそちら側)。
            pkc3_idles_trace("execute:set", -1, -1);
"""

# 🔴 **ヘルパーは file scope へ入れる。関数の中に入れてはいけない**(2026-08-24 に踏んだ)。
#
# ⚠ 1 稿目は `HELPER + 本体の置換` を 1 つの錨に当てたが、**その錨は関数の中**に在るので
#   名前空間スコープの関数定義が関数本体の内側へ入り、**コンパイル不能**になった。
#   ⚠ patch は「当たった」と報告するので、**生成された C++ を目視するまで気づけない**
#   (焼いて 2 時間後に赤で分かる形だった)。
# 🔑 だから錨を **2 段**に分ける ── ヘルパーは**関数定義の直前**、本体は中。
HELPER_TARGETS = (
    (SCHED_SRC, "Scheduler::IdlesLockGuard::IdlesLockGuard()\n{\n"),
    (APP_SRC, "void Application::Execute()\n{\n"),
)
# ⚠ ヘルパーは TU ごとに 1 つ要る ── 当てる先が 2 file なので 2 つ入る。
TARGETS = (
    (SCHED_SRC, SCHED_ANCHOR, SCHED_REPLACE),
    (APP_SRC, APP_ANCHOR, APP_REPLACE),
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
        print("skip: PKC3_IDLES_TRACE!=1(錨は 2 件とも在ることを確かめた)")
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
