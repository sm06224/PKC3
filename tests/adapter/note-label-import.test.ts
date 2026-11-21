/**
 * 🔴 バックアップの色ラベルを戻す口(`importNoteLabelsInto`)の実際の挙動(#1982 段 4)。
 * 観測点: ①いま一覧に無い lid は見送る ②いま付いている色は上書きしない ③足した件数を返す ④書けなければ throw
 */
import { describe, expect, it } from 'vitest';
import { importNoteLabelsInto } from '../../src/adapter/platform/note-label-import';

function setup(now: string[], live: string[]) {
  const put: Array<[string, number]> = [];
  const deps = {
    listLids: async () => now,
    put: async (l: string, c: number) => void put.push([l, c]),
    exists: (l: string) => live.includes(l),
  };
  return { put, deps };
}

describe('バックアップの色ラベルを戻す(importNoteLabelsInto)', () => {
  it('一覧に無い lid は見送る', async () => {
    const { put, deps } = setup([], ['a']);
    const r = await importNoteLabelsInto([{ lid: 'a', color: 2 }, { lid: 'gone', color: 3 }], deps);
    expect(put).toEqual([['a', 2]]);
    expect(r).toEqual({ added: 1, addedEntries: [{ lid: 'a', color: 2 }] });
  });

  it('いま付いている色は上書きしない', async () => {
    const { put, deps } = setup(['a'], ['a', 'b']);
    const r = await importNoteLabelsInto([{ lid: 'a', color: 5 }, { lid: 'b', color: 1 }], deps);
    expect(put).toEqual([['b', 1]]);
    expect(r.added).toBe(1);
    // 🔴 取り消しが外す対象は「足した行」だけ(前から在った a は入らない)
    expect(r.addedEntries).toEqual([{ lid: 'b', color: 1 }]);
  });

  it('往復: 取り込みで足した色は取り消しで外れ、前から在った色・付け直した色は残る', async () => {
    // 正本の模擬: lid → 色
    const store = new Map<string, number>([['a', 5]]);
    const deps = {
      listLids: async () => [...store.keys()],
      put: async (l: string, c: number) => void store.set(l, c),
      exists: () => true,
    };
    const r = await importNoteLabelsInto(
      [
        { lid: 'a', color: 1 },
        { lid: 'b', color: 2 },
        { lid: 'c', color: 3 },
      ],
      deps,
    );
    expect([...store]).toEqual([['a', 5], ['b', 2], ['c', 3]]);
    store.set('c', 7); // 取り込み後に user が付け直した
    // main.ts の removeNoteLabels と同じ規則(いまも同じ色の物だけ外す)
    for (const e of r.addedEntries) if (store.get(e.lid) === e.color) store.delete(e.lid);
    expect([...store], 'b は外れ、前から在った a と付け直した c は残る').toEqual([['a', 5], ['c', 7]]);
  });

  it('同じ lid が重ねて来ても 1 回だけ書く', async () => {
    const { put, deps } = setup([], ['a']);
    await importNoteLabelsInto([{ lid: 'a', color: 1 }, { lid: 'a', color: 2 }], deps);
    expect(put).toEqual([['a', 1]]);
  });

  it('書けなかったら throw する', async () => {
    const deps = {
      listLids: async () => [],
      put: async () => {
        throw new Error('x');
      },
      exists: () => true,
    };
    await expect(importNoteLabelsInto([{ lid: 'a', color: 1 }], deps)).rejects.toThrow();
  });
});
