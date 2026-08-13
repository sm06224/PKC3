#!/usr/bin/env python3
"""LibreOffice wasm の**メモリとスタック**を、対話に耐える値へ引き上げる(#117)。

2026-08-11、user の手元で **Office の窓は起動するのに、数回操作すると壊れる**。
コンソールの最後に emscripten 自身の断定が出た:

    Aborted(Cannot enlarge memory arrays to size 2898817024 bytes (OOM).
     Either (1) compile with -sINITIAL_MEMORY=X with X higher than the current
     value 1073741824, (2) compile with -sALLOW_MEMORY_GROWTH which allows
     increasing the size at runtime, ...)

LO の `EMSCRIPTEN_INTEL_GCC.mk` は **`TOTAL_MEMORY=1GB` 固定**で、
**`ALLOW_MEMORY_GROWTH` は file のどこにも無い**(全文検索で 0 件)。

## 🔴 直すのは 4 つ。**別々の症状に別々に効く**

### ① メモリを伸ばせるようにする(`ALLOW_MEMORY_GROWTH`)

1GB を超えた瞬間に **abort** する。⚠ `TOTAL_MEMORY` を大きな固定値にする道は
採らない ── pthread を使う wasm のメモリは SharedArrayBuffer で、固定値は
**起動時に丸ごと確保**される。4GB 固定にすると確保自体に失敗する環境が出る。
🔑 伸長なら要る分だけ増える(user 指示「効くのは定常」とも向きが合う)。

### ② スタックを積む(`STACK_SIZE` / `DEFAULT_PTHREAD_STACK_SIZE`)

⚠ **OOM より先にメモリ破損が起きている**。同じログで、OOM の前に
`data:image/svg+xml;base64,%0E%0E%0E?…` という**壊れた base64** を
`<img>` に入れて `ERR_INVALID_URL` になっていた ── LO が「画像のバイト列」と
思って読んだ場所が**ゴミだった**、という形である。

上流の既定は **128KB(メイン)/ 64KB(スレッド)** で、デスクトップ LO の
8MB に対して極端に細い。しかも落ちた時のスタックは `$func39568 → $func37996`
の**深い相互再帰** + `setTimeout` の入れ子(LO の入れ子イベントループ)。
🔑 スタックが溢れて隣を踏むと、まさに「ゴミを読む → 範囲外アクセス →
でたらめな大きさの malloc」の順で壊れる。観測された順序と一致する。

### ③ heap view を全部 export する(`HEAPU8` 他)

`ASSERTIONS=1` なので、export されていない view に触ると即 abort する。
詳細は `REPLACE_HEAPS` の注記。

### ④ スレッドプールを 7 → 16 にする(`PTHREAD_POOL_SIZE`)

保存ダイアログ 1 枚で尽き、デッドロック警告 + 45 秒フリーズ。
詳細は `REPLACE_POOL` の注記。

## ⚠ 4 つ同時に変えるが、次のログで**区別できる**

- OOM の abort が消える → ① が効いた
- 壊れた `data:` URL が消える → ② が効いた
- `'HEAPU8' was not exported` が消える → ③ が効いた
- `thread pool is exhausted` が消える → ④ が効いた

どれが効いたか分からなくなる変更ではないので、350 分のビルドを 4 回に
分けない(「回すものの粒度」── 分けても情報が増えない)。

## ⚠ 当たったことを確かめてから当てる

錨が 1 つでも見つからなければ**異常終了する**。上流が形を変えたときに、
黙って素通り(= 効いていないのに緑)になるのを防ぐ。
"""

import os
import sys
from pathlib import Path

MK = "solenv/gbuild/platform/EMSCRIPTEN_INTEL_GCC.mk"

# 上流の既定(錨)。⚠ 空白まで含めて一致させる ── ずれたら気づきたい
ANCHOR_MEMORY = "gb_EMSCRIPTEN_LDFLAGS += -s TOTAL_MEMORY=1GB"
ANCHOR_STACK = "gb_EMSCRIPTEN_LDFLAGS += -sSTACK_SIZE=131072 -sDEFAULT_PTHREAD_STACK_SIZE=65536"
# 🔴 heap view の export。⚠ `HEAPU16` と `HEAPU32` は在るのに **`HEAPU8` だけ無い**
ANCHOR_HEAPS = '"ClassHandle","HEAPU16","HEAPU32"'
# 🔴 スレッドプール。⚠ `ifeq ($(ENABLE_EMSCRIPTEN_PROXY_TO_PTHREAD),)` の中に在る
#    = **PKC3 の構成(PROXY_TO_PTHREAD 無効)でだけ効く行**である
ANCHOR_POOL = "gb_EMSCRIPTEN_LDFLAGS += -sPTHREAD_POOL_SIZE=7"

# 伸長つきへ。⚠ wasm32 の上限は 4GB なので MAXIMUM_MEMORY はそこで頭打ち
REPLACE_MEMORY = (
    "# PKC3(#117): 1GB 固定では対話中に OOM abort する(実測)。伸ばせるようにする。\n"
    "gb_EMSCRIPTEN_LDFLAGS += -s INITIAL_MEMORY=1GB -s ALLOW_MEMORY_GROWTH=1"
    " -s MAXIMUM_MEMORY=4GB"
)

# 128KB/64KB → 4MB/1MB。⚠ スレッド側も上げる(LO はワーカーでも深い)
REPLACE_STACK = (
    "# PKC3(#117): 128KB/64KB は LO の入れ子イベントループに対して細すぎる。\n"
    "gb_EMSCRIPTEN_LDFLAGS += -sSTACK_SIZE=4194304 -sDEFAULT_PTHREAD_STACK_SIZE=1048576"
)

# 🔴 **heap view を全部 export する**(#117、2026-08-12)。
#
# 出荷物を調べたら `Module["HEAPU16"]` と `Module["HEAPU32"]` は在るのに
# **`Module["HEAPU8"]` が無い**。`ASSERTIONS=1` なので、触った瞬間に
# `Aborted('HEAPU8' was not exported. add it to EXPORTED_RUNTIME_METHODS)` で死ぬ
# ── 実機で観測済み。⚠ `host.html` も `qtloader.js` も `HEAPU8` を触っていない
# (各 0 件)ので、**呼んでいるのは Qt / LO 側**。こちらのコードでは避けられない。
#
# ⚠ **HEAPU8 だけ足すのではなく、view を一式そろえる。** 1 往復のビルドが
# 6 時間なので、「次は HEAPF32 が無かった」でもう 1 往復するのは高い。
# view の export は**参照を 1 つ生やすだけ**でコストが無い ── 積んでおく。
REPLACE_HEAPS = (
    '"ClassHandle",'
    '"HEAP8","HEAPU8","HEAP16","HEAPU16","HEAP32","HEAPU32","HEAPF32","HEAPF64"'
)

# 🔴 **スレッドプールを 7 → 16 にする**(#117、2026-08-12)。
#
# 実機のコンソールに**文言どおりの警告**が出た:
#
#     Tried to spawn a new thread, but the thread pool is exhausted.
#     This might result in a deadlock unless some threads eventually exit ...
#     If you want to increase the pool size, use setting `-sPTHREAD_POOL_SIZE=...`.
#
# 出たのは**保存ダイアログを開いた瞬間**。⚠ そしてこれは「警告」で済んでいない ──
# 同じ調査で**タブが 45 秒応答しなくなる**のを 2 回観測している。
# 🔑 プールが尽きた後の `pthread_create` は worker を**非同期に**起こすので、
# 起こした側(メインスレッド)がその場で待つと**相手が起動できず固まる**。
# user の「数回動いて壊れる」「クリック反応なし」は、この形とよく合う。
#
# ## なぜ 16 か(上げ幅の根拠)
#
# ⚠ **大きければ良いわけではない。** プールのスレッドは**起動時に前もって**作る
# Worker で、1 本あたり JS 側の常駐が数 MB + スタック(いま 1MB へ上げた)。
# user 指示「効くのは定常」に対して、64 本は**常駐で払う**ことになる。
# 一方 user 指示「初回起動が遅くとも、そこは許容」なので、**起動時間では払える**。
# 尽きたのが 7 本のとき ── ダイアログ 1 枚で尽きる ── なので、2 倍強の 16 を取る。
# 🔑 足りなければまた上げる。今回から A-3(異常終了の検知)が入るので、
# **次は静かに固まらず、画面に出る**。
#
# ⚠ `-sPTHREAD_POOL_SIZE_STRICT=2`(尽きたら即 abort)は**採らない**。
# 診断は楽になるが、いまは「たまに尽きる」を**確実に死ぬ**へ変えるだけである。
REPLACE_POOL = (
    "# PKC3(#117): 7 本は保存ダイアログ 1 枚で尽き、デッドロック警告 + 45 秒フリーズ。\n"
    "gb_EMSCRIPTEN_LDFLAGS += -sPTHREAD_POOL_SIZE=16"
)


# 🔴 **調査用の SAFE_HEAP**(#134、2026-08-13)。
#
# 検証で「**ダイアログを閉じると `memory access out of bounds` で停止**」が
# **5/5** で再現した。⚠ この例外はメインスレッドで wasm が**直接トラップ**した
# `RuntimeError` なので、`lineno` / `colno` を持たない ── #124 で使った
# 「名前を出す仕掛け」は効かない(あれは embind の `val::global` 取りこぼしだった)。
#
# 🔑 `-sSAFE_HEAP=1` は**すべての load/store を検査**するので、範囲外に触った
# **その瞬間**に止まり、どのアドレスかが出る。再現手順が 5/5 なので 1 回踏めば足りる。
#
# ⚠ **配布には使えない**(実行が数倍遅くなる)。だから workflow 側で
# **tag を導出**にして、配布 tag へ出せない形にしてある。
SAFE_HEAP_FLAG = " -s SAFE_HEAP=1"


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-memory.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / MK
    text = path.read_text(encoding="utf-8")

    for anchor in (ANCHOR_MEMORY, ANCHOR_STACK, ANCHOR_HEAPS, ANCHOR_POOL):
        hits = text.count(anchor)
        if hits != 1:
            print(
                f"ERROR: 錨が {hits} 件({MK})。上流が形を変えた可能性がある:\n  {anchor}",
                file=sys.stderr,
            )
            return 1

    memory = REPLACE_MEMORY
    if os.environ.get("PKC3_SAFE_HEAP") == "1":
        memory += SAFE_HEAP_FLAG
    text = text.replace(ANCHOR_MEMORY, memory)
    text = text.replace(ANCHOR_STACK, REPLACE_STACK)
    text = text.replace(ANCHOR_HEAPS, REPLACE_HEAPS)
    text = text.replace(ANCHOR_POOL, REPLACE_POOL)

    # ⚠ 置換が本当に効いたか(空振りを合格と読まない)
    for must in (
        "ALLOW_MEMORY_GROWTH=1",
        "STACK_SIZE=4194304",
        "MAXIMUM_MEMORY=4GB",
        '"HEAPU8"',
        '"HEAPF64"',
        "PTHREAD_POOL_SIZE=16",
    ):
        if must not in text:
            print(f"ERROR: 置換後に {must} が無い", file=sys.stderr)
            return 1
    # ⚠ 錨がそのまま残っていたら「置換したつもり」である。
    #    heap の錨は **部分列**なので、`in` で消えたことまで確かめる
    # ⚠ **頼んだときだけ入る**ことを両方向で確かめる(「静かに調査ビルドを配る」を防ぐ)
    want_safe = os.environ.get("PKC3_SAFE_HEAP") == "1"
    if want_safe != ("SAFE_HEAP=1" in text):
        print(
            f"ERROR: SAFE_HEAP の有無が要求と食い違う(要求={want_safe})",
            file=sys.stderr,
        )
        return 1
    for gone in ("TOTAL_MEMORY=1GB", "STACK_SIZE=131072", ANCHOR_HEAPS, "PTHREAD_POOL_SIZE=7"):
        if gone in text:
            print(f"ERROR: 置換後も {gone} が残っている", file=sys.stderr)
            return 1

    path.write_text(text, encoding="utf-8")
    print(f"patched: {MK}(メモリ伸長 + スタック 4MB/1MB + heap view 一式 + プール 16)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
