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
import { THEMES } from '../../src/adapter/ui/render/theme';

/** 注釈を剥ぐ ── 剥がないと直前の注釈が選択子の一部として拾われる。 */
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

const TOKENS = strip(readFileSync('src/styles/tokens.css', 'utf-8'));

/** `選択子 { 宣言 }` を全部読み、選択子に `sel` を含むブロックの宣言を返す。 */
function blocksFor(css: string, sel: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1]!.split(',').map((x) => x.trim().replace(/\s+/g, ' '));
    if (sels.includes(sel)) out.push(m[2]!);
  }
  return out;
}

/** テーマ 1 つぶんの配色トークンを読む。無ければ undefined(呼び手が落とす)。 */
function token(theme: string, name: string): string | undefined {
  const decls = blocksFor(TOKENS, `:root[data-pkc-theme='${theme}']`).join(';');
  // ⚠ CSS は**後勝ち** ── 同名の宣言が重複したら、実行時に効くのは最後の 1 本。
  //   最初の一致を読むと「先頭は正しく、末尾で上書き」の変異が素通りする
  //   (着地前レビュー ⚠-2)
  const hits = [
    ...decls.matchAll(new RegExp(`(?:^|;)\\s*${name}:\\s*(#[0-9a-f]{6})\\s*(?:;|$)`, 'gi')),
  ];
  return hits.at(-1)?.[1];
}

const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

describe('2 ペインの行: hover と印(marked)の色(#312 ①)', () => {
  // ⚠ 空振り防止 ── テーマの数え上げは選択画面の一覧(THEMES)と突き合わせる。
  //   tokens.css を数え直すと「両方から消えた」を見逃す(docs-parity が 1 対 1 を守る)
  it('前提: テーマが 9 つ在る(減ったらこの test の走査範囲も減っている)', () => {
    expect(THEMES.length).toBe(9);
  });

  it('🔴 --surface-hover が全テーマに定義されている(欠けたテーマだけ hover が消える)', () => {
    for (const t of THEMES) {
      expect(token(t.id, '--surface-hover'), `${t.id}: --surface-hover が無い`).toBeTruthy();
    }
  });

  it('🔴 どのテーマでも hover ≠ marked(乗せただけの行が、印を付けた行に見えない)', () => {
    for (const t of THEMES) {
      const hover = token(t.id, '--surface-hover')!;
      const marked = token(t.id, '--surface-2')!;
      // ⚠ 文字列で比べない ── `#23282D` と `#23282d` は別の文字列だが**同じ色**である
      //   (着地前レビュー ⚠-1。文字列比較だと大文字 hex の同値が素通りする)
      expect(rgb(hover), `${t.id}: hover と印が同じ色(2026-08-19 に直り損ねた症状)`).not.toEqual(
        rgb(marked),
      );
    }
  });

  it('🔴 hover の明度は --surface と --surface-2 の間(「もっと薄い地」)', () => {
    for (const t of THEMES) {
      const s = rgb(token(t.id, '--surface')!);
      const s2 = rgb(token(t.id, '--surface-2')!);
      const h = rgb(token(t.id, '--surface-hover')!);
      // ⚠ 明るいテーマは surface > surface-2、暗いテーマは逆 ── 向きに依らず
      //   「各成分が両端の間」で見る(間なら明度も必ず間にある)
      for (let c = 0; c < 3; c++) {
        const lo = Math.min(s[c]!, s2[c]!);
        const hi = Math.max(s[c]!, s2[c]!);
        expect(
          h[c]! >= lo && h[c]! <= hi,
          `${t.id}: hover の成分 ${c} が --surface と --surface-2 の間に無い`,
        ).toBe(true);
      }
      expect(h, `${t.id}: hover が --surface と同じ(乗せても何も見えない)`).not.toEqual(s);
    }
  });
});

/**
 * `@media` ブロックを**構文で**取り除く(入れ子の brace を数えて対応する閉じまで)。
 *
 * ⚠ 「最初の `@media` で切る」では足りない ── app.css は `@media` 群の**後にも**
 *   素の規則が続く(filer の印の規則は媒体クエリより後に在り、切ると見えなくなる
 *   ── この test の 1 稿目が実際にそれで「規則が無い」と誤答した)。
 * ⚠ 中まで拾わない理由は従来どおり: 印刷や狭い版面だけの規則で
 *   「画面の規則を消しても緑」になる。
 */
function withoutMedia(css: string): string {
  let out = css;
  for (let at = out.indexOf('@media'); at !== -1; at = out.indexOf('@media')) {
    const open = out.indexOf('{', at);
    expect(open, '@media に { が無い(構文が壊れている)').toBeGreaterThan(-1);
    let depth = 1;
    let i = open + 1;
    for (; i < out.length && depth > 0; i++) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}') depth--;
    }
    expect(depth, '@media の閉じ } が無い(構文が壊れている)').toBe(0);
    out = out.slice(0, at) + out.slice(i);
  }
  return out;
}

describe('app.css の規則(hover が --surface-hover を使い、印を塗り直さない)', () => {
  const css = strip(readFileSync('src/styles/app.css', 'utf-8'));
  const screenOnly = withoutMedia(css);

  it('🔴 hover の規則が --surface-hover を使っている', () => {
    const hit = blocksFor(
      screenOnly,
      "[data-pkc-region='dual-table'] tbody tr:hover:not([data-pkc-marked]) td",
    );
    expect(hit.length, 'hover の規則が無い(選択子が変わったならこの test も追随する)').toBe(1);
    expect(hit.join(' ')).toContain('var(--surface-hover)');
  });

  it('🔴 印(marked)の規則は --surface-2 のまま', () => {
    const hit = blocksFor(screenOnly, "[data-pkc-region='dual-table'] tbody tr[data-pkc-marked] td");
    expect(hit.length, '印の規則が無い').toBe(1);
    expect(hit.join(' ')).toContain('var(--surface-2)');
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
  it('🔴 1 面のファイラでも hover は --surface-hover、印は --surface-2', () => {
    const hover = blocksFor(
      screenOnly,
      "[data-pkc-region='filer-table'] tbody tr:hover:not([data-pkc-marked]) td",
    );
    expect(hover.length, 'ファイラの hover の規則が無い').toBe(1);
    expect(hover.join(' ')).toContain('var(--surface-hover)');

    const marked = blocksFor(screenOnly, "[data-pkc-region='filer-table'] tbody tr[data-pkc-marked]");
    expect(marked.length, 'ファイラの印の規則が無い').toBe(1);
    expect(marked.join(' ')).toContain('var(--surface-2)');

    for (const bare of [
      "[data-pkc-region='filer-table'] tr:hover td",
      "[data-pkc-region='filer-table'] tbody tr:hover td",
    ]) {
      expect(blocksFor(screenOnly, bare), `素の hover 規則が復活している: ${bare}`).toEqual([]);
    }
  });
});
