/**
 * 🔴 バックアップのピン留めを戻す口(`importNotePinsInto`)の実際の挙動(#1377)。
 * 観測点: ①足りない分だけ足す(在るピンは書き直さない) ②生きているピンが上限なら見送る(ゴミ箱・消えたノートの分は数えない)
 * ③足した lid を返す(取り消しが外す対象) ④書けなかったら throw する(取り込み側が注意に回す)。
 */
import { describe, expect, it } from 'vitest';
import { importNotePinsInto } from '../../src/adapter/platform/note-pin-import';

function setup(now: string[], live: (l: string) => boolean, limit = 3) {
  const put: string[] = [];
  const deps = {
    list: async () => now,
    put: async (l: string) => void put.push(l),
    exists: live,
    limit,
  };
  return { put, deps };
}

describe('バックアップのピン留めを戻す(importNotePinsInto)', () => {
  it('足りない分だけ足し、足した lid を返す(在るピン・重複は書かない)', async () => {
    const { put, deps } = setup(['a'], () => true);
    const r = await importNotePinsInto(['a', 'b', 'b', 'c'], deps);
    expect(put).toEqual(['b', 'c']);
    expect(r).toEqual({ added: 2, overLimit: 0, addedLids: ['b', 'c'] });
  });

  it('🔴 生きているピンが上限に達したら見送り、件数を返す', async () => {
    const { put, deps } = setup(['a', 'b'], () => true, 3);
    const r = await importNotePinsInto(['c', 'd', 'e'], deps);
    expect(put).toEqual(['c']);
    expect(r).toEqual({ added: 1, overLimit: 2, addedLids: ['c'] });
  });

  it('🔴 消えた・ゴミ箱のノートのピンは満杯の数に入れない', async () => {
    const { put, deps } = setup(['x1', 'x2', 'x3', 'a'], (l) => l === 'a', 3);
    const r = await importNotePinsInto(['b', 'c'], deps);
    expect(put, '消えたピンを数えて断った').toEqual(['b', 'c']);
    expect(r.overLimit).toBe(0);
  });

  it('書けなかったら throw する', async () => {
    const deps = { list: async () => [], put: async () => Promise.reject(new Error('x')), exists: () => true, limit: 3 };
    await expect(importNotePinsInto(['a'], deps)).rejects.toThrow();
  });
});
