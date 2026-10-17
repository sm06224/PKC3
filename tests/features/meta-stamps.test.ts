/** @vitest-environment node */
/**
 * 保存の ack が差し替える `entryMetas` の「違いが時刻だけか」(#1087)。
 *
 * 守る主張: ①時刻だけの違いは組で返す(中身が同じ object は組に入れない)
 * ②時刻以外の欄・件数・lid の並びが 1 つでも違えば `null`(呼び側は従来どおり全件を作り直す)。
 * ⚠ ②は欄ごとに 1 件ずつ当てる ── 8 欄のうち 1 つを比べ落とした変異を、1 件の test で殺すため。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { stampChanges } from '../../src/features/relation/meta-stamps';

function meta(lid: string, order: number, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: '2026-10-01 00:00:00',
    updatedAt: '2026-10-01 00:00:00',
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: 10,
    ...over,
  };
}

const mapOf = (metas: EntryMeta[]): Map<string, EntryMeta> => new Map(metas.map((m) => [m.lid, m]));
const BASE = [meta('a', 1), meta('b', 2), meta('c', 3)];

describe('stampChanges ── 違いが時刻だけか', () => {
  it('同じ object ばかりなら、空の組(違いなし)', () => {
    expect(stampChanges(mapOf(BASE), mapOf(BASE))).toEqual([]);
  });

  it('🔴 1 件の更新日時だけが違えば、その 1 組だけを返す(他の件は数えない)', () => {
    const next = [BASE[0]!, { ...BASE[1]!, updatedAt: '2026-10-14 09:00:00' }, BASE[2]!];
    const pairs = stampChanges(mapOf(BASE), mapOf(next));
    expect(pairs).not.toBeNull();
    expect(pairs!.length).toBe(1);
    expect(pairs![0]![0]).toBe(BASE[1]);
    expect(pairs![0]![1]).toBe(next[1]);
  });

  it('作成日時だけが違っても組で返す', () => {
    const next = [{ ...BASE[0]!, createdAt: '2026-10-02 00:00:00' }, BASE[1]!, BASE[2]!];
    expect(stampChanges(mapOf(BASE), mapOf(next))?.length).toBe(1);
  });

  /** 時刻以外の欄は、1 つずつ「それだけ違う」形で当てる(どれか 1 つの比べ落としを殺す)。 */
  const OTHER_FIELDS: Array<[string, Partial<EntryMeta>]> = [
    ['title', { title: '別の題名' }],
    ['archetype', { archetype: 'folder' }],
    ['entryOrder', { entryOrder: 99 }],
    ['status', { status: 'done' }],
    ['date', { date: '2026-10-20' }],
    ['archived', { archived: true }],
    ['bodyChars', { bodyChars: 11 }],
  ];
  for (const [name, over] of OTHER_FIELDS) {
    it(`🔴 ${name} が違えば null(時刻も一緒に違っていても)`, () => {
      const next = [BASE[0]!, { ...BASE[1]!, ...over, updatedAt: '2026-10-14 09:00:00' }, BASE[2]!];
      expect(stampChanges(mapOf(BASE), mapOf(next))).toBeNull();
    });
  }

  it('🔴 件数が違えば null(足した / 消した)', () => {
    expect(stampChanges(mapOf(BASE), mapOf([...BASE, meta('d', 4)]))).toBeNull();
    expect(stampChanges(mapOf(BASE), mapOf([BASE[0]!, BASE[1]!]))).toBeNull();
  });

  it('🔴 lid の並びが違えば null(同じ件数・同じ欄でも、入れ替わった)', () => {
    const swapped = mapOf([{ ...BASE[1]!, entryOrder: 1 }, { ...BASE[0]!, entryOrder: 2 }, BASE[2]!]);
    expect(stampChanges(mapOf(BASE), swapped)).toBeNull();
    // 並びだけ入れ替えて欄は元のまま(Map の順序が違う)
    const reordered = mapOf([BASE[1]!, BASE[0]!, BASE[2]!]);
    expect(stampChanges(mapOf(BASE), reordered)).toBeNull();
  });
});
