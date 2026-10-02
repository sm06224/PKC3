/**
 * 描いた頁の絵の置き場(`public/pdf/page-cache.js`)── **外れたら即 revoke する**(#275 段①)。
 *
 * 🔴 不可侵指示(2026-07-27):生成物は寿命の終端で破棄する。ここでの終端は
 * 「置き場から押し出された」「見える範囲の前後 2 頁から外れた」「置き直された」「全部返す」の 4 つで、
 * **どれでも revoke が必ず 1 度**呼ばれることを見る(呼ばれない経路が在ると、窓を閉じるまで blob が積もる)。
 *
 * ⚠ **この file の原文を読んで走らせる**(`public/` は bundle を通らないので import できない)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Cache {
  put(page: number, url: string): number[];
  get(page: number): string | null;
  has(page: number): boolean;
  retain(keep: Set<number>): number[];
  clear(): void;
  map: Map<number, string>;
}
interface Api {
  PageCache: new (limit: number, revoke: (url: string) => void) => Cache;
  windowOf(first: number, last: number, total: number, radius: number): Set<number>;
}

function load(): Api {
  const root: { PkcPdfPageCache?: Api } = {};
  // 実物を走らせる(原文を読んで関数として評価する)
  new Function('self', readFileSync('public/pdf/page-cache.js', 'utf-8'))(root);
  expect(root.PkcPdfPageCache, '原文が API を公開していない(空振り)').toBeDefined();
  return root.PkcPdfPageCache as Api;
}

function make(limit: number): { cache: Cache; revoked: string[]; api: Api } {
  const api = load();
  const revoked: string[] = [];
  return { cache: new api.PageCache(limit, (u) => revoked.push(u)), revoked, api };
}

describe('PageCache ── LRU から外れた頁の URL は、その場で revoke される', () => {
  it('上限を超えて置くと、使われていない順に revoke され、その頁番号が返る', () => {
    const { cache, revoked } = make(3);
    expect(cache.put(1, 'u1')).toEqual([]);
    cache.put(2, 'u2');
    cache.put(3, 'u3');
    expect(revoked).toEqual([]);
    expect(cache.put(4, 'u4')).toEqual([1]);
    expect(revoked).toEqual(['u1']);
    expect([...cache.map.keys()]).toEqual([2, 3, 4]);
  });

  it('get は「使った」扱いで末尾へ回す ── 押し出されるのは本当に古い頁(対照: get しなければ先頭が出る)', () => {
    const a = make(3);
    a.cache.put(1, 'u1');
    a.cache.put(2, 'u2');
    a.cache.put(3, 'u3');
    expect(a.cache.get(1)).toBe('u1');
    a.cache.put(4, 'u4');
    expect(a.revoked).toEqual(['u2']); // 1 は使ったので残り、2 が出る

    const b = make(3);
    b.cache.put(1, 'u1');
    b.cache.put(2, 'u2');
    b.cache.put(3, 'u3');
    b.cache.put(4, 'u4');
    expect(b.revoked).toEqual(['u1']);
  });

  it('同じ頁を置き直すと、古い URL を先に返す(差し替えで積もらない)', () => {
    const { cache, revoked } = make(3);
    cache.put(1, 'old');
    cache.put(1, 'new');
    expect(revoked).toEqual(['old']);
    expect(cache.get(1)).toBe('new');
  });

  it('retain: 残す頁以外を全部 revoke し、外した頁番号を返す(残した頁は触らない)', () => {
    const { cache, revoked } = make(10);
    for (const p of [1, 2, 3, 4, 5]) cache.put(p, `u${String(p)}`);
    expect(cache.retain(new Set([3, 4, 5, 6])).sort()).toEqual([1, 2]);
    expect(revoked.sort()).toEqual(['u1', 'u2']);
    expect(cache.has(3) && cache.has(4) && cache.has(5)).toBe(true);
    expect(cache.has(1) || cache.has(2)).toBe(false);
  });

  it('clear: 全部返す(拡大したとき / 窓を閉じるとき)', () => {
    const { cache, revoked } = make(10);
    cache.put(1, 'u1');
    cache.put(2, 'u2');
    cache.clear();
    expect(revoked.sort()).toEqual(['u1', 'u2']);
    expect(cache.map.size).toBe(0);
  });

  it('revoke は 1 URL につき 1 度だけ(二重に返さない)', () => {
    const { cache, revoked } = make(2);
    cache.put(1, 'u1');
    cache.put(2, 'u2');
    cache.put(3, 'u3'); // u1 を返す
    cache.retain(new Set([3])); // u2 を返す
    cache.clear(); // u3 を返す
    expect(revoked.slice().sort()).toEqual(['u1', 'u2', 'u3']);
  });
});

describe('windowOf ── 見えている頁の前後 N 頁(1〜total に収める)', () => {
  const { api } = make(1);
  it('前後 2 頁', () => {
    expect([...api.windowOf(5, 6, 20, 2)]).toEqual([3, 4, 5, 6, 7, 8]);
  });
  it('端では収める', () => {
    expect([...api.windowOf(1, 1, 20, 2)]).toEqual([1, 2, 3]);
    expect([...api.windowOf(20, 20, 20, 2)]).toEqual([18, 19, 20]);
    expect([...api.windowOf(1, 1, 1, 2)]).toEqual([1]);
  });
});
