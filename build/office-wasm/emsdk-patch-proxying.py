#!/usr/bin/env python3
"""🔴 emscripten 4.0.10 の `emscripten_proxy_finish` が condvar を捨てた後に signal するのを直す(#1408)。

対象は emsdk の `system/lib/pthread/proxying.c`(4.0.10 の原文を読んで確かめた)。引数は emscripten の root
(`~/emsdk/upstream/emscripten`)。

## 何が起きていたか

同期 proxy の完了側は `pthread_mutex_unlock(&ctx->sync.mutex)` の**後**に `pthread_cond_signal(&ctx->sync.cond)` する。
待つ側は unlock で先に起きて stack 上の ctx を捨てる(= condvar が無くなる)ので、完了側が**捨てられた condvar** を
signal しに行き、内部ロックで固まる(起動中の固まり y4-IDm-14 の stack と一致)。
emscripten 5.0.5 の #26582 が順序を入れ替えて修正済み ── **signal を unlock の前**にする(同じ形を 4.0.10 へ移植する)。

直す場所は 2 つ(5.0.5 の実物も 2 つとも直している):
- `emscripten_proxy_finish`:錨は `ctx->sync.state = DONE;` から始まる 4 行。
- `cancel_ctx`:錨は `ctx->sync.state = CANCELED;` から始まる 3 行(待つ側が同じく先に起きて ctx を捨てる)。
⚠ `unlock; signal` の 2 行だけだと両方に同じ字が在って 2 件になるので、**state の行から**錨にする。
⚠ 2 つの錨は**全部確かめてから**書く(片側だけ当たった file を残さない)。

⚠ 直した後、**cache の libc(`libc-mt*.a` / `libc_optz-mt*.a`)を作り直す**のは workflow の仕事(patch は .c を直すだけ。
cache の .a は file が無ければ最終 link が build する)。この箱では compile できない(焼きで見る)。
"""

from __future__ import annotations

import sys
from pathlib import Path

SRC = "system/lib/pthread/proxying.c"
MARK = "PKC3-PROXYFINISH"

FINISH_ANCHOR = """    ctx->sync.state = DONE;
    remove_active_ctx(ctx);
    pthread_mutex_unlock(&ctx->sync.mutex);
    pthread_cond_signal(&ctx->sync.cond);
"""
FINISH_REPLACE = """    ctx->sync.state = DONE;
    remove_active_ctx(ctx);
    // PKC3-PROXYFINISH(#1408): signal を unlock の前に(emscripten 5.0.5 の #26582 と同じ)。
    // PKC3-PROXYFINISH: 後だと、待つ側が先に起きて ctx(condvar ごと)を捨て、捨てた condvar を signal しに行って固まる。
    pthread_cond_signal(&ctx->sync.cond); // PKC3-PROXYFINISH
    pthread_mutex_unlock(&ctx->sync.mutex); // PKC3-PROXYFINISH
"""

CANCEL_ANCHOR = """    ctx->sync.state = CANCELED;
    pthread_mutex_unlock(&ctx->sync.mutex);
    pthread_cond_signal(&ctx->sync.cond);
"""
CANCEL_REPLACE = """    ctx->sync.state = CANCELED;
    // PKC3-PROXYFINISH(#1408): cancel_ctx も同じ順に(5.0.5 の「Signal must be first」)。
    pthread_cond_signal(&ctx->sync.cond); // PKC3-PROXYFINISH
    pthread_mutex_unlock(&ctx->sync.mutex); // PKC3-PROXYFINISH
"""

PAIRS = [
    ("emscripten_proxy_finish", FINISH_ANCHOR, FINISH_REPLACE),
    ("cancel_ctx", CANCEL_ANCHOR, CANCEL_REPLACE),
]


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <emscripten root>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]) / SRC
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        print(f"ERROR: {SRC} を読めない: {e}", file=sys.stderr)
        return 1
    if MARK in text:
        print(f"SKIP: 既に当たっている({SRC})")
        return 0
    # 🔴 **全部の錨を確かめてから書く**(片側だけ当たった file を残さない)
    for name, anchor, _ in PAIRS:
        hits = text.count(anchor)
        if hits != 1:
            head = anchor.strip().splitlines()[0][:70]
            print(f"ERROR: 錨が {hits} 件({SRC} / {name}) ── emscripten が形を変えた: {head}", file=sys.stderr)
            return 1
    for _, anchor, replace in PAIRS:
        text = text.replace(anchor, replace, 1)
    path.write_text(text, encoding="utf-8")
    # 書いた後に読み直して確かめる(2 か所とも signal が unlock より前に在ること)
    after = path.read_text(encoding="utf-8")
    sig = "pthread_cond_signal(&ctx->sync.cond); // PKC3-PROXYFINISH"
    unl = "pthread_mutex_unlock(&ctx->sync.mutex); // PKC3-PROXYFINISH"
    if after.count(sig) != 2 or after.count(unl) != 2:
        print(f"ERROR: 書いた後の読み直しが食い違う({SRC})", file=sys.stderr)
        return 1
    for name, anchor, _ in PAIRS:
        head = anchor.splitlines()[0]
        at = after.find(head)
        if at < 0 or after.find(sig, at) > after.find(unl, at):
            print(f"ERROR: 書いた後の読み直しが食い違う({SRC} / {name})", file=sys.stderr)
            return 1
    print(f"patched: {SRC}(#1408 の直し ── emscripten_proxy_finish と cancel_ctx は signal してから unlock)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
