#!/usr/bin/env python3
"""`wasm-function[60973]` のような**整数のスタック**を、関数の名前に直す(#631)。

## なぜ要るか ── 焼き 1 本(30 分〜4 時間)を待たなくてよくなる

配っている Office の一式には **name section が 0 件**なので、停止したときに出るのは
`wasm-function[60973]` のような**番号だけ**である。これまでは「名前つきで焼き直す」
しか手が無いと思っていたので、#117 / #88 / #431 が**焼き待ちで止まっていた**。

🔑 **焼き直しは要らない。** `--profiling-funcs` で焼いた一式の name section を
**表として引けば**、配布一式の番号がそのまま名前になる(実証は #117 の
2026-08-30 のコメント)── `--profiling-funcs` は**名前の節を足すだけ**で、
関数の並びも offset も動かさないからである。

| 番号 | 名前 |
|---|---|
| 60973 | `Scheduler::CallbackTaskScheduling()` |
| 198121 | `QtTimer::timeoutActivated()` |
| 235333 | `void doActivate<false>(QObject*, int, void**)` |

## 🔴 使える条件は 1 つ ── `lo_sha` が同じであること

**反例を実測済み**(#631):番号 **39465** は `63426ccd1d7c` では
`vcl::Window::ToTop(ToTopFlags)`、`95e83feb2e85` では
`ImplBorderWindow::GetOptimalSize()` である。

⚠ 枝が 1 つ動いた瞬間、番号だけの記録は「**それらしい嘘**」になる ──
しかも**誰も検算しない側の誤り**である(名前が出てしまうので、正しく見える)。
🔑 だからこの道具は **`--lo-sha` を必須**にし、名前つき一式に同梱された
`build-info.json` の `lo_sha` と**突き合わせてから**しか引かない。

## 🔴 空振り防止 ── 名前が 0 件の一式を渡されたら「失敗」する

⚠ 黙って「名前なし」を並べると、**配布一式を渡した人が
「名前が付いていない関数だ」と誤読する**(CLAUDE.md §1「検査が空振りする」)。
だから name section が無い / 関数名の副節が無い / 0 件なら**必ず落とす**。

同じ理由で、**引けなかった番号が 1 つでもあれば落とす** ── 穴を黙って読ませない。

## 使い方

    # 番号を直に渡す
    python3 build/office-wasm/wasm-names.py --wasm names-pack/soffice.wasm \\
        --lo-sha 63426ccd1d7c 60973 198121

    # スタックの字をそのまま食わせる(`wasm-function[N]` を拾う)
    pbpaste | python3 build/office-wasm/wasm-names.py --wasm names-pack/soffice.wasm \\
        --lo-sha "$(jq -r .build.lo_sha pack.json)" --stack -

⚠ `--wasm` に渡すのは**名前つきで焼いた一式**の `soffice.wasm`、
`--lo-sha` に渡すのは**番号が出た(= 配布)一式**の `lo_sha` である。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

WASM_MAGIC = b"\x00asm"
# custom section の id。name section はここに入る
SECTION_CUSTOM = 0
# name section の副節 id。1 = 関数名(0 = モジュール名 / 2 = ローカル名)
SUBSECTION_FUNCTION_NAMES = 1
# git の短縮 sha の下限。⚠ これより短い突合を許すと、別の枝と一致してしまう
SHA_MIN = 7

FUNC_RE = re.compile(r"wasm-function\[(\d+)\]")


class BadWasm(Exception):
    """読めない / 名前を持たない wasm。⚠ 例外にして**黙って空を返さない**。"""


def uleb128(buf: bytes, pos: int) -> tuple[int, int]:
    """LEB128(符号なし)を 1 つ読む。`(値, 次の位置)` を返す。"""
    value = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise BadWasm("LEB128 の途中で file が終わった(壊れているか、wasm ではない)")
        byte = buf[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if byte & 0x80 == 0:
            return value, pos
        shift += 7
        if shift > 63:
            raise BadWasm("LEB128 が長すぎる(壊れている)")


def custom_sections(buf: bytes) -> "list[tuple[str, bytes]]":
    """custom section を `(名前, 中身)` で全部返す。"""
    if buf[:4] != WASM_MAGIC:
        raise BadWasm("wasm ではない(先頭 4 バイトが \\0asm でない)")
    pos = 8  # magic 4 + version 4
    out: list[tuple[str, bytes]] = []
    while pos < len(buf):
        section_id = buf[pos]
        pos += 1
        size, pos = uleb128(buf, pos)
        end = pos + size
        if end > len(buf):
            raise BadWasm("section が file の外へはみ出している(壊れている)")
        if section_id == SECTION_CUSTOM:
            name_len, name_pos = uleb128(buf, pos)
            name = buf[name_pos : name_pos + name_len].decode("utf-8", "replace")
            out.append((name, buf[name_pos + name_len : end]))
        pos = end
    return out


def function_names(buf: bytes) -> "dict[int, str]":
    """`番号 → 名前`。⚠ 名前が 1 件も無ければ**例外**(空の dict を返さない)。"""
    sections = [body for (name, body) in custom_sections(buf) if name == "name"]
    if not sections:
        raise BadWasm(
            "name section が 0 件 ── これは**配布用の一式**である。"
            "名前を引くには --profiling-funcs で焼いた一式を渡す"
        )
    names: dict[int, str] = {}
    for body in sections:
        pos = 0
        while pos < len(body):
            sub_id = body[pos]
            pos += 1
            sub_size, pos = uleb128(body, pos)
            end = pos + sub_size
            if sub_id != SUBSECTION_FUNCTION_NAMES:
                pos = end
                continue
            count, pos = uleb128(body, pos)
            for _ in range(count):
                index, pos = uleb128(body, pos)
                name_len, pos = uleb128(body, pos)
                names[index] = body[pos : pos + name_len].decode("utf-8", "replace")
                pos += name_len
            pos = end
    if not names:
        raise BadWasm(
            "name section は在るが**関数名の副節(id=1)が 0 件** ── "
            "名前を引ける一式ではない"
        )
    return names


def same_sha(a: str, b: str) -> bool:
    """短縮 sha どうしを突き合わせる。⚠ 7 文字未満は**一致と見なさない**。"""
    a, b = a.strip().lower(), b.strip().lower()
    if len(a) < SHA_MIN or len(b) < SHA_MIN:
        return False
    if not (all(c in "0123456789abcdef" for c in a) and all(c in "0123456789abcdef" for c in b)):
        return False
    return a.startswith(b) or b.startswith(a)


def check_sha(wasm: Path, want: str, build_info: "Path | None") -> str:
    """名前つき一式の `lo_sha` を読み、渡された `lo_sha` と突き合わせる。

    ⚠ **読めなければ止める。** 「無かったので飛ばした」を許すと、この道具の
    唯一の前提(枝が同じ)が黙って外れる ── そして出てくるのは
    **それらしい別の名前**である(#631 の反例)。
    """
    info_path = build_info if build_info is not None else wasm.parent / "build-info.json"
    if not info_path.exists():
        raise BadWasm(
            f"{info_path} が無い ── どの枝で焼いた一式か分からないので引けない"
            "(名前つき一式には office-wasm-build が同梱している)"
        )
    try:
        info = json.loads(info_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise BadWasm(f"{info_path} を読めない: {exc}") from exc
    got = info.get("lo_sha")
    if not isinstance(got, str) or got.strip() == "":
        raise BadWasm(f"{info_path} に lo_sha が無い")
    if not same_sha(got, want):
        raise BadWasm(
            f"lo_sha が食い違う ── 名前つき一式は {got}、番号が出たのは {want}。"
            "枝が違うと**別の関数の名前**が出る(#631 の反例: 番号 39465)"
        )
    return got


def parse_indices(args: argparse.Namespace) -> "list[int]":
    """引数とスタックの字から、引く番号を順番どおり・重複を潰さずに集める。"""
    out = [int(x) for x in args.index]
    if args.stack is not None:
        text = sys.stdin.read() if args.stack == "-" else Path(args.stack).read_text(encoding="utf-8")
        out.extend(int(m) for m in FUNC_RE.findall(text))
    return out


def main(argv: "list[str] | None" = None) -> int:
    parser = argparse.ArgumentParser(description="wasm の番号を関数名に直す(#631)")
    parser.add_argument("--wasm", required=True, type=Path, help="名前つきで焼いた soffice.wasm")
    parser.add_argument(
        "--lo-sha",
        required=True,
        help="番号が出た(配布)一式の lo_sha。⚠ 名前つき一式のものと一致しなければ止める",
    )
    parser.add_argument("--build-info", type=Path, default=None, help="既定は --wasm の隣")
    parser.add_argument("--stack", default=None, help="wasm-function[N] を含む file(- で標準入力)")
    parser.add_argument("index", nargs="*", help="引く番号")
    args = parser.parse_args(argv)

    try:
        sha = check_sha(args.wasm, args.lo_sha, args.build_info)
        names = function_names(args.wasm.read_bytes())
    except BadWasm as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"✗ {args.wasm} を読めない: {exc}", file=sys.stderr)
        return 2

    indices = parse_indices(args)
    if not indices:
        print(f"✗ 引く番号が 1 つも無い(名前は {len(names)} 件読めている)", file=sys.stderr)
        return 2

    missing = []
    for index in indices:
        name = names.get(index)
        if name is None:
            missing.append(index)
            print(f"{index}\t?")
        else:
            print(f"{index}\t{name}")
    # 🔑 番号と枝は**対で**残す ── 番号だけの記録は枝が動いた瞬間に嘘になる
    print(f"# lo_sha={sha}  名前 {len(names)} 件", file=sys.stderr)
    if missing:
        print(
            f"✗ 引けなかった番号が {len(missing)} 件ある: {missing[:10]}"
            " ── 別の一式の番号を渡していないか確かめる",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
