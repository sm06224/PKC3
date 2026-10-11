/**
 * 🔴 **PowerPoint のスライドを板へ戻す**(#530 C)── 書き出しとの往復。
 *
 * 守る主張:
 * 1. 🔴 **書き出した板を読み戻すと、枠の数・位置・大きさ・形・色が元と同じ**(丸め誤差の範囲)。
 *    ⚠ 期待値は**書き出しに渡した値**から作る(読み戻した値から作らない ── §1.10)。
 * 2. 線は**繋ぎ先・辺・通り方**まで戻る(名前は付け直される)。
 * 3. 🔴 **戻せなかったものは件数で数える** ── 図・表・グループ・両端の無い線。0 を返す実装を殺す。
 * 4. 他アプリの file(題名の図形が無い / 色名 / 知らない図形名)は壊さず読めた範囲だけ。
 */
import { describe, expect, it } from 'vitest';
import { buildPptx, type ExportBlock } from '@features/export/pptx';
import { pptxSlideNames, readPptxSlide, isPptxFileName } from '@features/import/pptx-board';
import type { PlaceShape } from '@features/markdown/place-shape';

const p = (text: string): ExportBlock => ({ kind: 'p', runs: [{ text }] });
const place = (
  x: number,
  y: number,
  w: number | null,
  h: number | null,
  span: number,
  shape: PlaceShape = 'rect',
  name: string | null = null,
  extra: { fill?: string; stroke?: string } = {},
): ExportBlock => ({ kind: 'place', x, y, w, h, shape, name, span, ...extra });
const pline = (
  from: string,
  to: string,
  fromAnchor: string | null = null,
  toAnchor: string | null = null,
  route: string | null = null,
  extra: { stroke?: string; width?: number } = {},
): ExportBlock => ({ kind: 'place-line', from, to, fromAnchor, toAnchor, route, ...extra });

const slideOf = (blocks: readonly ExportBlock[], n = 1): string => {
  const r = buildPptx(blocks, { title: 'T' });
  const part = r.parts.find((x) => x.name === `ppt/slides/slide${n}.xml`);
  expect(part, `スライド ${n} が無い`).toBeTruthy();
  return part!.text;
};

interface Placed { x: number; y: number; w: number; h: number; attrs: string }
/** 読み戻した本文の板の塊を、開き行の札から引く。 */
const placesOf = (body: string): Placed[] =>
  [...body.matchAll(/^:::format\{([^}]*\.pkc-place[^}]*)\}$/gm)].map((m) => {
    const a = m[1]!;
    const n = (k: string): number => Number(new RegExp(`(?:^|\\s)${k}=(\\d+)`).exec(a)![1]);
    return { x: n('x'), y: n('y'), w: n('w'), h: n('h'), attrs: a };
  });
const linesOf = (body: string): string[] =>
  [...body.matchAll(/^:::format\{([^}]*\.pkc-line[^}]*)\}$/gm)].map((m) => m[1]!);

const TOL = 1; // px。EMU → px の丸め

describe('🔴 書き出した板を読み戻すと、元と同じ位置・大きさになる(#530 C)', () => {
  const SRC = [
    { x: 0, y: 0, w: 240, h: 96, t: '左上' },
    { x: 320, y: 40, w: 200, h: 120, t: '中' },
    { x: 100, y: 300, w: 180, h: 80, t: '下' },
  ];
  const blocks: ExportBlock[] = SRC.flatMap((s) => [place(s.x, s.y, s.w, s.h, 1), p(s.t)]);

  it('🔴 枠の数と、各枠の x / y / w / h が元と一致する(換算を外すと落ちる)', () => {
    const got = readPptxSlide(slideOf(blocks));
    const ps = placesOf(got.body);
    // 空振り防止 ── 0 枚なら以下の検査は何も見ていない
    expect(ps.length).toBe(SRC.length);
    expect(got.placed).toBe(SRC.length);
    SRC.forEach((s, i) => {
      expect(Math.abs(ps[i]!.x - s.x), `x[${i}]`).toBeLessThanOrEqual(TOL);
      expect(Math.abs(ps[i]!.y - s.y), `y[${i}]`).toBeLessThanOrEqual(TOL);
      expect(Math.abs(ps[i]!.w - s.w), `w[${i}]`).toBeLessThanOrEqual(TOL);
      expect(Math.abs(ps[i]!.h - s.h), `h[${i}]`).toBeLessThanOrEqual(TOL);
    });
    expect(got.dropped).toBe(0);
    // 中身の字も戻る
    expect(got.body).toContain('左上');
    expect(got.body).toContain('下');
  });

  it('🔴 板の原点が 0 でなくても(左上が 40,40)絶対位置が戻る', () => {
    const got = readPptxSlide(slideOf([place(40, 40, 200, 100, 1), p('a'), place(300, 200, 200, 100, 1), p('b')]));
    const ps = placesOf(got.body);
    expect(ps.length).toBe(2);
    // 逆算が効いていれば 40 のまま。相対位置へ倒れていたら 0 になる
    expect(Math.abs(ps[0]!.x - 40)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(ps[0]!.y - 40)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(ps[1]!.x - 300)).toBeLessThanOrEqual(TOL);
  });

  it('題名の見出しが直前にあれば、それがノートの題名になる(板の枠にはならない)', () => {
    const got = readPptxSlide(slideOf([{ kind: 'h', level: 2, runs: [{ text: '体制図' }] }, place(10, 10, 200, 100, 1), p('x')]));
    expect(got.title).toBe('体制図');
    expect(placesOf(got.body).length).toBe(1);
    // 題名を板の枠にしていたら 2 になる
    expect(got.placed).toBe(1);
  });

  it('形と色が戻る(書き出しの表を裏返す)', () => {
    const shapes: PlaceShape[] = ['round', 'ellipse', 'diamond', 'arrow'];
    const bl = shapes.flatMap((s, i) => [place(i * 260, 0, 240, 96, 1, s, null, i === 0 ? { fill: '#ffcc00', stroke: '#112233' } : {}), p(s)]);
    const got = readPptxSlide(slideOf(bl));
    const ps = placesOf(got.body);
    expect(ps.length).toBe(4);
    shapes.forEach((s, i) => expect(ps[i]!.attrs, s).toContain(`shape=${s}`));
    expect(ps[0]!.attrs).toContain('fill=#ffcc00');
    expect(ps[0]!.attrs).toContain('stroke=#112233');
    // 色なしの付箋に、書き出しが引いた灰色の縁を色として足さない
    expect(ps[1]!.attrs).not.toContain('stroke=');
    expect(ps[1]!.attrs).not.toContain('fill=');
  });

  it('🔴 線の繋ぎ先・辺・通り方が戻る。名前は付け直され、本文の中で閉じている', () => {
    const bl = [
      place(0, 0, 200, 100, 1, 'rect', 'a'), p('はじめ'),
      place(400, 0, 200, 100, 1, 'ellipse', 'b'), p('判断'),
      pline('a', 'b', 'right', 'left', 'elbow', { stroke: '#cc0000', width: 4 }),
    ];
    const got = readPptxSlide(slideOf(bl));
    expect(got.lines).toBe(1);
    const ls = linesOf(got.body);
    expect(ls.length).toBe(1);
    expect(ls[0]).toContain('from=板1:right');
    expect(ls[0]).toContain('to=板2:left');
    expect(ls[0]).toContain('route=elbow');
    expect(ls[0]).toContain('stroke=#cc0000');
    expect(ls[0]).toContain('width=4');
    // 指された板に名前が付いている(付いていないと線はどこも指さない)
    const ps = placesOf(got.body);
    expect(ps[0]!.attrs).toContain('#板1');
    expect(ps[1]!.attrs).toContain('#板2');
    expect(got.dropped).toBe(0);
  });

  it('色も通り方も無い線は、余計な札を足さない', () => {
    const got = readPptxSlide(slideOf([
      place(0, 0, 200, 100, 1, 'rect', 'a'), p('A'),
      place(400, 0, 200, 100, 1, 'rect', 'b'), p('B'),
      pline('a', 'b', 'right', 'left'),
    ]));
    const l = linesOf(got.body)[0]!;
    expect(l).not.toContain('route=');
    expect(l).not.toContain('stroke=');
    expect(l).not.toContain('width=');
  });
});

describe('🔴 戻せなかったものは件数で数える(黙って捨てない)', () => {
  const wrap = (inner: string): string =>
    '<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p" xmlns:r="r"><p:cSld><p:spTree>'
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
    + `${inner}</p:spTree></p:cSld></p:sld>`;
  const sp = (id: number, x: number, y: number, prst = 'rect', text = 't'): string =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="1905000" cy="952500"/></a:xfrm>`
    + `<a:prstGeom prst="${prst}"/></p:spPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;

  it('図・表・グループを 1 つずつ数える', () => {
    const xml = wrap(
      sp(2, 0, 0)
      + '<p:pic><p:nvPicPr/></p:pic><p:graphicFrame/><p:grpSp/><p:graphicFrame/>',
    );
    const got = readPptxSlide(xml);
    expect(got.placed).toBe(1);
    expect(got.dropped).toBe(4);
  });

  it('位置を持たない図形と、両端が解決できない線を数える', () => {
    const noPos = '<p:sp><p:nvSpPr><p:cNvPr id="9" name="x"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>';
    const cxn = (a: string, b: string): string =>
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="20" name="線"/><p:cNvCxnSpPr><a:stCxn id="${a}" idx="3"/><a:endCxn id="${b}" idx="1"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr/></p:cxnSp>`;
    const got = readPptxSlide(wrap(sp(2, 0, 0) + sp(3, 3810000, 0) + noPos + cxn('2', '999') + cxn('2', '3')));
    expect(got.lines, '繋がる線は 1 本').toBe(1);
    expect(got.dropped, '位置なし 1 + 宙に浮いた線 1').toBe(2);
  });

  it('知らない図形名は四角として読み、件数に足す。色名の塗りは付けない', () => {
    const odd = sp(2, 0, 0, 'cloudCallout').replace('<a:prstGeom prst="cloudCallout"/>', '<a:prstGeom prst="cloudCallout"/><a:solidFill><a:schemeClr val="accent1"/></a:solidFill>');
    const got = readPptxSlide(wrap(odd));
    expect(got.dropped, '形が変わるので件数に足す').toBe(1);
    const ps = placesOf(got.body);
    expect(ps.length).toBe(1);
    expect(ps[0]!.attrs).not.toContain('shape=');
    expect(ps[0]!.attrs).not.toContain('fill=');
  });

  it('壊れた XML は投げる(呼び側が断り文にする)', () => {
    expect(() => readPptxSlide('これは XML ではありません')).toThrow();
  });

  it('本文を壊す行は字として残る(板の塊を途中で閉じない)', () => {
    const got = readPptxSlide(wrap(sp(2, 0, 0, 'rect', ':::')));
    expect(placesOf(got.body).length).toBe(1);
    expect(got.body).toContain('\\:::');
  });
});

describe('🔴 字の中の改行で、板の記法に差し込めない', () => {
  const wrap = (t: string): string =>
    '<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>'
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
    + '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr>'
    + `<p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const EVIL = ':::\n:::format{.pkc-place x=500 y=500 w=10 h=10 fill=#ff0000}\nEVIL\n- b\n# c';
  for (const [name, raw] of [
    ['生の改行', `hi\n${EVIL}`],
    ['&#10;', `hi&#10;${EVIL.replace(/\n/g, '&#10;')}`],
    ['CR / NEL / 行区切り', `hi\r${EVIL.replace(/\n/g, '\u0085')}\u2028x`],
  ] as const) {
    it(`${name} で塊を閉じて別の付箋を差し込めない`, () => {
      const got = readPptxSlide(wrap(raw));
      const opens = got.body.split('\n').filter((l) => l.startsWith(':::format'));
      expect(opens.length, '開きが 1 つだけ').toBe(1);
      expect(opens.filter((l) => l.includes('.pkc-place')).length, '付箋が 1 つだけ').toBe(1);
      expect(opens[0]).not.toContain('fill=');
      // 閉じの `:::` は塊の最後の 1 行だけ
      expect(got.body.split('\n').filter((l) => l === ':::').length).toBe(1);
      // 生の箇条書き・見出しが行頭に出ない
      expect(got.body.split('\n').filter((l) => /^(- b|# c)/.test(l))).toEqual([]);
    });
  }
});

describe('扉の副題と原点・知らない図形', () => {
  it('🔴 扉スライドの板も、原点が 0 でなくても絶対位置が戻り、副題は付箋にならない', () => {
    const got = readPptxSlide(slideOf([
      { kind: 'h', level: 1, runs: [{ text: '章' }] },
      { kind: 'h', level: 2, runs: [{ text: '副題です' }] },
      // ⚠ 扉の本文の枠は低い（1.5 インチ）── 収まる大きさにしないと縮められて逆算できない
      place(40, 40, 200, 60, 1), p('a'),
      place(300, 60, 200, 60, 1), p('b'),
    ]));
    expect(got.title).toBe('章');
    const ps = placesOf(got.body);
    expect(ps.length, '副題が付箋になっている').toBe(2);
    expect(Math.abs(ps[0]!.x - 40)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(ps[0]!.y - 40)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(ps[1]!.x - 300)).toBeLessThanOrEqual(TOL);
  });

  const odd = (geom: string): string =>
    '<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>'
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
    + `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm>${geom}</p:spPr>`
    + '<p:txBody><a:p><a:r><a:t>t</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>';
  it('🔴 知らない図形（star5 / custGeom）は四角で置き、件数に足す', () => {
    const a = readPptxSlide(odd('<a:prstGeom prst="star5"/>'));
    expect(a.placed).toBe(1);
    expect(a.dropped).toBe(1);
    expect(readPptxSlide(odd('<a:custGeom/>')).dropped).toBe(1);
  });
  it('対照群 ── 既知の形は形のまま戻り、件数に足さない', () => {
    const a = readPptxSlide(odd('<a:prstGeom prst="ellipse"/>'));
    expect(a.dropped).toBe(0);
    expect(placesOf(a.body)[0]!.attrs).toContain('shape=ellipse');
    expect(readPptxSlide(odd('<a:prstGeom prst="rect"/>')).dropped).toBe(0);
  });
});

describe('部品名と拡張子', () => {
  it('スライドは番号の順に並ぶ(slide10 が slide2 より後)', () => {
    expect(pptxSlideNames(['ppt/slides/slide10.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide1.xml', 'ppt/slides/_rels/slide1.xml.rels', 'ppt/presentation.xml']))
      .toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide10.xml']);
  });
  it('拡張子は .pptx だけ', () => {
    expect(isPptxFileName('a.PPTX')).toBe(true);
    expect(isPptxFileName('a.ppt')).toBe(false);
    expect(isPptxFileName('a.pptx.txt')).toBe(false);
  });
});
