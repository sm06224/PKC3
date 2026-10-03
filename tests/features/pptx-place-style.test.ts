/** @vitest-environment happy-dom */
/**
 * 🔴 **付箋と線の色・太さが PowerPoint へそのまま写る**(#530 段④。Gemini 裁定 A、2026-10-02)。
 *
 * 見るのは**生成物の XML**(どの部品にどの字が入ったか)。⚠ 材料は 2 通り:
 * - 本文(markdown)→ 画面と同じ HTML → 塊 → `.pptx`(**通して**見る。手で塊を組むと、
 *   HTML から色を拾う側(`html-blocks.ts`)を 1 度も通らない)
 * - 塊を直に組む(読めない綴りが書き出しの XML へ漏れないことを見る)
 *
 * 🔑 **色なしは 1 byte も変わらない**ことが主張の半分である(対照群を同じ it に置く)。
 */
import { describe, expect, it } from 'vitest';
import { htmlToDocxBlocks } from '@adapter/platform/export/html-blocks';
import { buildPptx, type ExportBlock } from '@features/export/pptx';
import { renderMarkdown } from '@features/markdown/markdown-render';

const slideOf = (blocks: readonly ExportBlock[]): string => {
  const r = buildPptx(blocks, { title: 'T' });
  const hit = r.parts.find((x) => x.name === 'ppt/slides/slide1.xml');
  expect(hit, 'slide1.xml が無い').toBeTruthy();
  return hit!.text;
};

const fromMarkdown = (md: string): string => {
  const doc = new DOMParser().parseFromString(`<body>${renderMarkdown(md)}</body>`, 'text/html');
  return slideOf(htmlToDocxBlocks(doc).blocks);
};

const BOARD = (extra = '', lineExtra = ''): string =>
  [
    `:::format{#a .pkc-place x=0 y=0 w=200 h=100${extra}}`,
    '左',
    ':::',
    '',
    ':::format{#b .pkc-place x=400 y=0 w=200 h=100}',
    '右',
    ':::',
    '',
    `:::format{.pkc-line from=a to=b${lineExtra}}`,
    ':::',
    '',
  ].join('\n');

/** 付箋(`<p:sp>`)のうち、題名の箱でないもの。 */
const boardSps = (xml: string): string[] =>
  [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).filter((s) => s.includes('付箋'));
const cxnOf = (xml: string): string => /<p:cxnSp>[\s\S]*?<\/p:cxnSp>/.exec(xml)![0];

describe('付箋の塗りと枠', () => {
  it('🔴 fill= が <a:solidFill> に、stroke= が <a:ln> の <a:solidFill> に入る', () => {
    const xml = fromMarkdown(BOARD(' fill=#ffe08a stroke=#b45309'));
    const [a] = boardSps(xml);
    expect(a, '付箋が出ていない').toBeTruthy();
    expect(a).toContain('<a:solidFill><a:srgbClr val="FFE08A"/></a:solidFill>');
    expect(a).toContain('<a:ln w="9525"><a:solidFill><a:srgbClr val="B45309"/></a:solidFill></a:ln>');
    // 塗りが付いたので noFill ではない(spPr の中)
    expect(a!.split('</a:prstGeom>')[1]!.split('</p:spPr>')[0]).not.toContain('<a:noFill/>');
  });

  it('🔴 塗りの上の字は塗りの明るさに合わせる(明るい塗り → 暗い字 / 暗い塗り → 白い字)', () => {
    const light = boardSps(fromMarkdown(BOARD(' fill=#ffe08a')))[0]!;
    expect(light).toMatch(/<a:rPr [^>]*><a:solidFill><a:srgbClr val="1A1A1A"\/><\/a:solidFill>/);
    const dark = boardSps(fromMarkdown(BOARD(' fill=#1e3a8a')))[0]!;
    expect(dark).toMatch(/<a:rPr [^>]*><a:solidFill><a:srgbClr val="FFFFFF"\/><\/a:solidFill>/);
    // 対照群: 塗りが無ければ字に色を足さない
    expect(boardSps(fromMarkdown(BOARD()))[0]).not.toMatch(/<a:rPr [^>]*><a:solidFill>/);
  });

  it('🔴 色なしの付箋は今までと 1 byte も変わらない(対照群: 色ありと並べて、色なしの側を見る)', () => {
    const plain = fromMarkdown(BOARD());
    const colored = fromMarkdown(BOARD(' fill=#ffe08a stroke=#b45309'));
    expect(colored, '色を付けたのに XML が同じ(色が落ちている)').not.toBe(plain);
    const [, b] = boardSps(colored);
    const [, bPlain] = boardSps(plain);
    // 色を付けていない 2 枚目は、色あり側の XML の中でも色なし側と同じ
    expect(b).toBe(bPlain);
    expect(bPlain).toContain('<a:noFill/>');
    expect(bPlain).not.toContain('<a:ln w=');
    expect(bPlain).not.toContain('<a:solidFill>');
  });

  it('🔴 読めない綴り(`javascript:` / 色の名前)は XML へ出ない(= 色なしと 1 byte も違わない)', () => {
    const plain = fromMarkdown(BOARD());
    for (const bad of [' fill=javascript:alert(1)', ' fill=red', ' stroke=url(x)', ' fill=#12']) {
      expect(fromMarkdown(BOARD(bad)), bad).toBe(plain);
    }
  });

  it('🔴 塊を直に組んで読めない字を渡しても、XML へ流さない(書き出しの側でも検める)', () => {
    const xml = slideOf([
      {
        kind: 'place', x: 0, y: 0, w: 200, h: 100, shape: 'rect', name: null, span: 1,
        fill: '"/><a:evil/>', stroke: 'red',
      },
      { kind: 'p', runs: [{ text: '中身' }] },
    ]);
    expect(xml).not.toContain('evil');
    expect(xml).not.toContain('val="red"');
  });

  it('🔴 形のある付箋(ひし形)にも塗りと枠が入り、図形名は変わらない', () => {
    const xml = fromMarkdown(BOARD(' shape=diamond fill=#ffe08a stroke=#112233'));
    const a = boardSps(xml)[0]!;
    expect(a).toContain('prst="diamond"');
    expect(a).toContain('<a:srgbClr val="FFE08A"/>');
    expect(a).toContain('<a:srgbClr val="112233"/>');
    expect(a, '色を付けたのに既定の灰色の縁が残っている').not.toContain('808080');
  });
});

describe('線の色と太さ', () => {
  it('🔴 stroke= / width= が <a:ln w=太さ(EMU)> + <a:solidFill> に入る', () => {
    const c = cxnOf(fromMarkdown(BOARD('', ' stroke=#2563eb width=4')));
    expect(c).toContain('<a:ln w="38100"><a:solidFill><a:srgbClr val="2563EB"/></a:solidFill></a:ln>');
  });

  it('🔴 色なし・太さなしの線は今までと同じ(808080 / 19050)', () => {
    const c = cxnOf(fromMarkdown(BOARD()));
    expect(c).toContain('<a:ln w="19050"><a:solidFill><a:srgbClr val="808080"/></a:solidFill></a:ln>');
  });

  it('🔴 色だけ・太さだけでも、書いていない側は既定のまま', () => {
    expect(cxnOf(fromMarkdown(BOARD('', ' stroke=#2563eb')))).toContain(
      '<a:ln w="19050"><a:solidFill><a:srgbClr val="2563EB"/>',
    );
    expect(cxnOf(fromMarkdown(BOARD('', ' width=1')))).toContain(
      '<a:ln w="9525"><a:solidFill><a:srgbClr val="808080"/>',
    );
  });

  it('🔴 読めない綴り(色の名前 / 範囲外の太さ)は既定へ倒れる', () => {
    const plain = fromMarkdown(BOARD());
    expect(fromMarkdown(BOARD('', ' stroke=red width=99'))).toBe(plain);
    expect(fromMarkdown(BOARD('', ' width=0'))).toBe(plain);
  });

  it('🔴 繋がったまま(stCxn / endCxn)は色を付けても外れない', () => {
    const c = cxnOf(fromMarkdown(BOARD('', ' stroke=#2563eb width=4')));
    expect(c).toContain('<a:stCxn');
    expect(c).toContain('<a:endCxn');
  });
});
