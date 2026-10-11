/**
 * ページの一覧の判断(`public/pdf/page-list.js`)── どの頁を描くか / どの頁を光らせるか(#275 段②-1a)。
 *
 * 🔴 不可侵指示:重い物は持ちすぎない。**100 頁の文書でも、一度に持つ絵は上限まで**(見えている頁の前後だけ)。
 * ⚠ **この file の原文を読んで走らせる**(`public/` は bundle を通らないので import できない)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Api {
  thumbWanted(visible: Iterable<number>, total: number, radius: number, limit: number, center: number): Set<number>;
  pickNext(wanted: Set<number>, skip: (p: number) => boolean, center: number): number | null;
  currentChange(prev: number, next: number, total: number): { off: number | null; on: number } | null;
}

function load(): Api {
  const root: { PkcPdfPageList?: Api } = {};
  new Function('self', readFileSync('public/pdf/page-list.js', 'utf-8'))(root);
  expect(root.PkcPdfPageList, '原文が API を公開していない(空振り)').toBeDefined();
  return root.PkcPdfPageList as Api;
}
const api = load();
const sorted = (s: Set<number>): number[] => [...s].sort((a, b) => a - b);

describe('thumbWanted ── 一覧で見えている頁の前後だけ描く', () => {
  it('見えている 10〜14 頁の前後 3 頁(7〜17)。外の頁は含まない', () => {
    const w = api.thumbWanted(new Set([10, 11, 12, 13, 14]), 100, 3, 40, 12);
    expect(sorted(w)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(w.has(6)).toBe(false);
    expect(w.has(18)).toBe(false);
  });

  it('端では 1〜total に収める(0 頁・total+1 頁は作らない)', () => {
    expect(sorted(api.thumbWanted(new Set([1, 2]), 100, 3, 40, 1))).toEqual([1, 2, 3, 4, 5]);
    expect(sorted(api.thumbWanted(new Set([99, 100]), 100, 3, 40, 100))).toEqual([96, 97, 98, 99, 100]);
  });

  it('何も見えていなければ空(一覧を隠している間は何も描かない)', () => {
    expect(api.thumbWanted(new Set(), 100, 3, 40, 1).size).toBe(0);
  });

  it('範囲の外の番号は無視する(0 や total+1 だけでは何も描かない)', () => {
    expect(api.thumbWanted(new Set([0, 101]), 100, 3, 40, 1).size).toBe(0);
  });

  it('🔴 上限を超えるときは center に近い順に limit 枚だけ(100 頁を一度に全部持たない)', () => {
    const all = new Set(Array.from({ length: 100 }, (_, i) => i + 1));
    const w = api.thumbWanted(all, 100, 3, 40, 50);
    expect(w.size).toBe(40);
    expect(w.has(50)).toBe(true);
    expect(w.has(1)).toBe(false);
    expect(w.has(100)).toBe(false);
    // 近い順に切れている(最も遠い頁でも center から 20 以内)
    expect(Math.max(...[...w].map((p) => Math.abs(p - 50)))).toBeLessThanOrEqual(20);
  });
});

describe('pickNext ── 次に描く頁は、まだ無い頁のうち center にいちばん近い物', () => {
  it('持っている頁・描いている最中の頁は飛ばす', () => {
    const wanted = new Set([4, 5, 6, 7]);
    expect(api.pickNext(wanted, () => false, 6)).toBe(6);
    expect(api.pickNext(wanted, (p) => p === 6, 6)).toBe(5); // 同じ近さなら若い頁
    expect(api.pickNext(wanted, (p) => p !== 7, 1)).toBe(7);
  });
  it('全部持っているなら null(描き続けない)', () => {
    expect(api.pickNext(new Set([1, 2]), () => true, 1)).toBeNull();
    expect(api.pickNext(new Set(), () => false, 1)).toBeNull();
  });
});

describe('currentChange ── いまの頁の光らせ方', () => {
  it('3 → 4: 3 を消して 4 を点ける', () => {
    expect(api.currentChange(3, 4, 10)).toEqual({ off: 3, on: 4 });
  });
  it('最初(まだどこも光らせていない 0)→ 1: 消す物は無い', () => {
    expect(api.currentChange(0, 1, 10)).toEqual({ off: null, on: 1 });
  });
  it('変わらない / 範囲の外 は null(何もしない)', () => {
    expect(api.currentChange(4, 4, 10)).toBeNull();
    expect(api.currentChange(4, 0, 10)).toBeNull();
    expect(api.currentChange(4, 11, 10)).toBeNull();
  });
});
