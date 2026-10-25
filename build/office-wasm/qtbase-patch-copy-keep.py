#!/usr/bin/env python3
"""🔴 **Office の中でコピーしたのに、外のクリップボードが空になる**のを直す(#121 / #774)。

## user の身に起きること

Office(Writer)で**画像**を選んで `Ctrl+C` すると、それまで外(他のアプリ / 別の頁)でコピーしていた字が**消えて空になる**
(`build/office-wasm/clipboard-probe.mjs` の `B3` 腕で 2/2。字・右クリックの「コピー」・近道キー・表は空にならない)。
LO が何も渡してこなかったのに、外の物だけが消える ── 「何もコピーしていない」と「空をコピーした」は別である。

## 原因(Qt 6.9 `qwasmclipboard.cpp` を読んで確定。実ブラウザの観測: host への書き込み依頼が 0 件で外が空)

`commonCopyEvent()`(ブラウザの `copy` event の処理)は、Qt のクリップボード(`mimeData`)に **字も HTML も運べる中身も無くても**、
最後に **無条件で `preventDefault()`** を呼ぶ。`copy` event は既定の動作(= 選択範囲をクリップボードへ)を止めると、
**`clipboardData` に入れた物だけ**がクリップボードに載る ── 何も入れなければ **空で上書き**される。

## 直し(最小)

運べる物(字 / HTML / 空でない他の型)が 1 つも無いときは、`preventDefault()` を呼ばずに返る。
ブラウザの既定の `copy` は、選択が空なら**クリップボードに触らない**ので、外の物は残る。

⚠ 中身があるときの動きは 1 行も変えない(足すのは早期 return の 1 ブロックだけ)。

## 覆る条件 / 言えないこと

- ⚠ **この箱では compile できない**。使うのは同じ関数が既に使っている API(`hasText` / `hasHtml` / `formats` / `data` /
  `isEmpty`)だけ。**焼いて**、`clipboard-probe.mjs` の `B3`(画像)で外が空にならない(= 種が残る)ことを見る。
- 画像そのものが外へ渡る(貼れる)かは別の話(`patch-lo-clipboard-png.py`)。この直しは「消さない」までである。
- ⚠ Qt の cache 鍵は `qtbase-patch-*.py` の hash なので、この 1 本を足すと Qt を焼き直す(約 25 分)。
"""

from __future__ import annotations

import sys
from pathlib import Path

REL = "src/plugins/platforms/wasm/qwasmclipboard.cpp"
MARK = "PKC3(#121)"

# ⚠ 錨は上流 6.9 の実物(`commonCopyEvent` の最後の `preventDefault` と、次の関数の頭)をそのまま写した。
ANCHOR = """    event.call<void>("preventDefault");
}

void QWasmClipboard::cut(val event)
"""
REPLACE = """    // PKC3(#121): 運べる物が 1 つも無いのに preventDefault すると、ブラウザは clipboardData に入れた物(= 空)で
    // PKC3(#121): クリップボードを上書きする(外でコピーした字が消える)。何も運べないときは既定の動作に任せる。
    if (!_mimes->hasText() && !_mimes->hasHtml()) {
        bool pkcHasBinary = false;
        for (auto pkcMime : _mimes->formats()) {
            if (!pkcMime.contains("text/") && !_mimes->data(pkcMime).isEmpty()) {
                pkcHasBinary = true;
                break;
            }
        }
        if (!pkcHasBinary)
            return;
    }

    event.call<void>("preventDefault");
}

void QWasmClipboard::cut(val event)
"""


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
    hits = text.count(ANCHOR)
    if hits != 1:
        print(f"ERROR: 錨が {hits} 件({REL}) ── 上流が形を変えた", file=sys.stderr)
        return 1
    path.write_text(text.replace(ANCHOR, REPLACE, 1), encoding="utf-8")
    print(f"patched: {REL}(#121 の直し ── 運べる物が無いコピーでは外のクリップボードを上書きしない)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
