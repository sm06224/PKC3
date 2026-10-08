#!/usr/bin/env python3
"""lightweight の hop(本体スレッド → main)で SolarMutex を**手放さず、main に貸す**(#1408 の候補 (c) の**直し**)。

## 症状(user の身に起きること)

Impress を読み込んでいる最中、まれに(下の実測で 1/150)**何も出さずに固まる**(「Office が停止しました」も出ない)。
閉じた直後に描画の途中で落ちる件(#1402)も、同じ「鍵を手放す隙」が素の一つと読んでいる。

## 何が起きていたか(#1408 の最新コメントの全スレッド stack。run 37695070751 の 150 本のうち 1 本 = y7-61)

    main(JS の callback → Qt の widget イベント → LibreOffice の処理):
      … sd / vcl の処理(SolarMutex を持っている)
      ← osl_acquireMutex ← __pthread_mutex_lock ← futex の busy-wait        ← 別の osl::Mutex(Z)を待って JS ごと止まる
    worker(LibreOffice の本体スレッド):
      … OutputDevice ← QtFrame ← EmscriptenLightweightRunInMainThread_(lightweight の hop)
      ← SolarMutexReleaser の戻り ← QtYieldMutex::doAcquire ← osl_acquireMutex ← futex   ← SolarMutex を取り直せない(main が持っている)

`vcl/qt5/QtInstance.cxx`(上流 `d6226c1a`、原文の 246〜266 行)の `QtInstance::EmscriptenLightweightRunInMainThread_` は、
本体スレッドから main へ関数を渡すとき **`SolarMutexReleaser` で SolarMutex を手放してから**渡し、main 側の lambda が `SolarMutexGuard` で取り直す。
本体スレッドが**別の osl::Mutex(Z)を持ったまま**ここへ入ると:

1. hop が SolarMutex だけを手放す
2. その隙に main の Qt イベントが SolarMutex を取り、処理の途中で Z を要求する(busy-wait で main ごと止まる)
3. 本体スレッドは hop から戻って SolarMutex を取り直したい(`~SolarMutexReleaser` → `doAcquire`)が main が持っている

= **鍵の順序の逆転**(本体: Z → SolarMutex を待つ / main: SolarMutex → Z を待つ)。

## 直し(重い経路 `QtYieldMutex::doAcquire` と同じ作法)

`QtYieldMutex`(同じ file の anonymous namespace)には、すでに「借りる」仕組みがある。`m_bNoYieldLock`(main だけが触る):
重い経路 `doAcquire` は closure を走らせるとき

    m_bNoYieldLock = true; // execute closure with borrowed SolarMutex
    func();
    m_bNoYieldLock = false;

とし、main の `doAcquire` / `doRelease` / `IsCurrentThread` はこの旗が立っていれば「借りている」として即 return / true を返す。
lightweight の hop も同じ形にする:

| | 上流 | この patch |
|---|---|---|
| 本体スレッド(hop の前) | `SolarMutexReleaser` で SolarMutex を**手放す** | **手放さない**(本体が持ったまま待つ) |
| main の lambda | `SolarMutexGuard` で**取る** | 借りている旗(`m_bNoYieldLock`)を**立てて** func を走らせ、戻す |

これで hop の間も SolarMutex の持ち主は変わらない。上の 1〜3 の「隙」が無くなる(main の他のイベントは、旗が立つのは func の間だけなので、
その間に別の入口から SolarMutex を取ろうとしても本体スレッドが持ち続けているだけで、取り合いにならない)。#1402 の「描画の途中で鍵が手放される」隙も塞ぐ**見込み**
(🟡 #1402 の原因は仮説。⚠ surface の差し替えの競合そのものは別 ── `patch-lo-surface-trace.py` が見ている)。

## 足す・無効にする(原文の行は 1 行も書き換えない)

- 上流の hop 呼び出し(`SolarMutexReleaser release;` から `&func);` まで 10 行)を `#if 0` と `#else` で**そのまま残して無効にし**、
  `#else` の側に新しい呼び出しを足す。
- 🔴 **`emscripten_sync_run_in_main_runtime_thread` は関数ではなく可変長 macro である**(emscripten 4.0.10
  `system/include/emscripten/threading_legacy.h:180`:`#define emscripten_sync_run_in_main_runtime_thread(sig, func_ptr, ...)
  emscripten_sync_run_in_main_runtime_thread_((sig), (void*)(func_ptr),##__VA_ARGS__)`。実体は末尾 `_` の関数)。macro の引数は `( )` しか守らず `{ }` は守らない。
  そこから 2 つ:
  ① **macro の引数の中に `#if` を挟まない**(未定義動作)── 呼び出しごと `#if 0` / `#else` で包む。
  ② 🔴 **lambda(最上位のカンマを含みうる)を macro の引数に書かない**。1 稿目は lambda を引数に直書きしており、その中の
  `aPkc3Borrow{ pHop->pMutex, !pHop->pMutex->m_bNoYieldLock }` の最上位カンマで引数が割れ、`error: expected '}' before ')' token` になった(g++ で再現)。
  直しは lambda を**呼び出しの前で関数ポインタに受けて**(`void (*const pPkc3Fn)(void*) = +[](void* pf) { … };`)、macro には `pPkc3Fn` だけを渡す。
- 足した行は全部 `PKC3-HOPBORROW` を含む。

### 🔴 持っていない呼び手がありうる ── 旗を立てると鍵なしで走る

`m_bNoYieldLock` を立てると、func の中の `SolarMutexGuard` は**何も取らずに素通り**する。本体スレッドが SolarMutex を**持っていない**まま hop に入ると、
借りる物が無いのに旗だけ立つので **func が鍵なしで走る**。上流の `RunInMainThread`(`:213` の `DBG_TESTSOLARMUTEX()`。`:211` は関数の頭)は「持っている」を前提にしているが、
lightweight 版の呼び手は**全部がそうとは限らない**:

| 呼び手 | 持っているか(上流の file を読んだ結果) |
|---|---|
| `QtInstance::RunInMainThread`(`:223` の `EmscriptenLightweightRunInMainThread(func)` の呼び出し行) | 持っている(先頭に `DBG_TESTSOLARMUTEX()`。⚠ debug build の検査。release では見ない) |
| `QtInstance::CreateClipboard`(`:608`) | 持っている(直前に `SolarMutexGuard aGuard;`) |
| `QtFrame::Damage`(`QtFrame.cxx:163`)/ `devicePixelRatioF`(`:202`)/ `SetMinClientSize`(`:363`)/ 画面移動(`:1184`) | **静的には証明できない**。VCL が SalFrame の関数を呼ぶ契約は SolarMutex を持っていることだが、別スレッド(UNO の呼び出しなど)から持たずに来る道を排除できない |
| `QtGraphicsBase()` の ctor(`QtGraphicsBase.hxx:27`)、`QtSvpGraphics` / `QtGraphics` の ctor が呼ぶ `devicePixelRatioF` | 同上(グラフィックスは VCL が SolarMutex の下で作るのが通常) |

だから **hop の前に本体側で `IsCurrentThread()` を取り、持っているときだけ借りる**。持っていないとき(`bHeld` が偽)は従来どおり
`SolarMutexGuard` で取る(上流は `SolarMutexReleaser` を作るが、持っていなければ `SolarMutexReleaser` は何もしない ── `svapp.hxx` の `IsCurrentThread() ? Release : 0` ──
ので、**持っていない呼び手の挙動は 1 バイトも変わらない**)。

### 旗は例外でも必ず戻す

`m_bNoYieldLock` が立ったまま戻らないと、main は以後どの `SolarMutexGuard` も素通りして**鍵が全部効かなくなる**。上流の `doAcquire` の作法は `func();` の
直後に戻すだけ(例外を考えていない)。func は UNO / Qt を呼ぶので投げうる ── 戻しは局所の struct のデストラクタに置く。

## 言えないこと

- 🔴 **焼かないとコンパイルできない**。名前と型は上流の原文を読んだだけ(`m_bNoYieldLock` は `public`、`GetYieldMutex()` は `SalInstance` の public、
  `IsCurrentThread()` は `QtYieldMutex` の public virtual)。手元では型だけ stub に替えた harness(g++ と pthread)で、旗の立ち方・戻り方・入れ子・Releaser を作らないことを確かめた。
- 🔴 **鍵なしで走る呼び手が無いこと**は静的には言えない(上の表)。持っていない呼び手は従来どおり `SolarMutexGuard` で取るので、新しい穴は作らないが、直しの対象にもならない。
- 🔴 **借りている間に main の他の仕事が割り込まないこと**は言えない。旗が立っている間、main が func の中で Qt のイベントループを回せば(入れ子の `processEvents` など)、
  そこで走るイベントは「借りている」鍵の下で走る(重い経路 `doAcquire` と同じ性質)。func が短い Qt の getter / setter なら起きないが、保証はしない。
- 🔴 **別の経路は塞がない**: `DoYield` の枝 B(`SolarMutexReleaser` の別の使い方)と `ProcessEvent` の suspend は別。この patch は `EmscriptenLightweightRunInMainThread_` だけを見る。
- 🔴 **効いたかは次の焼き**: #1408 の 150 本で、起動中の固まりの `SolarMutexReleaser の戻り` の形(y7-61)が 0 になるか。

## 作法(`patch-lo-timer-mutex.py` / `patch-lo-yield-wait.py` と同じ)

- **毎回当たる**(入力で gate しない)。錨が**ちょうど 1 件**在ることを書く前に確かめる。1 つでも外れたら何も書かない。
- 印の行数が期待どおり(= 当て済み)なら **SKIP して exit 0**(file は触らない)。印が在るのに行数が違う(部分適用 / 手編集)は **exit 1**。
- **足した行は全部 `PKC3-HOPBORROW` を含む**。原文の行は 1 行も書き換えない(`#if 0` の中に原文のまま残る)。
- 同じ file を触る他の patch(`patch-lo-yield-wait.py` は `doAcquire` の `wait`、`patch-lo-idles-trace.py` / `patch-lo-uev-trace.py` は `ImplYield` 以降、
  `patch-lo-qt-cjk-fonts.py` は `CreateQApplication`)とは**錨が重ならない**。
"""

import sys
from pathlib import Path

SRC = "vcl/qt5/QtInstance.cxx"
MARK = "PKC3-HOPBORROW"

# ── `EmscriptenLightweightRunInMainThread_` の hop(`if (pthread_self() != …)` の中)────────────
# 🔑 錨は hop の呼び出し 1 件(10 行)。原文に**ちょうど 1 件**(`RunInMainThread` の `m_Closure` 経路とは形が違う)。
#    錨ごと `#if 0` の中へ**原文のまま**残し、`#else` の側に新しい呼び出しを足す。
HOP_ANCHOR = """        SolarMutexReleaser release;
        emscripten_sync_run_in_main_runtime_thread(
            EM_FUNC_SIG_RETURN_VALUE_V | EM_FUNC_SIG_WITH_N_PARAMETERS(1)
                | EM_FUNC_SIG_SET_PARAM(0, EM_FUNC_SIG_PARAM_P),
            +[](void* pf) {
                DBG_TESTNOTSOLARMUTEX();
                SolarMutexGuard g;
                (*static_cast<std::function<void()>*>(pf))();
            },
            &func);
"""
HOP_REPLACE = (
    """#if 0 // PKC3-HOPBORROW
"""
    + HOP_ANCHOR
    + """#else // PKC3-HOPBORROW
        // PKC3-HOPBORROW: do not let go of the SolarMutex across the hop; lend it to the main thread instead (same as QtYieldMutex::doAcquire,
        // PKC3-HOPBORROW: m_bNoYieldLock). Letting go opened a window where a main-thread Qt event took the SolarMutex and then waited for another
        // PKC3-HOPBORROW: osl::Mutex that this thread still held, while this thread waited for the SolarMutex back (#1408 lock-order inversion).
        QtYieldMutex* const pPkc3Mutex = static_cast<QtYieldMutex*>(GetYieldMutex()); // PKC3-HOPBORROW
        // PKC3-HOPBORROW: only lend what we own. A caller that does not hold the SolarMutex keeps the old behaviour (SolarMutexGuard on main).
        struct Pkc3Hop // PKC3-HOPBORROW
        { // PKC3-HOPBORROW
            std::function<void()>* pFunc; // PKC3-HOPBORROW
            QtYieldMutex* pMutex; // PKC3-HOPBORROW
            bool bHeld; // PKC3-HOPBORROW
        } aPkc3Hop{ &func, pPkc3Mutex, pPkc3Mutex->IsCurrentThread() }; // PKC3-HOPBORROW
        // PKC3-HOPBORROW: the lambda lives OUTSIDE the macro call. emscripten_sync_run_in_main_runtime_thread is a variadic macro (emscripten 4.0.10
        // PKC3-HOPBORROW: threading_legacy.h:180), and a macro argument is split on every top-level comma: parens protect it, braces do not.
        void (*const pPkc3Fn)(void*) = +[](void* pf) { // PKC3-HOPBORROW
                DBG_TESTNOTSOLARMUTEX(); // PKC3-HOPBORROW
                Pkc3Hop* const pHop = static_cast<Pkc3Hop*>(pf); // PKC3-HOPBORROW
                if (!pHop->bHeld) // PKC3-HOPBORROW
                { // PKC3-HOPBORROW
                    SolarMutexGuard aPkc3Guard; // PKC3-HOPBORROW
                    (*pHop->pFunc)(); // PKC3-HOPBORROW
                    return; // PKC3-HOPBORROW
                } // PKC3-HOPBORROW
                // PKC3-HOPBORROW: the flag is main-thread-only. If it is already set (a nested hop while main runs a borrowed closure) leave it alone.
                // PKC3-HOPBORROW: reset it in a destructor: func may throw, and a flag stuck on would turn every SolarMutexGuard on main into a no-op.
                struct Pkc3Borrow // PKC3-HOPBORROW
                { // PKC3-HOPBORROW
                    QtYieldMutex* pMutex; // PKC3-HOPBORROW
                    bool bSet; // PKC3-HOPBORROW
                    ~Pkc3Borrow() // PKC3-HOPBORROW
                    { // PKC3-HOPBORROW
                        if (bSet) // PKC3-HOPBORROW
                            pMutex->m_bNoYieldLock = false; // PKC3-HOPBORROW
                    } // PKC3-HOPBORROW
                } aPkc3Borrow{ pHop->pMutex, !pHop->pMutex->m_bNoYieldLock }; // PKC3-HOPBORROW
                if (aPkc3Borrow.bSet) // PKC3-HOPBORROW
                    pHop->pMutex->m_bNoYieldLock = true; // PKC3-HOPBORROW: execute func with borrowed SolarMutex
                (*pHop->pFunc)(); // PKC3-HOPBORROW
            }; // PKC3-HOPBORROW
        emscripten_sync_run_in_main_runtime_thread( // PKC3-HOPBORROW
            EM_FUNC_SIG_RETURN_VALUE_V | EM_FUNC_SIG_WITH_N_PARAMETERS(1) // PKC3-HOPBORROW
                | EM_FUNC_SIG_SET_PARAM(0, EM_FUNC_SIG_PARAM_P), // PKC3-HOPBORROW
            pPkc3Fn, &aPkc3Hop); // PKC3-HOPBORROW
#endif // PKC3-HOPBORROW
"""
)

PARTS = ((HOP_ANCHOR, HOP_REPLACE),)


def _added_lines(anchor: str, replace: str) -> list[str]:
    """置換で**足した行**(原文の行でない行)。⚠ 全部 MARK を含んでいなければならない。"""
    orig = anchor.split("\n")
    return [ln for ln in replace.split("\n") if ln not in orig]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-hop-borrow.py <lo-core-dir>", file=sys.stderr)
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
    if text.count("#if 0 // PKC3-HOPBORROW") != 1 or text.count("#endif // PKC3-HOPBORROW") != 1:
        print("ERROR: #if 0 / #endif が 1 組入っていない", file=sys.stderr)
        return 1

    path.write_text(text, encoding="utf-8")
    # 🔴 書いた**あとに再読して**確かめる(write を落としても in-memory の検査は全部通る)
    after = path.read_text(encoding="utf-8")
    n_marks = sum(1 for line in after.splitlines() if MARK in line)
    if n_marks != n_expected or after.count("#if 0 // PKC3-HOPBORROW") != 1:
        print(
            f"ERROR: 書き戻し後の {SRC} の印が {n_marks} 行(期待 {n_expected})── write が落ちている",
            file=sys.stderr,
        )
        return 1
    print(f"patched: {SRC}(lightweight の hop で SolarMutex を手放さず main に貸す / #1408 ── 足した行 {n_marks})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
