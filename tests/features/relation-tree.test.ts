import { describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import {
  getStructuralChildren,
  getRootEntries,
  getAncestorFolders,
  resolveFilerScope,
} from '../../src/features/relation/tree';

function meta(lid: string, order: number, archetype = 'text'): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
  };
}

const rel = (id: string, from: string, to: string, kind = 'structural'): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind,
  createdAt: null,
  updatedAt: null,
});

// f1(folder) ── a, f2(folder) ── b。root: f1, c。semantic 辺はノイズ
const metas = new Map(
  [
    meta('f1', 1, 'folder'),
    meta('f2', 3, 'folder'),
    meta('a', 4),
    meta('b', 2),
    meta('c', 5),
  ].map((m) => [m.lid, m]),
);
const relations = [
  rel('r1', 'f1', 'a'),
  rel('r2', 'f1', 'f2'),
  rel('r3', 'f2', 'b'),
  rel('rx', 'a', 'c', 'semantic'), // structural ではない ── 木に影響しない
];

describe('relation tree(P3-7b 最小核)', () => {
  it('子は entryOrder 順(relations 配列順という PKC2 の暗黙仕様を持ち込まない)', () => {
    // r1(a, order4) が r2(f2, order3) より先に並んでいるが、結果は order 順
    expect(getStructuralChildren('f1', metas, relations).map((m) => m.lid)).toEqual([
      'f2',
      'a',
    ]);
  });

  it('root = structural 親なし(semantic 辺は親と見なさない)', () => {
    expect(getRootEntries(metas, relations).map((m) => m.lid)).toEqual(['f1', 'c']);
  });

  it('祖先 walk は近い順、cycle は打ち切り', () => {
    expect(getAncestorFolders('b', metas, relations).map((m) => m.lid)).toEqual([
      'f2',
      'f1',
    ]);
    // cycle: f1 → f2 → f1 を追加しても無限ループしない
    const cyclic = [...relations, rel('rc', 'f2', 'f1')];
    expect(getAncestorFolders('b', metas, cyclic).map((m) => m.lid)).toEqual([
      'f2',
      'f1',
    ]);
  });

  it('多重親は正準親(entryOrder 最小の folder)に決定 ── 一覧と祖先が一致し、辺の順序に依らない', () => {
    // f2(order3) と f1(order1) の両方が x の親 ── 正準は f1
    const m2 = new Map(metas);
    m2.set('x', meta('x', 9));
    const multi = [...relations, rel('m1', 'f2', 'x'), rel('m2', 'f1', 'x')];
    const reversed = [...relations, rel('m2', 'f1', 'x'), rel('m1', 'f2', 'x')];
    for (const rels of [multi, reversed]) {
      // 児は正準親の下にだけ現れる(2 か所表示 → クリックでテレポート、の封鎖)
      expect(getStructuralChildren('f1', m2, rels).map((m) => m.lid)).toContain('x');
      expect(getStructuralChildren('f2', m2, rels).map((m) => m.lid)).not.toContain('x');
      expect(getAncestorFolders('x', m2, rels)[0]?.lid).toBe('f1');
    }
  });

  it('規約外の辺は木に影響しない: 非 folder 親 / 不在親 / 自己辺', () => {
    const m2 = new Map(metas);
    const noisy = [
      ...relations,
      rel('n1', 'a', 'c'), // 非 folder 親(text → text)── c は root に残る
      rel('n2', 'ghost', 'b'), // 不在親 ── 無視(b の正準親は f2 のまま)
      rel('n3', 'f1', 'f1'), // 自己辺 ── 無視(f1 は root に残る)
    ];
    expect(getRootEntries(m2, noisy).map((m) => m.lid)).toEqual(['f1', 'c']);
    expect(getAncestorFolders('b', m2, noisy).map((m) => m.lid)).toEqual(['f2', 'f1']);
    // 「選択中なのに filer のどこにも見えない」を作らない: c は root で見え、
    // scope 解決も root(非 folder 親は親と見なさない ── 両者の判定が一致)
    expect(resolveFilerScope('c', m2, noisy)).toBeNull();
  });

  it('scope 解決: folder 選択はそれ / 非 folder は最近傍祖先 / 孤立は root', () => {
    expect(resolveFilerScope('f2', metas, relations)?.lid).toBe('f2');
    expect(resolveFilerScope('b', metas, relations)?.lid).toBe('f2');
    expect(resolveFilerScope('c', metas, relations)).toBeNull();
    expect(resolveFilerScope(null, metas, relations)).toBeNull();
  });
});
