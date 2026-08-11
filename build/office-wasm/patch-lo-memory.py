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

## 🔴 直すのは 2 つ。**別々の症状に別々に効く**

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

## ⚠ 2 つ同時に変えるが、次のログで**区別できる**

- OOM の abort が消える → ① が効いた
- 壊れた `data:` URL が消える → ② が効いた

どちらが効いたか分からなくなる変更ではないので、350 分のビルドを 2 回に
分けない(「回すものの粒度」── 分けても情報が増えない)。

## ⚠ 当たったことを確かめてから当てる

錨が 1 つでも見つからなければ**異常終了する**。上流が形を変えたときに、
黙って素通り(= 効いていないのに緑)になるのを防ぐ。
"""

import sys
from pathlib import Path

MK = "solenv/gbuild/platform/EMSCRIPTEN_INTEL_GCC.mk"

# 上流の既定(錨)。⚠ 空白まで含めて一致させる ── ずれたら気づきたい
ANCHOR_MEMORY = "gb_EMSCRIPTEN_LDFLAGS += -s TOTAL_MEMORY=1GB"
ANCHOR_STACK = "gb_EMSCRIPTEN_LDFLAGS += -sSTACK_SIZE=131072 -sDEFAULT_PTHREAD_STACK_SIZE=65536"

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


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-lo-memory.py <lo-core-dir>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / MK
    text = path.read_text(encoding="utf-8")

    for anchor in (ANCHOR_MEMORY, ANCHOR_STACK):
        hits = text.count(anchor)
        if hits != 1:
            print(
                f"ERROR: 錨が {hits} 件({MK})。上流が形を変えた可能性がある:\n  {anchor}",
                file=sys.stderr,
            )
            return 1

    text = text.replace(ANCHOR_MEMORY, REPLACE_MEMORY)
    text = text.replace(ANCHOR_STACK, REPLACE_STACK)

    # ⚠ 置換が本当に効いたか(空振りを合格と読まない)
    for must in ("ALLOW_MEMORY_GROWTH=1", "STACK_SIZE=4194304", "MAXIMUM_MEMORY=4GB"):
        if must not in text:
            print(f"ERROR: 置換後に {must} が無い", file=sys.stderr)
            return 1
    for gone in ("TOTAL_MEMORY=1GB", "STACK_SIZE=131072"):
        if gone in text:
            print(f"ERROR: 置換後も {gone} が残っている", file=sys.stderr)
            return 1

    path.write_text(text, encoding="utf-8")
    print(f"patched: {MK}(メモリ伸長 + スタック 4MB/1MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
