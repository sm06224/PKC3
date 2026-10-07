#!/usr/bin/env python3
"""🔴 **外から貼った後にコピーすると Office が止まる**のを直す(#1394)。

## user の身に起きること

Office の窓(Writer / Calc / Impress)へ**ブラウザの外で作った文字列を 1 度でも貼る**と、
その後の **Ctrl+C(コピー)で窓が止まる**(`invalid handle: N` で abort)。貼った内容は関係ない
(1 行でも複数行でも、貼った後に消して打ち直しても同じ)。貼らずにコピーするだけなら
1 回目は通る(2 回目以降は main 側で `TypeError: func.call is not a function` が出るが、
コピー自体は成立する)。

## 原因(#1394 のコメントで実測して確定)

Qt 6.9 `src/corelib/kernel/qcore_wasm.cpp` の 2 関数が、**関数内の `static` な `emscripten::val`** を持つ:

    QString::fromEcmaString : static const emscripten::val stringToUTF16(module_property(...))
    QString::toEcmaString   : static const emscripten::val UTF16ToString(module_property(...))

`static` の入れ物は wasm の共有メモリに 1 つだけだが、中身の **emval の handle は
「最初に呼んだスレッド」の JS 側の表でしか有効でない**(emscripten の `emval_handles` は
Worker ごとに別の JS 世界に在る)。呼び手が 2 スレッド在る ──
**main**(ブラウザの `copy` event → `commonCopyEvent`)と **pthread**(LO のコピー →
`QWasmClipboard::setMimeData` → `writeToClipboardApi`)。外から貼ると共有の mimeData に text が
残り、次の Ctrl+C で **main の copy event が先に static を取る**。その 36ms 後に pthread が
同じ handle を引くが、**worker の表には無い** → `invalid handle` → abort。

## 直し ── **static をやめて、毎回 `module_property` を取る**

    const emscripten::val UTF16ToString = emscripten::val::module_property("UTF16ToString");

- 2 か所とも直す(`fromEcmaString` は今は main からしか呼ばれていないが、同じ型の危険)。
  🔑 **片側だけ直さない**:1 か所しか当たらなければ**何も書かずに落ちる**。
- `thread_local` にしない ── スレッドが終わるときに val を破棄する後始末が要り、単純でない。
  `module_property` は JS の property を 1 回読むだけで、毎回取っても重くない。

## 覆る条件

- 上流が static をやめた / 呼び手が 1 スレッドだけになった → 錨が当たらなくなるので
  **焼くときにこの script が落ちて**教える(黙って素通りしない)。
- 毎回取るほうが遅くて困る(コピーの応答)と実測できたら `thread_local` + 破棄を検討する。

## ⚠ この箱では compile も実行もできない

当たることと当たった字しか確かめられない。効いたかは**焼いて、貼ってから 2 回続けてコピー**して
`invalid handle` が 0 件・main の `TypeError` が 0 件になるのを見る(#1394)。
"""

from __future__ import annotations

import sys
from pathlib import Path

REL = "src/corelib/kernel/qcore_wasm.cpp"

# ⚠ 錨は上流 6.9 の実物の行(`qtsrc69/qcore_wasm.cpp` :76 / :93)をそのまま写した。手で書き直さない。
FROM_ANCHOR = """    static const emscripten::val stringToUTF16(emscripten::val::module_property("stringToUTF16"));
"""
FROM_REPLACE = """    // PKC3(#1394): 関数内の static をやめる。emval の handle は作ったスレッドでしか有効でなく、
    // main と pthread の両方から呼ばれると後の側が `invalid handle` で abort する。
    const emscripten::val stringToUTF16 = emscripten::val::module_property("stringToUTF16");
"""

TO_ANCHOR = """    static const emscripten::val UTF16ToString(emscripten::val::module_property("UTF16ToString"));
"""
TO_REPLACE = """    // PKC3(#1394): 同上(main の copy event と pthread の LO のコピーの両方から呼ばれる)。
    const emscripten::val UTF16ToString = emscripten::val::module_property("UTF16ToString");
"""

PAIRS = [("fromEcmaString", FROM_ANCHOR, FROM_REPLACE), ("toEcmaString", TO_ANCHOR, TO_REPLACE)]

MARK = "PKC3(#1394)"


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <qtbase root>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / REL
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        print(f"ERROR: {REL} を読めない: {e}", file=sys.stderr)
        return 1
    # 🔑 先に「もう当たっていないか」を見る(他の qtbase patch と同じ作法)
    if MARK in text:
        print(f"SKIP: 既に当たっている({REL})")
        return 0
    # 🔴 **全部の錨を確かめてから書く**(1 か所だけ当てて残りで落ちると、半分直った file が残る)
    for name, anchor, _ in PAIRS:
        hits = text.count(anchor)
        if hits != 1:
            head = anchor.strip().splitlines()[0][:70]
            print(f"ERROR: 錨が {hits} 件({REL} / {name}) ── 上流が形を変えた: {head}", file=sys.stderr)
            return 1
    for _, anchor, replace in PAIRS:
        text = text.replace(anchor, replace, 1)
    path.write_text(text, encoding="utf-8")
    print(f"patched: {REL}(#1394 の直し ── fromEcmaString / toEcmaString の static val をやめる)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
