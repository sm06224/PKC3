/** @vitest-environment happy-dom */
/**
 * 🔴 portable(`file://` で開く単一 HTML)で、localStorage の記録を bundle ごとに分ける。
 *
 * ⚠ `file://` では origin が潰れ、別々の portable が同じ localStorage を共有する。
 *   分けないと B を開いた掃除・上書きが A の「最近開いた」「横に並べた枠」を消す。
 * 守るもの:鍵の選び方 / 分ける前の値を 1 度だけ読む / 書くのは分けた鍵だけ / 素の PKC3 の鍵は不変。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readScoped, scopedKey } from '../../src/adapter/platform/portable-scope';
import { OpenedStore, type OpenedStorage } from '../../src/adapter/platform/opened-store';
import { loadSplitLids, saveSplitLids } from '../../src/adapter/platform/split-store';

/** 鍵まで見る偽の保存(全部の portable が共有する localStorage を模す)。 */
function shared(initial: Record<string, string> = {}): OpenedStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => void data.set(k, v),
    remove: (k) => void data.delete(k),
  };
}

describe('鍵の選び方', () => {
  it('素の PKC3 は今までの鍵のまま、portable は bundle id を足す', () => {
    expect(scopedKey('pkc3.opened', null)).toBe('pkc3.opened');
    expect(scopedKey('pkc3.opened', 'b1')).toBe('pkc3.opened:b1');
    expect(scopedKey('pkc3.split-lids', 'b1')).toBe('pkc3.split-lids:b1');
  });

  it('分けた鍵が無いときだけ、分ける前の鍵を読む(素の PKC3 は読み替えない)', () => {
    const data: Record<string, string> = { 'pkc3.x': 'old' };
    const get = (k: string): string | null => data[k] ?? null;
    expect(readScoped(get, 'pkc3.x', 'b1')).toBe('old');
    data['pkc3.x:b1'] = 'new';
    expect(readScoped(get, 'pkc3.x', 'b1'), '分けた鍵が在るのに古い値を読んだ').toBe('new');
    expect(readScoped(get, 'pkc3.x', 'b2'), '別の portable の値を読んだ').toBe('old');
    expect(readScoped(get, 'pkc3.x', null)).toBe('old');
    delete data['pkc3.x'];
    expect(readScoped(get, 'pkc3.x', null)).toBeNull();
  });
});

describe('最近開いた記録(OpenedStore)', () => {
  it('🔴 B を開いて掃除しても、A の記録は消えない', () => {
    const ls = shared();
    const a = new OpenedStore(ls, 'A');
    a.push('a1', 100);
    const b = new OpenedStore(ls, 'B');
    b.push('b1', 200);
    b.prune((lid) => lid === 'b1'); // B には a1 が居ない
    expect(new OpenedStore(ls, 'A').map().get('a1'), 'B の掃除で A の記録が消えた').toBe(100);
    expect(new OpenedStore(ls, 'B').map().has('a1')).toBe(false);
  });

  it('分ける前の値は 1 度だけ読み、書くのは分けた鍵だけ', () => {
    const ls = shared({ 'pkc3.opened': JSON.stringify([{ lid: 'old', at: 5 }]) });
    const store = new OpenedStore(ls);
    store.scopeTo('A');
    expect(store.map().get('old'), '分ける前の記録を引き継がない').toBe(5);
    store.push('n1', 9);
    expect(ls.data.get('pkc3.opened'), '古い鍵へ書いた').toBe(JSON.stringify([{ lid: 'old', at: 5 }]));
    expect(ls.data.has('pkc3.opened:A')).toBe(true);
    expect(store.map().get('n1')).toBe(9);
  });

  it('🔴 portable で「消す」と、分ける前の記録が戻ってこない', () => {
    const ls = shared({ 'pkc3.opened': JSON.stringify([{ lid: 'old', at: 5 }]) });
    const store = new OpenedStore(ls, 'A');
    store.clear();
    expect(store.list()).toEqual([]);
  });

  it('素の PKC3 は今までの鍵を使い、消すと鍵ごと消える', () => {
    const ls = shared();
    const store = new OpenedStore(ls);
    store.push('n1', 1);
    expect([...ls.data.keys()]).toEqual(['pkc3.opened']);
    store.clear();
    expect(ls.data.size).toBe(0);
  });
});

describe('横に並べた枠(split-store)', () => {
  afterEach(() => localStorage.clear());

  it('🔴 portable ごとに別の鍵で憶え、素の PKC3 の鍵は動かさない', () => {
    saveSplitLids(['a1', 'a2'], 'A');
    saveSplitLids(['b1'], 'B');
    expect(loadSplitLids('A')).toEqual(['a1', 'a2']);
    expect(loadSplitLids('B')).toEqual(['b1']);
    expect(localStorage.getItem('pkc3.split-lids'), '素の鍵へ書いた').toBeNull();
    saveSplitLids(['n1']);
    expect(localStorage.getItem('pkc3.split-lids')).toBe('n1');
    expect(loadSplitLids('A'), '素の PKC3 の保存が portable を上書きした').toEqual(['a1', 'a2']);
  });

  it('分ける前の値は、分けた鍵が無いあいだだけ読む', () => {
    localStorage.setItem('pkc3.split-lids', 'old1 old2');
    expect(loadSplitLids('A')).toEqual(['old1', 'old2']);
    saveSplitLids([], 'A'); // 全部外したことも憶える
    expect(loadSplitLids('A'), '全部外したのに古い値が戻った').toEqual([]);
    expect(localStorage.getItem('pkc3.split-lids')).toBe('old1 old2');
  });
});
