/**
 * 印(複数選択)の地の明度は、フォルダの表・2 ペインの表が**同じ 1 つの
 * トークン**を読むこと(#1038 台帳③ 段 G、C13 / Q6 裁定「A + 濃く」。
 * 「一覧」タブは #813 段③ で外した)。
 *
 * 🔴 守る主張:
 * 1. `--pkc-mark-bg` は `--fg` と `--surface` の `color-mix`(色相を発明しない ──
 *    地は無彩色、色は情報にだけ)。**テーマごとには定義しない**(9 テーマ全部に
 *    自動で追従する `--pkc-tag-bg` と同じ技法)
 * 2. フォルダの表・2 ペインの表の `[data-pkc-marked]` 規則が、**2 つとも**
 *    `var(--pkc-mark-bg)` を読む(1 か所だけ直して 1 か所が古いまま、を防ぐ)
 * 3. 外した「一覧」の規則(`entry-list`)が CSS に残っていない
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

  it('🔴 外した「一覧」の規則が CSS に残っていない(死んだ規則を残さない)', () => {
    const raw = readFileSync('src/styles/app.css', 'utf-8');
    // ⚠ コメントを落としてから見る(解説に旧い名前を書いても落ちない ── 見るのは実行する規則)
    const css = stripComments(raw);
    expect(css, '「一覧」の器の規則が残っている').not.toContain('entry-list');
    // 空振り防止 ── 正規の側(フォルダの表)の規則は在る
    expect(blocksFor(screenOnly, "[data-pkc-region='filer-table'] tbody tr[data-pkc-marked]").length).toBe(1);
  });

  it('🔴 開いている行(data-pkc-selected)は !important を保つ(印との組合せが崩れない)', () => {
    const hit = blocksFor(screenOnly, '[data-pkc-selected]');
    expect(hit.length, '開いている行の規則が無い').toBe(1);
    expect(hit.join(' '), '!important が外れている').toMatch(/background:[^;]*!important/);
  });
});
