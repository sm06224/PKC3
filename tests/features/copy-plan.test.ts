/**
 * 写す(コピー)の段取り(#273 段③)。
 *
 * 🔴 守る主張:
 * 1. **フォルダを写したら中身も行く**(選んだ物だけではない)
 * 2. **親子は写した先で組み直す**(元の親を指したままにしない)
 * 3. **同じ場所へ写すときだけ名前に印**(別の場所なら変えない)
 * 4. **輪が入っていても止まる**(取込で輪は実際に入りうる)
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { collectSubtree, planCopy } from '../../src/features/relation/copy-plan';

function meta(lid: string, order: number, title = 't-' + lid, archetype = 'text'): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}
const rel = (id: string, fromLid: string, toLid: string): Relation => ({
  id,
  fromLid,
  toLid,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

/** f1 の中に x と、さらに中のフォルダ f2(その中に y)。平の a はルート。 */
const METAS = new Map(
  [
    meta('f1', 1, 'はこ1', 'folder'),
    meta('x', 2, 'えっくす'),
    meta('f2', 3, 'はこ2', 'folder'),
    meta('y', 4, 'わい'),
    meta('a', 5, 'あ'),
  ].map((m) => [m.lid, m]),
);
const RELS = [rel('r1', 'f1', 'x'), rel('r2', 'f1', 'f2'), rel('r3', 'f2', 'y')];

/** 呼び側の採番器を真似る(純関数に乱数を持ち込まない)。 */
function counter(): () => string {
  let n = 0;
  return () => `n${++n}`;
}

describe('写すものを数え上げる', () => {
  it('🔴 フォルダを選んだら、中身も孫も入る(親が先)', () => {
    expect(collectSubtree(['f1'], METAS, RELS)).toEqual(['f1', 'x', 'f2', 'y']);
  });

  it('平のノートは、それだけ', () => {
    expect(collectSubtree(['a'], METAS, RELS)).toEqual(['a']);
  });

  it('⚠ 同じものを 2 通りで選んでも 1 回だけ(親と子を同時に選んだとき)', () => {
    expect(collectSubtree(['f1', 'x'], METAS, RELS)).toEqual(['f1', 'x', 'f2', 'y']);
  });

  /**
   * 🔴 **輪が入っていても止まる**。⚠ 取込は循環を弾かない経路があるので、
   * 「起きない」ではなく「起きても止まる」で守る。
   */
  it('🔴 輪が入っていても止まる', () => {
    const metas = new Map(
      [meta('p', 1, 'p', 'folder'), meta('q', 2, 'q', 'folder')].map((m) => [m.lid, m]),
    );
    const rels = [rel('a', 'p', 'q'), rel('b', 'q', 'p')];
    const out = collectSubtree(['p'], metas, rels);
    expect(out.length, '同じものを 2 度数えている(止まっていない)').toBe(out.length);
    expect(new Set(out).size).toBe(out.length);
  });
});

describe('写す段取り', () => {
  it('🔴 親子は写した先で組み直す(元の親を指さない)', () => {
    const steps = planCopy(['f1'], null, METAS, RELS, counter());
    expect(steps.map((s) => s.sourceLid)).toEqual(['f1', 'x', 'f2', 'y']);
    const byId = new Map(steps.map((s) => [s.sourceLid, s]));
    expect(byId.get('f1')!.parentLid, '選んだ物は入れ先の直下へ').toBeNull();
    expect(byId.get('x')!.parentLid, '中身が元の親を指したまま').toBe(byId.get('f1')!.lid);
    expect(byId.get('f2')!.parentLid).toBe(byId.get('f1')!.lid);
    expect(byId.get('y')!.parentLid, '孫の親が写し先になっていない').toBe(byId.get('f2')!.lid);
  });

  it('🔴 別の場所へ写すときは名前を変えない', () => {
    const steps = planCopy(['a'], 'f1', METAS, RELS, counter());
    expect(steps[0]?.title, '別の場所なのに名前が変わった').toBe('あ');
    expect(steps[0]?.parentLid).toBe('f1');
  });

  it('🔴 同じ場所へ写すときだけ、名前に印を付ける', () => {
    const steps = planCopy(['a'], null, METAS, RELS, counter()); // a はルートに居る
    expect(steps[0]?.title).toBe('あ のコピー');
  });

  /** ⚠ 中身の名前まで変えない(変えると本文の参照と見た目が食い違う)。 */
  it('🔴 印が付くのは選んだ物だけで、中身は元の名前', () => {
    const steps = planCopy(['f1'], null, METAS, RELS, counter());
    const byId = new Map(steps.map((s) => [s.sourceLid, s]));
    expect(byId.get('f1')!.title).toBe('はこ1 のコピー');
    expect(byId.get('x')!.title, '中身の名前まで変えた').toBe('えっくす');
  });

  /**
   * 🔴 **印を付けるのは「選んだ物」だけ**(変異 C4 が生き延びて判明)。
   * ⚠ 1 稿目は「元の親 === 入れ先」だけで判定しても同じ答えになる fixture しか
   *   無く、**中身にまで印が付く変異を殺せなかった**(CLAUDE.md §2)。
   * 🔑 中身の親が**たまたま入れ先と同じ**になる形で当てる ── f1 を f1 の中へ写すと、
   *   中身 x の元の親(f1)が入れ先(f1)と一致する。
   */
  it('🔴 中身の親がたまたま入れ先と同じでも、中身には印を付けない', () => {
    const steps = planCopy(['f1'], 'f1', METAS, RELS, counter());
    const byId = new Map(steps.map((s) => [s.sourceLid, s]));
    // ⚠ f1 の元の親は**ルート**なので、f1 の中へ写すのは「別の場所」= 印は付かない
    expect(byId.get('f1')!.title, '別の場所なのに印が付いた').toBe('はこ1');
    // 🔑 ここが本題 ── x の元の親(f1)は入れ先と同じだが、**選んだ物ではない**
    expect(byId.get('x')!.title, '中身にまで印が付いた').toBe('えっくす');
  });

  it('lid は呼び側の採番器から来る(重複しない)', () => {
    const steps = planCopy(['f1'], null, METAS, RELS, counter());
    expect(new Set(steps.map((s) => s.lid)).size).toBe(steps.length);
  });

  it('何も選んでいなければ何も作らない', () => {
    expect(planCopy([], null, METAS, RELS, counter())).toEqual([]);
    expect(planCopy(['nope'], null, METAS, RELS, counter())).toEqual([]);
  });
});
