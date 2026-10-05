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

## 直し(v2)── 1 枠・1 bit を、suspend の stack・深さの数へ。**起こす順は LIFO**

⚠ v1(#1350)は resolver を id ごとの Map に持ち、resume が**溜まっている全部**を
`setTimeout(0)` で一度に起こした。焼いて実ブラウザで測ると、popup の後の dispatch は
exec-ret の 32 ms 後に出た(向きは正しい)が、`QMenu::hideEvent` →
`QEventLoop::exit(int)` で **`operation does not support unaligned accesses`** が出た。
🔴 **JSPI でも Emscripten の C の shadow stack(線形メモリ)は 1 本**である。外側の frame
(LO の main loop → ImplYield → processEvents → wait → suspend)が suspend したまま、
mouse callback の stack の上で menu の入れ子 loop が suspend している。そこで**外側を
先に起こす**と、外側が内側の frame(`QMenuPrivate::exec` の局所 `QEventLoop`)の上に
自分の frame を積んで**踏む**。内側が後で `hideEvent` → `eventLoop->exit()` を呼ぶと、
その QEventLoop は壊れていて trap する。
🔑 だから**起こす順は LIFO でなければならない** ── 内側(最後に suspend した物)を起こし、
**その stack が JS へ戻った後**でなければ、外側を起こしてはいけない。

1. **JS**: suspend の resolver を `Module.qtSuspends`(**stack。末尾が最も内側**)に
   `{ resolve, wake }` で積む。resume は**溜まっている全部に `wake = true`**(wake は
   dispatcher 全体への合図なので捨てない)を立て、`setTimeout(0)` の tick で
   **最も内側だけ**を見る。内側が起こされていなければ**外側は待つ**(wake は立ったまま残る)。
   起こしたら tick をもう 1 回予約する ── 起こした stack は「もう一度 suspend する(push)」
   か「JS へ戻る(push しない)」かのどちらかで、戻っていれば次の tick で外側が最も内側に
   なっている。⚠ `setTimeout` は残す(emscripten #10515 の回避。suspendId の照合は、
   wake flag が同じ役を担うので要らない)。
2. **C++**(v1 のまま): 1 bit を **深さの数**(`g_asyncify_suspend_depth`)にする。
   - `qt_asyncify_suspend()`: 深さ > 0 でも **JSPI なら入れ子で suspend してよい**。
     asyncify(1) は従来どおり入れ子不可(`return false`)。戻ってきた = この frame は
     起きたので `--depth`。
   - `qt_asyncify_resume()`: 深さが 0 のときだけ何もしない。**bit を先に落とさない**。
   - `wakeEventDispatcherThread()`: 深さが 0 のときだけ「suspend していない」。

## v3 ── shadow stack の位置で門を置く(Gemini 2026-10-05 の Q2c。sp guard)

v2 の LIFO は **Qt 自身の suspend だけ**を stack に持つ。⚠ JSPI の suspend は Qt の
`processEvents` 以外にも在りうる(Emscripten の `emscripten_sleep` / fetch の Suspending import、
Qt の `qstdweb` の非同期呼び出し)── それらは `Module.qtSuspends` に載らないので、
**その frame が top の上で生きている間に top を起こす**と、v1 と同じ踏み方になる。
🔑 **`__stack_pointer` は 1 本の wasm global で、JSPI は保存も復元もしない**。だから
「いま誰が上に居るか」は **`stackSave()`(= `_emscripten_stack_get_current()`)の値**で読める:
- suspend のとき `sp: stackSave()` を控える(EM_JS の中では、呼び手の C の frame の sp)。
- tick で top を起こす前に **`stackSave() === top.sp`** を見る。違えば**上に frame が生きている**
  ので起こさず、tick をもう 1 周置いて待つ(戻れば sp は同じ値へ戻る ── 関数の epilogue が戻す)。
- 約 1 秒(250 周)待っても戻らなければ `console.error('PKC3-UEV sp-defer …')` を 1 度だけ出す
  (probe の clipTrace が拾う。⚠ 起こしはしない ── 起こせば壊れる)。
- `stackSave` が無い一式では `sp: null` で門を閉じない(= v2 と同じ)。焼いた soffice.js には
  `stackSave=()=>_emscripten_stack_get_current()` が在る(run 37303396759 の一式で実測)。
⚠ 入れ子でない普段の経路では、suspend したときの sp と tick のときの sp は**必ず同じ**
(間に走った JS → wasm の呼び出しは、戻るときに sp を戻す)。だから門は普段は常に開いている。

🔑 **入れ子でない普段の経路(読み込み中を含む)は、stack に 1 件しか無い**ので
**今までと同じ動き**になる(suspend → resume → tick 1 回で起きる)。違いが出るのは
入れ子のときだけで、そのとき**内側から順に**起きる。
⚠ 原本は外側の resolver を**捨てて**いた(外側は永久に suspend ── #1344 の症状)。
v1 は**全部起こして**LIFO を破った。

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

# ── ② JS 側:1 枠 + suspendId の照合 → suspend の stack、LIFO で起こす(v2)
JS_ANCHOR = """    if (Module.qtSuspendId === undefined)
        Module.qtSuspendId = 0;
    ++Module.qtSuspendId;
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
JS_REPLACE = """    // PKC3-ASYNCNEST(#1344 v2): suspend の stack(末尾が最も内側)。C の shadow stack は JSPI でも 1 本なので、
    // PKC3-ASYNCNEST: 外側を内側より先に起こすと、内側の frame(QMenuPrivate::exec の局所 QEventLoop)を踏む。LIFO で起こす。
    return new Promise(resolve => { // PKC3-ASYNCNEST
        if (Module.qtSuspends === undefined) Module.qtSuspends = []; // PKC3-ASYNCNEST
        // PKC3-ASYNCNEST(v3): shadow stack の位置(`__stack_pointer`)を控える。起こす前に同じ位置に戻っていることを見る門。
        // PKC3-ASYNCNEST: `stackSave` が無い一式では null(= 門なし。v2 と同じ動き)。
        const sp = (typeof stackSave === 'function') ? stackSave() : null; // PKC3-ASYNCNEST
        Module.qtSuspends.push({ resolve: resolve, wake: false, sp: sp }); // PKC3-ASYNCNEST
    }); // PKC3-ASYNCNEST
});

EM_JS(void, qt_asyncify_resume_js, (), {
    const s = Module.qtSuspends; // PKC3-ASYNCNEST
    if (s === undefined || s.length === 0) return; // PKC3-ASYNCNEST
    for (const e of s) e.wake = true; // PKC3-ASYNCNEST: wake は dispatcher 全体への合図。溜まっている全部に立てる(捨てない)
    if (Module.qtResumeTickArmed) return; // PKC3-ASYNCNEST
    Module.qtResumeTickArmed = true; // PKC3-ASYNCNEST
    // PKC3-ASYNCNEST: Delayed wakeup with zero-timer(emscripten #10515 の回避はそのまま)。
    const tick = () => { // PKC3-ASYNCNEST
        Module.qtResumeTickArmed = false; // PKC3-ASYNCNEST
        const s = Module.qtSuspends; // PKC3-ASYNCNEST
        if (s === undefined || s.length === 0) return; // PKC3-ASYNCNEST
        const top = s[s.length - 1]; // PKC3-ASYNCNEST: 最も内側だけを見る(LIFO)
        if (!top.wake) return; // PKC3-ASYNCNEST: 内側が起こされていないなら外側は待つ(wake は立ったまま残る)
        // PKC3-ASYNCNEST(v3): この stack に載っていない frame(Qt 以外の JSPI suspend)が top の上で生きている間は起こさない。
        // PKC3-ASYNCNEST: 起こすと外側が内側の frame を踏む(v1 で踏んだ unaligned accesses と同じ壊れ方)。戻るまで tick で待つ。
        if (top.sp !== null && typeof stackSave === 'function' && stackSave() !== top.sp) { // PKC3-ASYNCNEST
            Module.qtResumeDeferred = (Module.qtResumeDeferred | 0) + 1; // PKC3-ASYNCNEST
            if (Module.qtResumeDeferred === 250) console.error('PKC3-UEV sp-defer n=250 sp=' + stackSave() + ' top=' + top.sp + ' depth=' + s.length); // PKC3-ASYNCNEST: 約 1 秒待っても戻らない(診断。1 度だけ)
            Module.qtResumeTickArmed = true; // PKC3-ASYNCNEST
            setTimeout(tick); // PKC3-ASYNCNEST: 待ちの再予約
            return; // PKC3-ASYNCNEST
        } // PKC3-ASYNCNEST
        Module.qtResumeDeferred = 0; // PKC3-ASYNCNEST
        s.pop(); // PKC3-ASYNCNEST
        top.resolve(); // PKC3-ASYNCNEST
        // PKC3-ASYNCNEST: 起こした stack は、もう一度 suspend する(push)か JS へ戻る(push しない)。次の tick で分かる。
        // PKC3-ASYNCNEST: 戻っていれば、次に内側になった物(外側)をその tick で起こす。
        Module.qtResumeTickArmed = true; // PKC3-ASYNCNEST
        setTimeout(tick); // PKC3-ASYNCNEST: 再予約
    }; // PKC3-ASYNCNEST
    setTimeout(tick); // PKC3-ASYNCNEST
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
    print(f"patched: {SRC}(#1344 の直し v3 ── JSPI の入れ子 suspend は LIFO で起こし、shadow stack の位置が戻るまで待つ)")
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <qtbase root>", file=sys.stderr)
        return 2
    return patch(Path(sys.argv[1]))


if __name__ == "__main__":
    sys.exit(main())
