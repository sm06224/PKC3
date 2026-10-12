/** @vitest-environment happy-dom */
/**
 * 🔴 **PowerPoint へ回転とグループを運ぶ**(#530 段⑤c・⑤e。設計 `board-next-stage-design-2026-10.md` §3.2・§3.3)。
 *
 * 守る主張:
 * 1. 書き出し: 回した付箋は `<a:xfrm rot="度×60000">`(`off` / `ext` は回す前の四角)。同じ `group=` の付箋は 1 つの `<p:grpSp>`
 *    (子の座標系は恒等 = `chOff = off` / `chExt = ext`)。1 枚だけのグループは作らない。
 * 2. 🔴 **回した付箋につないだ線の端は、回した辺の上にある**(数値で見る。`anchorPoint` の 1 本を引く ── 複製しない)。
 * 3. 🔴 **回していない / グループの無い板は、今までと 1 byte も変わらない**(origin/main で採ったハッシュで pin)。
 * 4. 取り込み: `rot` → `rotate=`(整数 0..359、0 は札を書かない)/ `<p:grpSp>` を開いて平らにし、同じ `group=` を付ける
 *    (座標は `off + (子 − chOff) × ext / chExt`。回した群は子の位置と向きに合成)。
 * 5. 往復(板 → .pptx → 板)で `rotate=` と `group=` が戻り、回した付箋がある板でも位置が戻る。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { htmlToDocxBlocks } from '@adapter/platform/export/html-blocks';
import { buildPptx, type ExportBlock } from '@features/export/pptx';
import { readPptxSlide } from '@features/import/pptx-board';
import { renderMarkdown } from '@features/markdown/markdown-render';

const p = (text: string): ExportBlock => ({ kind: 'p', runs: [{ text }] });
interface Opt { rotate?: number; group?: string; name?: string | null }
const place = (x: number, y: number, w: number, h: number, o: Opt = {}): ExportBlock => ({
  kind: 'place', x, y, w, h, shape: 'rect', name: o.name ?? null, span: 1,
  ...(o.rotate !== undefined ? { rotate: o.rotate } : {}),
  ...(o.group !== undefined ? { group: o.group } : {}),
});
const slideOf = (blocks: readonly ExportBlock[]): string => {
  const r = buildPptx(blocks, { title: 'T' });
  const hit = r.parts.find((x) => x.name === 'ppt/slides/slide1.xml');
  expect(hit, 'slide1.xml が無い').toBeTruthy();
  return hit!.text;
};
/** 付箋 1 枚 = 位置の塊 + 字の塊。 */
const note = (x: number, y: number, w: number, h: number, t: string, o: Opt = {}): ExportBlock[] => [place(x, y, w, h, o), p(t)];

const TOL = 1;

describe('🔴 回していない / グループの無い板は、今までと 1 byte も変わらない', () => {
  it('origin/main で採ったハッシュと一致する(rot も grpSp も出ない)', () => {
    const blocks: ExportBlock[] = [
      { kind: 'place', x: 40, y: 30, w: 240, h: 100, shape: 'rect', name: 'a', span: 1 }, p('一枚目'),
      { kind: 'place', x: 360, y: 200, w: 200, h: 120, shape: 'diamond', name: 'b', span: 1, fill: '#ffe08a', size: 'large' }, p('二枚目'),
      { kind: 'place-line', from: 'a', to: 'b', fromAnchor: null, toAnchor: null, route: 'elbow' },
    ];
    const xml = slideOf(blocks);
    // ハッシュは回転・グループの変更を入れる前の実装(origin/main 8cf82576)の出力から採った。変わったら「今までの板の bytes が動いた」
    expect(createHash('sha256').update(xml).digest('hex')).toBe(
      '2da4021aeb418bc560a42ba67f09b3d94778130f1f5b691093b90db189a1d68e',
    );
    expect(xml).not.toContain(' rot=');
    expect(xml).not.toContain('<p:grpSp>');
  });

  it('rotate: 0 と 1 枚だけの group でも、回転も群も出ない(札が無いのと同じ)', () => {
    const xml = slideOf([...note(40, 40, 200, 100, '左', { rotate: 0 }), ...note(300, 40, 200, 100, '右', { group: 'ひとり' })]);
    expect(xml).not.toContain(' rot=');
    expect(xml).not.toContain('<p:grpSp>');
  });
});

describe('🔴 回転 ── 書き出し(<a:xfrm rot>)', () => {
  it.each([
    [15, 900000],
    [90, 5400000],
    [359, 21540000],
  ])('rotate=%i は rot="%i"(度 × 60000)。回した 1 枚にだけ付く', (deg, rot) => {
    const xml = slideOf([...note(100, 100, 200, 100, '回す', { rotate: deg }), ...note(400, 100, 200, 100, '回さない')]);
    expect(xml.match(/ rot="/g)?.length, '回した 1 枚にだけ').toBe(1);
    expect(xml).toContain(`<a:xfrm rot="${rot}"><a:off `);
  });

  it('🔴 off / ext は回す前の四角のまま(画面の x= y= w= h= と同じ約束)。回していない相方と同じ大きさ', () => {
    const xml = slideOf([...note(100, 100, 200, 100, 'A', { rotate: 90 }), ...note(400, 100, 200, 100, 'B')]);
    const ext = [...xml.matchAll(/<a:ext cx="(\d+)" cy="(\d+)"\/>/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const boxes = ext.filter(([cx]) => cx === 200 * 9525 || cx === Math.round(200 * 9525 * 1));
    expect(boxes.length, '2 枚とも 200×100 のまま(入れ替わらない)').toBe(2);
    expect(boxes.every(([, cy]) => cy === 100 * 9525)).toBe(true);
  });

  it('🔴 回した付箋が板の左上より外へ出ても、スライドの外へはみ出さない(90° で上へ 50px 出る板)', () => {
    // x=0,y=0,w=200,h=100 を 90° 回すと、見た目は x 50..150 / y −50..150
    const xml = slideOf(note(0, 0, 200, 100, '縦', { rotate: 90 }));
    const m = /<a:xfrm rot="5400000"><a:off x="(\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(xml)!;
    const [x, y, cx, cy] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    // 独立に出す(90° は幅と高さが入れ替わるだけ): 見た目の上端 = 中心 y − cx/2
    const visTop = y + cy / 2 - cx / 2;
    const visLeft = x + cx / 2 - cy / 2;
    expect(visTop, '見た目の上端がスライドの内側').toBeGreaterThanOrEqual(0);
    expect(visLeft, '見た目の左端がスライドの内側').toBeGreaterThanOrEqual(0);
  });
});

describe('🔴 回した付箋が板の左へ出る / 上へ出る ── 原点の動かし方', () => {
  it('🔴 x=0 の縦長の付箋を 90° 回すと左へ 50px 出る ── 見た目の左端がスライドの内側に入る', () => {
    // x=0,y=0,w=100,h=200 を 90° → 見た目は x −50..150 / y 50..150
    const xml = slideOf(note(0, 0, 100, 200, '横', { rotate: 90 }));
    const m = /<a:xfrm rot="5400000"><a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(xml)!;
    const [x, , cx, cy] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    expect(x + cx / 2 - cy / 2, '見た目の左端').toBeGreaterThanOrEqual(0);
  });

  it('🔴 左へ出る付箋につないだ線も、同じだけ動いた座標で書く(付箋の角からの差が変わらない)', () => {
    const xml = slideOf([
      ...note(0, 100, 100, 200, 'A', { name: 'a', rotate: 90 }),
      ...note(300, 100, 100, 100, 'B', { name: 'b' }),
      { kind: 'place-line', from: 'a', to: 'b', fromAnchor: 'right', toAnchor: 'left', route: null },
    ]);
    const a = /<a:xfrm rot="5400000"><a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)"/.exec(xml)!;
    const c = /<p:cxnSp>[\s\S]*?<a:xfrm([^>]*)><a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(xml)!;
    const px = Number(a[3]) / 100; // 1px あたりの EMU(縮尺込み)
    // A の中心は (50,200)。右辺の真ん中 (100,200) を 90° 右回りすると (50,250)。A の左上 (0,100) からの差は (+50,+150)
    // 始点 (50,250) → 終点 B の左辺 (300,150): 右上へ向かう線(flipV)。始点は off の左下
    expect(c[1]).toContain('flipV');
    expect(Math.abs(Number(c[2]) - (Number(a[1]) + 50 * px)), '始点 x').toBeLessThanOrEqual(2);
    expect(Math.abs(Number(c[3]) + Number(c[5]) - (Number(a[2]) + 150 * px)), '始点 y').toBeLessThanOrEqual(2);
  });
});

describe('🔴 回転 ── 線の端は回した辺の上に付く', () => {
  const link = (): ExportBlock => ({
    kind: 'place-line', from: 'a', to: 'b', fromAnchor: 'right', toAnchor: 'top', route: null,
  });
  const build = (rotate: number | undefined): string =>
    slideOf([
      ...note(100, 100, 200, 100, 'A', { name: 'a', ...(rotate === undefined ? {} : { rotate }) }),
      ...note(100, 400, 200, 60, 'B', { name: 'b' }),
      link(),
    ]);
  const read = (xml: string) => {
    // ⚠ 線は付箋より前に並ぶ(後ろへ敷く)── 付箋 1 の名前から先で探す
    const a = /<a:xfrm(?: rot="\d+")?><a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(
      xml.slice(xml.indexOf('name="付箋 1"')),
    )!;
    const c = /<p:cxnSp>[\s\S]*?<a:xfrm([^>]*)><a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(xml)!;
    return {
      aOff: { x: Number(a[1]), y: Number(a[2]) },
      aW: Number(a[3]),
      cxn: { flip: c[1]!, x: Number(c[2]), y: Number(c[3]), w: Number(c[4]), h: Number(c[5]) },
    };
  };

  it('🔴 90° 回した A の「右」は、A の下側(中心の真下 w/2)から出る ── 数値で一致する', () => {
    const r = read(build(90));
    const k = r.aW / (200 * 9525); // 縮尺(小さい板は 1)
    const px = 9525 * k;
    // 回す前の A: 左上 (100,100) 幅 200 高さ 100 → 中心 (200,150)。右辺の真ん中 (300,150) を 90° 右回りすると (200, 250)
    // 左上の隅からの差は (+100, +150) px
    const expectStart = { x: r.aOff.x + 100 * px, y: r.aOff.y + 150 * px };
    // 終点は B の上辺の真ん中 (200,400) ── A の左上 (100,100) からの差は (+100, +300) px
    const expectEnd = { x: r.aOff.x + 100 * px, y: r.aOff.y + 300 * px };
    // 線は縦(x が同じ)で、始点が上・終点が下 ── off が始点、off + ext が終点
    expect(Math.abs(r.cxn.x - expectStart.x), 'x').toBeLessThanOrEqual(2);
    expect(Math.abs(r.cxn.y - expectStart.y), '始点の y').toBeLessThanOrEqual(2);
    expect(Math.abs(r.cxn.y + r.cxn.h - expectEnd.y), '終点の y').toBeLessThanOrEqual(2);
    expect(r.cxn.flip).toBe('');
  });

  it('対照群 ── 回していない A の「右」は右辺の真ん中(300,150)から出る(回した端と別の点)', () => {
    const r = read(build(undefined));
    const px = 9525 * (r.aW / (200 * 9525));
    // 始点 (300,150) → 終点 (200,400): 左下へ向かう線 = flipH。始点は off の右上
    expect(r.cxn.flip).toContain('flipH');
    expect(Math.abs(r.cxn.x + r.cxn.w - (r.aOff.x + 200 * px)), '始点 x = 右辺').toBeLessThanOrEqual(2);
    expect(Math.abs(r.cxn.y - (r.aOff.y + 50 * px)), '始点 y = 右辺の真ん中').toBeLessThanOrEqual(2);
  });
});

describe('🔴 グループ ── 書き出し(<p:grpSp>)', () => {
  const blocks = (): ExportBlock[] => [
    ...note(40, 40, 200, 100, '一', { group: 'チーム' }),
    ...note(300, 40, 200, 100, '二'),
    ...note(40, 240, 200, 100, '三', { group: 'チーム' }),
    ...note(300, 240, 200, 100, '四', { group: 'ひとり' }),
  ];

  it('🔴 同じ group= の付箋が 1 つの grpSp に入る。1 枚だけの group は作らない。群は最初の 1 枚の位置', () => {
    const xml = slideOf(blocks());
    expect(xml.match(/<p:grpSp>/g)?.length, '群は 1 つ(「ひとり」は作らない)').toBe(1);
    const grp = /<p:grpSp>([\s\S]*?)<\/p:grpSp>/.exec(xml)![1]!;
    expect(grp).toContain('name="チーム"');
    expect(grp).toContain('name="付箋 1"');
    expect(grp).toContain('name="付箋 3"');
    expect(grp, '群の外の付箋は入らない').not.toContain('name="付箋 2"');
    expect(grp).not.toContain('name="付箋 4"');
    // 並び: 群(付箋 1・3)→ 付箋 2 → 付箋 4
    const at = (s: string): number => xml.indexOf(s);
    expect(at('<p:grpSp>')).toBeLessThan(at('name="付箋 2"'));
    expect(at('name="付箋 2"')).toBeLessThan(at('name="付箋 4"'));
  });

  it('🔴 子の座標系は恒等(chOff = off / chExt = ext)で、枠は子の外接四角と一致する', () => {
    const xml = slideOf(blocks());
    const g = /<p:grpSpPr><a:xfrm><a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/><a:chOff x="(\d+)" y="(\d+)"\/><a:chExt cx="(\d+)" cy="(\d+)"\/>/.exec(xml)!;
    expect(g, 'grpSpPr が読めない').toBeTruthy();
    expect([g[5], g[6], g[7], g[8]]).toEqual([g[1], g[2], g[3], g[4]]);
    const grp = /<p:grpSp>([\s\S]*?)<\/p:grpSp>/.exec(xml)![1]!;
    const kids = [...grp.matchAll(/<p:sp>[\s\S]*?<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g)].map((m) => m.slice(1, 5).map(Number));
    expect(kids.length).toBe(2);
    const x1 = Math.min(...kids.map((k) => k[0]!));
    const y1 = Math.min(...kids.map((k) => k[1]!));
    const x2 = Math.max(...kids.map((k) => k[0]! + k[2]!));
    const y2 = Math.max(...kids.map((k) => k[1]! + k[3]!));
    expect([Number(g[1]), Number(g[2]), Number(g[3]), Number(g[4])]).toEqual([x1, y1, x2 - x1, y2 - y1]);
  });

  it('🔴 回した付箋が入った群の枠は、回した後の外接四角を含む(90° で上へ出た分)', () => {
    const xml = slideOf([
      ...note(100, 100, 200, 100, '回す', { group: 'G', rotate: 90 }),
      ...note(400, 100, 200, 100, '相方', { group: 'G' }),
    ]);
    const g = /<p:grpSpPr><a:xfrm><a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(xml)!;
    const m = /<a:xfrm rot="5400000"><a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(xml)!;
    const [rx, ry, rw, rh] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    // 回した付箋の見た目の上端(90°: 幅と高さが入れ替わる)
    const visTop = ry + rh / 2 - rw / 2;
    const gTop = Number(g[2]);
    expect(gTop, '群の上端は回した付箋の見た目の上端以上に広い').toBeLessThanOrEqual(Math.round(visTop));
    expect(rx).toBeGreaterThanOrEqual(0);
  });

  it('図形の id は板の中で重ならない(群・付箋・線)', () => {
    const xml = slideOf([
      ...note(40, 40, 200, 100, '一', { group: 'チーム', name: 'a' }),
      ...note(300, 40, 200, 100, '二', { group: 'チーム', name: 'b' }),
      { kind: 'place-line', from: 'a', to: 'b', fromAnchor: null, toAnchor: null, route: null },
    ]);
    const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    expect(new Set(ids).size, `id が重なっている: ${ids.join(',')}`).toBe(ids.length);
  });
});

describe('🔴 画面の本文 → 塊 → .pptx(rotate= / group= が html-blocks を通って届く)', () => {
  const md = [
    ':::format{#a .pkc-place x=40 y=40 w=200 h=100 rotate=30 group=チーム}',
    '左',
    ':::',
    '',
    ':::format{#b .pkc-place x=300 y=40 w=200 h=100 group=チーム}',
    '右',
    ':::',
    '',
  ].join('\n');
  it('回転は rot=1800000、グループは grpSp(読めない rotate=abc は回さない)', () => {
    const doc = new DOMParser().parseFromString(`<body>${renderMarkdown(md)}</body>`, 'text/html');
    const xml = slideOf(htmlToDocxBlocks(doc).blocks);
    expect(xml).toContain(' rot="1800000"');
    expect(xml).toContain('<p:grpSp>');
    const bad = new DOMParser().parseFromString(
      `<body>${renderMarkdown(md.replace('rotate=30', 'rotate=abc').replace('group=チーム', 'group="a b"'))}</body>`, 'text/html');
    const xml2 = slideOf(htmlToDocxBlocks(bad).blocks);
    expect(xml2).not.toContain(' rot=');
    expect(xml2).not.toContain('<p:grpSp>');
  });
});

describe('🔴 往復(板 → .pptx → 板)', () => {
  const attrsOf = (body: string): string[] =>
    [...body.matchAll(/^:::format\{([^}]*\.pkc-place[^}]*)\}$/gm)].map((m) => m[1]!);
  const n = (a: string, k: string): number => Number(new RegExp(`(?:^|\\s)${k}=(\\d+)`).exec(a)![1]);

  it('🔴 rotate= と group= が戻る。回した付箋がある板でも絶対位置が戻る', () => {
    const src = [
      { x: 60, y: 80, w: 200, h: 100, o: { rotate: 30, group: 'チームA', name: 'a' } },
      { x: 360, y: 80, w: 160, h: 100, o: { group: 'チームA' } },
      { x: 60, y: 300, w: 200, h: 100, o: { rotate: 90, name: 'c' } },
      { x: 360, y: 300, w: 160, h: 100, o: {} },
    ];
    const blocks: ExportBlock[] = [
      ...src.flatMap((s, i) => note(s.x, s.y, s.w, s.h, `付${i}`, s.o)),
      { kind: 'place-line', from: 'a', to: 'c', fromAnchor: null, toAnchor: null, route: null },
    ];
    const got = readPptxSlide(slideOf(blocks));
    const as = attrsOf(got.body);
    expect(as.length, '空振り防止').toBe(4);
    expect(got.dropped).toBe(0);
    expect(got.lines, '線も戻る').toBe(1);
    src.forEach((s, i) => {
      const a = as[i]!;
      expect(Math.abs(n(a, 'x') - s.x), `x[${i}]`).toBeLessThanOrEqual(TOL);
      expect(Math.abs(n(a, 'y') - s.y), `y[${i}]`).toBeLessThanOrEqual(TOL);
      expect(Math.abs(n(a, 'w') - s.w), `w[${i}]`).toBeLessThanOrEqual(TOL);
      expect(Math.abs(n(a, 'h') - s.h), `h[${i}]`).toBeLessThanOrEqual(TOL);
    });
    expect(as[0]).toContain('rotate=30');
    expect(as[2]).toContain('rotate=90');
    expect(as[1]).not.toContain('rotate=');
    expect(as[3]).not.toContain('rotate=');
    expect(as[0]).toContain('group=チームA');
    expect(as[1]).toContain('group=チームA');
    expect(as[2]).not.toContain('group=');
    expect(as[3]).not.toContain('group=');
  });

  it('🔴 いちばん右が 30° 回した付箋(外接四角の右端が整数 px でない)でも、絶対位置が戻る', () => {
    // 右端 = 中心 (160,130) + 半幅 111.6 = 271.6px(整数でない)。左の付箋は x=40 なので、相対位置へ倒れると x が 40 ずれる
    const got = readPptxSlide(slideOf([...note(60, 80, 200, 100, 'R', { rotate: 30 }), ...note(40, 300, 100, 60, 'L')]));
    const as = attrsOf(got.body);
    expect(as.length).toBe(2);
    expect(Math.abs(n(as[0]!, 'x') - 60), 'x[0]').toBeLessThanOrEqual(TOL);
    expect(Math.abs(n(as[0]!, 'y') - 80), 'y[0]').toBeLessThanOrEqual(TOL);
    expect(Math.abs(n(as[1]!, 'x') - 40), 'x[1]').toBeLessThanOrEqual(TOL);
    expect(Math.abs(n(as[1]!, 'y') - 300), 'y[1]').toBeLessThanOrEqual(TOL);
  });

  it('🔴 上へだけ出る 30° の付箋(縦の原点が動く)でも、横の絶対位置は戻る', () => {
    // y=0 の付箋を 30° → 見た目の上端は約 −43px(原点が動く)。横は動かないので x は元のまま戻る(相対位置へ倒れると 40 ずれる)
    const got = readPptxSlide(slideOf([...note(60, 0, 200, 100, 'T', { rotate: 30 }), ...note(40, 300, 100, 60, 'L')]));
    const as = attrsOf(got.body);
    expect(as.length).toBe(2);
    expect(Math.abs(n(as[0]!, 'x') - 60), 'x[0]').toBeLessThanOrEqual(TOL);
    expect(Math.abs(n(as[1]!, 'x') - 40), 'x[1]').toBeLessThanOrEqual(TOL);
    expect(n(as[0]!, 'y'), 'y は 0 以上').toBeGreaterThanOrEqual(0);
    expect(Math.abs(n(as[1]!, 'y') - n(as[0]!, 'y') - 300), '縦の差は保たれる').toBeLessThanOrEqual(TOL);
  });

  it('対照群 ── PKC3 の板でない file(枠の取り方が合わない)は相対位置で読む。回転の許容で広げない', () => {
    // 右端 8000001 EMU / 下端 4179571 EMU は 9525 の倍数でない(書き出しの枠の取り方に合わない)。倍数の検めを外して逆算すると x=203 になるが、相対位置なら 0
    const xml =
      '<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p" xmlns:r="r"><p:cSld><p:spTree>'
      + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
      + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
      + '<p:spPr><a:xfrm><a:off x="6095001" y="3227071"/><a:ext cx="1905000" cy="952500"/></a:xfrm>'
      + '<a:prstGeom prst="rect"/></p:spPr><p:txBody><a:p><a:r><a:t>t</a:t></a:r></a:p></p:txBody></p:sp>'
      + '</p:spTree></p:cSld></p:sld>';
    const as = attrsOf(readPptxSlide(xml).body);
    expect(as.length).toBe(1);
    expect(n(as[0]!, 'x')).toBe(0);
    expect(n(as[0]!, 'y')).toBe(0);
  });

  it('板の左上より外へ出る回転でも、付箋どうしの位置関係は保たれ、座標は負にならない', () => {
    // 0,0 の付箋を 90° → 見た目は上へ 50px はみ出す
    const got = readPptxSlide(slideOf([...note(0, 0, 200, 100, 'A', { rotate: 90 }), ...note(300, 200, 200, 100, 'B')]));
    const as = attrsOf(got.body);
    expect(as.length).toBe(2);
    expect(n(as[0]!, 'y')).toBeGreaterThanOrEqual(0);
    // 元の差 (300, 200) が保たれる
    expect(Math.abs(n(as[1]!, 'x') - n(as[0]!, 'x') - 300)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(n(as[1]!, 'y') - n(as[0]!, 'y') - 200)).toBeLessThanOrEqual(TOL);
    expect(as[0]).toContain('rotate=90');
  });

  it('グループ名が付いていない / 読めない名前の群は、取り込みで グループN になる(札が 1 つ以上増えない)', () => {
    const got = readPptxSlide(slideOf([
      ...note(40, 40, 200, 100, 'a', { group: 'チーム' }),
      ...note(300, 40, 200, 100, 'b', { group: 'チーム' }),
    ]));
    const as = attrsOf(got.body);
    expect(as.every((a) => a.includes('group=チーム'))).toBe(true);
  });
});

describe('🔴 取り込み ── <p:grpSp> を開いて平らにする', () => {
  const wrap = (inner: string): string =>
    '<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p" xmlns:r="r"><p:cSld><p:spTree>'
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
    + `${inner}</p:spTree></p:cSld></p:sld>`;
  const sp = (id: number, x: number, y: number, w = 1000000, h = 500000, extra = '', xfrmAttr = ''): string =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm${xfrmAttr}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"/>${extra}</p:spPr><p:txBody><a:p><a:r><a:t>t${id}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const grp = (
    name: string,
    f: { off: [number, number]; ext: [number, number]; chOff: [number, number]; chExt: [number, number]; rot?: number },
    inner: string,
  ): string =>
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${900 + name.length}" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>`
    + `<p:grpSpPr><a:xfrm${f.rot === undefined ? '' : ` rot="${f.rot}"`}><a:off x="${f.off[0]}" y="${f.off[1]}"/><a:ext cx="${f.ext[0]}" cy="${f.ext[1]}"/>`
    + `<a:chOff x="${f.chOff[0]}" y="${f.chOff[1]}"/><a:chExt cx="${f.chExt[0]}" cy="${f.chExt[1]}"/></a:xfrm></p:grpSpPr>`
    + `${inner}</p:grpSp>`;
  const attrsOf = (body: string): string[] =>
    [...body.matchAll(/^:::format\{([^}]*\.pkc-place[^}]*)\}$/gm)].map((m) => m[1]!);
  const n = (a: string, k: string): number => Number(new RegExp(`(?:^|\\s)${k}=(\\d+)`).exec(a)![1]);
  const IDENT = { chOff: [0, 0] as [number, number], chExt: [1, 1] as [number, number] };

  it('🔴 群の中の付箋が板に出る(もう「取り込めなかった物」に数えない)。名前が読めない群は グループ1', () => {
    const got = readPptxSlide(wrap(
      grp('Group 5', { off: [1000000, 2000000], ext: [4000000, 2000000], chOff: [0, 0], chExt: [2000000, 1000000] },
        sp(2, 0, 0) + sp(3, 1000000, 500000)),
    ));
    expect(got.placed).toBe(2);
    expect(got.dropped).toBe(0);
    const as = attrsOf(got.body);
    expect(as.length).toBe(2);
    expect(as[0]).toContain('group=グループ1');
    expect(as[1]).toContain('group=グループ1');
  });

  it('🔴 座標は off + (子 − chOff) × ext/chExt で戻る(2 倍に拡大した群)', () => {
    const got = readPptxSlide(wrap(
      grp('Team', { off: [1000000, 2000000], ext: [4000000, 2000000], chOff: [0, 0], chExt: [2000000, 1000000] },
        sp(2, 0, 0) + sp(3, 1000000, 500000)),
    ));
    const as = attrsOf(got.body);
    // 子 2: (0,0) 1000000×500000 → (1000000,2000000) 2000000×1000000。子 3: (1000000,500000) → (3000000,3000000)
    // 原点は左上の最小 = 子 2 の位置 → 子 2 は (0,0)、子 3 は (2000000,1000000) EMU = (210, 105) px
    expect(n(as[0]!, 'x')).toBe(0);
    expect(n(as[0]!, 'y')).toBe(0);
    expect(n(as[0]!, 'w')).toBe(Math.round(2000000 / 9525));
    expect(n(as[0]!, 'h')).toBe(Math.round(1000000 / 9525));
    expect(n(as[1]!, 'x')).toBe(Math.round(2000000 / 9525));
    expect(n(as[1]!, 'y')).toBe(Math.round(1000000 / 9525));
    expect(as[0]).toContain('group=Team');
  });

  it('🔴 回した群: 子の中心を群の中心の周りに回し、子の向きに群の向きを足す(90°)', () => {
    const got = readPptxSlide(wrap(
      grp('Turn', { off: [1000000, 1000000], ext: [2000000, 1000000], chOff: [1000000, 1000000], chExt: [2000000, 1000000], rot: 5400000 },
        sp(2, 1000000, 1000000, 1000000, 1000000) + sp(3, 2000000, 1000000, 1000000, 1000000)),
    ));
    const as = attrsOf(got.body);
    expect(as.length).toBe(2);
    // 群の中心 (2000000,1500000)。子 2 の中心 (1500000,1500000) → 90° 右回りで (2000000,1000000)、子 3 (2500000,1500000) → (2000000,2000000)
    // 角の取り方: 正方形なので回した後の四角は (1500000,500000) と (1500000,1500000)。原点は外接四角の左上 = (1500000,500000)
    expect(n(as[0]!, 'x')).toBe(0);
    expect(n(as[0]!, 'y')).toBe(0);
    expect(n(as[1]!, 'x')).toBe(0);
    expect(n(as[1]!, 'y')).toBe(Math.round(1000000 / 9525));
    expect(as[0]).toContain('rotate=90');
    expect(as[1]).toContain('rotate=90');
  });

  it('🔴 入れ子: 内側の名前だけが残り、外側の直接の子は外側の名前。入れ子の数を言う', () => {
    const got = readPptxSlide(wrap(
      grp('Outer', { off: [0, 0], ext: [1, 1], ...IDENT },
        grp('Inner', { off: [0, 0], ext: [1, 1], ...IDENT }, sp(2, 0, 0) + sp(3, 2000000, 0))
        + sp(4, 0, 1000000) + sp(5, 2000000, 1000000)),
    ));
    const as = attrsOf(got.body);
    expect(as.length).toBe(4);
    expect(as.filter((a) => a.includes('group=Inner')).length).toBe(2);
    expect(as.filter((a) => a.includes('group=Outer')).length, '外側の直接の子').toBe(2);
    expect(got.simplified, '入れ子 1 つ').toBe(1);
    expect(got.dropped).toBe(0);
  });

  it('🔴 同じ名前の群は 2 つ目から グループN。読める名前の グループ1 を番号が奪わない', () => {
    const got = readPptxSlide(wrap(
      grp('Team', { off: [0, 0], ext: [1, 1], ...IDENT }, sp(2, 0, 0) + sp(3, 2000000, 0))
      + grp('Team', { off: [0, 0], ext: [1, 1], ...IDENT }, sp(4, 0, 1000000) + sp(5, 2000000, 1000000))
      + grp('a b', { off: [0, 0], ext: [1, 1], ...IDENT }, sp(6, 0, 2000000) + sp(7, 2000000, 2000000))
      + grp('グループ1', { off: [0, 0], ext: [1, 1], ...IDENT }, sp(8, 0, 3000000) + sp(9, 2000000, 3000000)),
    ));
    const as = attrsOf(got.body);
    const names = as.map((a) => /group=(\S+)/.exec(a)![1]);
    // 1 組目 Team / 2 組目 重複 → 番号 / 3 組目 読めない → 番号 / 4 組目 グループ1(読める名前を先に確保)
    expect(names[0]).toBe('Team');
    expect(names[1]).toBe('Team');
    expect(names[6]).toBe('グループ1');
    expect(names[7]).toBe('グループ1');
    expect(names[2]).toBe(names[3]);
    expect(names[4]).toBe(names[5]);
    expect(new Set(names).size, '4 つの群は 4 つの名前').toBe(4);
    expect(names[2]).not.toBe('グループ1');
    expect(names[4]).not.toBe('グループ1');
    expect(names[2]).not.toBe(names[4]);
  });

  it('1 枚しか残らない群は作らない。群の中の線(つなぎ先)は読める', () => {
    const cxn =
      '<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="20" name="線"/><p:cNvCxnSpPr><a:stCxn id="2" idx="3"/><a:endCxn id="4" idx="1"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr/></p:cxnSp>';
    const got = readPptxSlide(wrap(
      grp('ひとり', { off: [0, 0], ext: [1, 1], ...IDENT }, sp(2, 0, 0) + sp(3, 9999999, 9999999).replace(/<a:off[^>]*\/>/, '') + cxn)
      + sp(4, 3000000, 0),
    ));
    // 3 は位置なしで落ちる → 群は 1 枚 → group= を書かない
    expect(got.dropped).toBe(1);
    expect(got.lines, '群の中の図形を指す線も繋がる').toBe(1);
    expect(attrsOf(got.body).some((a) => a.includes('group='))).toBe(false);
  });

  it('群の中の図・表は取り込めなかった物として数える', () => {
    const got = readPptxSlide(wrap(grp('G', { off: [0, 0], ext: [1, 1], ...IDENT }, sp(2, 0, 0) + sp(3, 2000000, 0) + '<p:pic><p:nvPicPr/></p:pic>')));
    expect(got.placed).toBe(2);
    expect(got.dropped).toBe(1);
  });
});

describe('🔴 取り込み ── rot を rotate= に戻す', () => {
  const wrap = (inner: string): string =>
    '<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p" xmlns:r="r"><p:cSld><p:spTree>'
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
    + `${inner}</p:spTree></p:cSld></p:sld>`;
  const sp = (id: number, xfrmAttr: string): string =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm${xfrmAttr}><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm>`
    + `<a:prstGeom prst="rect"/></p:spPr><p:txBody><a:p><a:r><a:t>t</a:t></a:r></a:p></p:txBody></p:sp>`;
  const rotOf = (xfrmAttr: string): string | null => {
    const m = /rotate=(\d+)/.exec(readPptxSlide(wrap(sp(2, xfrmAttr))).body);
    return m === null ? null : m[1]!;
  };

  it.each([
    [' rot="900000"', '15'],
    [' rot="5400000"', '90'],
    [' rot="21540000"', '359'],
    [' rot="-900000"', '345'], // 負は mod 360
    [' rot="21600000"', null], // 360° = 回していない
    [' rot="0"', null],
    ['', null],
    [' rot="934000"', '16'], // 15.57° → 整数へ丸める
    [' rot="21590000"', null], // 359.83° → 360 = 0
  ])('%s → rotate=%s(0 は札を書かない)', (attr, want) => {
    expect(rotOf(attr)).toBe(want);
  });

  it('反転(flipH / flipV)は読まず、直した付箋の数に足す', () => {
    const got = readPptxSlide(wrap(sp(2, ' flipH="1"') + sp(3, '')));
    expect(got.simplified).toBe(1);
    expect(got.placed).toBe(2);
  });
});
