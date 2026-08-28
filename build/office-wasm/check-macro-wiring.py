#!/usr/bin/env python3
"""🔴 **マクロ(Basic)が一式に入っているかを 3 段で数える**(#431)。

> user 指示 2026-08-28:「**いまだに動かないマクロ機能なども全部完璧で
> 動かせるようにしっかり対応していきましょう**」

## なぜ 3 段に分けるか

2026-08-26 に手で数えたとき、**段によって答えが違った**:

| 段 | 見る場所 | そのときの結果 |
|---|---|---|
| ① **定義** | `soffice.data.js.metadata`(詰め込んだ file の目録) | ⚠ **一部だけ在る**(`.xba` の骨 / `oovbaapi.rdb` / `macroassigndialog.ui`) |
| ② **登録** | `program/services/services.rdb` | 🔴 **0 件** |
| ③ **実体** | `soffice.wasm` | 🔴 **0 件** |

🔑 **②が 0 件なのが決定的**である ── スクリプトの提供者が UNO に登録されて
いないので、「ツール → マクロ」から**呼び出す先が解決できない**。
⚠ ①だけ在ると **メニューは出るのに動かない**(無言の dead click)。

🔑 だから「マクロが入ったか」を**1 つの数**で言わない。3 段を別々に出す ──
`--disable-scripting` を外して焼いたとき、**どこまで進んだか**が読める形にする。

## ⚠ 数え方の罠(手で数えたときに踏んだ)

- 🔴 **`StarBasic` は UNO の型名にも出る**(前回 67 件ヒットしたのはそちら)。
  だから実体の判定には **`SbiRuntime` / `SbModule` / `StarBASIC`(大文字 BASIC)**
  という **C++ の class 名**を使う。
- ⚠ `services.rdb` は **UTF-16 で持つ文字列が在る** ── ASCII だけで grep すると
  「在るのに 0 件」になる。**両方**で数える。
- ⚠ 一式の file を 1 つでも読めなかったら、**数を出さずに落とす**
  (CLAUDE.md「対照群が届かない回は判定不能と書く。結果を読まない」)。

使い方:

    python3 build/office-wasm/check-macro-wiring.py <一式のディレクトリ>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# ── 段② 登録(UNO へ script provider が登録されているか)
#    ⚠ `com.sun.star.script.provider` は**サービス名**、残りは実装名である。
REGISTRATION = (
    "ScriptProviderForBasic",
    "MasterScriptProviderFactory",
    "com.sun.star.script.provider",
    "ScriptProviderForBasicOnly",
)

# ── 段③ 実体(Basic のエンジンがリンクされているか)
#
# 🔴 **印は「対照群で 0 件」であることを実測して選んだ**(2026-08-28)。
#    ⚠ それらしい名前を並べるだけでは駄目 ── scripting **OFF** の一式で数えたら、
#    `Sbx*` の一族は**軒並み 1 件**当たった(UNO の型名の側である):
#
#    | 印 | scripting OFF での件数 | |
#    |---|---|---|
#    | `SbiRuntime` / `SbModule` / `StarBASIC` | **0** | ✅ 使える |
#    | `SbiParser` / `SbiImage` / `SbMethod` / `SbUnoObject` | **0** | ✅ 使える |
#    | `SbxObject` / `SbxArray` / `SbxVariable` / `SbxDimArray` | **1** | 🔴 使えない |
#
#    ⚠ 1 件しか当たらない印を混ぜると、**入っていないのに「1/4 入った」**と出る
#    ── 進んでいない物を進んで見せる向きなので、いちばん質が悪い。
# 🔴 **`StarBasic`(小文字 asic)も使わない** ── 前回 67 件当たったのは UNO の型名側。
IMPLEMENTATION = (
    "SbiRuntime",
    "SbModule",
    "StarBASIC",
    "SbiParser",
)

# ── 段① 定義(詰め込んだ目録に Basic の資材が在るか)
DEFINITION = (
    "basic/Standard/Module1.xba",
    "oovbaapi.rdb",
    "macroassigndialog.ui",
    "scriptorganizer.ui",
)


def count(blob: bytes, needle: str) -> int:
    """ASCII と UTF-16LE の**両方**で数える。

    ⚠ 片方だけだと「在るのに 0 件」になる ── `services.rdb` は UTF-16 で
    文字列を持つ場所が在る(手で数えたときに踏んだ)。
    """
    return blob.count(needle.encode("utf-8")) + blob.count(needle.encode("utf-16-le"))


def read(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except OSError:
        return None


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    if not root.is_dir():
        print(f"ERROR: 一式のディレクトリが無い: {root}", file=sys.stderr)
        return 2

    # ⚠ 一式の並びは版で変わりうるので、**探して**から読む(決め打ちしない)
    def find(name: str) -> Path | None:
        if (root / name).is_file():
            return root / name
        hits = sorted(root.rglob(name))
        return hits[0] if hits else None

    meta = find("soffice.data.js.metadata")
    data = find("soffice.data")
    wasm = find("soffice.wasm")

    # 🔴 **読めなかったら数を出さない**(判定不能を「0 件」と書かない)
    missing = [n for n, p in (("soffice.data.js.metadata", meta), ("soffice.data", data),
                              ("soffice.wasm", wasm)) if p is None]
    if missing:
        print(f"ERROR: 一式に無い(判定不能): {', '.join(missing)}", file=sys.stderr)
        print("  ⚠ 数を出しません ── 見る物が無いのを「0 件」と書くと嘘になります", file=sys.stderr)
        return 2

    meta_b, wasm_b = read(meta), read(wasm)
    if meta_b is None or wasm_b is None:
        print("ERROR: 読めない file が在る(判定不能)", file=sys.stderr)
        return 2

    # 🔴 **`services.rdb` は loose file ではない**(2026-08-28 に踏んだ)。
    #    emscripten は詰め込んだ file を **`soffice.data` の 1 本**にまとめ、
    #    位置は `soffice.data.js.metadata` の `start` / `end` が持つ。
    #    ⚠ `root/services.rdb` を探しても**永久に見つからない** ── 「無い」と
    #    「入っていない」を取り違えるところだった(CLAUDE.md §4)。
    try:
        catalog = json.loads(meta_b.decode("utf-8"))
        entries = catalog["files"]
    except (ValueError, KeyError) as e:
        print(f"ERROR: 目録を読めない(判定不能): {e}", file=sys.stderr)
        return 2

    def slice_out(suffix: str) -> bytes | None:
        """詰め込みの中から 1 file を切り出す。⚠ 見つからなければ `None`。"""
        hit = next((f for f in entries if str(f.get("filename", "")).endswith(suffix)), None)
        if hit is None:
            return None
        with data.open("rb") as fh:
            fh.seek(int(hit["start"]))
            return fh.read(int(hit["end"]) - int(hit["start"]))

    rdb_b = slice_out("/program/services/services.rdb")
    if rdb_b is None:
        print("ERROR: 目録に services.rdb が無い(判定不能)", file=sys.stderr)
        return 2

    print(f"一式: {root}")
    print(f"  soffice.wasm  {len(wasm_b):,} バイト")
    print(f"  services.rdb  {len(rdb_b):,} バイト(soffice.data から切り出し)")
    print()

    stages: list[tuple[str, int, int]] = []

    print("── 段① 定義(詰め込んだ目録に Basic の資材が在るか)")
    got = 0
    for n in DEFINITION:
        c = count(meta_b, n)
        got += 1 if c else 0
        print(f"   {'✅' if c else '❌'} {n:34} {c} 件")
    stages.append(("定義", got, len(DEFINITION)))

    print("\n── 段② 登録(UNO に script provider が登録されているか)")
    print("   🔑 ここが 0 件だと、メニューは出ても**呼ぶ先が解決できない**")
    got = 0
    for n in REGISTRATION:
        c = count(rdb_b, n)
        got += 1 if c else 0
        print(f"   {'✅' if c else '❌'} {n:34} {c} 件")
    stages.append(("登録", got, len(REGISTRATION)))

    print("\n── 段③ 実体(Basic のエンジンがリンクされているか)")
    print("   ⚠ `StarBasic`(小文字)は UNO の型名にも出るので使わない")
    got = 0
    for n in IMPLEMENTATION:
        c = count(wasm_b, n)
        got += 1 if c else 0
        print(f"   {'✅' if c else '❌'} {n:34} {c} 件")
    stages.append(("実体", got, len(IMPLEMENTATION)))

    print("\n── まとめ")
    for name, got_, all_ in stages:
        print(f"   {name}: {got_}/{all_}")

    ok = all(g == a for _, g, a in stages)
    if ok:
        print("\n✅ 3 段とも揃っている ── 次は**実機で動くか**(#431 段③)")
        print("   ⚠ 揃っていても動くとは限らない(#225 で「名前は在るのに落ちる」を踏んだ)")
    else:
        print("\n🔴 揃っていない ── 上の ❌ が、どこで止まっているかである")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
