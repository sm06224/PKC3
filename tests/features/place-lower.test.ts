/**
 * 🔴 **付箋を後ろへ送る**(依頼 118-1。Gemini の回答「推薦どおり」= A)。
 *
 * 負の z は描画が捨てるので、書ける最小は 0。観測点は「書いた後の各付箋の z」と「触った行の数」:
 *   - 他の付箋が全部 z≥1 → この付箋の z だけが動く(他は 1 バイトも触らない)
 *   - 0(z の無い付箋を含む)が居る → 他を全部 1 つ上げて、この付箋を 0 にする(順番は保つ)
 *   - 既にいちばん後ろ / 他に付箋が無い → body をそのまま返し、メニューにも出さない
 */
import { describe, expect, it } from 'vitest';
import { lowerPlace, placeIsBackmost, raisePlace } from '../../src/features/markdown/place-notation';
import { blockMenuActions } from '../../src/features/entry-actions';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';

const A = ':::format{#a .pkc-place x=1 y=1}';
const B = ':::format{#b .pkc-place x=2 y=2 z=3}';
const C = ':::format{#c .pkc-place x=3 y=3 z=5}';
const body = (...opens: string[]): string => opens.flatMap((o, i) => [o, `p${String(i)}`, ':::', '']).join('\n');
const zs = (b: string): Array<number | null> =>
  b
    .split('\n')
    .filter((l) => l.includes('.pkc-place'))
    .map((l) => {
      const m = /\bz=(\d+)/.exec(l);
      return m === null ? null : Number(m[1]);
    });
const lineOf = (b: string, id: string): number => b.split('\n').findIndex((l) => l.includes(`#${id} `));

describe('lowerPlace', () => {
  it('他が全部 z>=1 なら、この付箋の z だけを「最小 - 1」にする(他の行は 1 バイトも触らない)', () => {
    const b = body(B, C);
    const withD = `${b}:::format{#d .pkc-place x=9 y=9 z=7}\nd\n:::\n`;
    const at = lineOf(withD, 'd');
    const r = lowerPlace(withD, { line: at, openLine: withD.split('\n')[at]! })!;
    expect(zs(r)).toEqual([3, 5, 2]);
    // 触ったのは自分の開き行だけ
    const before = withD.split('\n');
    const after = r.split('\n');
    expect(after.map((l, i) => (l === before[i] ? null : i)).filter((x) => x !== null)).toEqual([at]);
  });

  it('0 の付箋(z の無い付箋を含む)が居るときは、他を全部 1 つ上げて自分を 0 にする(順番は保つ)', () => {
    const b = body(A, B, C);
    const at = lineOf(b, 'c');
    const r = lowerPlace(b, { line: at, openLine: b.split('\n')[at]! })!;
    // a: なし→1 / b: 3→4 / c: 5→0。b より前の順(a < b)は保たれる
    expect(zs(r)).toEqual([1, 4, 0]);
    expect(r.split('\n').filter((l) => l.includes('#c '))[0]).toContain('z=0');
  });

  it('引き分け(同じ z が並ぶ)でも 1 つ下げる / 既に独りでいちばん後ろなら body をそのまま返す', () => {
    const tie = body(':::format{#a .pkc-place x=1 y=1 z=2}', ':::format{#b .pkc-place x=2 y=2 z=2}');
    const at = lineOf(tie, 'b');
    const r = lowerPlace(tie, { line: at, openLine: tie.split('\n')[at]! })!;
    expect(zs(r)).toEqual([2, 1]);
    const back = body(':::format{#a .pkc-place x=1 y=1 z=1}', ':::format{#b .pkc-place x=2 y=2 z=4}');
    const atA = lineOf(back, 'a');
    expect(lowerPlace(back, { line: atA, openLine: back.split('\n')[atA]! })).toBe(back);
    expect(placeIsBackmost(back, atA)).toBe(true);
    expect(placeIsBackmost(back, lineOf(back, 'b'))).toBe(false);
  });

  it('他に付箋が無い / fence の中の付箋は数えない / 開き行がずれていれば断る(null)', () => {
    const only = body(A);
    expect(lowerPlace(only, { line: 0, openLine: A })).toBe(only);
    expect(placeIsBackmost(only, 0)).toBe(true);
    const inFence = ['```', ':::format{.pkc-place x=1 y=1 z=0}', '```', '', B, 'b', ':::', ''].join('\n');
    const at = lineOf(inFence, 'b');
    // fence の中の z=0 はコードの字 ── 数えないので「他に付箋が無い」= 既に後ろ
    expect(lowerPlace(inFence, { line: at, openLine: inFence.split('\n')[at]! })).toBe(inFence);
    expect(lowerPlace(only, { line: 0, openLine: ':::format{#zz .pkc-place}' })).toBeNull();
  });

  it('前へ出す(raisePlace)と対 ── 後ろへ送った付箋は、前へ出すと元の前後に戻れる', () => {
    const b = body(A, B, C);
    const at = lineOf(b, 'c');
    const low = lowerPlace(b, { line: at, openLine: b.split('\n')[at]! })!;
    const atLow = lineOf(low, 'c');
    const up = raisePlace(low, { line: atLow, openLine: low.split('\n')[atLow]! })!;
    const zc = zs(up)[2]!;
    expect(zc, '前へ出したのに他より前にならない').toBeGreaterThan(Math.max(zs(up)[0]!, zs(up)[1]!));
  });

  it('書換の口(applyBodyRewrite の place-lower)も同じ結果を返す', () => {
    const b = body(A, B, C);
    const at = lineOf(b, 'c');
    const open = b.split('\n')[at]!;
    expect(applyBodyRewrite(b, { kind: 'place-lower', line: at, openLine: open })).toBe(
      lowerPlace(b, { line: at, openLine: open }),
    );
  });
});

describe('右クリックの一覧(blockMenuActions)', () => {
  const labels = (ctx: Parameters<typeof blockMenuActions>[0]): string[] => blockMenuActions(ctx).map((a) => a.label);

  it('🔴 板の上に「後ろへ送る」が出る / 既にいちばん後ろなら出さない(押しても本文が変わらない口を作らない)', () => {
    expect(labels({ board: true })).toContain('後ろへ送る');
    expect(labels({ board: true })).toContain('前へ出す');
    expect(labels({ board: true, back: true })).not.toContain('後ろへ送る');
    expect(labels({ board: true, back: true })).toContain('前へ出す');
    expect(labels({ board: true, front: true })).not.toContain('前へ出す');
    expect(labels({ board: true, front: true })).toContain('後ろへ送る');
    expect(blockMenuActions({ board: true }).find((a) => a.label === '後ろへ送る')?.action).toBe('lower-place');
  });

  it('板でない塊には出ない', () => {
    expect(labels({ board: false })).not.toContain('後ろへ送る');
  });
});
