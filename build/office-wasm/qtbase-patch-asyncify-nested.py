#!/usr/bin/env python3
"""🔴 **JSPI の入れ子 suspend で、外側の `processEvents` が二度と戻らない**のを直す(#1344)。

対象は Qt 6.9 の `src/corelib/kernel/qeventdispatcher_wasm.cpp`(上流の原文を読んで確かめた)。

## 何が起きていたか(原文)

- JS 側は resolver を **`Module.qtAsyncifyWakeUp` の 1 枠**に置く。resume は resolver を
  取り出して `setTimeout` に預け、発火時に **`Module.qtSuspendId !== suspendId` なら
  起こさずに捨てる**(「別の suspend が割り込んだ」という扱い)。
- C++ 側 `g_is_asyncify_suspended` は **1 bit**。`qt_asyncify_resume()` は
  **予約した時点で** bit を落とす。`wakeEventDispatcherThread()` は bit が false なら
  「suspend していない」と答える。
- JSPI では、マウス callback の中で「`PostUserEvent` → `wakeUp()` → resume 予約(bit=false)」
  の直後に、`QMenu::exec` の入れ子 `processEvents` が `wait()` → **suspend できてしまう**
  (bit が false なので)→ `qtSuspendId` が進む → 予約していた `setTimeout` が
  **外側の frame の resolver を捨てる** → 外側の `processEvents` は**二度と戻らず**、
  LibreOffice の main loop が死ぬ(#1344 のコメントの実測)。

## 直し ── 1 枠・1 bit を、id ごとの Map・深さの数へ

1. **JS**: resolver を **id ごとの `Map`** に持つ。resume は**溜まっている全部**を
   `setTimeout(0)` で起こす(**id の照合で捨てない**)。⚠ `setTimeout` は残す
   (emscripten #10515 の回避)。
2. **C++**: 1 bit を **深さの数**(`g_asyncify_suspend_depth`)にする。
   - `qt_asyncify_suspend()`: 深さ > 0 でも **JSPI なら入れ子で suspend してよい**。
     asyncify(1) は従来どおり入れ子不可(`return false`)。戻ってきた = この frame は
     起きたので `--depth`。
   - `qt_asyncify_resume()`: 深さが 0 のときだけ何もしない。**bit を先に落とさない**。
   - `wakeEventDispatcherThread()`: 深さが 0 のときだけ「suspend していない」。

🔑 **入れ子でない普段の経路(読み込み中を含む)は、Map に 1 件しか無い**ので
**今までと同じ動き**になる。違いが出るのは入れ子のときだけで、そのとき**両方の frame が
起きる**(どちらが event を処理しても `QMenu` の loop は exit flag で返る)。

## ⚠ この箱では compile も実行もできない

emsdk も Qt ツリーもこの箱に無い。**当たることと、当たった字**と、**JS 側の挙動**
(`tests/office-asyncify-nested-patch.test.ts` が node で実走する)しか確かめられない。
**C++ のコンパイルは焼きで見る**(`g++ -fsyntax-only` は Qt の header が無くて通らない)。
効いたかどうかは焼いた一式の probe で見る ── 観測点は
「**`QMenu::exec` が返った後 1 秒以内に、外側の dispatch が走る**」。

⚠ **Qt の cache 鍵は `qtbase-patch-*.py` の hash** なので、この 1 本を足した時点で
**Qt を host + wasm から焼き直す**(数時間)。

⚠ 印は **`PKC3-ASYNCNEST`**。足した行・変えた行は**全部この印を含む**
(JS 側の行も同じ。原文との差を機械で数えるため)。
"""

from __future__ import annotations

import sys
from pathlib import Path

SRC = "src/corelib/kernel/qeventdispatcher_wasm.cpp"
MARK = "PKC3-ASYNCNEST"
OLD_NAME = "g_is_asyncify_suspended"

# ── ① 1 bit → 深さの数
VAR_ANCHOR = """static bool g_is_asyncify_suspended = false;
"""
VAR_REPLACE = """// PKC3-ASYNCNEST(#1344): 1 bit を「いま suspend している frame の数」にした。
// PKC3-ASYNCNEST: JSPI は入れ子で suspend できる ── bit のままだと、resume を予約した直後の
// PKC3-ASYNCNEST: 入れ子 suspend が外側の frame の起こしを捨てさせていた。
static int g_asyncify_suspend_depth = 0; // PKC3-ASYNCNEST
"""

# ── ② JS 側:1 枠 + suspendId の照合 → id ごとの Map、全部起こす
JS_ANCHOR = """    ++Module.qtSuspendId;
    await new Promise(resolve => {
        Module.qtAsyncifyWakeUp = resolve;
    });
});

EM_JS(void, qt_asyncify_resume_js, (), {
    let wakeUp = Module.qtAsyncifyWakeUp;
    if (wakeUp == undefined)
        return;
    Module.qtAsyncifyWakeUp = undefined;
    const suspendId = Module.qtSuspendId;

    // Delayed wakeup with zero-timer. Workaround/fix for
    // https://github.com/emscripten-core/emscripten/issues/10515
    setTimeout(() => {
        // Another suspend occurred while the timeout was in queue.
        if (Module.qtSuspendId !== suspendId)
            return;
        wakeUp();
    });
});
"""
JS_REPLACE = """    ++Module.qtSuspendId;
    const id = Module.qtSuspendId; // PKC3-ASYNCNEST
    if (Module.qtAsyncifyWakeUps === undefined) Module.qtAsyncifyWakeUps = new Map(); // PKC3-ASYNCNEST
    await new Promise(resolve => { // PKC3-ASYNCNEST
        Module.qtAsyncifyWakeUps.set(id, resolve); // PKC3-ASYNCNEST
    });
});

EM_JS(void, qt_asyncify_resume_js, (), {
    const m = Module.qtAsyncifyWakeUps; // PKC3-ASYNCNEST
    if (m === undefined || m.size === 0) // PKC3-ASYNCNEST
        return;
    const wakeUps = Array.from(m.values()); // PKC3-ASYNCNEST
    m.clear(); // PKC3-ASYNCNEST

    // PKC3-ASYNCNEST: Delayed wakeup with zero-timer (emscripten #10515 の回避はそのまま)。
    // PKC3-ASYNCNEST: 1 枠 + suspendId の照合だと、JSPI の入れ子 suspend で外側の frame の起こしが捨てられる(#1344)。
    setTimeout(() => { for (const wakeUp of wakeUps) wakeUp(); }); // PKC3-ASYNCNEST
});
"""

# ── ③ C++ 側:suspend
SUSPEND_ANCHOR = """    if (g_is_asyncify_suspended)
        return false;
    g_is_asyncify_suspended = true;
    qt_asyncify_suspend_js();
    return true;
"""
SUSPEND_REPLACE = """    // PKC3-ASYNCNEST(#1344): asyncify(1) は従来どおり入れ子不可。JSPI は入れ子で suspend してよい。
    if (g_asyncify_suspend_depth > 0 && !qstdweb::haveJspi()) // PKC3-ASYNCNEST
        return false;
    ++g_asyncify_suspend_depth; // PKC3-ASYNCNEST
    qt_asyncify_suspend_js();
    --g_asyncify_suspend_depth; // PKC3-ASYNCNEST: 戻ってきた = この frame は起きた
    return true;
"""

# ── ④ C++ 側:resume(⚠ 錨は `g_… = false;` まで含めて一意にする ── 先頭 2 行は wake 側と同じ)
RESUME_ANCHOR = """    if (!g_is_asyncify_suspended)
        return;
    g_is_asyncify_suspended = false;
    qt_asyncify_resume_js();
"""
RESUME_REPLACE = """    // PKC3-ASYNCNEST(#1344): 予約した時点で bit を落とさない(落とすと入れ子 suspend を許してしまう)。
    if (g_asyncify_suspend_depth == 0) // PKC3-ASYNCNEST
        return;
    qt_asyncify_resume_js();
"""

# ── ⑤ C++ 側:wake
WAKE_ANCHOR = """    if (!g_is_asyncify_suspended)
        return false;
    runOnMainThread([]() { qt_asyncify_resume(); });
"""
WAKE_REPLACE = """    if (g_asyncify_suspend_depth == 0) // PKC3-ASYNCNEST(#1344)
        return false;
    runOnMainThread([]() { qt_asyncify_resume(); });
"""

PAIRS = [
    (VAR_ANCHOR, VAR_REPLACE),
    (JS_ANCHOR, JS_REPLACE),
    (SUSPEND_ANCHOR, SUSPEND_REPLACE),
    (RESUME_ANCHOR, RESUME_REPLACE),
    (WAKE_ANCHOR, WAKE_REPLACE),
]


def patch(root: Path) -> int:
    path = root / SRC
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        print(f"ERROR: {SRC} を読めない: {e}", file=sys.stderr)
        return 1
    # 🔑 二重当ては**落とす**(file は触らない)。他の qtbase patch の SKIP と違い、
    #    この 1 本は「当たった後にもう一度当てた」を事故として扱う。
    if MARK in text:
        print(f"ERROR: 既に当たっている({SRC})── 二重当ては受けない", file=sys.stderr)
        return 1
    for anchor, replace in PAIRS:
        hits = text.count(anchor)
        if hits != 1:
            head = anchor.strip().splitlines()[0][:70]
            print(f"ERROR: 錨が {hits} 件({SRC}) ── 上流が形を変えた: {head}", file=sys.stderr)
            return 1
        text = text.replace(anchor, replace, 1)
    # 🔴 錨に載っていない読み手が残っていないか(上流が読み手を足した日に、ここで落ちる)。
    #    ⚠ 注釈の中の字は数えない。
    for n, line in enumerate(text.splitlines(), 1):
        if OLD_NAME in line and not line.lstrip().startswith("//"):
            print(f"ERROR: {OLD_NAME} の読み手が残っている({SRC}:{n}) ── 錨が足りない: {line.strip()[:70]}",
                  file=sys.stderr)
            return 1
    path.write_text(text, encoding="utf-8")
    print(f"patched: {SRC}(#1344 の直し ── JSPI の入れ子 suspend で外側の起こしを捨てない)")
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <qtbase root>", file=sys.stderr)
        return 2
    return patch(Path(sys.argv[1]))


if __name__ == "__main__":
    sys.exit(main())
