/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-sdpr-trace.py` を検める(#1402 の**計装**。直しではない)。
 *
 * 🔴 **何のための印か**: Office を閉じた直後に、本体スレッドが `ThumbnailView::Paint` ←
 * `createPixelProcessor2DFromOutputDevice`(上流 `d6226c1a` の `processor2dtools.cxx`)で `memory access out of bounds` になる。
 * 落ちる場所が `HasMirroredGraphics()` の中か `CairoPixelProcessor2D` の ctor の中か、`rTargetOutDev` が何かが分かっていない。
 * 入口(`HasMirroredGraphics()` を呼ぶ**前**)に `enter #N outdev= type= t=`、ctor の**直後**に `made #N outdev= valid= t=` を出す。
 * 「enter があって made が無い」で、落ちたのがその間であることを言う。
 *
 * ⚠ 見るのは:
 *   ① **錨が原文に当たる**(上流の file そのまま)/ 1 つ外しても落ちる(file は不変)/ 当て済みは **SKIP(exit 0)で不変** /
 *      印が欠けた file・多い file は SKIP せず exit 1
 *   ② **印の位置**: enter は `HasMirroredGraphics()` の**前**・`if (bUsePrimitiveRenderer)` の中、made は ctor の**後**・`valid()` の検査の**前**。
 *      足した行は全部 `#if USE_HEADLESS_CODE` の**中**(`<cstdio>` / `<chrono>` も)── Windows の枝は 1 バイトも変わらない
 *   ③ **足した行は全部印を含み、原文の行は 1 行も書き換えない**
 *   ④ **本当にコンパイルして走らせる**(型を stub に替えた harness): **最初の 300 回は毎回・以後 50 回ごと・2 秒空いたら必ず・
 *      `OutputDevice` が前回出した物と変わったら必ず・前の呼び出しから 100 ms 空いたら必ず**(閉じた直後の連続描画の先頭と相手の入れ替わりを拾う)、
 *      enter が `HasMirroredGraphics()` より前・made が ctor の後に出る、鏡像で made が出ない、`type` / `valid` が値どおり
 *   ⑤ workflow の本数の主張がこの 1 本を数えている / 上流の実 file(在れば)へ本当に当たる
 *
 * 🔴 **言えないこと**: 本物の LO の header でコンパイルできること / 本物で落ちた呼び出し自身の enter が出ること
 * (同じ `OutputDevice` への 100 ms 未満の間隔の塊の途中で、50 回の倍数でも前回の出力から 2 秒未満でもない回は出ない)。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compileAndRun,
  count,
  extractFunction,
  haveCxx,
  makeTree,
  pyJson,
  restoreWithout,
  run,
  type Tree,
} from './helpers/office-lo-patch';

const SCRIPT = 'build/office-wasm/patch-lo-sdpr-trace.py';
const REL = 'drawinglayer/source/processor2d/processor2dtools.cxx';
const MARK = 'PKC3-SDPR';
const EXCERPT = readFileSync('tests/fixtures/office-lo/processor2dtools.excerpt.cxx', 'utf-8');
const FN = 'std::unique_ptr<BaseProcessor2D> createPixelProcessor2DFromOutputDevice(';
/** 上流の実 file(在る箱でだけ回す。CI には無いので skip ── 実物の錨は焼く前の `check-patches-on-ref.sh` が見る)。 */
const UPSTREAM = process.env['PKC3_LO_UP'] ?? '';
/**
 * 足す行の数(include 2 + 入口 22(注釈 1 + static 4 + lambda 6 + 連番と時刻 2 + 相手 1 + 判定 1 + 前回時刻 1 + 出力ブロック 6)+ made 2)。
 * 数え直したら理由を 1 行書く。(2026-10-07 のレビューで、相手が変わった所と 100 ms 空いた所を足した分 +5。)
 */
const ADDED = 26;

const FIX_ANCHORS = pyJson(SCRIPT, '[a for a,_ in m.PARTS]') as string[];
const tree = (body: string = EXCERPT): Tree => makeTree(REL, 'pkc3-sdpr-', body);

function patched(): string {
  const t = tree();
  try {
    expect(run(SCRIPT, t.dir).code).toBe(0);
    return t.read();
  } finally {
    t.cleanup();
  }
}

describe('#1402(sdpr-trace)── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている(0 件でも「全部当たった」は真になる)', () => {
    expect(FIX_ANCHORS.length, '錨を拾えていない').toBe(3);
    expect(new Set(FIX_ANCHORS).size, '同じ錨が在る').toBe(FIX_ANCHORS.length);
    expect(EXCERPT, '抜粋が空').toContain(FN);
  });

  it('🔴 錨は、上流の原文の抜粋に**ちょうど 1 件**ずつ当たる', () => {
    for (const a of FIX_ANCHORS) {
      expect(count(EXCERPT, a), `錨が 1 件でない:\n${a}`).toBe(1);
    }
  });

  it('🔴 毎回当たる(入力で gate しない)。当てると印が入り、file が変わる', () => {
    const t = tree();
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('patched:');
      expect(t.read()).not.toBe(EXCERPT);
      expect(t.read()).toContain(MARK);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 冪等: 当て済みは SKIP(exit 0)で、file は 1 バイトも変わらない', () => {
    const t = tree();
    try {
      expect(run(SCRIPT, t.dir).code).toBe(0);
      const once = t.read();
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('SKIP');
      expect(t.read()).toBe(once);
      expect(count(t.read(), 'PKC3-SDPR: enter #')).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 印が在るのに欠けている file(部分適用 / 手編集)は SKIP しない ── exit 1 で file は不変', () => {
    const partial = EXCERPT.replace(FIX_ANCHORS[0]!, FIX_ANCHORS[0]! + '// PKC3-SDPR (only the include line)\n');
    expect(partial, '部分適用の形を作れていない').not.toBe(EXCERPT);
    const t = tree(partial);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).not.toContain('SKIP');
      expect(r.out).toContain('部分適用');
      expect(t.read(), '部分適用の file を書き換えた').toBe(partial);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 錨が 1 つでも無ければ落ちる(exit 1)。何も書かない', () => {
    for (let i = 0; i < FIX_ANCHORS.length; i++) {
      const broken = EXCERPT.replace(FIX_ANCHORS[i]!, '// 上流が形を変えた\n');
      expect(broken, `錨 ${i} を外せていない`).not.toBe(EXCERPT);
      const t = tree(broken);
      try {
        const r = run(SCRIPT, t.dir);
        expect(r.code, `錨 ${i} を外しても落ちない:\n${r.out}`).toBe(1);
        expect(r.out, `錨 ${i} の落ち方が「錨の欠落」でない`).toContain('錨が 0 件');
        expect(t.read(), '落ちたのに書き換えている').toBe(broken);
      } finally {
        t.cleanup();
      }
    }
  });

  it('🔴 錨が 1 字違っても落ちる(上流が空白を変えたら、黙って通さない)', () => {
    const broken = EXCERPT.replace(FIX_ANCHORS[2]!, FIX_ANCHORS[2]!.replace('if (aRetval->valid())', 'if (aRetval->valid() )'));
    expect(broken).not.toBe(EXCERPT);
    const t = tree(broken);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(t.read()).toBe(broken);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 錨が 2 件になっても落ちる(同じ形が増えたら、どちらかを選ばない)', () => {
    const doubled = `${EXCERPT}\n${FIX_ANCHORS[1]}`;
    const t = tree(doubled);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('錨が 2 件');
      expect(t.read()).toBe(doubled);
    } finally {
      t.cleanup();
    }
  });

  it('当て先の file が無ければ落ちる', () => {
    const t = tree();
    try {
      const r = run(SCRIPT, `${t.dir}/no-such-root`);
      expect(r.code).toBe(1);
      expect(r.out).toContain(REL);
    } finally {
      t.cleanup();
    }
  });
});

describe('#1402(sdpr-trace)── 当てた結果(描いた C++ で見る)', () => {
  it('🔴 順序: 入口の印 → `HasMirroredGraphics()` → ctor → made の印 → `valid()` の検査(落ちる前に出ることが要)', () => {
    const fn = extractFunction(patched(), FN);
    const at = (needle: string): number => {
      expect(count(fn, needle), `「${needle.trim()}」が関数の中で 1 件でない`).toBe(1);
      return fn.indexOf(needle);
    };
    const gateAt = at('if (bUsePrimitiveRenderer)\n    {\n        // PKC3-SDPR');
    const enterAt = at('PKC3-SDPR: enter #');
    const mirrorAt = at('rTargetOutDev.HasMirroredGraphics()');
    const ctorAt = at('std::make_unique<CairoPixelProcessor2D>(');
    const madeAt = at('PKC3-SDPR: made #');
    const validAt = at('            if (aRetval->valid())\n            {');
    expect(gateAt).toBeLessThan(enterAt);
    expect(enterAt).toBeLessThan(mirrorAt);
    expect(mirrorAt).toBeLessThan(ctorAt);
    expect(ctorAt).toBeLessThan(madeAt);
    expect(madeAt).toBeLessThan(validAt);
  });

  it('🔴 頻度の規則を手で書いて突き合わせる(300 回まで毎回 / 50 回ごと / 2 秒空いたら必ず)と、印の書式', () => {
    const after = patched();
    expect(after).toContain(
      `        const bool bPkc3Say = nPkc3N <= 300 || nPkc3N % 50 == 0 || nPkc3Now - nPkc3LastMs >= 2000 || pPkc3Dev != pPkc3LastDev || nPkc3Now - nPkc3PrevMs >= 100; // ${MARK}\n        nPkc3PrevMs = nPkc3Now; // ${MARK}\n`,
    );
    // 出したときだけ「前回の出力」を更新する(相手 / 時刻)。前の呼び出しの時刻は出した出さないに関わらず毎回更新する
    expect(after).toContain(`            nPkc3LastMs = nPkc3Now; // ${MARK}\n            pPkc3LastDev = pPkc3Dev; // ${MARK}\n`);
    expect(after).toContain(
      `            std::fprintf(stderr, "${MARK}: enter #%d outdev=%p type=%d t=%lld\\n", nPkc3N, static_cast<const void*>(&rTargetOutDev), static_cast<int>(rTargetOutDev.GetOutDevType()), nPkc3Now); // ${MARK}\n`,
    );
    expect(after).toContain(
      `                std::fprintf(stderr, "${MARK}: made #%d outdev=%p valid=%d t=%lld\\n", nPkc3N, static_cast<const void*>(&rTargetOutDev), aRetval->valid() ? 1 : 0, pPkc3Ms()); // ${MARK}\n`,
    );
    // made は enter を出した回だけ(対で読める)
    expect(after).toContain(`            if (bPkc3Say) // ${MARK}\n                std::fprintf(stderr, "${MARK}: made`);
  });

  it('🔴 足した行は全部 `USE_HEADLESS_CODE` の中(`#if` と `#elif defined(_WIN32)` の間 / 関数の中の `#if` の枝)', () => {
    const after = patched();
    // include: 最初の `#if USE_HEADLESS_CODE` と `#elif defined(_WIN32)` の間
    const ifAt = after.indexOf('#if USE_HEADLESS_CODE');
    const elifAt = after.indexOf('#elif defined(_WIN32)', ifAt);
    const head = after.slice(ifAt, elifAt);
    expect(head).toContain(`#include <cstdio> // ${MARK}`);
    expect(head).toContain(`#include <chrono> // ${MARK}`);
    // 関数の中: 印は全部 `#elif defined(_WIN32)` より前
    const fn = extractFunction(after, FN);
    const fnIf = fn.indexOf('#if USE_HEADLESS_CODE');
    const fnElif = fn.indexOf('#elif defined(_WIN32)');
    expect(fnIf).toBeGreaterThanOrEqual(0);
    expect(fnElif).toBeGreaterThan(fnIf);
    const lastMark = fn.lastIndexOf(MARK);
    expect(lastMark, '印が Windows の枝に漏れている').toBeLessThan(fnElif);
    // Windows の枝と既定の枝は 1 バイトも変わらない
    const win = (t: string): string => t.slice(t.indexOf('#elif defined(_WIN32)', t.indexOf(FN)));
    expect(win(after)).toBe(win(EXCERPT));
  });

  it('🔴 足した行は全部印を含む。原文の行は 1 行も書き換えない', () => {
    const after = patched();
    expect(after).not.toBe(EXCERPT);
    expect(restoreWithout(after, MARK)).toBe(EXCERPT);
    const added = after.split('\n').filter((l) => l.includes(MARK));
    expect(added.length).toBe(ADDED);
    const origLines = new Set(EXCERPT.split('\n'));
    const bare = after.split('\n').filter((l) => !origLines.has(l) && !l.includes(MARK));
    expect(bare, '印の無い足し行').toEqual([]);
    for (const l of added) {
      expect(l, '行末の \\ は次の行をコメントへ連結する').not.toMatch(/\\\s*$/);
      expect(l, 'ブロックコメントは使わない').not.toMatch(/\/\*|\*\//);
    }
    const code = added
      .filter((l) => !/^\s*\/\/ /.test(l))
      .map((l) => l.replace(/"[^"]*"/g, '').replace(/\/\/.*$/, ''))
      .join('\n');
    expect(count(code, '{')).toBe(count(code, '}'));
  });

  it('🔴 原文の他の所は動かない: `HasMirroredGraphics` / ctor の引数 / `VclPixelProcessor2D` の既定の枝は元のまま', () => {
    const after = patched();
    for (const needle of [
      '        const bool bMirrored(rTargetOutDev.IsRTLEnabled() || rTargetOutDev.HasMirroredGraphics());\n',
      '    return std::make_unique<VclPixelProcessor2D>(rViewInformation2D, rTargetOutDev);\n',
      '                    rTargetOutDev,\n                    rViewInformation2D));\n',
    ]) {
      expect(count(after, needle), needle).toBe(count(EXCERPT, needle));
    }
  });
});

/**
 * `createPixelProcessor2DFromOutputDevice` を、型だけ stub に替えて本当にコンパイルして走らせる。
 * 引数: `n mirrored type invalid [steps…]`。`n` 回は同じ相手 `a` へ続けて呼ぶ(間を空けない)。
 * step は `K:ms[:b]` ── 「`ms` 待ってから呼ぶ」を `K` 回(相手は `a`、`:b` なら別の `b`)。step の頭で `STEP <番号> dev=…` を出す。
 * 🔑 step があるときだけ、**最後の通常呼び出しと step の各呼び出し**について、呼ぶ直前 / 直後の実測時刻(`steady_clock` の ms。patch と同じ時計)を
 * `CALL #<通し番号> dev=… t0=… t1=…` の 1 行で出す(負荷で刻みが伸びた回を test が見分けるため)。
 */
function harness(fn: string): string {
  return `#define USE_HEADLESS_CODE 1
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <thread>
enum OutDevType { OUTDEV_WINDOW, OUTDEV_PRINTER, OUTDEV_VIRDEV, OUTDEV_PDF };
static bool g_mirrored = false;
static bool g_invalid = false;
struct OutputDevice {
    OutDevType meType = OUTDEV_WINDOW;
    OutDevType GetOutDevType() const { return meType; }
    bool IsRTLEnabled() const { return false; }
    // 落ちる候補の場所。enter はこれより前に出ていなければならない
    bool HasMirroredGraphics() const { std::fprintf(stderr, "IN_HASMIRRORED\\n"); return g_mirrored; }
};
namespace drawinglayer::geometry { struct ViewInformation2D {}; }
namespace drawinglayer::processor2d {
struct BaseProcessor2D { virtual ~BaseProcessor2D() = default; };
struct CairoPixelProcessor2D : BaseProcessor2D {
    bool mbValid;
    CairoPixelProcessor2D(OutputDevice&, const geometry::ViewInformation2D&) : mbValid(!g_invalid) { std::fprintf(stderr, "IN_CTOR\\n"); }
    bool valid() const { return mbValid; }
};
struct VclPixelProcessor2D : BaseProcessor2D { VclPixelProcessor2D(const geometry::ViewInformation2D&, OutputDevice&) {} };
${fn}
}
static long long nowMs()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
static int g_calls = 0;
static void callOnce(OutputDevice& d, const drawinglayer::geometry::ViewInformation2D& v, bool verbose)
{
    const long long t0 = nowMs();
    (void)drawinglayer::processor2d::createPixelProcessor2DFromOutputDevice(d, v);
    const long long t1 = nowMs();
    ++g_calls;
    if (verbose)
        std::fprintf(stderr, "CALL #%d dev=%p t0=%lld t1=%lld\\n", g_calls, static_cast<void*>(&d), t0, t1);
}
int main(int argc, char** argv)
{
    if (argc < 5) return 2;
    const int n = std::atoi(argv[1]);
    g_mirrored = std::atoi(argv[2]) != 0;
    OutputDevice a;
    a.meType = static_cast<OutDevType>(std::atoi(argv[3]));
    OutputDevice b;
    b.meType = a.meType;
    g_invalid = std::atoi(argv[4]) != 0;
    drawinglayer::geometry::ViewInformation2D v;
    for (int i = 0; i < n; ++i)
        callOnce(a, v, argc > 5 && i == n - 1);
    for (int s = 5; s < argc; ++s)
    {
        int k = 0;
        int ms = 0;
        char w[2] = { 0, 0 };
        const int got = std::sscanf(argv[s], "%d:%d:%1s", &k, &ms, w);
        OutputDevice& d = (got >= 3 && w[0] == 'b') ? b : a;
        std::fprintf(stderr, "STEP %d dev=%p\\n", s - 4, static_cast<void*>(&d));
        for (int j = 0; j < k; ++j)
        {
            if (ms > 0) std::this_thread::sleep_for(std::chrono::milliseconds(ms));
            callOnce(d, v, true);
        }
    }
    return 0;
}
`;
}

interface Call {
  k: number;
  dev: string;
  t0: number;
  t1: number;
}

/**
 * 🔑 規則の判定器(負荷で刻みが伸びても嘘をつかない)。harness が出した**実測**の時刻(呼ぶ直前 `t0` / 直後 `t1`)と、patch が出した enter(`#N` / `t=`)を突き合わせ、
 * 最後の通常呼び出しより後の各呼び出しについて 2 つを数える:
 *   - **missing**: 規則により**必ず**出るはずなのに出ていない回。「必ず」= 通し番号が 300 以下 / 50 の倍数、または
 *     **前の呼び出しの直後 `t1` から今の直前 `t0` まで 100 ms 以上**(patch の見た間隔はこれ以上)、または
 *     **前回の出力の `t=` から `t0` まで 2 秒以上**、または相手が前回出した物と違う。
 *   - **unexplained**: 出ているのに、規則では**どうやっても説明できない**回。「説明できる」= 上の条件が、`t1`(最大に見積もった時刻)で 1 つでも成り立つ。
 * 負荷で刻みが 100 ms を超えた回の enter は規則どおりなので unexplained に数えない。
 */
function judge(stderr: string): { missing: number[]; unexplained: number[]; calls: Call[] } {
  const lines = stderr.split('\n');
  const calls: Call[] = [];
  for (const l of lines) {
    const m = /^CALL #(\d+) dev=(\S+) t0=(\d+) t1=(\d+)$/.exec(l);
    if (m) calls.push({ k: Number(m[1]), dev: m[2]!, t0: Number(m[3]), t1: Number(m[4]) });
  }
  const enters = new Map<number, { t: number; dev: string }>();
  for (const l of lines) {
    const m = /PKC3-SDPR: enter #(\d+) outdev=(\S+) type=\d+ t=(\d+)$/.exec(l);
    if (m) enters.set(Number(m[1]), { t: Number(m[3]), dev: m[2]! });
  }
  expect(calls.length, 'CALL の行が出ていない(step が無い?)').toBeGreaterThanOrEqual(2);
  // 最後の通常呼び出し(calls[0])までの最後の出力が「前回の出力」
  let last: { t: number; dev: string } | undefined;
  for (const [n, e] of enters) if (n <= calls[0]!.k) last = e;
  expect(last, '通常呼び出しの間に 1 本も出ていない').toBeDefined();
  const missing: number[] = [];
  const unexplained: number[] = [];
  for (let i = 1; i < calls.length; i++) {
    const c = calls[i]!;
    const prev = calls[i - 1]!;
    const byCount = c.k <= 300 || c.k % 50 === 0;
    const devChanged = c.dev !== last!.dev;
    const must = byCount || devChanged || c.t0 - prev.t1 >= 100 || c.t0 - last!.t >= 2000;
    const can = byCount || devChanged || c.t1 - prev.t0 >= 100 || c.t1 - last!.t >= 2000;
    const e = enters.get(c.k);
    if (must && !e) missing.push(c.k);
    if (e && !can) unexplained.push(c.k);
    if (e) last = e;
  }
  return { missing, unexplained, calls };
}

describe('#1402(sdpr-trace)── 本当にコンパイルして走らせる(型だけ stub)', () => {
  const src = haveCxx() ? harness(extractFunction(patched(), FN)) : '';
  const go = (...a: (number | string)[]): ReturnType<typeof compileAndRun> => compileAndRun(src, a.map(String));
  const only = (err: string, re: RegExp): string[] => err.split('\n').filter((l) => re.test(l));
  /** `STEP <k>` から次の STEP の手前までの行。 */
  const stepLines = (err: string, k: number): string[] => {
    const all = err.split('\n');
    const from = all.findIndex((l) => l.startsWith(`STEP ${k} `));
    expect(from, `STEP ${k} が出ていない`).toBeGreaterThanOrEqual(0);
    const rest = all.slice(from + 1);
    const to = rest.findIndex((l) => l.startsWith('STEP '));
    return to < 0 ? rest : rest.slice(0, to);
  };
  const enters = (lines: string[]): string[] => lines.filter((l) => /PKC3-SDPR: enter/.test(l));

  it.skipIf(!haveCxx())('🔴 順番: enter → `HasMirroredGraphics()` → ctor → made。値(type / valid)は呼んだとおり', () => {
    const r = go(1, 0, 2, 0);
    expect(r.compile, r.compileOut).toBe(0);
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stderr.split('\n').filter((l) => l !== '');
    expect(lines.map((l) => l.replace(/^(PKC3-SDPR: \w+|IN_\w+).*$/, '$1'))).toEqual([
      'PKC3-SDPR: enter',
      'IN_HASMIRRORED',
      'IN_CTOR',
      'PKC3-SDPR: made',
    ]);
    expect(lines[0]).toMatch(/enter #1 outdev=\S+ type=2 t=\d+$/);
    expect(lines[3]).toMatch(/made #1 outdev=\S+ valid=1 t=\d+$/);
    // enter と made が同じ outdev を指す
    expect(/outdev=(\S+)/.exec(lines[0]!)![1]).toBe(/outdev=(\S+)/.exec(lines[3]!)![1]);
  }, 60_000);

  it.skipIf(!haveCxx())('🔴 ctor が「無効」を返せば valid=0 と出る / 鏡像のときは made を出さない(ctor に入らない)', () => {
    const bad = go(1, 0, 0, 1);
    expect(bad.compile, bad.compileOut).toBe(0);
    expect(only(bad.stderr, /made/)[0]).toMatch(/valid=0/);
    const mirrored = go(1, 1, 0, 0);
    expect(only(mirrored.stderr, /PKC3-SDPR: enter/).length).toBe(1);
    expect(only(mirrored.stderr, /PKC3-SDPR: made/).length, '鏡像なのに ctor に入っている').toBe(0);
    expect(only(mirrored.stderr, /IN_CTOR/).length).toBe(0);
  }, 60_000);

  it.skipIf(!haveCxx())('🔴 頻度: 1000 回呼ぶと enter は #1〜#300 と #350, #400, … #1000(14 本)── made も同じ回に出る', () => {
    const r = go(1000, 0, 0, 0);
    expect(r.compile, r.compileOut).toBe(0);
    const ns = only(r.stderr, /PKC3-SDPR: enter/).map((l) => Number(/#(\d+)/.exec(l)![1]));
    const want = [...Array.from({ length: 300 }, (_, i) => i + 1), ...Array.from({ length: 14 }, (_, i) => 350 + 50 * i)];
    // 期待は手で数えた 314 本。⚠ 呼び出しの間が 100 ms 空けば(負荷で止まれば)規則どおり**余分に**出るので、足りない物と余分の数を別に見る
    expect(want.filter((n) => !ns.includes(n)), '出るはずの回が出ていない').toEqual([]);
    expect(ns.length - want.length, '余分に出ている(止まった回が 2 回を超える)').toBeLessThanOrEqual(2);
    const madeNs = only(r.stderr, /PKC3-SDPR: made/).map((l) => Number(/#(\d+)/.exec(l)![1]));
    expect(madeNs, 'made は enter を出した回だけ・全部').toEqual(ns);
  }, 60_000);

  it.skipIf(!haveCxx())('🔴 2 秒の規則: 400 回の後、50 ms おきに 45 回(= 2.25 秒、50 の倍数を跨がない)── 前回の出力から 2 秒空いた回は必ず出る。説明できない出力は無い', () => {
    const r = go(400, 0, 0, 0, '45:50');
    expect(r.compile, r.compileOut).toBe(0);
    const j = judge(r.stderr);
    // 場面が成り立っている: 最後の呼び出しの直前は、#400 の出力から 2 秒以上後(sleep だけで 2.25 秒)
    const t400 = Number(/PKC3-SDPR: enter #400 outdev=\S+ type=\d+ t=(\d+)$/m.exec(r.stderr)![1]);
    expect(j.calls[j.calls.length - 1]!.t0 - t400, '場面が 2 秒に届いていない').toBeGreaterThanOrEqual(2000);
    expect(enters(stepLines(r.stderr, 1)).length, '前回の出力から 2 秒空いたのに 1 本も出ていない').toBeGreaterThanOrEqual(1);
    expect(j.missing, '規則で必ず出るはずの回が出ていない').toEqual([]);
    expect(j.unexplained, '規則で説明できない出力').toEqual([]);
    // 対照群: 2 秒の手前(同じ間隔で 30 回 = 1.5 秒)。出ていても、100 ms の規則(負荷で刻みが伸びた回)で説明できるものだけ
    const short = judge(go(400, 0, 0, 0, '30:50').stderr);
    expect(short.missing).toEqual([]);
    expect(short.unexplained, '2 秒未満で規則に説明できない出力').toEqual([]);
  }, 60_000);

  it.skipIf(!haveCxx())('🔴 100 ms の規則: 前の呼び出しから 150 ms 空いた #402 は出る。10 ms しか空かない #401 は(実測の間隔が 100 ms 未満なら)出ない', () => {
    const r = go(400, 0, 0, 0, '1:10', '1:150');
    expect(r.compile, r.compileOut).toBe(0);
    const j = judge(r.stderr);
    const c402 = j.calls.find((c) => c.k === 402)!;
    const c401 = j.calls.find((c) => c.k === 401)!;
    expect(c402.t0 - c401.t1, '場面が成り立っていない(sleep が 150 ms に届いていない)').toBeGreaterThanOrEqual(100);
    const gap = stepLines(r.stderr, 2);
    expect(enters(gap).length, '100 ms 空いたのに出ていない').toBe(1);
    expect(enters(gap)[0]).toMatch(/enter #402 /);
    expect(only(gap.join('\n'), /PKC3-SDPR: made #402 /).length).toBe(1);
    expect(j.missing, '規則で必ず出るはずの回が出ていない').toEqual([]);
    // #401 は、実測の間隔が 100 ms 以上に伸びた(負荷)ときだけ出てよい ── 説明できない出力だけを落とす
    expect(j.unexplained, '規則で説明できない出力(10 ms の刻みで出た)').toEqual([]);
  }, 60_000);

  it.skipIf(!haveCxx())('🔴 相手が変わったら必ず出す: a から b に変わった最初の 1 回と、b から a に戻った最初の 1 回。同じ相手の続きは(説明できる回を除き)出ない', () => {
    const r = go(400, 0, 0, 0, '1:0', '2:0:b', '1:0:a');
    expect(r.compile, r.compileOut).toBe(0);
    const j = judge(r.stderr);
    expect(j.missing, '規則で必ず出るはずの回が出ていない').toEqual([]);
    expect(j.unexplained, '規則で説明できない出力(同じ相手の続きで出た)').toEqual([]);
    const toB = enters(stepLines(r.stderr, 2));
    expect(toB.length, '変わった最初の 1 回は出る').toBeGreaterThanOrEqual(1);
    expect(toB[0]).toMatch(/enter #402 /);
    const back = enters(stepLines(r.stderr, 3));
    expect(back.length, 'a に戻った 1 回').toBe(1);
    expect(back[0]).toMatch(/enter #404 /);
    // 出た回の outdev が、その step で呼んだ相手と一致する
    const devOf = (k: number): string => /dev=(\S+)/.exec(r.stderr.split('\n').find((l) => l.startsWith(`STEP ${k} `))!)![1]!;
    expect(toB[0]).toContain(`outdev=${devOf(2)} `);
    expect(back[0]).toContain(`outdev=${devOf(3)} `);
    expect(devOf(2)).not.toBe(devOf(3));
  }, 60_000);
});

describe('#1402(sdpr-trace)── 上流の実 file へ', () => {
  const real = UPSTREAM ? join(UPSTREAM, REL) : '';
  it.skipIf(!real || !existsSync(real))('🔴 実 file へ当たる(exit 0)。足した行は 21・消した行は 0。2 度目は SKIP で不変', () => {
    const orig = readFileSync(real, 'utf-8');
    const t = tree(orig);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(0);
      const after = t.read();
      expect(after.split('\n').length - orig.split('\n').length).toBe(ADDED);
      expect(restoreWithout(after, MARK)).toBe(orig);
      const r2 = run(SCRIPT, t.dir);
      expect(r2.code, r2.out).toBe(0);
      expect(r2.out).toContain('SKIP');
      expect(t.read()).toBe(after);
    } finally {
      t.cleanup();
    }
  });

  it.skipIf(!real || !existsSync(real))('🔴 抜粋は実 file の原文そのまま(1〜140 行)', () => {
    const orig = readFileSync(real, 'utf-8').split('\n').slice(0, 140).join('\n') + '\n';
    expect(EXCERPT.startsWith(orig)).toBe(true);
  });
});

describe('#1402(sdpr-trace)── 他の検査との関係', () => {
  it('🔑 当て先が、他の LO patch と重ならない(同じ file を 2 本が触ると当てる順で結果が変わる)', () => {
    const owners = readdirSync('build/office-wasm')
      .filter((f) => /^patch-.*\.py$/.test(f))
      .filter((f) => readFileSync(join('build/office-wasm', f), 'utf-8').includes(`"${REL}"`));
    expect(owners).toEqual(['patch-lo-sdpr-trace.py']);
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/^SRC\s*=\s*"drawinglayer\/source\/processor2d\/processor2dtools\.cxx"/m);
  });

  it('🔑 workflow の本数の主張が、この 1 本を数えている(31 → 34 の 3 本のうち 1 本)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/31 → 34\(2026-10-07\)/);
    expect(yml).toContain('patch-lo-sdpr-trace.py');
    expect(yml).toContain('test "$n" -eq 34');
  });
});
