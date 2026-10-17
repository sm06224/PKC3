/**
 * #1087 M11: 閉じの区切りを探す走査が、閉じが無い行で 2 乗になっていた。
 *
 * 守るもの:
 *  1. 出力が変わっていないこと ── ① 直す前の実装から取った HTML の指紋(fixture)との等値
 *     ② `readMathAt` の旧実装(下に写し)との差分
 *  2. 長い 1 行で時間が伸びないこと(余裕を大きく取る)
 *
 * 守っていないもの: 実ブラウザの描画(unit のみ)。時間の上限は端末差に負けないよう緩い。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { closesMath, isEscaped, opensMath, readMathAt } from '../../src/features/markdown/math-delims';

// ---- 旧実装(直す前の readMathAt をそのまま写したもの。差分の対照群) ----
function oldReadMathAt(src: string, start: number, posMax: number) {
  if (src[start] !== '$') return null;
  if (isEscaped(src, start)) return null;
  const display = src[start + 1] === '$';
  const dl = display ? 2 : 1;
  const from = start + dl;
  if (display) {
    if (isEscaped(src, start + 1)) return null;
  } else if (!opensMath(src, start)) {
    return null;
  }
  for (let i = from; i < posMax; i++) {
    const ch = src[i];
    if (ch === '\n') return null;
    if (ch === '`') return null;
    if (ch !== '$') continue;
    if (isEscaped(src, i)) continue;
    if (display) {
      if (src[i + 1] !== '$') continue;
      if (i === from) return null;
      return { from, to: i, end: i + 2, display: true };
    }
    if (!closesMath(src, i)) continue;
    if (i === from) return null;
    return { from, to: i, end: i + 1, display: false };
  }
  return null;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const PIECES = [
  '$', '$', '$', '\\$', '$$', '$$', '1', '23', 'a', 'x', 'PATH', ' ', ' ', '日本', '、', '`', '``', '\n', '{', '${d}',
  '[[ruby:a|b]]', '[[ruby:', '[[ruby:漢|かん]]', '[[em:x]]', '[[em:', ']]', ']', '|', '\\', '\\\\', '==', '*', '_',
  ':', ':', ':bold:', ':red:', 'ruby:', ':a:', ':code:[x]', ':sup:[2]', ':home:', '::', '12:30', ':bg-black, white:',
];

function genLine(r: () => number): string {
  const n = 1 + Math.floor(r() * 14);
  let s = '';
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(r() * PIECES.length)]!;
  return s;
}

const FIXFILE = join(process.cwd(), 'tests/features/fixtures', 'markdown-scan-linear.hashes.json');
const N = 3000;
const SEED = 20261017;
const lines: string[] = (() => {
  const r = rng(SEED);
  return Array.from({ length: N }, () => genLine(r));
})();

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

describe('M11: 出力が直す前と同じ', () => {
  it('readMathAt は旧実装と全位置で一致する', () => {
    let checked = 0;
    let spans = 0;
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        for (const posMax of [line.length, Math.max(0, line.length - 2)]) {
          const a = readMathAt(line, i, posMax);
          const b = oldReadMathAt(line, i, posMax);
          expect(a, JSON.stringify([line, i, posMax])).toEqual(b);
          checked++;
          if (b) spans++;
        }
      }
    }
    // 空振り防止: 数式が実際に読めた形を十分含むこと
    expect(spans).toBeGreaterThan(500);
    expect(checked).toBeGreaterThan(50000);
  });

  it('同じ src に昇順で何度も問い合わせても(メモ経由でも)旧実装と一致する', () => {
    const memo = {} as Parameters<typeof readMathAt>[3];
    for (const line of lines.slice(0, 1500)) {
      for (let i = 0; i < line.length; i++) {
        expect(readMathAt(line, i, line.length, memo)).toEqual(oldReadMathAt(line, i, line.length));
      }
    }
  });

  it('renderMarkdown の HTML が、直す前の実装から取った指紋と一致する', () => {
    const expected = JSON.parse(
      readFileSync(FIXFILE, 'utf8'),
    ) as string[];
    expect(expected.length).toBe(N);
    const got = lines.map((l) => sha(renderMarkdown(l)));
    const bad = got.map((g, i) => (g === expected[i] ? -1 : i)).filter((i) => i >= 0);
    expect(bad.map((i) => lines[i])).toEqual([]);
    // 空振り防止: 数式 / ruby / 圏点が実際に出る入力を含む
    const htmls = lines.map((l) => renderMarkdown(l));
    expect(htmls.filter((h) => h.includes('pkc-math')).length).toBeGreaterThan(100);
    expect(htmls.filter((h) => h.includes('<ruby>')).length).toBeGreaterThan(100);
    expect(htmls.filter((h) => h.includes('pkc-em-dot')).length).toBeGreaterThan(100);
  });
});

describe('M11: 長い 1 行が線形', () => {
  // 計測(2026-10-17、直す前・この箱): `$a ` x 20000 = 約 9.6 s / `[[ruby:a|` x 5000 = 約 1.0 s(原因は ruby 規則ではなく
  // `:` の簡易 inline の走査)。直した後は 53 ms / 約 10 ms。
  // 上限は直した後の実測(数十 ms)の数十倍の余裕を取る。
  it('`$a ` を 20000 個並べた 1 行', () => {
    const t = performance.now();
    renderMarkdown('$a '.repeat(20000));
    expect(performance.now() - t).toBeLessThan(1500);
  });
  it('閉じの無い `$` / `$$` の長い行', () => {
    const t = performance.now();
    renderMarkdown('$'.repeat(20000) + 'x');
    renderMarkdown('$$ a '.repeat(8000));
    expect(performance.now() - t).toBeLessThan(1500);
  });
  it('`:` が並ぶ 1 行(ruby: / 簡易 inline の走査)', () => {
    const t = performance.now();
    renderMarkdown('ruby:a|'.repeat(20000));
    expect(performance.now() - t).toBeLessThan(1500);
  });
  it('閉じの無い `[[ruby:` / `[[em:` を 20000 個', () => {
    const t = performance.now();
    renderMarkdown('[[ruby:a|'.repeat(20000));
    renderMarkdown('[[em:a'.repeat(20000));
    expect(performance.now() - t).toBeLessThan(1500);
  });
});
