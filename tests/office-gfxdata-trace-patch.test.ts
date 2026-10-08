/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-gfxdata-trace.py` を検める(#1402 の**印と null 門**)。
 *
 * 🔴 **何のための印か**: Office を閉じた直後に、本体スレッドが `ThumbnailView::Paint` ←
 * `createPixelProcessor2DFromOutputDevice` で `memory access out of bounds` になる。候補の 1 つは、
 * `OutputDevice::GetSystemGfxData()`(上流 `d6226c1a` の `outdev.cxx`)が `ApplyFullDamage()`(SolarMutex を手放す hop を含みうる)の**後**に
 * `mpGraphics` を読み直す間に、別の経路(`WindowOutputDevice::AcquireGraphics` の奪取)が `mpGraphics` を null にすること。
 * 控えと読み直しが**変わったときだけ** `gfx changed` を出し、null なら**空の `SystemGraphicsData()` を返して落ちない**(門 = 直しの一部)。
 * あわせて返す直前の `pSurface` を `surface outdev= gfx= surface=` で出す(`PKC3-SURFACE: resize destroy` の `t=` と突き合わせる)。
 *
 * ⚠ 見るのは:
 *   ① **錨が原文に当たる**(上流の file そのまま)/ 1 つ外しても落ちる(file は不変)/ 当て済みは **SKIP(exit 0)で不変** /
 *      印が欠けた file・多い file は SKIP せず exit 1
 *   ② **位置**: 控えは `ApplyFullDamage` の**前**・読み直しは**後**・null 門は「変わった」ブロックの中・`pSurface` の印は原文の `return` の前。
 *      足した行は全部 `#if USE_HEADLESS_CODE` の**中**(`<cstdio>` / `<chrono>` を除く)── 他の build の `GetSystemGfxData` は 1 バイトも変わらない
 *   ③ **足した行は全部印を含み、原文の行は 1 行も書き換えない**
 *   ④ **本当にコンパイルして走らせる**(型を stub に替えた harness): 変わらなければ **0 行**、null になれば**落ちずに空を返し**印が出る、
 *      別の pointer ならそのまま続けて新しい物で返す、`surface` の印は 300 回まで毎回・50 回ごと・2 秒空いたら必ず・
 *      **前回出した値と変わったら必ず**(resize の直後の最初の読み)、
 *      headless でない build では**何も出ず**原文と同じに返る
 *   ⑤ workflow の本数の主張がこの 1 本を数えている / 上流の実 file(在れば)へ本当に当たる
 *
 * 🔴 **言えないこと**: 本物の LO の header でコンパイルできること / 本物の奪取で `mpGraphics` が null になること /
 * 🔴 **`pSurface` が差し替えで捨てられた物を指す競合は、この門では直らない**(null のときだけ捕まえる)。
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

const SCRIPT = 'build/office-wasm/patch-lo-gfxdata-trace.py';
const REL = 'vcl/source/outdev/outdev.cxx';
const MARK = 'PKC3-GFXDATA';
const EXCERPT = readFileSync('tests/fixtures/office-lo/outdev.excerpt.cxx', 'utf-8');
const FN = 'SystemGraphicsData OutputDevice::GetSystemGfxData() const';
/** 上流の実 file(在る箱でだけ回す。CI には無いので skip ── 実物の錨は焼く前の `check-patches-on-ref.sh` が見る)。 */
const UPSTREAM = process.env['PKC3_LO_UP'] ?? '';
/**
 * 足す行の数(include 2 + 控えと lambda と static 11 + 読み直しと門 6 + `pSurface` の印 12)。数え直したら理由を 1 行書く。
 * (2026-10-07 のレビューで、`pSurface` が変わったら必ず出す分 +2: `pPkc3LastSurface` の宣言と更新。)
 */
const ADDED = 31;

const FIX_ANCHORS = pyJson(SCRIPT, '[a for a,_ in m.PARTS]') as string[];
const tree = (body: string = EXCERPT): Tree => makeTree(REL, 'pkc3-gfxdata-', body);

function patched(): string {
  const t = tree();
  try {
    expect(run(SCRIPT, t.dir).code).toBe(0);
    return t.read();
  } finally {
    t.cleanup();
  }
}

describe('#1402(gfxdata-trace)── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている(0 件でも「全部当たった」は真になる)', () => {
    expect(FIX_ANCHORS.length, '錨を拾えていない').toBe(2);
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
      expect(count(t.read(), 'PKC3-GFXDATA: gfx changed')).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 印が在るのに欠けている file(部分適用 / 手編集)は SKIP しない ── exit 1 で file は不変', () => {
    const partial = EXCERPT.replace(FIX_ANCHORS[0]!, FIX_ANCHORS[0]! + '// PKC3-GFXDATA (only the include line)\n');
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
    const broken = EXCERPT.replace(FIX_ANCHORS[1]!, FIX_ANCHORS[1]!.replace('mpGraphics->ApplyFullDamage();', 'mpGraphics->ApplyFullDamage( );'));
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

describe('#1402(gfxdata-trace)── 当てた結果(描いた C++ で見る)', () => {
  it('🔴 順序: 控え → `ApplyFullDamage` → 読み直し(変わった印)→ null 門 → `pSurface` の印 → 原文の `return`', () => {
    const fn = extractFunction(patched(), FN);
    const at = (needle: string): number => {
      expect(count(fn, needle), `「${needle.trim()}」が関数の中で 1 件でない`).toBe(1);
      return fn.indexOf(needle);
    };
    const keepAt = at('const void* const pPkc3Before = static_cast<const void*>(mpGraphics);');
    const applyAt = at('mpGraphics->ApplyFullDamage();');
    const cmpAt = at('if (static_cast<const void*>(mpGraphics) != pPkc3Before)');
    const changedAt = at('PKC3-GFXDATA: gfx changed');
    const gateAt = at('if (!mpGraphics) // PKC3-GFXDATA');
    const retEmptyAt = at('return SystemGraphicsData(); // PKC3-GFXDATA');
    const surfAt = at('PKC3-GFXDATA: surface outdev');
    const origRetAt = at('    return mpGraphics->GetGraphicsData();\n');
    expect(keepAt).toBeLessThan(applyAt);
    expect(applyAt).toBeLessThan(cmpAt);
    expect(cmpAt).toBeLessThan(changedAt);
    expect(changedAt).toBeLessThan(gateAt);
    expect(gateAt).toBeLessThan(retEmptyAt);
    expect(retEmptyAt).toBeLessThan(surfAt);
    expect(surfAt).toBeLessThan(origRetAt);
  });

  it('🔴 null 門と印の書式を手で書いて突き合わせる(変わったときだけ / null なら空を返す)', () => {
    const after = patched();
    expect(after).toContain(
      [
        `    if (static_cast<const void*>(mpGraphics) != pPkc3Before) // ${MARK}`,
        `    { // ${MARK}`,
        `        std::fprintf(stderr, "${MARK}: gfx changed outdev=%p before=%p after=%p t=%lld\\n", static_cast<const void*>(this), pPkc3Before, static_cast<const void*>(mpGraphics), pPkc3Ms()); // ${MARK}`,
        `        if (!mpGraphics) // ${MARK}`,
        `            return SystemGraphicsData(); // ${MARK}`,
        `    } // ${MARK}`,
        '',
      ].join('\n'),
    );
    expect(after).toContain(
      `        std::fprintf(stderr, "${MARK}: surface outdev=%p gfx=%p surface=%p t=%lld\\n", static_cast<const void*>(this), static_cast<const void*>(mpGraphics), aPkc3Data.pSurface, nPkc3Now); // ${MARK}\n`,
    );
    expect(after).toContain(
      `    if (nPkc3N <= 300 || nPkc3N % 50 == 0 || nPkc3Now - nPkc3LastMs >= 2000 || aPkc3Data.pSurface != pPkc3LastSurface) // ${MARK}\n    { // ${MARK}\n        nPkc3LastMs = nPkc3Now; // ${MARK}\n        pPkc3LastSurface = aPkc3Data.pSurface; // ${MARK}\n`,
    );
  });

  it('🔴 足した行は全部 `#if USE_HEADLESS_CODE` の中(include の 2 行を除く)── `#if` と `#endif` が釣り合い、他の build は原文のまま', () => {
    const after = patched();
    const fn = extractFunction(after, FN);
    // 関数の中の行を、`#if USE_HEADLESS_CODE` の深さで分類する
    let depth = 0;
    const outside: string[] = [];
    for (const l of fn.split('\n')) {
      if (/^#if\b/.test(l)) {
        depth++;
        continue;
      }
      if (/^#endif\b/.test(l)) {
        depth--;
        continue;
      }
      if (l.includes(MARK) && depth !== 1) outside.push(l);
    }
    expect(depth, '#if / #endif が釣り合っていない').toBe(0);
    expect(outside, 'headless の外に漏れた足し行').toEqual([]);
    // headless の枝を取り除くと(`#if USE_HEADLESS_CODE … #endif` の塊ごと)、原文の関数と同じ形になる
    const stripBlocks = (t: string): string => t.replace(/#if USE_HEADLESS_CODE[^\n]*\n[\s\S]*?#endif[^\n]*\n/g, '');
    expect(stripBlocks(fn).replace(/\n{2,}/g, '\n')).toBe(stripBlocks(extractFunction(EXCERPT, FN)).replace(/\n{2,}/g, '\n'));
    // include は file scope
    expect(after).toContain(`#include <cstdio> // ${MARK}\n#include <chrono> // ${MARK}\n`);
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
      .filter((l) => !/^\s*\/\/ /.test(l) && !l.startsWith('#'))
      .map((l) => l.replace(/"[^"]*"/g, '').replace(/\/\/.*$/, ''))
      .join('\n');
    expect(count(code, '{')).toBe(count(code, '}'));
  });

  it('🔴 原文の他の所は動かない: 取得の分岐 / `assert` / `ApplyFullDamage` の条件 / 原文の `return` が元のまま', () => {
    const after = patched();
    for (const needle of [
      '    if (!mpGraphics && !AcquireGraphics())\n        return SystemGraphicsData();\n    assert(mpGraphics);\n',
      '    if (OUTDEV_WINDOW == GetOutDevType())\n        mpGraphics->ApplyFullDamage();\n',
      '    return mpGraphics->GetGraphicsData();\n',
    ]) {
      expect(count(after, needle), needle).toBe(count(EXCERPT, needle));
    }
  });
});

/**
 * `GetSystemGfxData` を、型だけ stub に替えて本当にコンパイルして走らせる。
 * 引数: `mode n [steps…]`。`mode` は `ApplyFullDamage` の間に起きること(0 = 何も / 1 = `mpGraphics` が null に奪われる / 2 = 別の物に差し替わる)。
 * `n` 回は `a` を使って続けて呼ぶ(間を空けない)。step は `K:ms[:b]` ── 「`ms` 待ってから呼ぶ」を `K` 回(使うのは `a`、`:b` なら別の `b`)。
 * step の頭で `STEP <番号>` を出す。
 */
function harness(fn: string, headless: 0 | 1): string {
  return `#define USE_HEADLESS_CODE ${headless}
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <thread>
enum OutDevType { OUTDEV_WINDOW, OUTDEV_PRINTER, OUTDEV_VIRDEV, OUTDEV_PDF };
struct SystemGraphicsData {
#if USE_HEADLESS_CODE
    void* pSurface = nullptr;
#endif
    int tag = 0;
};
struct OutputDevice;
static OutputDevice* g_dev = nullptr;
static int g_mode = 0;
struct SalGraphics {
    int id;
    void ApplyFullDamage();
    SystemGraphicsData GetGraphicsData() {
        SystemGraphicsData d;
        // this の member を本当に読む(volatile)。this が null のまま入れば、ここで落ちる = 門を外した変異が code != 0 になる
        volatile const int seen = id;
        d.tag = 7 + (seen - seen);
#if USE_HEADLESS_CODE
        d.pSurface = this;
#endif
        return d;
    }
};
static SalGraphics g_a{ 1 };
static SalGraphics g_b{ 2 };
struct OutputDevice {
    mutable SalGraphics* mpGraphics = nullptr;
    OutDevType GetOutDevType() const { return OUTDEV_WINDOW; }
    bool AcquireGraphics() const { return false; }
    SystemGraphicsData GetSystemGfxData() const;
};
// ApplyFullDamage は SolarMutex を手放す hop を含みうる ── その間に mpGraphics が奪われる / 差し替わる、を模す
void SalGraphics::ApplyFullDamage()
{
    if (g_mode == 1) g_dev->mpGraphics = nullptr;
    if (g_mode == 2) g_dev->mpGraphics = &g_b;
}
${fn}
int main(int argc, char** argv)
{
    if (argc < 3) return 2;
    g_mode = std::atoi(argv[1]);
    const int n = std::atoi(argv[2]);
    OutputDevice d;
    g_dev = &d;
    SystemGraphicsData r;
    for (int i = 0; i < n; ++i)
    {
        d.mpGraphics = &g_a;
        r = d.GetSystemGfxData();
    }
    for (int s = 3; s < argc; ++s)
    {
        int k = 0;
        int ms = 0;
        char w[2] = { 0, 0 };
        const int got = std::sscanf(argv[s], "%d:%d:%1s", &k, &ms, w);
        SalGraphics* use = (got >= 3 && w[0] == 'b') ? &g_b : &g_a;
        std::fprintf(stderr, "STEP %d gfx=%p\\n", s - 2, static_cast<void*>(use));
        for (int j = 0; j < k; ++j)
        {
            if (ms > 0) std::this_thread::sleep_for(std::chrono::milliseconds(ms));
            d.mpGraphics = use;
            r = d.GetSystemGfxData();
        }
    }
    std::printf("tag=%d a=%p b=%p\\n", r.tag, static_cast<void*>(&g_a), static_cast<void*>(&g_b));
#if USE_HEADLESS_CODE
    std::printf("surface=%p\\n", r.pSurface);
#endif
    return 0;
}
`;
}

describe('#1402(gfxdata-trace)── 本当にコンパイルして走らせる(型だけ stub)', () => {
  const fn = haveCxx() ? extractFunction(patched(), FN) : '';
  const go = (headless: 0 | 1, ...a: (number | string)[]): ReturnType<typeof compileAndRun> =>
    compileAndRun(harness(fn, headless), a.map(String));
  const only = (err: string, re: RegExp): string[] => err.split('\n').filter((l) => re.test(l));
  const num = (t: string, k: string): string => new RegExp(`${k}=(\\S+)`).exec(t)![1]!;
  /** `STEP <k>` から次の STEP の手前までの行。 */
  const stepLines = (err: string, k: number): string[] => {
    const all = err.split('\n');
    const from = all.findIndex((l) => l.startsWith(`STEP ${k} `));
    expect(from, `STEP ${k} が出ていない`).toBeGreaterThanOrEqual(0);
    const rest = all.slice(from + 1);
    const to = rest.findIndex((l) => l.startsWith('STEP '));
    return to < 0 ? rest : rest.slice(0, to);
  };
  const surfaces = (lines: string[]): string[] => lines.filter((l) => /PKC3-GFXDATA: surface/.test(l));

  it.skipIf(!haveCxx())('🔴 変わらなければ **0 行**(changed)。surface の印は 1 行で、返す物の pSurface と一致する', () => {
    const r = go(1, 0, 1);
    expect(r.compile, r.compileOut).toBe(0);
    expect(r.code, r.stderr).toBe(0);
    expect(only(r.stderr, /gfx changed/).length, '変わっていないのに changed を出した').toBe(0);
    const surf = only(r.stderr, /PKC3-GFXDATA: surface/);
    expect(surf.length).toBe(1);
    expect(surf[0]).toMatch(new RegExp(`gfx=${num(r.stdout, 'a')} surface=${num(r.stdout, 'a')} t=\\d+$`));
    expect(num(r.stdout, 'surface')).toBe(num(r.stdout, 'a'));
    expect(num(r.stdout, 'tag')).toBe('7');
  }, 60_000);

  it.skipIf(!haveCxx())('🔴 null に奪われたら **落ちずに空を返し**、changed が before=旧 after=(null) で 1 行出る(surface の印は出ない)', () => {
    const r = go(1, 1, 1);
    expect(r.compile, r.compileOut).toBe(0);
    // 門を外すと `nullptr->GetGraphicsData()` が stub の `this` の member を読んで落ちる(code != 0 / signal)
    expect(r.code, `落ちた(門が効いていない):\n${r.stderr}`).toBe(0);
    expect(num(r.stdout, 'tag'), '空の SystemGraphicsData を返していない').toBe('0');
    expect(r.stdout).toMatch(/^surface=(\(nil\)|0x0|0)$/m);
    const ch = only(r.stderr, /gfx changed/);
    expect(ch.length).toBe(1);
    expect(ch[0]).toMatch(new RegExp(`before=${num(r.stdout, 'a')} after=(\\(nil\\)|0x0|0) t=\\d+$`));
    expect(only(r.stderr, /PKC3-GFXDATA: surface/).length, 'null で返したのに surface の印を出した').toBe(0);
  }, 60_000);

  it.skipIf(!haveCxx())('🔴 別の pointer に変わったら changed を出して**そのまま続け**、新しい物で返す(止めない)', () => {
    const r = go(1, 2, 1);
    expect(r.compile, r.compileOut).toBe(0);
    expect(r.code, r.stderr).toBe(0);
    const ch = only(r.stderr, /gfx changed/);
    expect(ch.length).toBe(1);
    expect(ch[0]).toMatch(new RegExp(`before=${num(r.stdout, 'a')} after=${num(r.stdout, 'b')} t=\\d+$`));
    expect(num(r.stdout, 'tag')).toBe('7');
    expect(num(r.stdout, 'surface'), '新しい mpGraphics で返していない').toBe(num(r.stdout, 'b'));
    expect(only(r.stderr, /PKC3-GFXDATA: surface/)[0]).toMatch(new RegExp(`gfx=${num(r.stdout, 'b')} surface=${num(r.stdout, 'b')} `));
  }, 60_000);

  it.skipIf(!haveCxx())('🔴 surface の頻度: 1000 回で 300 + 14 = 314 行(手で数えた値)/ 400 回の後 2.1 秒おいた 1 回も出る(303 行)', () => {
    const many = go(1, 0, 1000);
    expect(many.compile, many.compileOut).toBe(0);
    expect(only(many.stderr, /PKC3-GFXDATA: surface/).length).toBe(314);
    const slept = go(1, 0, 400, '1:2100');
    const tail = surfaces(stepLines(slept.stderr, 1));
    expect(tail.length, '2 秒空いた後の 1 回が出ていない').toBe(1);
    // 対照群: 空いた回を除けば 302 行(規則が「毎回出す」に化けていない)
    expect(only(slept.stderr, /PKC3-GFXDATA: surface/).length).toBe(303);
  }, 60_000);

  it.skipIf(!haveCxx())('🔴 pSurface が前回出した値と変わったら必ず出す(resize の直後の最初の読み)。同じ値の続きは出ない', () => {
    // 400 回(#400 は 50 の倍数で出た = 前回の値は a)の後: 同じ a の続き(出ない)→ b に変わった最初(#402、出る)→ b の続き(出ない)→ a に戻った(#404、出る)
    const r = go(1, 0, 400, '1:0', '2:0:b', '1:0:a');
    expect(r.compile, r.compileOut).toBe(0);
    expect(surfaces(stepLines(r.stderr, 1)).length, '同じ値の続きで出た').toBe(0);
    const toB = surfaces(stepLines(r.stderr, 2));
    expect(toB.length, 'b に変わった最初の 1 回だけ').toBe(1);
    const gfxOf = (k: number): string => /gfx=(\S+)/.exec(r.stderr.split('\n').find((l) => l.startsWith(`STEP ${k} `))!)![1]!;
    expect(toB[0]).toContain(`surface=${gfxOf(2)} `);
    const back = surfaces(stepLines(r.stderr, 3));
    expect(back.length, 'a に戻った 1 回').toBe(1);
    expect(back[0]).toContain(`surface=${gfxOf(3)} `);
    expect(gfxOf(2)).not.toBe(gfxOf(3));
  }, 60_000);

  it.skipIf(!haveCxx())('🔴 headless でない build: 何も出ず、原文と同じに返る(足した行が他の build に漏れていない)', () => {
    const r = go(0, 1, 3);
    expect(r.compile, r.compileOut).toBe(0);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr, 'headless でないのに印が出た').toBe('');
    expect(num(r.stdout, 'tag')).toBe('7');
  }, 60_000);
});

describe('#1402(gfxdata-trace)── 上流の実 file へ', () => {
  const real = UPSTREAM ? join(UPSTREAM, REL) : '';
  it.skipIf(!real || !existsSync(real))('🔴 実 file へ当たる(exit 0)。足した行は 29・消した行は 0。2 度目は SKIP で不変', () => {
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

  it.skipIf(!real || !existsSync(real))('🔴 抜粋は実 file の原文そのまま(1〜59 行 + 242〜254 行)', () => {
    const l = readFileSync(real, 'utf-8').split('\n');
    expect(EXCERPT).toContain(l.slice(0, 58).join('\n'));
    expect(EXCERPT).toContain(l.slice(241, 254).join('\n'));
  });
});

describe('#1402(gfxdata-trace)── 他の検査との関係', () => {
  it('🔑 当て先が、他の LO patch と重ならない(同じ file を 2 本が触ると当てる順で結果が変わる)', () => {
    const owners = readdirSync('build/office-wasm')
      .filter((f) => /^patch-.*\.py$/.test(f))
      .filter((f) => readFileSync(join('build/office-wasm', f), 'utf-8').includes(`"${REL}"`));
    expect(owners).toEqual(['patch-lo-gfxdata-trace.py']);
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/^SRC\s*=\s*"vcl\/source\/outdev\/outdev\.cxx"/m);
  });

  it('🔑 workflow の本数の主張が、この 1 本を数えている(31 → 34 の 3 本のうち 1 本)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/31 → 34\(2026-10-07\)/);
    expect(yml).toContain('patch-lo-gfxdata-trace.py');
    expect(yml).toContain('test "$n" -eq 35');
  });
});
