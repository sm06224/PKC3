/** @vitest-environment node */
/**
 * #1982 段 4: アクセントの色の選択 × 全配色のコントラスト行列、と字体の適用。
 * ⚠ 閾値は `theme-tokens.test.ts` の PAIRS(アクセント関係の行)と同じ。下げない。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { THEMES } from '../../src/adapter/ui/render/theme';
import { ACCENTS, FONTS, isAccentChoice, isFontChoice } from '../../src/features/appearance-choice';

const css = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function block(selector: string): Record<string, string> {
  const at = css.indexOf(selector + ' {');
  expect(at, `${selector} が tokens.css に無い`).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf('{', at), css.indexOf('}', at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

function lum(h: string): number {
  const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
}
function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function hueOf(h: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx === mn) return 0;
  const d = mx - mn;
  const x = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (x * 60 + 360) % 360;
}
function hueDiff(a: string, b: string): number {
  const d = Math.abs(hueOf(a) - hueOf(b));
  return Math.min(d, 360 - d);
}

const AREA = [
  ['--accent-fg', '--accent', 4.5],
  ['--accent-dim-fg', '--accent-dim', 4.5],
  ['--accent', '--surface', 3],
  ['--accent', '--bg', 3],
  ['--accent', '--surface-2', 3],
  ['--accent', '--accent-dim', 3],
  ['--fg', '--accent-dim', 3],
] as const;

describe('アクセントの色 × 全配色', () => {
  const choices = ACCENTS.filter((a) => a.id !== 'theme');
  it('前提: 選べる色が 4 つ・配色が 12', () => {
    expect(choices.length).toBe(4);
    expect(THEMES.length).toBe(12);
  });

  for (const t of THEMES) {
    for (const a of choices) {
      it(`${t.id} × ${a.id} が読める`, () => {
        const base: Record<string, string> = {};
        const themeCss = t.id === 'light' ? ":root,\n:root[data-pkc-theme='light']" : `:root[data-pkc-theme='${t.id}']`;
        const at = css.indexOf(themeCss + ' {');
        expect(at).toBeGreaterThanOrEqual(0);
        for (const m of css.slice(css.indexOf('{', at), css.indexOf('}', at)).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) base[m[1]!] = m[2]!.trim();
        const over = block(`:root[data-pkc-tone='${t.dark ? 'dark' : 'light'}'][data-pkc-accent='${a.id}']`);
        for (const k of ['--accent', '--accent-fg', '--accent-dim', '--accent-dim-fg']) expect(over[k], `${a.id}: ${k}`).toMatch(/^#[0-9a-f]{6}$/i);
        const tok = { ...base, ...over };
        for (const [f, b, min] of AREA) {
          expect(ratio(tok[f]!, tok[b]!), `${t.id} × ${a.id}: ${f} on ${b}`).toBeGreaterThanOrEqual(min);
        }
        // 🔴 ネオンもアクセントに付いていく(差し替えないと、アクセントを青にしてもネオンだけ配色の元の色で光る)
        for (const k of ['--neon', '--neon-core']) expect(over[k], `${a.id}: ${k} を差し替えていない`).toMatch(/^#[0-9a-f]{6}$/i);
        for (const g of ['--surface', '--bg']) {
          expect(ratio(over['--neon']!, tok[g]!), `${t.id} × ${a.id}: ネオンの線が ${g} から見分けられない`).toBeGreaterThanOrEqual(3);
          expect(ratio(over['--neon-core']!, tok[g]!), `${t.id} × ${a.id}: ネオンの芯が ${g} から見分けられない`).toBeGreaterThanOrEqual(3);
        }
        if (t.dark) expect(lum(over['--neon-core']!), '暗い配色の芯が線より明るくない').toBeGreaterThan(lum(over['--neon']!));
        else expect(lum(over['--neon-core']!), '明るい配色の芯が線より濃くない').toBeLessThan(lum(over['--neon']!));
        // 線と芯の両方がアクセントと同じ色相(実測の差は 0〜5 度。15 度で締める ── 別の色の芯に差し替えると落ちる)
        for (const k of ['--neon', '--neon-core']) {
          const dh = hueDiff(over[k]!, over['--accent']!);
          expect(dh, `${a.id}: ${k} の色相がアクセントから離れた(${dh} 度)`).toBeLessThanOrEqual(15);
        }
      });
    }
  }
});

describe('選択肢の門', () => {
  it('知らない id は受けない / 既定は受ける', () => {
    expect(isAccentChoice('theme')).toBe(true);
    expect(isAccentChoice('red')).toBe(false);
    expect(isFontChoice('mincho')).toBe(true);
    expect(isFontChoice('comic')).toBe(false);
    expect(FONTS.length).toBe(4);
  });
});
