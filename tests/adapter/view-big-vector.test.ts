/** @vitest-environment happy-dom */
/**
 * 🔴 **拡大窓は、焼いた PNG ではなくベクタを開く**(user 報告 2026-08-28)。
 *
 * > 「別窓で開いた時、ラスタ化された方の画像が開くのは BAD!
 * >  巨大な MerMaid を開いたらぽしょぽしょの図になってしまったよ」
 *
 * 画面の `<img>` は **本文の表示幅 × dpr** で焼いてあるので、拡大窓でそれを開けば
 * 粗い ── とくに段に収めるため縮めた巨大な図ほど粗い。
 *
 * ⚠ ただし**素の SVG をそのまま渡すと別の不具合になる** ── mermaid の SVG は
 * `width="100%"` なので、**`<img>` が読む自然幅は 300px**(`rasterize` の注記の実測値)。
 * 「実寸で開く」窓がそれを実寸だと信じると、**巨大な図が 300px で開く**。
 *
 * 🔑 **期待値は実装と別の観測で組む**(CLAUDE.md §1)── 実装は正規表現で書き換えるので、
 * ここでは **DOM に食わせて属性を読む**(= `<img>` が読むのと同じ経路)。
 * 同じ正規表現をもう一度書くと、実装が間違える形では期待値も同じように間違える。
 */
import { describe, expect, it } from 'vitest';
import { svgWithIntrinsicSize } from '@adapter/ui/render/mermaid-raster';

/** ⚠ 実装の綴りを 1 文字も参照しない読み方(`<img>` と同じく DOM として読む)。 */
const rootAttrs = (svg: string): { w: string | null; h: string | null; viewBox: string | null } => {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  return {
    w: root.getAttribute('width'),
    h: root.getAttribute('height'),
    viewBox: root.getAttribute('viewBox'),
  };
};

describe('拡大窓へ渡す SVG の実寸(user 報告 2026-08-28)', () => {
  /** mermaid が実際に吐く形 ── `width="100%"` + `style` の頭打ち + viewBox。 */
  const MERMAID = [
    '<svg aria-roledescription="flowchart-v2" role="graphics-document document"',
    ' viewBox="0 0 1840 960" style="max-width: 1840px;" width="100%" id="pkc3-mmd-1"',
    ' xmlns="http://www.w3.org/2000/svg"><g><rect/></g></svg>',
  ].join('');

  it('🔴 `width="100%"` を viewBox の実寸に置き換える(でないと 300px で開く)', () => {
    const a = rootAttrs(MERMAID);
    // ⚠ **前提の検算** ── 直す前の形が本当に「% 指定」であること
    expect(a.w, '前提が崩れている ── 元から数値なら、この直しは要らない').toBe('100%');

    const out = rootAttrs(svgWithIntrinsicSize(MERMAID));
    expect(out.w, '幅が viewBox の実寸になっていない').toBe('1840');
    expect(out.h, '高さが viewBox の実寸になっていない').toBe('960');
    // 🔑 viewBox は**残す**(消すと拡大時の座標系が壊れる)
    expect(out.viewBox, 'viewBox を落としている').toBe('0 0 1840 960');
  });

  it('⚠ viewBox が読めない図は 1 バイトも触らない(壊すより渡すほうが安全)', () => {
    const NO_BOX = '<svg xmlns="http://www.w3.org/2000/svg" width="100%"><g/></svg>';
    expect(svgWithIntrinsicSize(NO_BOX), '触ってはいけない図を書き換えた').toBe(NO_BOX);
  });

  it('⚠ 既に実寸を持つ図は、その値が viewBox に揃う(二重指定を残さない)', () => {
    const SIZED =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20" viewBox="0 0 300 150"><g/></svg>';
    const out = rootAttrs(svgWithIntrinsicSize(SIZED));
    expect(out.w, '古い width が残っている').toBe('300');
    expect(out.h, '古い height が残っている').toBe('150');
  });

  it('⚠ 中に入れ子の `<svg>` があっても、根だけを直す', () => {
    const NESTED =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="100%">' +
      '<svg width="100%" viewBox="0 0 5 5"><g/></svg></svg>';
    const out = svgWithIntrinsicSize(NESTED);
    expect(rootAttrs(out).w, '根が直っていない').toBe('400');
    // 🔑 入れ子はそのまま(根だけを触る)
    expect(out, '入れ子まで書き換えている').toContain('<svg width="100%" viewBox="0 0 5 5">');
  });
});
