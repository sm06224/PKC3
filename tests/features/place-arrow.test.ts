/** @vitest-environment happy-dom */
/**
 * 🔴 **板の線の矢じり**(#530。Gemini 裁定 2026-10-11 依頼 15)── 記法・形・テンプレート・PowerPoint の往復。
 *
 * 守る主張:
 * 1. 記法: `arrow=end` / `arrow=both`。札が無い・`none` = 矢じりなし。読めない字は `bad`(黙って倒さない)
 * 2. 書き込み: 「矢じりなし」は札を**消す**。線の行にだけ書ける(付箋の行は断る)。他の札・他の行は 1 字も動かない
 * 3. 形: 端で線が進む向きに三角が付く。折れ線は最後の区間の向き。太いほど大きい。両端は 2 つ
 * 4. テンプレート「3 段の流れ図」の線は最初から `arrow=end`
 * 5. PowerPoint: `a:tailEnd`(終わり)/ `a:headEnd`(始まり)が出て、読み戻すと同じ `arrow=` になる。
 *    矢じりなしの線の XML は 1 byte も変わらない(対照群)
 */
import { describe, expect, it } from 'vitest';
import { htmlToDocxBlocks } from '@adapter/platform/export/html-blocks';
import { buildPptx, type ExportBlock } from '@features/export/pptx';
import { pptxSlideNames, readPptxSlide } from '@features/import/pptx-board';
import { applyBodyRewrite } from '@features/markdown/body-rewrite';
import { renderMarkdown } from '@features/markdown/markdown-render';
import {
  isPlaceStyle,
  LINE_STYLE_KEYS,
  parseArrowSpell,
  placeArrowOf,
  PLACE_ARROWS,
  BOARD_STYLE_KEYS,
} from '@features/markdown/place-color';
import {
  arrowHeadLength,
  placeArrowHeadsOf,
  placeLineOf,
  type PlaceRect,
} from '@features/markdown/place-line';
import { addPlaceTemplate, placeStyleAt, setPlaceStyle } from '@features/markdown/place-notation';

const box = (x: number, y: number, w = 100, h = 60): PlaceRect => ({ x, y, w, h });

describe('記法(arrow=)', () => {
  it('🔴 end / both は読める。札が無い・空・none は「矢じりなし」。読めない字は bad', () => {
    expect(PLACE_ARROWS.length, '一覧が空だと下の検査が何も見ない').toBe(3);
    expect(parseArrowSpell('end')).toEqual({ kind: 'ok', arrow: 'end' });
    expect(parseArrowSpell(' both ')).toEqual({ kind: 'ok', arrow: 'both' });
    expect(parseArrowSpell('none')).toEqual({ kind: 'ok', arrow: 'none' });
    expect(parseArrowSpell(null)).toEqual({ kind: 'none' });
    expect(parseArrowSpell('')).toEqual({ kind: 'none' });
    expect(parseArrowSpell('ned')).toEqual({ kind: 'bad', raw: 'ned' });
    expect(parseArrowSpell('END')).toEqual({ kind: 'bad', raw: 'END' }); // 大文字は別の字
    expect(placeArrowOf('ned'), '読めない字は矢じりなし(描く側の規則)').toBe('none');
    expect(placeArrowOf(true), '値なしの札(arrow)も矢じりなし').toBe('none');
    expect(placeArrowOf('end')).toBe('end');
  });

  it('🔴 持てる札: 線だけが arrow を持つ(付箋は持たない)', () => {
    expect(LINE_STYLE_KEYS).toContain('arrow');
    expect(BOARD_STYLE_KEYS).not.toContain('arrow');
    expect(isPlaceStyle({ arrow: 'end' })).toBe(true);
    expect(isPlaceStyle({ arrow: null })).toBe(true);
    expect(isPlaceStyle({ arrow: 'ned' })).toBe(false);
  });
});

describe('書き込み(setPlaceStyle)と読み(placeStyleAt)', () => {
  const OPEN = ':::format{.pkc-line from=a to=b}';
  const BODY = [':::format{#a .pkc-place x=0 y=0}', ':::', '', ':::format{#b .pkc-place x=300 y=0}', ':::', '', OPEN, ':::', ''].join('\n');
  const LINE = 6;
  const write = (body: string, arrow: 'none' | 'end' | 'both' | null): string | null =>
    setPlaceStyle(body, { line: LINE, openLine: body.split('\n')[LINE]! }, { arrow });

  it('🔴 end → arrow=end / both → 札は 1 つだけ / none・null → 札が消える(arrow=none と書かない)', () => {
    const end = write(BODY, 'end')!;
    expect(end.split('\n')[LINE]).toBe(':::format{.pkc-line from=a to=b arrow=end}');
    const both = write(end, 'both')!;
    expect(both.split('\n')[LINE]).toBe(':::format{.pkc-line from=a to=b arrow=both}');
    for (const off of ['none', null] as const) {
      const cleared = write(both, off)!;
      expect(cleared, off ?? 'null').toBe(BODY);
      expect(cleared).not.toContain('arrow');
    }
  });

  it('矢じりが元から無い線に「矢じりなし」を書いても本文は動かない', () => {
    expect(write(BODY, 'none')).toBe(BODY);
  });

  it('🔴 他の札と並ぶ: 色・太さは残り、他の行は 1 字も動かない', () => {
    const body = BODY.replace(OPEN, ':::format{.pkc-line from=a to=b stroke=#2563eb width=4}');
    const next = write(body, 'both')!;
    expect(next.split('\n')[LINE]).toBe(':::format{.pkc-line from=a to=b stroke=#2563eb width=4 arrow=both}');
    expect(next.split('\n').filter((_, i) => i !== LINE)).toEqual(body.split('\n').filter((_, i) => i !== LINE));
  });

  it('🔴 付箋の行には書かない(持てない札)', () => {
    expect(
      setPlaceStyle(BODY, { line: 0, openLine: BODY.split('\n')[0]! }, { arrow: 'end' }),
    ).toBeNull();
    // 対照群: 同じ付箋の行へ持てる札(fill)は書ける ── 上の null が「行の門」で落ちたのではないこと
    expect(setPlaceStyle(BODY, { line: 0, openLine: BODY.split('\n')[0]! }, { fill: '#ffffff' })).not.toBeNull();
  });

  it('🔴 applyBodyRewrite(store-effects が書く当の関数)を通っても同じ', () => {
    const next = applyBodyRewrite(BODY, { kind: 'place-style', line: LINE, openLine: OPEN, style: { arrow: 'end' } });
    expect(next?.split('\n')[LINE]).toBe(':::format{.pkc-line from=a to=b arrow=end}');
  });

  it('🔴 読み: いまの矢じりと「書かれているか」(読めない字も書かれている扱い)', () => {
    expect(placeStyleAt(OPEN)).toMatchObject({ arrow: 'none', written: { arrow: false } });
    expect(placeStyleAt(`${OPEN.slice(0, -1)} arrow=both}`)).toMatchObject({ arrow: 'both', written: { arrow: true } });
    expect(placeStyleAt(`${OPEN.slice(0, -1)} arrow=ned}`)).toMatchObject({ arrow: 'none', written: { arrow: true }, any: true });
    // 付箋の行は arrow を持たない
    expect(placeStyleAt(':::format{#a .pkc-place x=0 y=0 arrow=end}')).toMatchObject({ arrow: 'none', written: { arrow: false } });
  });
});

describe('矢じりの形(placeArrowHeadsOf)', () => {
  const straight = placeLineOf(box(0, 0), box(300, 0)); // (100,30) → (300,30)

  it('🔴 end: 終わりの端に、進む向きへ尖る三角 1 つ(始まりには付かない)', () => {
    const h = placeArrowHeadsOf(straight, 'straight', null, 'end', null);
    expect(h.start).toBeNull();
    expect(h.end).toBe('M 300 30 L 288 34.8 L 288 25.2 Z');
  });

  it('🔴 both: 始まりの三角は外向き(左へ尖る)', () => {
    const h = placeArrowHeadsOf(straight, 'straight', null, 'both', null);
    expect(h.start).toBe('M 100 30 L 112 25.2 L 112 34.8 Z');
    expect(h.end).toBe('M 300 30 L 288 34.8 L 288 25.2 Z');
  });

  it('none は何も返さない(対照群)', () => {
    expect(placeArrowHeadsOf(straight, 'straight', null, 'none', null)).toEqual({ start: null, end: null });
  });

  it('🔴 太いほど大きい: 標準 2px で 12、4px で 16、1px で 10', () => {
    expect([1, 2, 4].map(arrowHeadLength)).toEqual([10, 12, 16]);
    expect(placeArrowHeadsOf(straight, 'straight', null, 'end', 4).end).toBe('M 300 30 L 284 36.4 L 284 23.6 Z');
    expect(placeArrowHeadsOf(straight, 'straight', null, 'end', 2).end).toBe(
      placeArrowHeadsOf(straight, 'straight', null, 'end', null).end, // 札なし = 標準の太さ
    );
  });

  it('🔴 向きは端で線が進む向き: 下へ向かう線は下へ、斜めは斜めへ尖る', () => {
    const down = placeLineOf(box(0, 0), box(0, 300)); // bottom → top: (50,60) → (50,300)
    const h = placeArrowHeadsOf(down, 'straight', null, 'end', null).end!;
    expect(h.startsWith('M 50 300 ')).toBe(true);
    // 三角の底は先端より上(y が小さい)
    const ys = [...h.matchAll(/[ML] [-\d.]+ ([-\d.]+)/g)].map((m) => Number(m[1]));
    expect(ys[1]).toBeLessThan(300);
    expect(ys[2]).toBeLessThan(300);
  });

  it('🔴 折れ線・曲線は端に着く最後の区間の向き(線の上に乗る)', () => {
    const ln = placeLineOf(box(0, 0), box(300, 200)); // right → left: (100,30) → (300,230)
    for (const route of ['elbow', 'curve'] as const) {
      const h = placeArrowHeadsOf(ln, route, null, 'both', null);
      // 既定の曲がり所 v:200 ── 最後の区間は (200,230)→(300,230) = 右向き、最初は (100,30)→(200,30) = 右向き
      expect(h.end, route).toBe('M 300 230 L 288 234.8 L 288 225.2 Z');
      expect(h.start, route).toBe('M 100 30 L 112 25.2 L 112 34.8 Z');
    }
  });

  it('⚠ 最後の区間の長さが 0(曲がる所が端点に重なる)ときは、その前の区間を見る', () => {
    const ln = placeLineOf(box(0, 0), box(300, 200)); // (100,30) → (300,230)
    const h = placeArrowHeadsOf(ln, 'elbow', { axis: 'v', at: 300 }, 'end', null);
    // 点列 (100,30)(300,30)(300,230)(300,230): 最後の非ゼロ区間は (300,30)→(300,230) = 下向き
    expect(h.end).toBe('M 300 230 L 295.2 218 L 304.8 218 Z');
  });

  it('⚠ 端点が全部重なる(長さ 0 の線)は矢じりを出さない', () => {
    const dot = { x1: 5, y1: 5, x2: 5, y2: 5, from: straight.from, to: straight.to };
    expect(placeArrowHeadsOf(dot, 'straight', null, 'both', null)).toEqual({ start: null, end: null });
  });
});

describe('テンプレート「3 段の流れ図」の線', () => {
  it('🔴 2 本とも最初から arrow=end(書かれた本文と、読む側が受ける印の両方)', () => {
    const next = addPlaceTemplate('', 0, 0, 'flow3')!;
    const lines = next.split('\n').filter((l) => l.includes('.pkc-line'));
    expect(lines, '線が 2 本でない').toHaveLength(2);
    for (const l of lines) expect(l).toMatch(/ arrow=end\}$/);
    const html = renderMarkdown(next, { sourceLineAnchors: true } as never);
    expect([...html.matchAll(/data-pkc-arrow="end"/g)]).toHaveLength(2);
  });

  it('対照群: 付箋 4 枚・2 × 2 の表には線が無い(arrow を持ち込まない)', () => {
    for (const id of ['sticky4', 'grid2x2'] as const) {
      const body = addPlaceTemplate('', 0, 0, id as never);
      if (body !== null) expect(body, id).not.toContain('arrow');
    }
  });
});

describe('PowerPoint ── 書き出しと取り込み', () => {
  const BOARD = (lineExtra = ''): string =>
    [
      ':::format{#a .pkc-place x=0 y=0 w=200 h=100}',
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
  const lnOf = (xml: string): string => /<a:ln w="\d+">[\s\S]*?<\/a:ln>/.exec(/<p:cxnSp>[\s\S]*?<\/p:cxnSp>/.exec(xml)![0])![0];

  it('🔴 本文 → 画面の HTML → 塊 → .pptx: end は tailEnd だけ / both は headEnd + tailEnd', () => {
    const end = lnOf(fromMarkdown(BOARD(' arrow=end')));
    expect(end).toContain('<a:tailEnd type="triangle"/>');
    expect(end).not.toContain('headEnd');
    const both = lnOf(fromMarkdown(BOARD(' arrow=both')));
    expect(both).toContain('<a:headEnd type="triangle"/><a:tailEnd type="triangle"/>');
    // 仕様の順(塗り → headEnd → tailEnd)── 入れ違えると PowerPoint が拒む
    expect(both.indexOf('</a:solidFill>')).toBeLessThan(both.indexOf('<a:headEnd'));
  });

  it('🔴 対照群: 矢じりなし・読めない字の線は今までと 1 byte も変わらない', () => {
    const plain = fromMarkdown(BOARD());
    expect(lnOf(plain)).not.toMatch(/headEnd|tailEnd/);
    expect(fromMarkdown(BOARD(' arrow=ned'))).toBe(plain);
    expect(fromMarkdown(BOARD(' arrow=none'))).toBe(plain);
  });

  it('🔴 色・太さと並んでも矢じりは ln の中に入る(width は EMU のまま)', () => {
    const ln = lnOf(fromMarkdown(BOARD(' stroke=#2563eb width=4 arrow=end')));
    expect(ln).toBe('<a:ln w="38100"><a:solidFill><a:srgbClr val="2563EB"/></a:solidFill><a:tailEnd type="triangle"/></a:ln>');
  });

  const pline = (extra: Partial<Extract<ExportBlock, { kind: 'place-line' }>> = {}): ExportBlock => ({
    kind: 'place-line', from: 'a', to: 'b', fromAnchor: 'right', toAnchor: 'left', route: null, ...extra,
  });
  const place = (x: number, name: string): ExportBlock => ({ kind: 'place', x, y: 0, w: 200, h: 100, shape: 'rect', name, span: 1 });
  const p = (text: string): ExportBlock => ({ kind: 'p', runs: [{ text }] });
  const linesOf = (body: string): string[] =>
    [...body.matchAll(/^:::format\{([^}]*\.pkc-line[^}]*)\}$/gm)].map((m) => m[1]!);
  const roundTrip = (line: ExportBlock): string => {
    const xml = slideOf([place(0, 'a'), p('A'), place(400, 'b'), p('B'), line]);
    const got = readPptxSlide(xml);
    expect(got.lines).toBe(1);
    return linesOf(got.body)[0]!;
  };

  it('🔴 往復: end → arrow=end / both → arrow=both / なし → 札を足さない', () => {
    expect(roundTrip(pline({ arrow: 'end' }))).toContain(' arrow=end');
    expect(roundTrip(pline({ arrow: 'both' }))).toContain(' arrow=both');
    expect(roundTrip(pline())).not.toContain('arrow');
  });

  it('🔴 始まりだけに矢じりが付いた線(他のアプリの file)は、向きを入れ替えて arrow=end にする', () => {
    const xml = slideOf([place(0, 'a'), p('A'), place(400, 'b'), p('B'), pline({ arrow: 'end' })]);
    // tailEnd を headEnd へ入れ替える(= 始まりだけ)
    const flipped = xml.replace('<a:tailEnd type="triangle"/>', '<a:headEnd type="triangle"/>');
    expect(flipped).not.toBe(xml);
    const l = linesOf(readPptxSlide(flipped).body)[0]!;
    expect(l).toContain(' arrow=end');
    // 元は a(右)→ b(左)。入れ替えると b の左 → a の右に繋がる(矢じりは a を指す)
    const from = /from=(\S+)/.exec(l)![1]!;
    const to = /to=(\S+)/.exec(l)![1]!;
    expect(from).toMatch(/:left$/);
    expect(to).toMatch(/:right$/);
    // 指す先の板は元の「始まり」の板(= 本文で先に出る 1 枚目)
    const body = readPptxSlide(flipped).body;
    const firstName = /#(板\d+) \.pkc-place x=0 /.exec(body)?.[1];
    expect(to.split(':')[0]).toBe(firstName);
  });

  it('矢じりの種類が none の線は付けない(type="none" は付いていない扱い)', () => {
    const xml = slideOf([place(0, 'a'), p('A'), place(400, 'b'), p('B'), pline({ arrow: 'end' })]);
    const none = xml.replace('<a:tailEnd type="triangle"/>', '<a:tailEnd type="none"/>');
    expect(linesOf(readPptxSlide(none).body)[0]).not.toContain('arrow');
  });

  it('名前の一覧が空でないこと(空振り防止)', () => {
    expect(pptxSlideNames(['ppt/slides/slide1.xml']).length).toBe(1);
  });
});
