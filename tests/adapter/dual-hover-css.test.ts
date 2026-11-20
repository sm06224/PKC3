/**
 * 2 ペインの行の「印(marked)」と「hover」が、**別の色**であること(#312 の最初の仕事①)。
 *
 * 🔴 守る主張:
 * 1. hover の地(`--surface-hover`)が **9 テーマ全部**に定義されている
 *    ── 欠けたテーマは初期値へ落ちて、そのテーマでだけ hover が消える
 * 2. どのテーマでも **hover ≠ marked**(`--surface-hover` ≠ `--surface-2`)
 *    ── 2026-08-19 の作り直しで hover の側だけ直り損ね、**マウスを乗せた
 *    だけの行が、印を付けた行に見えていた**(コメントだけが直った後の姿だった)
 * 3. hover の明度は **`--surface` と `--surface-2` の間**(「もっと薄い地」)
 * 4. app.css の hover は `--surface-hover` を使い、**marked の行を塗り直さない**
 *
 * ⚠ happy-dom は描画しないので、規則は**構文で**読む(`announce.test.ts` /
 *   `pane-visibility.test.ts` と同じ作法: `選択子 { 宣言 }` を全部読み、
 *   選択子リストは `,` で割って**丸ごと一致**で探す。`@media` の中は拾わない)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
/**
 * ⚠ **道具は共有する**(#303 の着地前レビュー B-4)── ここに在った
 *   `strip` / `blocksFor` / `withoutMedia` は `calendar-row-height.test.ts` へ
 *   丸ごとコピーされていた。CLAUDE.md §1 に「CSS を読む test で 5 回踏んだ」と
 *   記録がある種類の道具なので、2 か所に置くと**次に直したとき片方だけ直る**。
 */
import { stripComments, blocksFor, withoutMedia } from '../helpers/css-blocks';
import { THEMES } from '../../src/adapter/ui/render/theme';

const TOKENS = stripComments(readFileSync('src/styles/tokens.css', 'utf-8'));

describe('2 ペインの行: hover と印(marked)の色(#312 ①)', () => {
  // ⚠ 空振り防止 ── テーマの数え上げは選択画面の一覧(THEMES)と突き合わせる。
  //   tokens.css を数え直すと「両方から消えた」を見逃す(docs-parity が 1 対 1 を守る)
  it('前提: テーマが 10 個在る(減ったらこの test の走査範囲も減っている)', () => {
    expect(THEMES.length).toBe(10);
  });

  /**
   * 🔴 #1982 段 2 で hover の定義を替えた: 旧い per-theme の hex(`--surface` と `--surface-2` の間 ──
   *   `#fafbfc` on `#fff` で乗せても見えなかった)から、**素の `:root` の 1 本**
   *   `color-mix(in srgb, var(--fg) N%, transparent)` へ。どの地の上でも同じ強さで見え、
   *   全テーマが同じ定義を読む(欠けるテーマが無い)。見える濃さの検算は `shell-tone-css.test.ts`。
   */
  it('🔴 --surface-hover は素の :root の 1 本の定義で、どのテーマも上書きしない(欠けたテーマだけ hover が消えない)', () => {
    const base = blocksFor(TOKENS, ':root').filter((b) => b.includes('--surface-hover:'));
    expect(base.length, '素の :root に --surface-hover が 1 本だけ在る').toBe(1);
    expect(base[0]).toMatch(/--surface-hover:\s*color-mix\(in srgb,\s*var\(--fg\)\s*\d+%,\s*transparent\)/);
    for (const t of THEMES) {
      const own = blocksFor(TOKENS, `:root[data-pkc-theme='${t.id}']`).join(';');
      expect(own, `${t.id}: --surface-hover を上書きしている`).not.toContain('--surface-hover');
    }
  });

  it('🔴 hover ≠ marked: hover の割合は印(--pkc-mark-bg の 18%)より薄い(乗せただけの行が、印を付けた行に見えない)', () => {
    const hover = /--surface-hover:[^;]*?(\d+)%/.exec(TOKENS)![1]!;
    const mark = /--pkc-mark-bg:\s*color-mix\(in oklab,\s*var\(--fg\)\s*(\d+)%/.exec(TOKENS)![1]!;
    expect(Number(hover), 'hover が印より濃い / 同じ').toBeLessThan(Number(mark));
    expect(Number(hover), 'hover が薄すぎて見えない').toBeGreaterThanOrEqual(6);
  });
});

describe('app.css の規則(hover が --surface-hover を使い、印を塗り直さない)', () => {
  const css = stripComments(readFileSync('src/styles/app.css', 'utf-8'));
  const screenOnly = withoutMedia(css);

  it('🔴 hover の規則が --surface-hover を使っている', () => {
    const hit = blocksFor(
      screenOnly,
      "[data-pkc-region='dual-table'] tbody tr:hover:not([data-pkc-marked]) td",
    );
    expect(hit.length, 'hover の規則が無い(選択子が変わったならこの test も追随する)').toBe(1);
    expect(hit.join(' ')).toContain('var(--surface-hover)');
  });

  it('🔴 印(marked)の規則は --pkc-mark-bg(#1038 台帳③ 段 G、C13 / Q6「A + 濃く」)', () => {
    const hit = blocksFor(screenOnly, "[data-pkc-region='dual-table'] tbody tr[data-pkc-marked] td");
    expect(hit.length, '印の規則が無い').toBe(1);
    expect(hit.join(' ')).toContain('var(--pkc-mark-bg)');
  });

  it('🔴 印を除外しない素の hover 規則が残っていない(印の地を hover が上書きしない)', () => {
    // ⚠ `:not` を外す変異はこの選択子に戻る ── marked と同じ詳細度で後勝ちになり、
    //   「乗せている間だけ印が薄く見える」が戻る
    const hit = blocksFor(screenOnly, "[data-pkc-region='dual-table'] tbody tr:hover td");
    expect(hit, '素の hover 規則が復活している').toEqual([]);
  });

  /**
   * 🔴 **対称の反対側: 1 面のファイラ(filer-table)**(CLAUDE.md「片側を直したら、
   * 対称の反対側を必ず疑う」)。同じ欠陥(hover = marked = `--surface-2`)が
   * こちらにも在った ── dual だけ直すと「1 面のファイラでは乗せた行が印に見える」が残る。
   * ⚠ こちらの印は `td` ではなく `tr` に塗る(行ごと)── 選択子ごと pin する。
   */
  it('🔴 1 面のファイラでも hover は --surface-hover、印は --pkc-mark-bg', () => {
    const hover = blocksFor(
      screenOnly,
      "[data-pkc-region='filer-table'] tbody tr:hover:not([data-pkc-marked]) td",
    );
    expect(hover.length, 'ファイラの hover の規則が無い').toBe(1);
    expect(hover.join(' ')).toContain('var(--surface-hover)');

    const marked = blocksFor(screenOnly, "[data-pkc-region='filer-table'] tbody tr[data-pkc-marked]");
    expect(marked.length, 'ファイラの印の規則が無い').toBe(1);
    expect(marked.join(' ')).toContain('var(--pkc-mark-bg)');

    for (const bare of [
      "[data-pkc-region='filer-table'] tr:hover td",
      "[data-pkc-region='filer-table'] tbody tr:hover td",
    ]) {
      expect(blocksFor(screenOnly, bare), `素の hover 規則が復活している: ${bare}`).toEqual([]);
    }
  });
});
