/**
 * 暗いテーマの文字色(`:文字:red:` と「文字色 ▾」の 6 色)が WCAG AA(4.5:1)を満たすことの検算。
 * 値は `app.css` の `dark-text-colors` の枠、地は `tokens.css` の暗いテーマ全部の `--bg` / `--surface` / `--surface-2`。
 * ⚠ 枠の中のコメントは剥がして対象行だけ見る(コメントの字で満たさない)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TEXT_COLORS } from '../../src/features/markdown/word-format';

const APP = readFileSync('src/styles/app.css', 'utf8');
const TOKENS = readFileSync('src/styles/tokens.css', 'utf8');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');

function block(): string {
  const m = /\/\* BEGIN dark-text-colors \*\/([\s\S]*?)\/\* END dark-text-colors \*\//.exec(APP);
  if (m === null) throw new Error('dark-text-colors の枠が無い');
  return stripComments(m[1]!);
}

function lum(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function darkGrounds(): { theme: string; token: string; value: string }[] {
  const out: { theme: string; token: string; value: string }[] = [];
  for (const m of stripComments(TOKENS).matchAll(/:root\[data-pkc-theme='([^']+)'\]\s*\{([^}]*)\}/g)) {
    const body = m[2]!;
    if (!/color-scheme:\s*dark/.test(body)) continue;
    for (const t of ['--bg', '--surface', '--surface-2']) {
      const v = new RegExp(`${t}:\\s*(#[0-9a-fA-F]{6})`).exec(body);
      if (v !== null) out.push({ theme: m[1]!, token: t, value: v[1]! });
    }
  }
  return out;
}

describe('暗いテーマの文字色のコントラスト', () => {
  const css = block();
  const vars = new Map(
    [...css.matchAll(/--pkc-dark-text-([a-z]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!] as const),
  );
  const grounds = darkGrounds();

  it('対照: 暗い地を拾えていて、6 色すべてに暗い用の値がある', () => {
    expect(grounds.length).toBeGreaterThanOrEqual(6);
    expect([...vars.keys()].sort()).toEqual(TEXT_COLORS.map((c) => c.id).sort());
  });

  it('対照: 明るい地向けの元の値は暗い地のどこかで 4.5 を割る(検算が空振りしていない)', () => {
    const dim = TEXT_COLORS.some((c) => grounds.some((g) => ratio(c.value, g.value) < 4.5));
    expect(dim).toBe(true);
  });

  for (const c of TEXT_COLORS) {
    it(`${c.id}: 暗いテーマすべての地で 4.5:1 以上`, () => {
      const v = vars.get(c.id)!;
      const bad = grounds
        .filter((g) => ratio(v, g.value) < 4.5)
        .map((g) => `${g.theme}${g.token} ${ratio(v, g.value).toFixed(2)}`);
      expect(bad).toEqual([]);
    });

    it(`${c.id}: 色名と 16 進(文字色 ▾ が書く形)の両方を差し替える`, () => {
      expect(css).toContain(`[style^='color: ${c.value}']`);
      expect(css).toContain(`[style*='; color: ${c.value}']`);
      expect(css).toContain(`[style^='color: ${c.id}']`);
      expect(css).toContain(`var(--pkc-tc-${c.id})`);
      expect(css).toContain(`var(--pkc-tc-${c.id}-name)`);
      expect(css).toContain(`--pkc-tc-${c.id}: var(--pkc-dark-text-${c.id})`);
    });
  }
});
