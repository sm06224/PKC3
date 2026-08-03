/** @vitest-environment node */
/**
 * P8: 配色**トークン**の網羅と、**読めるかどうか**。
 *
 * 🔴 テーマが 9 個になった時点で、**目で確かめるのは不可能**になった。
 * 前回ライトで白 on 淡緑 = **1.80:1** の読めない文字を出荷しており、
 * 面の smoke は `body` の背景しか見ないので **green のまま**だった。
 * ここが「読めない配色を出荷しない」唯一の関門である。
 *
 * ⚠ 閾値は 2 段階(WCAG):
 *   - 文字(地の上の `--fg` / `--muted`)= **4.5:1**
 *   - UI 部品(リンク色・枠)= **3:1** 以下
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { THEMES } from '../../src/adapter/ui/render/theme';

const css = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');

/** `:root[data-pkc-theme='x']` ブロックの中のトークンを読む(light は既定と同居)。 */
function tokensOf(theme: string): Record<string, string> {
  const needle =
    theme === 'light'
      ? ":root,\n:root[data-pkc-theme='light'] {"
      : `:root[data-pkc-theme='${theme}'] {`;
  const at = css.indexOf(needle);
  expect(at, `${theme} のブロックが tokens.css に無い`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  const body = css.slice(open, close);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) out[m[1]!] = m[2]!.trim();
  return out;
}

/** `#rgb` / `#rrggbb` → [r,g,b]。⚠ それ以外の記法はこの file では使わせない。 */
function rgb(hex: string): [number, number, number] {
  const h = hex.trim();
  expect(h, `色が 16 進で書かれていない: ${hex}`).toMatch(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i);
  const full = h.length === 4 ? `#${h[1]!}${h[1]!}${h[2]!}${h[2]!}${h[3]!}${h[3]!}` : h;
  return [
    parseInt(full.slice(1, 3), 16),
    parseInt(full.slice(3, 5), 16),
    parseInt(full.slice(5, 7), 16),
  ];
}

/** WCAG の相対輝度。 */
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 前景 / 背景 / 最低比 の組。⚠ **実際に画面で重なる組だけ**を並べる。 */
const PAIRS: readonly { fg: string; bg: string; min: number; what: string }[] = [
  { fg: '--fg', bg: '--surface', min: 4.5, what: '本文' },
  { fg: '--fg', bg: '--bg', min: 4.5, what: '本文(地)' },
  { fg: '--fg', bg: '--surface-2', min: 4.5, what: '本文(見出し帯)' },
  { fg: '--muted', bg: '--surface', min: 4.5, what: '補助文' },
  { fg: '--muted', bg: '--surface-2', min: 4.5, what: '補助文(見出し帯)' },
  { fg: '--accent-fg', bg: '--accent', min: 4.5, what: '最上部の帯' },
  { fg: '--accent-dim-fg', bg: '--accent-dim', min: 4.5, what: '選択中の行' },
  { fg: '--danger', bg: '--surface', min: 4, what: '危険な操作' },
  { fg: '--accent', bg: '--surface', min: 3, what: 'リンク・強調' },
  { fg: '--border', bg: '--surface', min: 1.2, what: '枠(見えること)' },
];

describe('配色トークン', () => {
  it('🔴 全テーマが**同じトークン一式**を定義している', () => {
    const base = Object.keys(tokensOf('light')).filter((k) => k.startsWith('--'));
    // 空振り防止: 色トークンが実在すること(規則ごと消えても気づく)
    expect(base.length).toBeGreaterThan(8);
    for (const t of THEMES) {
      const got = Object.keys(tokensOf(t.id));
      expect(
        base.filter((k) => !got.includes(k)),
        `${t.id} に足りないトークン`,
      ).toEqual([]);
    }
  });

  it.each(THEMES.map((t) => t.id))('🔴 %s が読める(コントラスト比)', (theme) => {
    const tok = tokensOf(theme);
    for (const { fg, bg, min, what } of PAIRS) {
      const f = tok[fg];
      const b = tok[bg];
      expect(f, `${theme}: ${fg} が無い`).toBeTruthy();
      expect(b, `${theme}: ${bg} が無い`).toBeTruthy();
      const ratio = contrast(f!, b!);
      expect(
        ratio,
        `${theme} の「${what}」が読めない: ${fg}(${f!}) on ${bg}(${b!}) = ${ratio.toFixed(2)}:1(要 ${min}:1)`,
      ).toBeGreaterThanOrEqual(min);
    }
  });

  it('🔴 明暗の宣言が実際の明るさと合っている', () => {
    // ⚠ `color-scheme` を取り違えると、スクロールバーや既定の入力欄だけが
    // 逆の明るさで出る(部分的にちぐはぐになる)
    for (const t of THEMES) {
      const l = luminance(tokensOf(t.id)['--surface']!);
      expect(t.dark ? l < 0.25 : l > 0.5, `${t.id} の dark 宣言が実際と逆`).toBe(true);
    }
  });
});
