/** @vitest-environment node */
/**
 * P7b review L-1 / M-9: 配色**トークン**の網羅と役割。
 *
 * ⚠ happy-dom では `import.meta.url` が file: にならないので、CSS を読む検査は
 * node env の別 file に置く(面の test とは関心が違う)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 🔴 **トークンの網羅を機械で見る**(review L-1)。
 * ライト側で 1 つ落とすと、暗い側の色が白地に載って実質不可視になるが
 * (`--fg` を落とすと ≈1.7:1)、面の smoke は `body` の背景しか見ないので
 * **green のまま**だった。
 */
describe('配色トークンの網羅', () => {
  const css = readFileSync(new URL('../../src/styles/app.css', import.meta.url), 'utf8');
  const block = (selector: string): string => {
    const at = css.indexOf(selector);
    expect(at).toBeGreaterThanOrEqual(0);
    const open = css.indexOf('{', at);
    const close = css.indexOf('}', open);
    return css.slice(open, close);
  };
  const names = (body: string): string[] =>
    [...body.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]!);

  it('ダークで定義した**色**は、ライトで全部上書きされている', () => {
    const dark = names(block(':root {'));
    const light = new Set(names(block(":root[data-pkc-theme='light'] {")));
    // ⚠ 幾何とフォントは配色ではない ── 上書きされないのが正しい
    const geometry = /^--(radius|s\d|font)$/;
    const colors = dark.filter((n) => !geometry.test(n));
    // 空振り防止: 色トークンが実在すること(規則が消えても気づく)
    expect(colors.length).toBeGreaterThan(8);
    expect(colors.filter((n) => !light.has(n))).toEqual([]);
  });

  it('🔴 `--accent-dim` の上の文字に `--accent-fg` を流用していない', () => {
    // review M-9: ライトで白 on 淡緑 = 1.80:1(スクリーンショットで白飛び)
    const active = block("[data-pkc-region='topbar'] [data-pkc-active] {");
    expect(active).toContain('var(--accent-dim-fg)');
    expect(active).not.toContain('var(--accent-fg)');
  });
});
