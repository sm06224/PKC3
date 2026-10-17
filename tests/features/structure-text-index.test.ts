/** @vitest-environment node */
/**
 * 🔴 **構成のテキストは、正準親の解決を 1 度だけ行う**(#1087)。画面の字は変えない。
 *
 * 守る主張:
 * 1. 出力が、節点ごとに `getStructuralChildren` を呼んでいた旧実装と 1 バイトも違わない
 *    (3 段以上 / 並べ替えが要る兄弟 = 同値の entryOrder は lid で決まる / 多重親)
 * 2. `resolveCanonicalParents` は `relations` を 1 周舐める ── 舐めた回数で呼ばれた回数を数える
 *    (同 module 内の呼び出しは module mock で横取りできないので、`relations` の走査で見る)
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { getRootEntries, getStructuralChildren } from '../../src/features/relation/tree';
import {
  MAX_STRUCTURE_DEPTH,
  structureLines,
  type StructureLine,
} from '../../src/features/structure/structure-text';

function meta(lid: string, title: string, order: number, archetype = 'text'): EntryMeta {
  return {
    lid, title, archetype,
    createdAt: null, updatedAt: null, entryOrder: order,
    status: null, date: null, archived: false, bodyChars: null,
  };
}
const rel = (id: string, from: string, to: string): Relation => ({
  id, fromLid: from, toLid: to, kind: 'structural', createdAt: null, updatedAt: null,
});
const mapOf = (ms: EntryMeta[]) => new Map(ms.map((m) => [m.lid, m]));

/** 旧実装(#1087 の前)の歩き方をそのまま写した対照。節点ごとに `getStructuralChildren` を呼ぶ。 */
function oldStructureLines(
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): StructureLine[] {
  const out: StructureLine[] = [];
  const seen = new Set<string>();
  const walk = (m: EntryMeta, depth: number): void => {
    if (seen.has(m.lid) || depth > MAX_STRUCTURE_DEPTH) return;
    seen.add(m.lid);
    out.push({ lid: m.lid, depth, title: m.title, isFolder: m.archetype === 'folder' });
    for (const c of getStructuralChildren(m.lid, metas, relations)) walk(c, depth + 1);
  };
  for (const r of getRootEntries(metas, relations)) walk(r, 0);
  return out;
}

function fixture() {
  const ms = [
    meta('top', '仕事', 5, 'folder'),
    meta('top2', '私用', 1, 'folder'),
    meta('sub-b', '資料', 30, 'folder'),
    meta('sub-a', '会議', 20, 'folder'),
    // 同値の entryOrder ── lid で決まる(z を先に書いても a が前)
    meta('leaf-z', '末尾', 7),
    meta('leaf-a', '先頭', 7),
    meta('leaf-m', '真ん中', 3),
    meta('deep1', '三段目', 50),
    meta('deep2', '三段目の二', 40),
    meta('deep3', '四段目', 1),
    // 多重親: top2(order 1)のほうが正準
    meta('shared', '共有', 9),
    meta('loose', 'ルート直下', 2),
  ];
  const rs = [
    rel('r1', 'top', 'sub-b'),
    rel('r2', 'top', 'sub-a'),
    rel('r3', 'sub-a', 'leaf-z'),
    rel('r4', 'sub-a', 'leaf-a'),
    rel('r5', 'sub-a', 'leaf-m'),
    rel('r6', 'sub-b', 'deep1'),
    rel('r7', 'sub-b', 'deep2'),
    rel('r8', 'sub-b', 'deep3'),
    rel('r9', 'top', 'shared'),
    rel('r10', 'top2', 'shared'),
    // 非 folder 親 / 自己辺 ── 無視される
    rel('r11', 'loose', 'leaf-m'),
    rel('r12', 'top', 'top'),
  ];
  return { metas: mapOf(ms), rs };
}

describe('構成のテキストの歩き方(#1087)', () => {
  it('🔴 出力が旧実装(節点ごとに子を引く)と同じ', () => {
    const { metas, rs } = fixture();
    const now = structureLines(metas, rs);
    expect(now).toEqual(oldStructureLines(metas, rs));
    // ⚠ 前提: 対照が空振りしていない(3 段以上・同値 tie・多重親が実際に出ている)
    expect(Math.max(...now.map((l) => l.depth)), '3 段以上が無い').toBeGreaterThanOrEqual(2);
    const order = now.map((l) => l.lid);
    expect(order.indexOf('leaf-a'), 'lid の tie-break が効く形になっていない').toBeLessThan(
      order.indexOf('leaf-z'),
    );
    expect(order.indexOf('leaf-m'), 'entryOrder の差で並ぶ形になっていない').toBeLessThan(
      order.indexOf('leaf-a'),
    );
    expect(order.filter((l) => l === 'shared'), '多重親の児は 1 度だけ').toHaveLength(1);
    const shared = now.find((l) => l.lid === 'shared')!;
    expect(shared.depth, '正準親は entryOrder 最小の top2').toBe(1);
  });

  it('🔴 relations を舐める回数 = 正準親の解決は節点の数に比例しない', () => {
    const { metas, rs } = fixture();
    let sweeps = 0;
    const counted = Object.assign([...rs], {
      [Symbol.iterator]: function* (this: Relation[]) {
        sweeps += 1;
        yield* Array.prototype.values.call(this) as Iterable<Relation>;
      },
    }) as Relation[];
    structureLines(metas, counted);
    // 子の索引 1 回 + ルートを引く 1 回。節点(12 個)ごとに増えないこと
    expect(metas.size).toBeGreaterThan(10);
    expect(sweeps, '数えられていない(対照が空振り)').toBeGreaterThanOrEqual(1);
    expect(sweeps).toBeLessThanOrEqual(2);
  });
});
