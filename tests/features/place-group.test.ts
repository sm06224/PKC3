/**
 * 🔴 **板の付箋のグループ**(#530 段⑤b。Gemini 裁定 2026-10-11 依頼 19 Q3)── 記法と書き込み(pure)。
 *
 * 守る主張:
 * 1. 記法は付箋の開き行の `group=名前`。読めない名前・値なしは「グループに入っていない」(本文は消さない)
 * 2. 「グループにする」は選んだ付箋の全部に同じ `グループN`(使われていない最小の N)を書く。2 枚未満・門が 1 つでも外れたら 1 バイトも書かない
 * 3. 「グループを解く」は同じ名前の全員の札を消す(位置は動かさない)。入っていない付箋は body をそのまま返す
 * 4. 全員を一度に動かす(`movePlaces`)── 1 枚でも門が外れたら 1 枚も書かない。全員が元の位置なら body をそのまま返す
 * 5. 動かす量の下限は全員で同じだけ手前で止める(形を崩さない)。1 枚だけなら今までの `max(0, …)` と同じ
 * 6. 古い本文(`group=` を持たない)は 1 バイトも変わらない
 */
import { describe, expect, it } from 'vitest';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import {
  clampGroupDelta,
  groupPlaces,
  movePlaces,
  parsePlaceGroup,
  placeGroupAt,
  placeGroupItems,
  ungroupPlace,
} from '../../src/features/markdown/place-notation';

const A = ':::format{#a .pkc-place x=10 y=20 w=100 h=60}';
const B = ':::format{#b .pkc-place x=200 y=20 w=100 h=60}';
const C = ':::format{#c .pkc-place x=400 y=20 w=100 h=60}';
// 付箋 1 枚 = 5 行(開き行 / 最初の行 / 追記 / 閉じ / 空行)
const body = (...opens: string[]): string =>
  opens.flatMap((o, i) => [o, `付箋${i + 1}`, '追記', ':::', '']).join('\n');
const T = (b: string, n: number) => ({ line: n, openLine: b.split('\n')[n]! });
const lineOf = (b: string, i: number): string => b.split('\n')[i]!;
const at = (i: number): number => i * 5;

describe('記法 group=', () => {
  it('🔴 読める名前は拾い、読めない名前・値なしは「入っていない」', () => {
    expect(parsePlaceGroup('グループ1')).toBe('グループ1');
    expect(parsePlaceGroup('見積_2-b')).toBe('見積_2-b');
    for (const bad of ['', '  ', 'a b', 'a"b', "a'b", 'a=b', 'a,b', 'a}', true, undefined, 3]) {
      expect(parsePlaceGroup(bad), String(bad)).toBeNull();
    }
    expect(placeGroupAt(':::format{.pkc-place group=G1}')).toBe('G1');
    expect(placeGroupAt(':::format{.pkc-place group}')).toBeNull();
    expect(placeGroupAt(':::format{.pkc-place group="a b"}')).toBeNull();
  });

  it('⚠ 線の塊と板でない塊は、group= があっても付箋のグループではない', () => {
    expect(placeGroupAt(':::format{.pkc-line from=a to=b group=G1}')).toBeNull();
    expect(placeGroupAt(':::format{.pkc-card group=G1}')).toBeNull();
    // 両方のクラスを持つ塊は線として読む(書き出しと同じ) ── 付箋のグループには数えない
    expect(placeGroupAt(':::format{.pkc-place .pkc-line group=G1}')).toBeNull();
  });

  it('付箋の一覧: 最初の 1 行 / 入っているグループ / fence の中は数えない / 線は数えない', () => {
    const b = [
      A, '', '最初の行', '次の行', ':::', '',
      ':::format{#l .pkc-line from=a to=b}', ':::', '',
      '```', B, 'x', ':::', '```', '',
      ':::format{#d .pkc-place x=1 y=2 group=G1}', '長い' + 'あ'.repeat(60), ':::',
    ].join('\n');
    const items = placeGroupItems(b);
    expect(items.map((i) => i.line)).toEqual([0, 15]);
    expect(items[0]).toMatchObject({ label: '最初の行', group: null });
    expect(items[1]!.group).toBe('G1');
    expect(items[1]!.label.endsWith('…')).toBe(true);
    expect(items[1]!.label.length).toBe(41);
  });
});

describe('groupPlaces(グループにする)', () => {
  it('🔴 選んだ全部に同じ group=グループ1 を書き、ほかの字は 1 バイトも変えない', () => {
    const b = body(A, B, C);
    const out = groupPlaces(b, [T(b, at(0)), T(b, at(2))])!;
    expect(lineOf(out, at(0))).toBe(':::format{#a .pkc-place x=10 y=20 w=100 h=60 group=グループ1}');
    expect(lineOf(out, at(2))).toBe(':::format{#c .pkc-place x=400 y=20 w=100 h=60 group=グループ1}');
    expect(lineOf(out, at(1))).toBe(B);
    const rest = (s: string): string => s.split('\n').filter((_, i) => i !== at(0) && i !== at(2)).join('\n');
    expect(rest(out)).toBe(rest(b));
  });

  it('名前は使われていない最小の N(欠番を埋める)', () => {
    const b = body(
      ':::format{#a .pkc-place x=1 y=1 group=グループ1}',
      ':::format{#b .pkc-place x=2 y=1 group=グループ1}',
      ':::format{#c .pkc-place x=3 y=1 group=グループ3}',
      ':::format{#d .pkc-place x=4 y=1}',
      ':::format{#e .pkc-place x=5 y=1}',
    );
    const out = groupPlaces(b, [T(b, at(3)), T(b, at(4))])!;
    expect(placeGroupAt(lineOf(out, at(3)))).toBe('グループ2');
    expect(placeGroupAt(lineOf(out, at(4)))).toBe('グループ2');
  });

  it('🔴 2 枚未満は書かない(1 枚だけのグループは作らない)', () => {
    const b = body(A, B);
    expect(groupPlaces(b, [T(b, 0)])).toBeNull();
    expect(groupPlaces(b, [])).toBeNull();
  });

  it('🔴 1 枚でも門が外れたら 1 枚も書かない(開き行の食い違い / 同じ行を 2 度 / 付箋でない行 / fence の中 / 線)', () => {
    const b = body(A, B);
    expect(groupPlaces(b, [T(b, at(0)), { line: at(1), openLine: B + ' ' }])).toBeNull();
    expect(groupPlaces(b, [T(b, at(0)), T(b, at(0))])).toBeNull();
    expect(groupPlaces(b, [T(b, at(0)), T(b, 1)])).toBeNull();
    const fenced = ['```', A, 'x', ':::', '```', '', B, 'y', ':::'].join('\n');
    expect(groupPlaces(fenced, [T(fenced, 1), T(fenced, 6)])).toBeNull();
    const line = [A, 'x', ':::', '', ':::format{.pkc-line from=a to=b}', ':::'].join('\n');
    expect(groupPlaces(line, [T(line, 0), T(line, 4)])).toBeNull();
  });

  it('Tier 1 の寛容形(括弧なし)も、括弧つきへ整えて書ける', () => {
    const b = [':::.pkc-place', 'x', ':::', '', B, 'y', ':::'].join('\n');
    const out = groupPlaces(b, [T(b, 0), T(b, 4)])!;
    expect(placeGroupAt(lineOf(out, 0))).toBe('グループ1');
    expect(placeGroupAt(lineOf(out, 4))).toBe('グループ1');
  });

  it('別のグループに入っている付箋を渡すと、新しいグループへ移る(札が重ならない)', () => {
    const b = body(':::format{#a .pkc-place x=1 y=1 group=G9}', B);
    const out = groupPlaces(b, [T(b, 0), T(b, at(1))])!;
    expect(lineOf(out, 0).match(/group=/g)).toHaveLength(1);
    expect(placeGroupAt(lineOf(out, 0))).toBe('グループ1');
  });

  it('body-rewrite 経由でも同じ(place-group)', () => {
    const b = body(A, B);
    const viaRewrite = applyBodyRewrite(b, { kind: 'place-group', members: [T(b, at(0)), T(b, at(1))] });
    expect(viaRewrite).toBe(groupPlaces(b, [T(b, at(0)), T(b, at(1))]));
    expect(viaRewrite).not.toBe(b);
  });
});

describe('ungroupPlace(グループを解く)', () => {
  const grouped = (): string =>
    body(
      ':::format{#a .pkc-place x=10 y=20 group=G1}',
      ':::format{#b .pkc-place x=200 y=20 group=G1}',
      ':::format{#c .pkc-place x=400 y=20 group=G2}',
      ':::format{#d .pkc-place x=5 y=5}',
    );

  it('🔴 同じ名前の全員の札だけが消え、位置・別のグループ・入っていない付箋は 1 バイトも動かない', () => {
    const b = grouped();
    const out = ungroupPlace(b, T(b, at(0)))!;
    expect(lineOf(out, at(0))).toBe(':::format{#a .pkc-place x=10 y=20}');
    expect(lineOf(out, at(1))).toBe(':::format{#b .pkc-place x=200 y=20}');
    expect(lineOf(out, at(2))).toBe(':::format{#c .pkc-place x=400 y=20 group=G2}');
    expect(lineOf(out, at(3))).toBe(lineOf(b, at(3)));
  });

  it('入っていない付箋なら body をそのまま返す(null ではない = 競合の顔をしない)', () => {
    const b = grouped();
    expect(ungroupPlace(b, T(b, at(3)))).toBe(b);
  });

  it('読めない group= を持つだけの付箋は、その 1 枚の札だけ消す(ほかを巻き込まない)', () => {
    const b = body(':::format{#a .pkc-place x=1 y=1 group="a b"}', ':::format{#b .pkc-place x=2 y=1 group="a b"}');
    const out = ungroupPlace(b, T(b, 0))!;
    expect(lineOf(out, 0)).toBe(':::format{#a .pkc-place x=1 y=1}');
    expect(lineOf(out, at(1))).toBe(lineOf(b, at(1)));
  });

  it('門: 開き行が違えば null', () => {
    const b = grouped();
    expect(ungroupPlace(b, { line: 0, openLine: 'x' })).toBeNull();
  });

  it('グループにしてから解くと、元の本文に戻る(置けるなら外せる)', () => {
    const b = body(A, B, C);
    const g = groupPlaces(b, [T(b, at(0)), T(b, at(1))])!;
    expect(ungroupPlace(g, T(g, at(0)))).toBe(b);
  });

  it('body-rewrite 経由でも同じ(place-ungroup)', () => {
    const b = grouped();
    expect(applyBodyRewrite(b, { kind: 'place-ungroup', ...T(b, at(0)) })).toBe(ungroupPlace(b, T(b, at(0))));
  });
});

describe('movePlaces(全員を一度に動かす)', () => {
  const m = (b: string, i: number, x: number, y: number) => ({ ...T(b, at(i)), x, y });

  it('🔴 全員の x= y= だけを 1 回で書く', () => {
    const b = body(A, B, C);
    const out = movePlaces(b, [m(b, 0, 40, 50), m(b, 1, 230, 50)])!;
    expect(lineOf(out, at(0))).toBe(':::format{#a .pkc-place x=40 y=50 w=100 h=60}');
    expect(lineOf(out, at(1))).toBe(':::format{#b .pkc-place x=230 y=50 w=100 h=60}');
    expect(lineOf(out, at(2))).toBe(C);
  });

  it('🔴 1 枚でも門が外れたら 1 枚も書かない', () => {
    const b = body(A, B);
    expect(movePlaces(b, [m(b, 0, 40, 50), { line: at(1), openLine: B + 'x', x: 1, y: 1 }])).toBeNull();
    expect(movePlaces(b, [m(b, 0, -1, 0)])).toBeNull();
    expect(movePlaces(b, [m(b, 0, 1.5, 0)])).toBeNull();
    expect(movePlaces(b, [m(b, 0, 1, 1), m(b, 0, 2, 2)])).toBeNull();
    // 板の開き行でない行(本文の行)は、開き行の字が一致していても動かさない
    expect(movePlaces(b, [m(b, 0, 40, 50), { line: 1, openLine: '付箋1', x: 1, y: 1 }])).toBeNull();
    expect(movePlaces(b, [])).toBeNull();
  });

  it('全員が元の位置なら body をそのまま返す', () => {
    const b = body(A, B);
    expect(movePlaces(b, [m(b, 0, 10, 20), m(b, 1, 200, 20)])).toBe(b);
  });

  it('body-rewrite 経由でも同じ(place-move-group)', () => {
    const b = body(A, B);
    const moves = [m(b, 0, 40, 50), m(b, 1, 230, 50)];
    expect(applyBodyRewrite(b, { kind: 'place-move-group', moves })).toBe(movePlaces(b, moves));
  });
});

describe('clampGroupDelta(動かす量の下限)', () => {
  it('🔴 全員の左上が 0 を下回らないよう、全員で同じだけ手前で止める', () => {
    const starts = [{ x: 10, y: 20 }, { x: 200, y: 5 }];
    expect(clampGroupDelta(starts, -100, -100)).toEqual({ dx: -10, dy: -5 });
    expect(clampGroupDelta(starts, 30, 40)).toEqual({ dx: 30, dy: 40 });
  });

  it('1 枚だけなら今までの max(0, start + d) と同じ', () => {
    for (const [s, d] of [[10, -50], [10, -10], [10, 5], [0, -1], [0, 7]] as const) {
      const c = clampGroupDelta([{ x: s, y: s }], d, d);
      expect(s + c.dx).toBe(Math.max(0, s + d));
    }
  });
});
