/** @vitest-environment happy-dom */
/**
 * Word の書き出しで、箇条書き・表のマス・文の途中の画像を**置いた位置のまま**入れる(台帳 #1852 束 A1。#1163 の依頼 142 ②)。
 *
 * 直す前は、画像が囲む塊の上や表の後ろへ移り、箇条書きには空の黒丸、表のマスは空になっていた。
 * 守る主張(対照群を同じ it に置く):
 * 1. 文の途中の画像は同じ段落に入る(前 IMG 後が 1 段落)
 * 2. 画像で始まる項目は、空の黒丸を作らず、その項目の中に入る
 * 3. 表のマスの画像はそのマスの中に入る(表の後ろへ送らない)/ マスの幅・項目の字下げの内側に収まる
 * 4. 解けなかった画像は、その場に理由が出て、注意の件数に数えられる(黙って消えない)
 * 5. 画像だけの段落は寄せを段落に掛ける / 文の途中では寄せない
 * 6. PowerPoint(`inlineImages` を渡さない)は今までどおり塊として分ける
 */
import { describe, expect, it } from 'vitest';
import { buildDocx, type DocxBlock } from '../../src/features/export/docx';
import { htmlToDocxBlocks } from '../../src/adapter/platform/export/html-blocks';

const parse = (html: string): Document => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
const img = (k: string, extra = ''): string => `<img data-pkc-asset-key="${k}" alt="${k}"${extra}>`;

/** 画像を解いた体で入れ物へ書く(呼び側 `export-archive.ts` がやること)。 */
function resolveAll(r: ReturnType<typeof htmlToDocxBlocks>, size = { w: 200, h: 100 }): void {
  r.inlineImages.forEach((ref, j) => {
    ref.holder.media = `media/image${j + 1}.png`;
    ref.holder.widthPx = size.w;
    ref.holder.heightPx = size.h;
  });
}
const docXml = (r: ReturnType<typeof htmlToDocxBlocks>): string =>
  buildDocx(r.blocks, '', '2026-10-18T00:00:00Z', undefined, r.inlineSkipped).parts.find((p) => p.name === 'word/document.xml')!.text;
const paras = (xml: string): string[] => xml.split(/<w:p>|<w:p /).slice(1);

describe('文の途中の画像(依頼 142 ②)', () => {
  it('🔴 前 IMG 後が 1 段落のまま。画像は文の間に入る', () => {
    const r = htmlToDocxBlocks(parse(`<p>前の文 ${img('a')} 後の文</p>`), { inlineImages: true });
    expect(r.blocks.map((b) => b.kind)).toEqual(['p']);
    expect(r.images, '塊の画像として預けた').toEqual([]);
    expect(r.inlineImages).toHaveLength(1);
    resolveAll(r);
    const p = paras(docXml(r)).find((x) => x.includes('前の文'))!;
    expect(p.indexOf('前の文')).toBeLessThan(p.indexOf('<w:pict>'));
    expect(p.indexOf('<w:pict>')).toBeLessThan(p.indexOf('後の文'));
  });

  it('対照: 渡さなければ(PowerPoint)今までどおり前・画像・後の 3 つの塊に分ける', () => {
    const r = htmlToDocxBlocks(parse(`<p>前の文 ${img('a')} 後の文</p>`));
    expect(r.blocks.map((b) => b.kind)).toEqual(['p', 'skipped', 'p']);
    expect(r.images).toHaveLength(1);
    expect(r.inlineImages).toEqual([]);
  });
});

describe('箇条書きの中の画像(依頼 142 ②)', () => {
  it('🔴 画像で始まる項目は、空の黒丸の項目を作らず、その項目の中に入る', () => {
    const r = htmlToDocxBlocks(parse(`<ul><li>${img('a')} 説明</li><li>次</li></ul>`), { inlineImages: true });
    const lis = r.blocks.filter((b): b is Extract<DocxBlock, { kind: 'li' }> => b.kind === 'li');
    expect(lis).toHaveLength(2);
    expect(lis[0]!.runs.some((x) => x.image !== undefined), '画像が最初の項目に入っていない').toBe(true);
    resolveAll(r);
    const xml = docXml(r);
    const first = paras(xml).find((x) => x.includes('<w:numPr>'))!;
    expect(first).toContain('<w:pict>');
    expect(first).toContain('説明');
    // 空の項目(字も画像も無い黒丸の段落)が無い
    expect(paras(xml).filter((x) => x.includes('<w:numPr>') && !x.includes('<w:t ') && !x.includes('<w:pict>'))).toEqual([]);
  });

  it('項目の中の画像は、字下げの内側に収まる(本文幅いっぱいにしない)', () => {
    // 1 段目の項目 = 本文幅 − 字下げ 480 twip。大きな画像(3000px)で上限に当てる
    const r = htmlToDocxBlocks(parse(`<ul><li>${img('a')}</li></ul>`), { inlineImages: true });
    resolveAll(r, { w: 3000, h: 1500 });
    const xml = docXml(r);
    const w = Number(/style="width:([0-9.]+)pt/.exec(xml)![1]);
    const bodyPt = (9638 / 1440) * 72;
    expect(w).toBeLessThan(bodyPt);
    expect(w).toBeCloseTo(bodyPt - 480 / 20, 0);
    // 対照: 本文の段落なら本文幅いっぱい
    const r2 = htmlToDocxBlocks(parse(`<p>${img('a')}</p>`), { inlineImages: true });
    resolveAll(r2, { w: 3000, h: 1500 });
    expect(Number(/style="width:([0-9.]+)pt/.exec(docXml(r2))![1])).toBeCloseTo(bodyPt, 0);
  });
});

describe('表のマスの中の画像(依頼 142 ②)', () => {
  const html = `<table><tr><th>h1</th><th>h2</th></tr><tr><td>x</td><td>y ${img('k1')}</td></tr></table><p>next</p>`;

  it('🔴 画像はそのマスの中に入り、表の後ろへ送らない(添え書きも出ない)', () => {
    const r = htmlToDocxBlocks(parse(html), { inlineImages: true });
    expect(r.blocks.map((b) => b.kind)).toEqual(['table', 'p']);
    resolveAll(r);
    const xml = docXml(r);
    const tbl = xml.slice(xml.indexOf('<w:tbl>'), xml.indexOf('</w:tbl>'));
    expect(tbl).toContain('<w:pict>');
    expect(xml.slice(xml.indexOf('</w:tbl>')), '表の後ろに画像が出た').not.toContain('<w:pict>');
    expect(xml).not.toContain('列目の画像');
  });

  it('マスの幅(2 列なら本文の半分から余白を引いた幅)に収まる', () => {
    const r = htmlToDocxBlocks(parse(html), { inlineImages: true });
    resolveAll(r, { w: 3000, h: 3000 });
    const xml = docXml(r);
    const w = Number(/style="width:([0-9.]+)pt/.exec(xml)![1]);
    expect(w).toBeCloseTo(((Math.floor(9360 / 2) - 216) / 20), 0);
  });

  it('対照: 渡さなければ(PowerPoint)今までどおり表の後ろに「N 行目・M 列目の画像」を添える', () => {
    const r = htmlToDocxBlocks(parse(html));
    expect(r.blocks.map((b) => b.kind)).toEqual(['table', 'p', 'skipped', 'p']);
  });
});

describe('解けなかった画像は黙って消えない(依頼 142 ②)', () => {
  it('🔴 その場に理由の字が出て、注意の件数に数えられる。解けた画像は数えない(対照)', () => {
    const r = htmlToDocxBlocks(parse(`<p>${img('a')} と ${img('b')}</p>`), { inlineImages: true });
    // a は解けた / b は解けなかった(理由つき)
    const [a, b] = r.inlineImages;
    a!.holder.media = 'media/image1.png';
    a!.holder.widthPx = 10;
    a!.holder.heightPx = 10;
    b!.holder.failWhy = '大きさを読めませんでした';
    const built = buildDocx(r.blocks, '', '2026-10-18T00:00:00Z');
    const xml = built.parts.find((p) => p.name === 'word/document.xml')!.text;
    expect(xml).toContain('［画像「b」 は入れられませんでした: 大きさを読めませんでした］');
    expect(xml.match(/<w:pict>/g)).toHaveLength(1);
    expect(built.warnings.join()).toContain('画像「b」 1 件');
    expect(built.warnings.join(), '解けた画像まで数えた').not.toContain('画像「a」');
    expect(built.counts.images).toBe(1);
    expect(built.counts.skipped).toBe(1);
  });

  it('入れ物に何も書かなければ(呼び側が解かなかった)既定の理由で残る', () => {
    const r = htmlToDocxBlocks(parse(`<p>${img('a')}</p>`), { inlineImages: true });
    const xml = docXml(r);
    expect(xml).toContain('は入れられませんでした: 取り出せませんでした');
    expect(xml).not.toContain('<w:pict>');
  });

  it('走りを写して(引用の中の見出しなど)も、解いた結果は写しに届く', () => {
    const r = htmlToDocxBlocks(parse(`<blockquote><h2>題 ${img('a')}</h2></blockquote>`), { inlineImages: true });
    resolveAll(r);
    expect(docXml(r)).toContain('<w:pict>');
  });
});

describe('寄せ(依頼 142 ②と #1640 ③)', () => {
  it('🔴 画像だけの段落は寄せを段落に掛ける。文の途中の画像では掛けない(対照)', () => {
    const only = htmlToDocxBlocks(parse(`<p>${img('a', ' data-pkc-img-align="center"')}</p>`), { inlineImages: true });
    resolveAll(only);
    expect(paras(docXml(only)).find((x) => x.includes('<w:pict>'))).toContain('<w:jc w:val="center"/>');
    const mid = htmlToDocxBlocks(parse(`<p>文 ${img('a', ' data-pkc-img-align="center"')} 文</p>`), { inlineImages: true });
    resolveAll(mid);
    expect(docXml(mid)).not.toContain('<w:jc ');
  });
});
