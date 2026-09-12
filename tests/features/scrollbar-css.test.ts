/**
 * 🔴 **スクロールバーの見え方を CSS 面で pin する**(#858。user 裁定 2026-09-12
 * 「**細い 6px / 常に見える**」── 掴める幅は 14px のまま)。
 *
 * ⚠ 直す前は**スクロールバーを触る CSS が 1 行も無く**、スクロールする面が全部
 * OS の既定で描かれていた。つまりこの主張の実体は **CSS の字面**なので、ここで pin する。
 *
 * 🔴 **いちばん守りたいのは「標準プロパティが `@supports` の中に在ること」**である ──
 * Chromium は `scrollbar-width` / `scrollbar-color` が既定以外なら
 * **`::-webkit-scrollbar` の指定を丸ごと無視する**ので、素で書くと
 * 「見える 6px / 掴める 14px」が**静かに死ぬ**(見た目は「細いバー」なので気づけない)。
 * ⚠ だから「在るか」ではなく「**どこに在るか**」を見る(`withoutAtRule` で外を作る)。
 *
 * 🔑 **太さは 2 か所に書かない** ── CSS から読んだ数字で
 * 「見える太さ = 帯の幅 − 枠 × 2」を**計算して**比べる。枠を 3px にした日に
 * 「見える太さが 8px になった」で落ちる(裁定は 6px と 10px である)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutAtRule } from '../helpers/css-blocks';

const CSS = stripComments(readFileSync('src/styles/app.css', 'utf8'));

/** 宣言から `<prop>: <n>px` の数値を採る(無ければ null)。 */
function px(declarations: string, prop: string): number | null {
  const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*(\\d+)px`).exec(declarations);
  return m === null ? null : Number(m[1]);
}

describe('🔴 スクロールバー(#858)', () => {
  it('帯は 14px(押し所)、地は透明', () => {
    const bar = blocksFor(CSS, '::-webkit-scrollbar');
    expect(bar).toHaveLength(1); // 空振り防止:読めていること
    expect(px(bar[0]!, 'width')).toBe(14);
    expect(px(bar[0]!, 'height')).toBe(14);

    const track = blocksFor(CSS, '::-webkit-scrollbar-track');
    expect(track).toHaveLength(1);
    expect(track[0]!).toMatch(decl('background', 'transparent'));
  });

  it('🔴 見える太さは 6px ── 帯の幅と枠から**計算して**確かめる', () => {
    const bar = blocksFor(CSS, '::-webkit-scrollbar');
    const thumb = blocksFor(CSS, '::-webkit-scrollbar-thumb');
    expect(thumb).toHaveLength(1);
    const width = px(bar[0]!, 'width');
    const ring = px(thumb[0]!, 'border');
    expect(width).not.toBeNull();
    expect(ring).not.toBeNull();
    // 🔑 枠の内側だけ塗るので、見えるのは「幅 − 枠 × 2」
    expect(width! - ring! * 2).toBe(6);
    // ⚠ この 1 行が無いと枠の内側だけ塗られず、**14px の帯がべた塗り**になる
    expect(thumb[0]!).toMatch(decl('background-clip', 'padding-box'));
    expect(thumb[0]!).toMatch(decl('border', '\\d+px solid transparent'));
  });

  it('乗せると 10px に見える(押し所は 14px のまま)', () => {
    const bar = blocksFor(CSS, '::-webkit-scrollbar');
    const hov = blocksFor(CSS, '*:hover::-webkit-scrollbar-thumb');
    expect(hov).toHaveLength(1); // 選択子リストに**丸ごと**在ること
    const ring = px(hov[0]!, 'border-width');
    expect(ring).not.toBeNull();
    expect(px(bar[0]!, 'width')! - ring! * 2).toBe(10);
    // ⚠ 面を乗せたときと、つまみ自身を乗せたときの**両方**を同じ規則が受ける
    expect(blocksFor(CSS, '::-webkit-scrollbar-thumb:hover')).toHaveLength(1);
  });

  it('色は token から採る(9 テーマで初期値へ落ちないため)', () => {
    const thumb = blocksFor(CSS, '::-webkit-scrollbar-thumb')[0]!;
    const hov = blocksFor(CSS, '*:hover::-webkit-scrollbar-thumb')[0]!;
    expect(thumb).toMatch(decl('background-color', 'var\\(--border\\)'));
    expect(hov).toMatch(decl('background-color', 'var\\(--muted\\)'));
    // 🔴 直値の色を書いていない(テーマを跨いだ日に 1 つだけ浮く)
    expect(thumb + hov).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('🔴 標準プロパティは `@supports` の**中だけ**に在る(外に在ると Chromium で 6/14 が死ぬ)', () => {
    // ① 中に在る
    const inside = blocksFor(CSS, 'html').filter((b) => /scrollbar-(width|color)/.test(b));
    expect(inside).toHaveLength(1);
    expect(inside[0]!).toMatch(decl('scrollbar-width', 'thin'));
    expect(inside[0]!).toMatch(decl('scrollbar-color', 'var\\(--border\\) transparent'));

    // ② 🔴 外には 1 件も無い(`@supports` を構文で取り除いてから数える)
    const outside = withoutAtRule(CSS, 'supports');
    expect(outside).not.toMatch(/scrollbar-width/);
    expect(outside).not.toMatch(/scrollbar-color/);
    // ⚠ 空振り防止:取り除く前には在る(= 走査が効いている)
    expect(CSS).toMatch(/scrollbar-width/);
    // ⚠ そして取り除いたのは `@supports` だけで、素の規則は残っている
    expect(outside).toMatch(/::-webkit-scrollbar-thumb/);
  });

  it('Firefox 向けの条件は `-moz-appearance` で切ってある', () => {
    expect(CSS).toMatch(/@supports \(-moz-appearance: none\)/);
  });
});
