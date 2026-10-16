/** @vitest-environment happy-dom */
/**
 * 添付の画像が、囲む塊(段落・項目・引用・表)の**前**へ出ない。
 * 直す前は `前 IMG 後` が [画像, 段落(前後)] になり、Word / PowerPoint で画像が先頭に飛んでいた。
 */
import { describe, expect, it } from 'vitest';
import type { DocxBlock } from '@features/export/docx';
import { htmlToDocxBlocks } from '@adapter/platform/export/html-blocks';

const run = (html: string): { blocks: DocxBlock[]; images: { at: number; assetKey: string }[] } => {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const r = htmlToDocxBlocks(doc);
  return { blocks: r.blocks, images: r.images };
};
const text = (b: DocxBlock): string => ('runs' in b ? b.runs.map((x) => x.text).join('') : '');
/** 塊の並びを 1 行で読む(画像の予約は `img:<key>`)。 */
const shape = (blocks: DocxBlock[], images: { at: number; assetKey: string }[]): string[] =>
  blocks.map((b, i) => {
    const im = images.find((x) => x.at === i);
    if (im !== undefined) return `img:${im.assetKey}`;
    if (b.kind === 'li') return `li${b.depth}:${text(b)}`;
    return `${b.kind}:${text(b)}`;
  });
const IMG = '<img data-pkc-asset-key="k1" alt="a">';

describe('添付の画像は置かれた位置の順で出る', () => {
  it('段落の途中: [前, 画像, 後]', () => {
    const { blocks, images } = run(`<p>before ${IMG} after</p>`);
    expect(shape(blocks, images)).toEqual(['p:before', 'img:k1', 'p:after']);
  });

  it('対照群: 画像だけの段落は画像 1 つだけ(空の段落を作らない)', () => {
    const { blocks, images } = run(`<p>${IMG}</p>`);
    expect(shape(blocks, images)).toEqual(['img:k1']);
  });

  it('箇条書きの項目の途中: 続きは同じ階層・同じ一覧の項目で出る', () => {
    const { blocks, images } = run(`<ul><li>x ${IMG} y</li><li>z</li></ul>`);
    expect(shape(blocks, images)).toEqual(['li0:x', 'img:k1', 'li0:y', 'li0:z']);
    const [a, , c, d] = blocks as Extract<DocxBlock, { kind: 'li' }>[];
    expect(c!.list).toBe(a!.list);
    expect(d!.list).toBe(a!.list);
    expect(c!.depth).toBe(a!.depth);
  });

  it('画像だけの項目: 項目の印を残してから画像', () => {
    const { blocks, images } = run(`<ul><li>${IMG}</li></ul>`);
    expect(shape(blocks, images)).toEqual(['li0:', 'img:k1']);
  });

  it('引用の途中: [引用(前), 画像, 引用(後)]', () => {
    const { blocks, images } = run(`<blockquote><p>q1 ${IMG} q2</p></blockquote>`);
    // 引用の中の段落は引用へ置き換わる ── 画像は間に挟まる
    expect(shape(blocks, images)).toEqual(['quote:q1', 'img:k1', 'quote:q2']);
  });

  it('表のセルの中: 画像は表の後ろに出て、セルの字は残る', () => {
    const { blocks, images } = run(
      `<table><tr><th>h</th></tr><tr><td>c ${IMG}</td></tr></table><p>next</p>`,
    );
    const s = shape(blocks, images);
    expect(s[0]).toBe('table:');
    expect(s.slice(1)).toEqual(['img:k1', 'p:next']);
    const t = blocks[0] as Extract<DocxBlock, { kind: 'table' }>;
    expect(t.rows[1]![0]!.runs.map((r) => r.text).join('').trim()).toBe('c');
  });
});
