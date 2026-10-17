/** @vitest-environment happy-dom */
/**
 * 🔴 **本文の ` ```svg ` の囲みは、Word・PowerPoint に絵として入る**(#1163 依頼 235。Gemini の裁定:
 * `svg` の囲みは絵にして書き出す / `html` の囲みは今までどおり 1 行の案内)。
 *
 * 画面の物語:本文に ` ```svg ` で描いた図を Word に書き出すと、図は「埋め込み枠 / 書き出したファイルでは動きません」の
 * 1 行になって消えていた。いまは図として入る。
 *
 * 守る主張:
 * 1. 取り出す字: 根が `<svg>` の囲みだけ。xmlns が無ければ足す。文や script が混ざる囲み・途中で切れた囲みは絵にしない
 * 2. 塊の列: svg の囲みは `figures` に原文つきで預けられ、「埋め込み枠」の案内は出ない。` ```html ` は今までどおり案内の 1 行
 * 3. 日本語(全角)の字を含む svg でも原文が崩れない
 */
import { describe, expect, it } from 'vitest';
import { svgFenceSource } from '@features/export/svg-fence';
import { htmlToDocxBlocks } from '@adapter/platform/export/html-blocks';
import { renderMarkdown } from '@features/markdown/markdown-render';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>';

describe('svgFenceSource(取り出す字)', () => {
  it('根が svg ならそのまま(前後の空白は落とす)', () => {
    expect(svgFenceSource(`\n  ${SVG}\n`)).toBe(SVG);
  });

  it('xmlns が無ければ足す(画像として読み込むときに要る)', () => {
    const got = svgFenceSource('<svg width="4" height="4"><rect/></svg>');
    expect(got).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect/></svg>');
  });

  it('xml 宣言・注釈が前に在ってもよい', () => {
    const src = `<?xml version="1.0"?>\n<!-- 図 -->\n${SVG}`;
    expect(svgFenceSource(src)).toBe(src);
  });

  it('日本語(全角)の字を含んでも崩れない', () => {
    const src = '<svg xmlns="http://www.w3.org/2000/svg"><text x="1" y="9">全角ＡＢＣ　図</text></svg>';
    expect(svgFenceSource(src)).toBe(src);
  });

  it('🔴 絵にできない物は null(黙って一部だけ入れない)', () => {
    expect(svgFenceSource('説明文\n' + SVG), '前に文が在る').toBeNull();
    expect(svgFenceSource(SVG + '\n<p>あと</p>'), '後ろに別の物が在る').toBeNull();
    expect(svgFenceSource('<svg width="4"><rect/>'), '途中で切れている').toBeNull();
    expect(svgFenceSource('<div>' + SVG + '</div>'), '根が svg でない').toBeNull();
    expect(svgFenceSource(''), '空').toBeNull();
    expect(svgFenceSource('<svgfoo></svgfoo>'), 'svg で始まる別の名前').toBeNull();
  });

  it('自己閉じの根は閉じタグ無しでも絵にできる', () => {
    expect(svgFenceSource('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>')).not.toBeNull();
  });
});

const parse = (md: string) => htmlToDocxBlocks(new DOMParser().parseFromString(`<body>${renderMarkdown(md)}</body>`, 'text/html'));

describe('Word・PowerPoint の塊の列(2)', () => {
  it('🔴 ```svg の囲みは図として預けられ、「埋め込み枠」の案内が出ない', () => {
    const r = parse('前\n\n```svg\n' + SVG + '\n```\n\n後');
    expect(r.figures, '図として預けられていない').toHaveLength(1);
    expect(r.figures[0]!.kind).toBe('svg');
    expect(r.figures[0]!.source).toBe(SVG);
    expect(r.blocks.some((b) => b.kind === 'skipped' && b.what === '埋め込み枠'), '案内の 1 行が残っている').toBe(false);
    // 預けた場所は図の置き場(焼けなければ「描けませんでした」の行になる ── 黙って消えない)
    const at = r.figures[0]!.at;
    expect(r.blocks[at]).toMatchObject({ kind: 'skipped', what: '図', why: '描けませんでした' });
    // 原文の字(<svg …>)が等幅の文字として本文に混ざらない
    const text = JSON.stringify(r.blocks);
    expect(text).not.toContain('<rect');
  });

  it('🔴 日本語の字を含む ```svg も原文のまま預かる', () => {
    const src = '<svg xmlns="http://www.w3.org/2000/svg"><text x="1" y="9">全角ＡＢＣ</text></svg>';
    expect(parse('```svg\n' + src + '\n```').figures[0]!.source).toBe(src);
  });

  it('対照群: ```html は今までどおり案内の 1 行(絵にしない)', () => {
    const r = parse('```html\n<p>hi</p>\n```');
    expect(r.figures).toHaveLength(0);
    expect(r.blocks.some((b) => b.kind === 'skipped' && b.what === '埋め込み枠')).toBe(true);
  });

  it('対照群: 根が svg でない ```svg(文が混ざる)も、今までどおり案内の 1 行', () => {
    const r = parse('```svg\n説明\n' + SVG + '\n```');
    expect(r.figures).toHaveLength(0);
    expect(r.blocks.some((b) => b.kind === 'skipped' && b.what === '埋め込み枠')).toBe(true);
  });

  it('対照群: mermaid の図は今までどおり mermaid として預かる', () => {
    const r = parse('```mermaid\ngraph TD\n A-->B\n```');
    expect(r.figures.map((f) => f.kind)).toEqual(['mermaid']);
  });
});
