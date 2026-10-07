/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-surface-trace.py` を検める(#1402 の**計装**。直しではない)。
 *
 * 🔴 **何のための印か**: Office を閉じた直後に、本体スレッドが `ThumbnailView::Paint` ←
 * `createPixelProcessor2DFromOutputDevice` で `memory access out of bounds` になる。候補の 1 つは、
 * `QtSvpSalFrame::DoHandleResizeEvent`(上流 `d6226c1a` の `QtSvpSalFrame.cxx`)が **main で SolarMutex を取らずに**
 * 新しい cairo surface へ差し替えて古い物を捨てる間に、本体が `GetGraphicsData()` で受け取った生の `pSurface` を読むこと。
 * 差し替えの前後と破棄の直前に、時刻つきの印(`PKC3-SURFACE: resize before/after/destroy`)を出す。
 *
 * ⚠ 見るのは:
 *   ① **錨が原文に当たる**(上流の file そのまま)/ 1 つ外しても落ちる(file は不変)/ 当て済みは **SKIP(exit 0)で不変** /
 *      印が欠けた file・多い file は SKIP せず exit 1
 *   ② **印の位置**: before は `setSurface` の**前**、after は `m_pSurface.reset` の**後**、destroy は `copySource` の**後**
 *      (= `old_surface` の dtor の直前)。lambda は最初の使用より前
 *   ③ **足した行は全部印を含み、原文の行は 1 行も書き換えない**
 *   ④ **本当にコンパイルして走らせる**(型を stub に替えた harness): 出る順番が before → SETSURFACE → after → COPYSOURCE →
 *      destroy → **実際の `cairo_surface_destroy`**、`old` / `new` の pointer が対応する、大きさが同じなら**何も出ない**
 *   ⑤ workflow の本数の主張がこの 1 本を数えている / 上流の実 file(在れば)へ本当に当たる
 *
 * 🔴 **言えないこと**: 本物の LO / Qt / cairo の header でコンパイルできること /
 * 本物で「捨てた surface を読んだ」が印から読めること(焼いて、`PKC3-SDPR` / `PKC3-GFXDATA` の `t=` と突き合わせるまで言えない)。
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

const SCRIPT = 'build/office-wasm/patch-lo-surface-trace.py';
const REL = 'vcl/qt5/QtSvpSalFrame.cxx';
const MARK = 'PKC3-SURFACE';
const EXCERPT = readFileSync('tests/fixtures/office-lo/QtSvpSalFrame.excerpt.cxx', 'utf-8');
/** 上流の実 file(在る箱でだけ回す。CI には無いので skip ── 実物の錨は焼く前の `check-patches-on-ref.sh` が見る)。 */
const UPSTREAM = process.env['PKC3_LO_UP'] ?? '';
/** 足す行の数(include 2 + 注釈 1 + lambda 6 + before 1 + after 1 + destroy 1)。数え直したら理由を 1 行書く。 */
const ADDED = 12;

const FIX_ANCHORS = pyJson(SCRIPT, '[a for a,_ in m.PARTS]') as string[];
const tree = (body: string = EXCERPT): Tree => makeTree(REL, 'pkc3-surface-', body);

function patched(): string {
  const t = tree();
  try {
    expect(run(SCRIPT, t.dir).code).toBe(0);
    return t.read();
  } finally {
    t.cleanup();
  }
}

describe('#1402(surface-trace)── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている(0 件でも「全部当たった」は真になる)', () => {
    expect(FIX_ANCHORS.length, '錨を拾えていない').toBe(3);
    expect(new Set(FIX_ANCHORS).size, '同じ錨が在る').toBe(FIX_ANCHORS.length);
    expect(EXCERPT, '抜粋が空').toContain('void QtSvpSalFrame::DoHandleResizeEvent(int nWidth, int nHeight)');
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
      expect(count(t.read(), 'PKC3-SURFACE: resize before')).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 印が在るのに欠けている file(部分適用 / 手編集)は SKIP しない ── exit 1 で file は不変', () => {
    const partial = EXCERPT.replace(FIX_ANCHORS[0]!, FIX_ANCHORS[0]! + '// PKC3-SURFACE (only the include line)\n');
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
    const broken = EXCERPT.replace(FIX_ANCHORS[1]!, FIX_ANCHORS[1]!.replace('UniqueCairoSurface old_surface', 'UniqueCairoSurface  old_surface'));
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
    const doubled = `${EXCERPT}\n${FIX_ANCHORS[2]}`;
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

describe('#1402(surface-trace)── 当てた結果(描いた C++ で見る)', () => {
  it('🔴 順序: lambda → before → setSurface → release → reset → after → copySource → destroy(印)', () => {
    const whole = patched();
    const fn = extractFunction(whole, 'void QtSvpSalFrame::DoHandleResizeEvent(int nWidth, int nHeight)');
    const at = (needle: string): number => {
      expect(count(fn, needle), `「${needle.trim()}」が関数の中で 1 件でない`).toBe(1);
      return fn.indexOf(needle);
    };
    const lambdaAt = at('auto const pPkc3Ms = []() -> long long');
    const beforeAt = at('PKC3-SURFACE: resize before');
    const setAt = at('m_pSvpGraphics->setSurface(pSurface');
    const relAt = at('UniqueCairoSurface old_surface(m_pSurface.release());');
    const resetAt = at('m_pSurface.reset(pSurface);');
    const afterAt = at('PKC3-SURFACE: resize after');
    const copyAt = at('m_pSvpGraphics->copySource(rect, old_surface.get());');
    const destroyAt = at('PKC3-SURFACE: resize destroy');
    expect(lambdaAt).toBeLessThan(beforeAt);
    expect(beforeAt).toBeLessThan(setAt);
    expect(setAt).toBeLessThan(relAt);
    expect(relAt).toBeLessThan(resetAt);
    expect(resetAt).toBeLessThan(afterAt);
    expect(afterAt).toBeLessThan(copyAt);
    expect(copyAt).toBeLessThan(destroyAt);
  });

  it('🔴 印の書式を手で書いて突き合わせる(pointer の意味を取り違えない)', () => {
    const after = patched();
    // before: old は m_pSurface(まだ差し替え前)/ new は作った pSurface
    expect(after).toContain(
      `            std::fprintf(stderr, "${MARK}: resize before frame=%p gfx=%p old=%p new=%p w=%d h=%d t=%lld\\n", static_cast<void*>(this), static_cast<void*>(m_pSvpGraphics.get()), static_cast<void*>(m_pSurface.get()), static_cast<void*>(pSurface), nWidth, nHeight, pPkc3Ms()); // ${MARK}\n`,
    );
    // after: old は release した後の old_surface / new は m_pSurface
    expect(after).toContain(
      `            std::fprintf(stderr, "${MARK}: resize after frame=%p gfx=%p old=%p new=%p w=%d h=%d t=%lld\\n", static_cast<void*>(this), static_cast<void*>(m_pSvpGraphics.get()), static_cast<void*>(old_surface.get()), static_cast<void*>(m_pSurface.get()), nWidth, nHeight, pPkc3Ms()); // ${MARK}\n`,
    );
    expect(after).toContain(
      `            std::fprintf(stderr, "${MARK}: resize destroy old=%p t=%lld\\n", static_cast<void*>(old_surface.get()), pPkc3Ms()); // ${MARK}\n`,
    );
  });

  it('🔴 `#include` は file scope で、`.moc` の include より前(`<cstdio>` / `<chrono>`)', () => {
    const after = patched();
    expect(count(EXCERPT, '#include <cstdio>'), '抜粋の前提(元には無い)').toBe(0);
    expect(after).toContain(
      [
        '#include <QtSvpSalFrame.hxx>',
        `#include <cstdio> // ${MARK}`,
        `#include <chrono> // ${MARK}`,
        '#include <QtSvpSalFrame.moc>',
        '',
      ].join('\n'),
    );
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

  it('🔴 原文の他の所は動かない: 差し替えの 3 行と `copySource` が元のまま', () => {
    const after = patched();
    for (const needle of [
      '            m_pSvpGraphics->setSurface(pSurface, basegfx::B2IVector(nWidth, nHeight));\n',
      '            UniqueCairoSurface old_surface(m_pSurface.release());\n',
      '            m_pSurface.reset(pSurface);\n',
      '            m_pSvpGraphics->copySource(rect, old_surface.get());\n',
      'void CairoDeleter::operator()(cairo_surface_t* pSurface) const { cairo_surface_destroy(pSurface); }\n',
    ]) {
      expect(count(after, needle), needle).toBe(count(EXCERPT, needle));
    }
  });
});

/** `DoHandleResizeEvent` を、型だけ stub に替えて本当にコンパイルして走らせる。 */
function harness(fn: string): string {
  return `#include <algorithm>
#include <chrono>
#include <cstdio>
#include <memory>
enum { CAIRO_FORMAT_ARGB32 = 0 };
struct cairo_surface_t { int w; int h; };
struct cairo_user_data_key_t { int u; };
static cairo_surface_t* cairo_image_surface_create(int, int w, int h) { return new cairo_surface_t{ w, h }; }
static int cairo_image_surface_get_width(cairo_surface_t* s) { return s->w; }
static int cairo_image_surface_get_height(cairo_surface_t* s) { return s->h; }
static void cairo_surface_set_user_data(cairo_surface_t*, const cairo_user_data_key_t*, void*, void*) {}
// 実際の破棄。ここが出る順番が「古い surface が無効になる瞬間」
static void cairo_surface_destroy(cairo_surface_t* s) { std::fprintf(stderr, "DESTROY surface=%p\\n", static_cast<void*>(s)); delete s; }
struct CairoDeleter { void operator()(cairo_surface_t* p) const { cairo_surface_destroy(p); } };
using UniqueCairoSurface = std::unique_ptr<cairo_surface_t, CairoDeleter>;
namespace basegfx { struct B2IVector { B2IVector(int, int) {} }; }
struct SalTwoRect { SalTwoRect(int, int, int, int, int, int, int, int) {} };
struct SvpSalGraphics { static const cairo_user_data_key_t* getDamageKey() { static cairo_user_data_key_t k; return &k; } };
struct QtSvpGraphics : SvpSalGraphics {
    void setSurface(cairo_surface_t*, const basegfx::B2IVector&) { std::fprintf(stderr, "SETSURFACE\\n"); }
    void copySource(const SalTwoRect&, cairo_surface_t*) { std::fprintf(stderr, "COPYSOURCE\\n"); }
};
template <class T> static T qMin(T a, T b) { return a < b ? a : b; }
struct DamageHandler {};
struct QtSvpSalFrame {
    UniqueCairoSurface m_pSurface;
    std::unique_ptr<QtSvpGraphics> m_pSvpGraphics;
    DamageHandler m_aDamageHandler;
    void DoHandleResizeEvent(int nWidth, int nHeight);
};
${fn}
int main()
{
    QtSvpSalFrame f;
    f.m_pSvpGraphics.reset(new QtSvpGraphics());
    f.m_pSurface.reset(cairo_image_surface_create(0, 100, 50));
    std::printf("old=%p\\n", static_cast<void*>(f.m_pSurface.get()));
    std::fprintf(stderr, "CALL same size\\n");
    f.DoHandleResizeEvent(100, 50);
    std::fprintf(stderr, "CALL new size\\n");
    f.DoHandleResizeEvent(200, 100);
    std::printf("new=%p\\n", static_cast<void*>(f.m_pSurface.get()));
    std::fprintf(stderr, "END\\n");
    return 0;
}
`;
}

describe('#1402(surface-trace)── 本当にコンパイルして走らせる(型だけ stub)', () => {
  it.skipIf(!haveCxx())('🔴 出る順番: before → 差し替え → after → 複写 → destroy(印)→ **実際の破棄**。pointer が対応し、同じ大きさでは何も出ない', () => {
    const fn = extractFunction(patched(), 'void QtSvpSalFrame::DoHandleResizeEvent(int nWidth, int nHeight)');
    const r = compileAndRun(harness(fn));
    expect(r.compile, r.compileOut).toBe(0);
    expect(r.code, r.stderr).toBe(0);
    const old = /old=(\S+)/.exec(r.stdout)![1]!;
    const nw = /new=(\S+)/.exec(r.stdout)![1]!;
    expect(old).not.toBe(nw);
    const lines = r.stderr.split('\n').filter((l) => l !== '');
    // 同じ大きさ: CALL と CALL の間に 1 行も無い
    const sameAt = lines.indexOf('CALL same size');
    const newAt = lines.indexOf('CALL new size');
    expect(sameAt).toBe(0);
    expect(newAt, '同じ大きさの呼び出しが何か出した').toBe(1);
    const endAt = lines.indexOf('END');
    expect(endAt, 'END が出ていない').toBeGreaterThan(newAt);
    const seq = lines.slice(newAt + 1, endAt).map((l) => l.replace(/^(PKC3-SURFACE: resize \w+|SETSURFACE|COPYSOURCE|DESTROY).*$/, '$1'));
    expect(seq).toEqual([
      'PKC3-SURFACE: resize before',
      'SETSURFACE',
      'PKC3-SURFACE: resize after',
      'COPYSOURCE',
      'PKC3-SURFACE: resize destroy',
      'DESTROY',
    ]);
    const body = lines.slice(newAt + 1, endAt);
    // before: old=旧 new=新 w=200 h=100 / after: 同じ対応 / destroy と実際の破棄が**同じ旧 pointer**
    expect(body[0]).toMatch(new RegExp(`old=${old} new=${nw} w=200 h=100 t=\\d+$`));
    expect(body[2]).toMatch(new RegExp(`old=${old} new=${nw} w=200 h=100 t=\\d+$`));
    expect(body[4]).toMatch(new RegExp(`old=${old} t=\\d+$`));
    expect(body[5]).toBe(`DESTROY surface=${old}`);
  }, 60_000);
});

describe('#1402(surface-trace)── 上流の実 file へ', () => {
  const real = UPSTREAM ? join(UPSTREAM, REL) : '';
  it.skipIf(!real || !existsSync(real))('🔴 実 file へ当たる(exit 0)。足した行は 12・消した行は 0。2 度目は SKIP で不変', () => {
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

  it.skipIf(!real || !existsSync(real))('🔴 抜粋は実 file の原文そのまま(全文)', () => {
    expect(readFileSync(real, 'utf-8')).toBe(EXCERPT);
  });
});

describe('#1402(surface-trace)── 他の検査との関係', () => {
  it('🔑 当て先が、他の LO patch と重ならない(同じ file を 2 本が触ると当てる順で結果が変わる)', () => {
    const owners = readdirSync('build/office-wasm')
      .filter((f) => /^patch-.*\.py$/.test(f))
      .filter((f) => readFileSync(join('build/office-wasm', f), 'utf-8').includes(`"${REL}"`));
    expect(owners).toEqual(['patch-lo-surface-trace.py']);
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/^SRC\s*=\s*"vcl\/qt5\/QtSvpSalFrame\.cxx"/m);
  });

  it('🔑 workflow の本数の主張が、この 1 本を数えている(31 → 34 の 3 本のうち 1 本)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/31 → 34\(2026-10-07\)/);
    expect(yml).toContain('patch-lo-surface-trace.py');
    expect(yml).toContain('test "$n" -eq 34');
  });
});
