/**
 * 🔴 **見た目の段はトークンから選ぶ**(#1982 段 0。user 裁定 2026-11-19)。
 *
 * 守る主張:
 * 1. `app.css` / `tokens.css` が `var(--x)` で使うトークンは、**どこかで必ず定義されている**
 *    (CSS の宣言か、TS が `style.setProperty` で入れる名前)。
 *    ⚠ 実例: `--shadow-sm` は 3 か所で使われていたのに定義が無く、ずっと fallback で描いていた
 *    (`--mono` / `--success` / `--pkc-border` も同じ)。fallback があると画面は壊れないので、
 *    **目では気づけない** ── ここで機械に見させる。
 * 2. 字の大きさに**素の px を増やさない**(段 `--fs-*` から選ぶ)。残りは理由つきの例外で、段 2 で畳む。
 * 3. 影の 3 段は**全テーマ**が持つ(欠けたテーマでは影が消える)。
 * 4. 動きのトークンは `prefers-reduced-motion` で 0 になる。
 * 5. 字の大きさの段は値の集合で pin する(名前だけ見ると、全部同じ値にする変異が通る)。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mediaBlock, stripComments } from '../helpers/css-blocks';

const APP = stripComments(readFileSync('src/styles/app.css', 'utf-8'));
const TOKENS = stripComments(readFileSync('src/styles/tokens.css', 'utf-8'));

function tsSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsSources(p));
    else if (p.endsWith('.ts')) out.push(readFileSync(p, 'utf-8'));
  }
  return out;
}
const TS = tsSources('src').join('\n');

/** TS が名前を組み立てて入れるトークン(`pane-size.ts` の `--pkc-pane-${id}`)。 */
const DYNAMIC_PREFIXES: readonly string[] = ['--pkc-pane-'];

describe('🔴 見た目の段はトークンから選ぶ(#1982 段 0)', () => {
  it('🔴 var() で使うトークンは、CSS か TS のどこかで定義されている', () => {
    const used = new Set([...(APP + TOKENS).matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!));
    // 空振り防止 ── 走査が壊れて 0 件なら、この test は何も見ていない
    expect(used.size).toBeGreaterThan(80);
    const defined = new Set([...(APP + TOKENS).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
    const missing = [...used].filter((name) => {
      if (defined.has(name)) return false;
      if (DYNAMIC_PREFIXES.some((p) => name.startsWith(p))) return false;
      // TS が `setProperty('--x', …)` などで入れる名前(字として現れていればよい)
      return !new RegExp(`${name}(?![\\w-])`).test(TS);
    });
    expect(missing, '定義の無いトークンを使っている(fallback で黙って描いている)').toEqual([]);
  });

  it('🔴 字の大きさの素の px は増やさない(段 `--fs-*` から選ぶ)', () => {
    const raw = [...APP.matchAll(/font-size:\s*([\d.]+px)/g)].map((m) => m[1]!);
    const viaToken = [...APP.matchAll(/font-size:\s*var\(--fs-/g)].length;
    // ⚠ 上限だけでは 0 件へ縮む変異(段を全部消す)が通るので、段を使っている数の下限も置く
    expect(viaToken, '`--fs-*` を使う規則が減った(段が使われていない)').toBeGreaterThan(200);
    // 🔑 残りの例外(段 2 で畳む): 12.5px = 打つ欄 / 11.5px / 9px
    expect(raw.length, `素の px の字の大きさが増えた: ${raw.join(', ')}`).toBeLessThanOrEqual(10);
    expect(new Set(raw), '新しい素の値が生えた').toEqual(new Set(['12.5px', '11.5px', '9px']));
  });

  it('🔴 字の大きさの段は 10 / 11 / 12 / 13 / 14 / 16 / 18px', () => {
    const px = ['--fs-2xs', '--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--fs-xl', '--fs-2xl'].map(
      (n) => TOKENS.match(new RegExp(`${n}:\\s*([^;]+);`))?.[1]?.trim(),
    );
    expect(px).toEqual(['10px', '11px', '12px', '13px', '14px', '16px', '18px']);
  });

  it('🔴 影の 3 段は全テーマが持つ', () => {
    const themes = [...TOKENS.matchAll(/:root\[data-pkc-theme='([\w-]+)'\]\s*\{([^}]*)\}/g)];
    expect(themes.length, 'テーマを引けない(走査が壊れている)').toBe(10);
    for (const [, name, body] of themes) {
      for (const t of ['--shadow-sm', '--shadow', '--shadow-lg']) {
        expect(body, `${name} に ${t} が無い`).toMatch(new RegExp(`${t}:\\s*0 `));
      }
    }
  });

  it('🔴 動きのトークンは reduced-motion で 0 になる', () => {
    expect(TOKENS).toMatch(/--dur:\s*180ms;/);
    const { body } = mediaBlock(APP, '(prefers-reduced-motion: reduce)');
    expect(body).toMatch(/--dur-fast:\s*0ms/);
    expect(body).toMatch(/--dur:\s*0ms/);
  });
});
