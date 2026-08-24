#!/usr/bin/env python3
"""計装のヘルパーが**本当にコンパイルできる**ことを、焼く前に確かめる。

🔴 **これは 1 本の焼きを落として学んだ検査である**(2026-08-24、run 32786136716)。

`patch-lo-idles-trace.py` に「どの行にも `pthread_self()` を出す」を足したとき、
`static_cast<void*>(pthread_self())` と書いた。⚠ **`pthread_t` を pointer だと
決めつけていた**が、emscripten では `unsigned long` である ── 15 分の焼きが
`make` で落ちて、compiler にそう教わった:

    error: cannot cast from type 'pthread_t' (aka 'unsigned long')
           to pointer type 'void *'

🔑 **ヘルパーは libc だけで書く規律なので、手元の g++ でそのまま通せる。**
LO を建てなくても、**書式・型・警告**はここで全部落とせる ── 焼きは 15〜30 分、
この検査は 1 秒である。

## 何を主張するか

1. 各ヘルパーが **`-Wall -Wextra -Werror`** で通る(LO も警告に厳しい)
2. 🔴 **`pthread_t` の実体が「整数」でも「pointer」でも通る** ── 上の事故そのもの。
   ⚠ 片方だけで試すと、もう片方で落ちる形が素通りする
3. 走らせて **1 行出る**(書式指定子と引数が食い違っていないこと ── ⚠ 通るだけでは
   `%llu` に 32bit を渡すような取り違えを捕まえられない)

⚠ **空振り防止**: ヘルパーを 1 つも見つけられなかったら落ちる。
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
FLOOR = 3  # 実測(2026-08-24): idles / ime / save の 3 本

# ⚠ `#include <pthread.h>` を差し替えて実体を作る。**両方**当てるのが肝。
# ⚠ stub には `[[maybe_unused]]` を付ける ── stub は**足場**であって主張の対象ではない。
#    付けないと、`pthread_self()` を呼ばないヘルパー(いまの ime / save がそう)で
#    `-Wunused-function` が鳴り、**中身と無関係な理由で落ちる**。
SHAPES = {
    "整数(emscripten の実体)": (
        "typedef unsigned long pthread_t;\n"
        "[[maybe_unused]] static pthread_t pthread_self(){ return 4321UL; }\n"
    ),
    "pointer(glibc 風)": (
        "struct __pthread; typedef struct __pthread* pthread_t;\n"
        "[[maybe_unused]] static pthread_t pthread_self(){ return (pthread_t)0x1234; }\n"
    ),
}


def helpers() -> list[tuple[str, str]]:
    """`patch-lo-*.py` のうち、module 直下に `HELPER` を持つものを集める。"""
    out: list[tuple[str, str]] = []
    sys.dont_write_bytecode = True
    for path in sorted(HERE.glob("patch-lo-*.py")):
        spec = importlib.util.spec_from_file_location(f"pkc3_{path.stem}", path)
        if spec is None or spec.loader is None:
            continue
        mod = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(mod)
        except Exception as e:  # pragma: no cover - 読めない patch は別の検査が落とす
            print(f"ERROR: {path.name} を読み込めない: {e}", file=sys.stderr)
            raise SystemExit(1)
        text = getattr(mod, "HELPER", None)
        if isinstance(text, str) and "pkc3_" in text:
            out.append((path.name, text))
    return out


def entry_point(text: str) -> str | None:
    """ヘルパーの関数名(`pkc3_…_trace`)を拾う ── 走らせて 1 行出させるため。"""
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("void pkc3_") and "(" in s:
            return s[len("void ") : s.index("(")]
    return None


def check(name: str, text: str) -> bool:
    fn = entry_point(text)
    if fn is None:
        print(f"ERROR: {name} のヘルパーに `void pkc3_…(` が無い ── 検査が空振りしている",
              file=sys.stderr)
        return False
    ok = True
    for shape, stub in SHAPES.items():
        src = text.replace("#include <pthread.h>", stub)
        # ⚠ `pthread.h` を使わないヘルパーでも、この差し替えは無害(何も置き換わらない)
        src += f'\nint main(){{ {fn}("t:probe", 1, 2, 3); return 0; }}\n'
        with tempfile.TemporaryDirectory() as d:
            cxx, exe = Path(d) / "t.cxx", Path(d) / "t"
            cxx.write_text(src, encoding="utf-8")
            r = subprocess.run(
                ["g++", "-std=c++20", "-Wall", "-Wextra", "-Werror", str(cxx), "-o", str(exe)],
                capture_output=True, text=True,
            )
            if r.returncode != 0:
                print(f"ERROR: {name} / {shape}: compile できない\n{r.stderr[:800]}", file=sys.stderr)
                ok = False
                continue
            run = subprocess.run([str(exe)], capture_output=True, text=True, cwd=d)
            # ⚠ 走らせて 1 行出ることまで見る(書式と引数の食い違いは compile では出ない)
            if "t:probe" not in run.stderr:
                print(f"ERROR: {name} / {shape}: 走らせても 1 行も出ない", file=sys.stderr)
                ok = False
                continue
            print(f"  {name} / {shape}: ✅ {run.stderr.strip().splitlines()[0]}")
    return ok


# 🔴 **検査そのものの対照群**(2026-08-24)。
#
# ⚠ いまの 3 本はどれも警告を出さず、どれも 1 行出すので、**門を外しても落ちない**
#    (変異試験 M5「`-Werror` を外す」/ M6「出力を見ない」が SURVIVED で教えた)。
# 🔑 だから **その門だけが鳴る形**を自前で用意する ── 門を N 個置いたら、
#    N 個目だけが鳴る場面を N 通り作る(CLAUDE.md §1)。
SELF_GOOD = """
#include <cstdio>
#include <pthread.h>
namespace
{
void pkc3_self_trace(const char* what, int a, int b, int c)
{
    std::fprintf(stderr, "SELF %s %d %d %d\\n", what, a, b, c);
}
}
"""

# ① 警告が出るだけ(`-Werror` が無ければ通る)── 警告の門だけが鳴る
SELF_WARN = """
#include <cstdio>
#include <pthread.h>
namespace
{
void pkc3_self_trace(const char* what, int a, int b, int c)
{
    int nUnused = 1;
    std::fprintf(stderr, "SELF %s %d %d %d\\n", what, a, b, c);
}
}
"""

# ② compile は通るが **1 行も出さない** ── 走らせて見る門だけが鳴る
SELF_QUIET = """
#include <cstdio>
#include <pthread.h>
namespace
{
void pkc3_self_trace(const char* what, int a, int b, int c)
{
    char line[64];
    std::snprintf(line, sizeof line, "%s %d %d %d", what, a, b, c);
    (void)line;
}
}
"""


def self_test() -> bool:
    """門が本当に鳴るかを、こちらで作った 3 つの形で確かめる。"""
    ok = True
    if not check("(対照群)良い形", SELF_GOOD):
        print("ERROR: 良い形を落としている ── 検査が厳しすぎる", file=sys.stderr)
        ok = False
    for label, text, why in (
        ("警告の出る形", SELF_WARN, "`-Werror` の門が死んでいる"),
        ("1 行も出さない形", SELF_QUIET, "走らせて見る門が死んでいる"),
    ):
        # ⚠ ここは**落ちるのが正しい** ── 出力は捨てて真偽だけ見る
        import contextlib, io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            passed = check(f"(対照群){label}", text)
        if passed:
            print(f"ERROR: {label} が通ってしまう ── {why}", file=sys.stderr)
            ok = False
        else:
            print(f"  (対照群){label}: ✅ ちゃんと落ちる")
    return ok


def main() -> int:
    try:
        subprocess.run(["g++", "--version"], capture_output=True, check=True)
    except Exception:
        # ⚠ 道具が無いのを「通った」と読まない(CLAUDE.md「走らなかった = 確かめていない」)
        print("ERROR: g++ が無い ── この検査は走っていない", file=sys.stderr)
        return 1

    if not self_test():
        return 1

    found = helpers()
    print(f"計装のヘルパー: {len(found)} 本")
    if len(found) < FLOOR:
        print(f"ERROR: {len(found)} 本しか見つからない(下限 {FLOOR})"
              f" ── 拾い方が patch の書き方に追随していない", file=sys.stderr)
        return 1
    return 0 if all(check(n, t) for n, t in found) else 1


if __name__ == "__main__":
    raise SystemExit(main())
