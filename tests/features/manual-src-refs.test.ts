/** @vitest-environment node */
/**
 * 🔴 **コードが引くマニュアルの節の名前は、実在の見出しと一字一句同じ**(#779 段⑨)。
 *
 * ⚠ 章立てを組み替えると、画面の字(「書き方はマニュアルの「…」」)や、
 *   コードの注釈が指す節の名前が黙って腐る。`マニュアル「X」` / `マニュアルの「X」` を
 *   `src/` 全体(画面の字と注釈の両方)から拾い、`X` が見出しにあることを確かめる。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { refKey } from '../../src/features/help/manual-refs';

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|css)$/u.test(n)) out.push(p);
  }
  return out;
}

const heads = (() => {
  let fence = false;
  const hs = new Set<string>();
  for (const l of readFileSync('docs/manual.md', 'utf-8').split('\n')) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence) continue;
    const m = /^#{1,6} (.*)$/.exec(l);
    if (m) hs.add(refKey(m[1]!));
  }
  return hs;
})();

const RE = /マニュアル(?:の|中の)?\s*[「『]([^」』]+)[」』]/gu;

describe('src が引くマニュアルの節の名前', () => {
  const found: { file: string; line: number; name: string; user: boolean }[] = [];
  for (const f of walk('src')) {
    readFileSync(f, 'utf-8').split('\n').forEach((text, i) => {
      for (const m of text.matchAll(RE)) {
        const user = !/^\s*(\/\/|\*|\/\*)/u.test(text);
        found.push({ file: f, line: i + 1, name: m[1]!, user });
      }
    });
  }

  it('空振り防止 ── 画面の字の引きと注釈の引きの両方を拾えている', () => {
    // 画面の字で節を引いている 2 か所は名指しで在ることを見る(1 件でも緑になる床を避ける)
    const userFiles = found.filter((x) => x.user).map((x) => x.file);
    expect(userFiles.some((f) => f.endsWith('sql-to-note.ts')), 'sql-to-note.ts の引きが拾えていない').toBe(true);
    expect(userFiles.some((f) => f.endsWith('filer.ts')), 'filer.ts の引きが拾えていない').toBe(true);
    expect(found.filter((x) => !x.user).length, '注釈の引きが少なすぎる').toBeGreaterThan(10);
  });

  it('🔴 引かれた名前はどれも、いまのマニュアルの見出しと同じ', () => {
    const bad = found
      .filter((x) => !heads.has(refKey(x.name)))
      .map((x) => `${x.file}:${x.line} 「${x.name}」`);
    expect(bad, '存在しない節の名前を引いている').toEqual([]);
  });
});
