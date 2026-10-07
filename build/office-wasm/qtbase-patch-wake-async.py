#!/usr/bin/env python3
"""🔴 **別スレッドからの resume の依頼を同期にしない**(#1408。main と LO スレッドの相互待ちを断つ)。

対象は Qt 6.9 の `src/corelib/kernel/qeventdispatcher_wasm.cpp`(上流の原文を読んで確かめた)。

## 何が起きていたか(#1408 のコメント 6046860101 / 6047296663 で確定)

main が `QtYieldMutex::doAcquire` で SolarMutex を待つと futex の busy-wait になり、JS のイベントループが止まる。
そのとき SolarMutex の持ち主(別スレッド)が `wakeEventDispatcherThread()` の
`runOnMainThread` = **`proxySync`(main の mailbox が捌かれるのを待つ)** に入ると、双方が永久に待つ。
Qt 6.10 も別スレッドからの起こしは非同期(main からも非同期だが、ここでは main は従来どおり同期のまま)。
6.10 は構造が別物なので丸ごとは写さず、別スレッドの枝だけ `runOnMainThreadAsync` にする(LibreOffice は Qt 6.9 が必須)。

## 直し ── main 自身は従来どおり同期、別スレッドは Async

⚠ **`qtbase-patch-asyncify-nested.py` が当たった後**のテキストに当てる(glob はアルファベット順に走る)。
錨は、その patch が残した wake の 3 行(`if (g_asyncify_suspend_depth == 0)` / `return false;` /
`runOnMainThread([]() { qt_asyncify_resume(); });`)── 素の原文にも最後の 1 行は在るので、3 行で当てて順番を守らせる。
足した行は**全部 `PKC3-WAKEASYNC` つき**。`emscripten_is_main_runtime_thread()` は fixture の include
(`<emscripten/threading.h>`)で足りる。

⚠ この箱では compile できない(焼きで見る。`qtbase-patch-asyncify-nested.py` と同じ)。
"""

from __future__ import annotations

import sys
from pathlib import Path

SRC = "src/corelib/kernel/qeventdispatcher_wasm.cpp"
MARK = "PKC3-WAKEASYNC"

# 🔑 錨は asyncify-nested が書いた直前 2 行を含める ── 素の原文にも `runOnMainThread([]() { qt_asyncify_resume(); });` は
#    1 件在る(wake の 1 行)ので、1 行だけだと**順番を飛ばしても当たってしまう**。2 行を含めれば、asyncify-nested の
#    後でなければ当たらない(落ちて教える)。
ANCHOR = """    if (g_asyncify_suspend_depth == 0) // PKC3-ASYNCNEST(#1344)
        return false;
    runOnMainThread([]() { qt_asyncify_resume(); });
"""
REPLACE = """    if (g_asyncify_suspend_depth == 0) // PKC3-ASYNCNEST(#1344)
        return false;
    // PKC3-WAKEASYNC(#1408): 別スレッドからの resume の依頼を同期(proxySync = main の mailbox を待つ)にしない。
    // PKC3-WAKEASYNC: main が SolarMutex を futex の busy-wait で待っている間は mailbox が捌かれないので、持ち主がここで待つと双方が永久に待つ。
    // PKC3-WAKEASYNC: Qt 6.10 も別スレッドからの起こしは非同期(main からも非同期だが、ここでは main は従来どおり同期のまま)。
    if (emscripten_is_main_runtime_thread()) // PKC3-WAKEASYNC
        runOnMainThread([]() { qt_asyncify_resume(); }); // PKC3-WAKEASYNC
    else // PKC3-WAKEASYNC
        runOnMainThreadAsync([]() { qt_asyncify_resume(); }); // PKC3-WAKEASYNC
"""


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <qtbase root>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        print(f"ERROR: {SRC} を読めない: {e}", file=sys.stderr)
        return 1
    # 🔑 先に「もう当たっていないか」を見る(他の qtbase patch と同じ作法)
    if MARK in text:
        print(f"SKIP: 既に当たっている({SRC})")
        return 0
    hits = text.count(ANCHOR)
    if hits != 1:
        print(
            f"ERROR: 錨が {hits} 件({SRC}) ── 上流が形を変えたか、qtbase-patch-asyncify-nested.py より前に走った: "
            f"{ANCHOR.strip().splitlines()[0][:70]}",
            file=sys.stderr,
        )
        return 1
    text = text.replace(ANCHOR, REPLACE, 1)
    path.write_text(text, encoding="utf-8")
    # 書いた後に読み直して確かめる(足した行が全部印つきで、非 main の枝が Async になっていること)
    after = path.read_text(encoding="utf-8")
    added = [l for l in REPLACE.splitlines() if MARK in l]
    if after.count(MARK) != len(added) or "runOnMainThreadAsync([]() { qt_asyncify_resume(); });" not in after:
        print(f"ERROR: 書いた後の読み直しが食い違う({SRC})", file=sys.stderr)
        return 1
    print(f"patched: {SRC}(#1408 の直し ── 別スレッドからの resume の依頼は runOnMainThreadAsync)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
