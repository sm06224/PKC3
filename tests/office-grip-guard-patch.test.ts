/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-grip-guard.py` を検める(#1402 の**印と null 門**)。
 *
 * 🔴 **直す物 / 直さない物**: Impress を開くと約 3 % で `memory access out of bounds`
 * (`SalGraphics::DrawPolyLine` ← `OutputDevice::DrawPolygon(tools::Polygon)` の hairline 経路 ← `SplitWindow::ImplDrawGrip`)。
 * 塗りの呼び出し(`DrawPolyPolygon`)が main スレッドへ hop する間に `mpGraphics` が変わりうるのに、縁を引く直前で
 * 誰も再検査しない。この patch は**主に印**(`before` / `after` を出して、落ちた場所を絞る)と、null のときだけ縁を
 * 引かずに返る門である。🔴 **ぶら下がった pointer は直せない**(null 門は素通りする)。
 *
 * ⚠ 見るのは 5 つ:
 *   ① **錨が原文に当たる**(上流 `d6226c1a` の抜粋)/ 1 つ外しても落ちる(file は不変)/ 当て済みは SKIP(exit 0)で不変
 *   ② **順序**: `bSuccess` → 旗 → null 門 → 印(上限 100)→ `DrawPolyLine` → `after` の印 → `if(bSuccess)`
 *      (null 門は `DrawPolyLine` の前 / `after` の印は後。逆だと意味が消える)
 *   ③ **足した行は全部印を含み、原文の行は 1 行も書き換えない**(`#ifdef` / `#else` / `#endif` にも印)
 *   ④ **`<cstdio>`** と `__EMSCRIPTEN__` の中だけの `<emscripten/stack.h>` / カウンタ / 他の LO patch と当て先が重ならない
 *   ⑤ workflow の本数の主張がこの 1 本を数えている / 上流の実 file(在れば)へ本当に当たる
 *
 * 🔴 **言えないこと**: 当てた後の C++ が本物の LO の header でコンパイルできること /
 * 本物で停止が消えること(**消えない見込みも在る** ── 印が目的)。焼いて、Impress を開く probe で
 * `PKC3-GRIPGUARD:` の `before` / `after` の対を読むまで言えない。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-grip-guard.py';
const REL = 'vcl/source/outdev/polygon.cxx';
const MARK = 'PKC3-GRIPGUARD';
const EXCERPT = readFileSync('tests/fixtures/office-lo/polygon.excerpt.cxx', 'utf-8');
/** 上流(`d6226c1a`)を展開した作業 dir。在るときだけ実 file へ当てる(CI には無い)。 */
/** 上流の実 file(在る箱でだけ回す。CI には無いので skip ── 実物の錨は焼く前の `check-patches-on-ref.sh` が見る)。 */
const UPSTREAM = process.env['PKC3_LO_UP'] ?? '';

/** python の module から値を取り出す(⚠ 錨の字をここへ書き写さない)。 */
function pyJson(script: string, expr: string): unknown {
  const code = [
    'import importlib.util,sys,json',
    'sys.dont_write_bytecode=True',
    `sp=importlib.util.spec_from_file_location("p","${script}")`,
    'm=importlib.util.module_from_spec(sp); sp.loader.exec_module(m)',
    `print(json.dumps(${expr}))`,
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf-8', stdio: 'pipe' }));
}

const FIX_ANCHORS = pyJson(SCRIPT, '[a for a,_ in m.PARTS]') as string[];

interface Tree {
  dir: string;
  read: () => string;
  cleanup: () => void;
}

function tree(body: string = EXCERPT): Tree {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-gripguard-'));
  mkdirSync(dirname(join(dir, REL)), { recursive: true });
  writeFileSync(join(dir, REL), body, 'utf-8');
  return {
    dir,
    read: () => readFileSync(join(dir, REL), 'utf-8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function run(script: string, dir: string): { code: number; out: string } {
  const r = spawnSync('python3', [script, dir], { encoding: 'utf-8', stdio: 'pipe' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** 数える(部分文字列の出現数)。 */
const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** 足した行(印を含む行)を取り除く。この直しは**原文の行を 1 行も書き換えない**(足すだけ)。 */
function restore(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.includes(MARK))
    .join('\n');
}

function patched(): string {
  const t = tree();
  try {
    expect(run(SCRIPT, t.dir).code).toBe(0);
    return t.read();
  } finally {
    t.cleanup();
  }
}

describe('#1402(grip-guard)── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている(0 件でも「全部当たった」は真になる)', () => {
    expect(FIX_ANCHORS.length, '錨を拾えていない').toBe(3);
    expect(new Set(FIX_ANCHORS).size, '同じ錨が在る').toBe(FIX_ANCHORS.length);
    expect(EXCERPT, '抜粋が空').toContain('void OutputDevice::DrawPolygon( const tools::Polygon& rPoly )');
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
      expect(count(t.read(), 'if (g_nPkc3GripSaid < 100)')).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 印が在るのに門が欠けている file(部分適用 / 手編集)は SKIP しない ── exit 1 で file は不変', () => {
    const partial = EXCERPT.replace(FIX_ANCHORS[0]!, FIX_ANCHORS[0]! + '// PKC3-GRIPGUARD (only the include line)\n');
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
    // ⚠ `bool bSuccess(true);` は兄弟の DrawPolyPolygon(B2DPolyPolygon) にも在る ── 変えるのは**錨の中**の 1 字
    const broken = EXCERPT.replace(FIX_ANCHORS[1]!, FIX_ANCHORS[1]!.replace('bool bSuccess(true);', 'bool  bSuccess(true);'));
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

describe('#1402(grip-guard)── 当てた結果(描いた C++ で見る)', () => {
  it('🔴 順序: bSuccess → 旗 → null 門 → 印(上限)→ DrawPolyLine → after の印 → if(bSuccess)', () => {
    const whole = patched();
    // 🔑 兄弟の DrawPolyPolygon(B2DPolyPolygon) にも同じ形が在るので、**この関数の範囲**だけを見る
    const fnAt = whole.indexOf('void OutputDevice::DrawPolygon( const tools::Polygon& rPoly )');
    expect(fnAt, '関数が無い').toBeGreaterThan(0);
    const fnEnd = whole.indexOf('\n}\n', fnAt);
    expect(fnEnd, '関数の終わりが無い').toBeGreaterThan(fnAt);
    const after = whole.slice(fnAt, fnEnd);
    const at = (needle: string): number => {
      expect(count(after, needle), `「${needle.trim()}」が関数の中で 1 件でない`).toBe(1);
      return after.indexOf(needle);
    };
    const succAt = at('bool bSuccess(true);');
    const flagAt = at('bool bPkc3Said = false;');
    const nullAt = at('if (!mpGraphics) // PKC3-GRIPGUARD');
    const capAt = at('if (g_nPkc3GripSaid < 100)');
    const beforeAt = at('PKC3-GRIPGUARD: before gfx=%p dev=%p stackfree=%lu');
    const lineAt = at('bSuccess = mpGraphics->DrawPolyLine(');
    const afterAt = at('after DrawPolyLine returned');
    const okAt = at('if(bSuccess)');
    expect(succAt).toBeGreaterThan(0);
    expect(succAt).toBeLessThan(flagAt);
    expect(flagAt).toBeLessThan(nullAt);
    expect(nullAt).toBeLessThan(capAt);
    expect(capAt).toBeLessThan(beforeAt);
    expect(beforeAt).toBeLessThan(lineAt);
    expect(lineAt).toBeLessThan(afterAt);
    expect(afterAt).toBeLessThan(okAt);
    // 🔴 null 門は**塗りの後**(DrawPolyPolygon の後)で、縁の中に在る(塗りの前では意味が無い)
    expect(after.indexOf('mpGraphics->DrawPolyPolygon(')).toBeLessThan(nullAt);
  });

  it('🔴 null 門は印を出して `return`(縁を引かない)/ 印の上限は 100 で、`DrawPolyLine` は包まない', () => {
    const after = patched();
    const nullAt = after.indexOf('            if (!mpGraphics) // PKC3-GRIPGUARD');
    // ⚠ 兄弟関数にも同じ行が在るので、null 門より**後ろ**の 1 件を取る
    const lineAt = after.indexOf('            bSuccess = mpGraphics->DrawPolyLine(', nullAt);
    expect(nullAt).toBeGreaterThan(-1);
    expect(lineAt).toBeGreaterThan(nullAt);
    // 🔑 期待値は patch から取らず**手で書く**
    expect(after.slice(nullAt, lineAt)).toBe(
      [
        `            if (!mpGraphics) // ${MARK}`,
        `            { // ${MARK}`,
        `                std::fputs("${MARK}: mpGraphics null after fill (line skipped)\\n", stderr); // ${MARK}`,
        `                return; // ${MARK}`,
        `            } // ${MARK}`,
        `            if (g_nPkc3GripSaid < 100) // ${MARK}`,
        `            { // ${MARK}`,
        `                ++g_nPkc3GripSaid; // ${MARK}`,
        `                bPkc3Said = true; // ${MARK}`,
        `#ifdef __EMSCRIPTEN__ // ${MARK}`,
        `                std::fprintf(stderr, "${MARK}: before gfx=%p dev=%p stackfree=%lu\\n", static_cast<void*>(mpGraphics), static_cast<const void*>(this), static_cast<unsigned long>(emscripten_stack_get_free())); // ${MARK}`,
        `#else // ${MARK}`,
        `                std::fprintf(stderr, "${MARK}: before gfx=%p dev=%p\\n", static_cast<void*>(mpGraphics), static_cast<const void*>(this)); // ${MARK}`,
        `#endif // ${MARK}`,
        `            } // ${MARK}`,
        ``,
      ].join('\n'),
    );
    // after の印は旗が立った回だけ
    expect(after).toContain(
      `        if (bPkc3Said) std::fputs("${MARK}: after DrawPolyLine returned\\n", stderr); // ${MARK}\n        if(bSuccess)\n            return;\n`,
    );
  });

  it('🔴 `#include` と file scope のカウンタ: `<cstdio>` と(Emscripten のときだけ)`<emscripten/stack.h>`、関数より前', () => {
    const after = patched();
    expect(count(EXCERPT, '#include <cstdio>'), '抜粋の前提(元には無い)').toBe(0);
    expect(after).toContain(
      [
        '#include <cassert>',
        '#include <memory>',
        `#include <cstdio> // ${MARK}`,
        `#ifdef __EMSCRIPTEN__ // ${MARK}`,
        `#include <emscripten/stack.h> // ${MARK}`,
        `#endif // ${MARK}`,
        `namespace { int g_nPkc3GripSaid = 0; } // ${MARK}`,
        '',
      ].join('\n'),
    );
    const fnAt = after.indexOf('void OutputDevice::DrawPolygon( const tools::Polygon& rPoly )');
    expect(after.indexOf('namespace { int g_nPkc3GripSaid')).toBeLessThan(fnAt);
    // `emscripten_stack_get_free` は `#ifdef __EMSCRIPTEN__` の中の 1 か所だけ
    expect(count(after, 'emscripten_stack_get_free()')).toBe(1);
    const useAt = after.indexOf('emscripten_stack_get_free()');
    expect(after.lastIndexOf('#ifdef __EMSCRIPTEN__', useAt)).toBeGreaterThan(after.lastIndexOf('#endif', useAt));
    // 上限の `< 100` と `++` が 1 件ずつ
    expect(count(after, 'g_nPkc3GripSaid < 100')).toBe(1);
    expect(count(after, '++g_nPkc3GripSaid;')).toBe(1);
  });

  it('🔴 足した行は全部 mark で終わる(注釈の 1 行を除く)。原文の行は 1 行も書き換えない', () => {
    const after = patched();
    expect(after).not.toBe(EXCERPT);
    expect(restore(after)).toBe(EXCERPT);
    // 足した行は 23 行(include 側 5 + 旗 1 + 注釈 1 + null 門 5 + 印 10 + after 1)
    const added = after.split('\n').filter((l) => l.includes(MARK));
    expect(added.length).toBe(23);
    // 🔴 印の無い足し行が無い(原文の行集合に無い行は、全部印を含む)
    const origLines = new Set(EXCERPT.split('\n'));
    const bare = after.split('\n').filter((l) => !origLines.has(l) && !l.includes(MARK));
    expect(bare, '印の無い足し行').toEqual([]);
    const comments = added.filter((l) => /^\s*\/\/ /.test(l));
    expect(comments.length).toBe(1);
    for (const l of added.filter((x) => !comments.includes(x))) {
      expect(l.endsWith(` // ${MARK}`), `行末が印でない: ${l}`).toBe(true);
    }
    for (const l of added) {
      expect(l, '行末の \\ は次の行をコメントへ連結する').not.toMatch(/\\\s*$/);
      expect(l, 'ブロックコメントは使わない').not.toMatch(/\/\*|\*\//);
    }
    // 括弧は釣り合っている(文字列を除いて `{` と `}` の数が同じ。`#ifdef` の対も)
    const code = added.filter((l) => !comments.includes(l)).join('\n').replace(/"[^"]*"/g, '');
    expect(count(code, '{')).toBe(count(code, '}'));
    expect(count(code, '#ifdef')).toBe(count(code, '#endif'));
    expect(count(code, '#else')).toBe(1);
  });

  it('🔴 原文の他の所は動かない: 塗り・`return`・縁の引数・後続の経路が元のまま', () => {
    const after = patched();
    for (const needle of [
      'mpGraphics->DrawPolyPolygon(',
      '                bPixelSnapHairline,\n                *this);\n',
      '    tools::Polygon aPoly = ImplLogicToDevicePixel( rPoly );\n',
      '        mpGraphics->DrawPolygon( nPoints, pPtAry, *this );\n',
    ]) {
      expect(count(after, needle), needle).toBe(count(EXCERPT, needle));
    }
    expect(count(after, 'DrawPolyLine(')).toBe(count(EXCERPT, 'DrawPolyLine('));
  });
});

describe('#1402(grip-guard)── 上流の実 file へ', () => {
  const real = UPSTREAM ? join(UPSTREAM, REL) : '';
  it.skipIf(!real || !existsSync(real))('🔴 実 file へ当たる(exit 0)。足した行は 23・消した行は 0。2 度目は SKIP で不変', () => {
    const orig = readFileSync(real, 'utf-8');
    const t = tree(orig);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(0);
      const after = t.read();
      expect(after.split('\n').length - orig.split('\n').length).toBe(23);
      expect(restore(after)).toBe(orig);
      const r2 = run(SCRIPT, t.dir);
      expect(r2.code, r2.out).toBe(0);
      expect(r2.out).toContain('SKIP');
      expect(t.read()).toBe(after);
    } finally {
      t.cleanup();
    }
  });
});

describe('#1402(grip-guard)── 他の検査との関係', () => {
  it('🔑 当て先が、他の LO patch と重ならない(同じ file を 2 本が触ると当てる順で結果が変わる)', () => {
    const owners = readdirSync('build/office-wasm')
      .filter((f) => /^patch-.*\.py$/.test(f))
      .filter((f) => readFileSync(join('build/office-wasm', f), 'utf-8').includes(`"${REL}"`));
    expect(owners).toEqual(['patch-lo-grip-guard.py']);
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/^SRC\s*=\s*"vcl\/source\/outdev\/polygon\.cxx"/m);
  });

  it('🔑 workflow の本数の主張が、この 1 本を数えている(28 → 29)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/28 → 29\(2026-10-07\)/);
    expect(yml).toContain('patch-lo-grip-guard.py');
    expect(yml).toContain('test "$n" -eq 30');
  });
});
