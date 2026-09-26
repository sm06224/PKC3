/**
 * 印(複数選択)の地の明度は、一覧タブ・フォルダの表・2 ペインの表が**同じ 1 つの
 * トークン**を読むこと(#1038 台帳③ 段 G、C13 / Q6 裁定「A + 濃く」)。
 *
 * 🔴 守る主張:
 * 1. `--pkc-mark-bg` は `--fg` と `--surface` の `color-mix`(色相を発明しない ──
 *    地は無彩色、色は情報にだけ)。**テーマごとには定義しない**(9 テーマ全部に
 *    自動で追従する `--pkc-tag-bg` と同じ技法)
 * 2. 一覧・フォルダの表・2 ペインの表の `[data-pkc-marked]` 規則が、**3 つとも**
 *    `var(--pkc-mark-bg)` を読む(2 か所だけ直して 1 か所が古いまま、を防ぐ)
 * 3. 一覧タブの hover は marked の行を塗り直さない(`:not([data-pkc-marked])`)
 * 4. 開いている行(`[data-pkc-selected]`)は `!important` を保つ ── 無いと
 *    「開いていて、かつ印が付いている」行の見え方が CSS の詳細度・順序で
 *    ひっくり返りうる(「開いて見える」が読み手の環境で変わる、を防ぐ)
 *
 * ⚠ happy-dom は描画しないので、規則は**構文で**読む(`tests/helpers/css-blocks.ts`)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments, blocksFor, withoutMedia } from '../helpers/css-blocks';

const TOKENS = stripComments(readFileSync('src/styles/tokens.css', 'utf-8'));
const screenOnly = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));

describe('印(marked)の地の明度は 1 つのトークン(#1038 台帳③ 段 G、C13)', () => {
  it('🔴 --pkc-mark-bg は --fg と --surface の color-mix(テーマごとに定義しない)', () => {
    // 素の :root(テーマ非依存の層)に、ちょうど 1 回だけ定義がある
    const hits = [...TOKENS.matchAll(/--pkc-mark-bg:\s*([^;]+);/g)];
    expect(hits.length, '--pkc-mark-bg の定義が 1 つではない').toBe(1);
    const value = hits[0]![1]!.trim();
    expect(value, '--fg を混ぜていない(色相を発明した可能性)').toContain('var(--fg)');
    expect(value, '--surface から離していない').toContain('var(--surface)');
    expect(value, 'color-mix ではない').toMatch(/^color-mix\(/);
    // ⚠ 9 テーマのどこにも --pkc-mark-bg が個別定義されていない
    //   (個別定義があると、その 1 テーマだけ「+ 濃く」の直しが効かなくなる)
    for (const m of TOKENS.matchAll(/:root\[data-pkc-theme='[^']+'\]\s*\{([^}]*)\}/g)) {
      expect(m[1], 'テーマ側で --pkc-mark-bg を上書きしている').not.toContain('--pkc-mark-bg');
    }
  });

  it.each([
    ["[data-pkc-region='filer-table'] tbody tr[data-pkc-marked]", 'フォルダの表'],
    ["[data-pkc-region='dual-table'] tbody tr[data-pkc-marked] td", '2 ペインの表'],
    ["[data-pkc-region='entry-list'] [data-pkc-entry][data-pkc-marked]", '一覧タブ'],
  ])('🔴 %s(%s)が var(--pkc-mark-bg) を読む', (sel) => {
    const hit = blocksFor(screenOnly, sel);
    expect(hit.length, `${sel} の規則が無い(1 つではない)`).toBe(1);
    expect(hit.join(' '), `${sel} が --pkc-mark-bg を読んでいない`).toContain(
      'var(--pkc-mark-bg)',
    );
    // ⚠ 直す前の値(--surface-2)へ戻す変異を検算する
    expect(hit.join(' '), `${sel} がまだ --surface-2 を読んでいる`).not.toContain(
      'var(--surface-2)',
    );
  });

  it('🔴 一覧タブの hover は marked の行を塗り直さない', () => {
    const hover = blocksFor(
      screenOnly,
      "[data-pkc-region='entry-list'] [data-pkc-entry]:hover:not([data-pkc-marked])",
    );
    expect(hover.length, '一覧タブの hover 規則が無い').toBe(1);
    // ⚠ `:not` を外した素の hover 規則が復活していないこと(dual/filer と同じ検算)
    const bare = blocksFor(screenOnly, "[data-pkc-region='entry-list'] [data-pkc-entry]:hover");
    expect(bare, '一覧タブに素の hover 規則が復活している').toEqual([]);
  });

  it('🔴 開いている行(data-pkc-selected)は !important を保つ(印との組合せが崩れない)', () => {
    const hit = blocksFor(screenOnly, '[data-pkc-selected]');
    expect(hit.length, '開いている行の規則が無い').toBe(1);
    expect(hit.join(' '), '!important が外れている').toMatch(/background:[^;]*!important/);
  });
});
