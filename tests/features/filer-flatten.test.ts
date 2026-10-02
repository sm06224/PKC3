/**
 * 🔴 **「中まで全部出す」の行(#813 段②。🟣 Gemini 裁定 2026-10-01 の C)**。
 *
 * 左の列の「フォルダ」の表は、いままで**いま居る場所の直下だけ**を出していた。入り切りを
 * 1 つ足し、入にすると**配下を階層をまたいで全部**平らに出す(ルートなら全件)。
 * 規則は純関数 `filerRows` の 1 か所 ── 描く側・範囲選択・鍵の行送りが同じ並びを見る。
 *
 * ⚠ 守るのは 3 つ:
 *   ① 入のとき、**配下だけ**(別の枝・自分自身は出ない)で、ルートは**全件**
 *   ② 切のとき、**1 バイトも変わらない**(同じ入力で同じ出力 = 対照群)
 *   ③ 絞り込み・種類の絞り・並び順は、平らに出していても**今までと同じ規則**で効く
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import {
  filerRows,
  flatParentNames,
  type FilerRowsOptions,
} from '@features/relation/filer-list';
import { getFlatDescendants } from '@features/relation/tree';
import { SMART_ARCHETYPE } from '@features/smart/smart-spec';

const meta = (lid: string, order: number, archetype = 'text', title = `t-${lid}`): EntryMeta => ({
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
});
const rel = (id: string, from: string, to: string): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

/**
 * 木:
 *   (root) ── f1 ── { f2 ── { b },  a }
 *          ── f3 ── { c }          ← f1 とは別の枝
 *          ── x                    ← 入れ物に入っていない 1 件
 */
const METAS = new Map(
  [
    meta('f1', 1, 'folder'),
    meta('f2', 2, 'folder'),
    meta('b', 3),
    meta('a', 4),
    meta('f3', 5, 'folder'),
    meta('c', 6),
    meta('x', 7),
  ].map((m) => [m.lid, m]),
);
const RELS = [
  rel('r1', 'f1', 'f2'),
  rel('r2', 'f1', 'a'),
  rel('r3', 'f2', 'b'),
  rel('r4', 'f3', 'c'),
];

const OPTS: Omit<FilerRowsOptions, 'flatten'> = {
  filterQuery: '',
  searchHits: null,
  sort: 'manual',
  sortDesc: false,
  openedAt: new Map(),
  kinds: new Set(),
};
const lids = (rows: readonly EntryMeta[]): string[] => rows.map((m) => m.lid);
const rows = (scope: string | null, over: Partial<FilerRowsOptions> = {}): string[] =>
  lids(filerRows(scope, METAS, RELS, { ...OPTS, flatten: false, ...over }));

describe('🔴 「中まで全部出す」── 行の決め方(#813 段②)', () => {
  it('切のとき、いままでどおり直下だけ(対照群)', () => {
    // ⚠ 期待値は**手で書いた木の読み**(実装の関数を呼ばない)
    expect(rows(null)).toEqual(['f1', 'f3', 'x']);
    expect(rows('f1')).toEqual(['f2', 'a']);
    expect(rows('f2')).toEqual(['b']);
  });

  it('🔴 ルートで入れると**全件**(フォルダ自身も行として出る)', () => {
    const all = rows(null, { flatten: true });
    expect(all, '全件が出ていない').toEqual(['f1', 'f2', 'b', 'a', 'f3', 'c', 'x']);
    // 空振り防止 ── 直下だけ(3 件)とは**別物**であること
    expect(all.length).toBeGreaterThan(rows(null).length);
    // フォルダ自身も行(かつての一覧タブと同じ)
    for (const f of ['f1', 'f2', 'f3']) expect(all).toContain(f);
  });

  it('🔴 ルートで入れた行は、全ノートが entryOrder の順(階層を見ない)', () => {
    // ⚠ 出どころは「一覧タブを外す前に全件を平らに見る道を作る」── かつては一覧タブの
    //   `listRows` と突き合わせていた。一覧タブを外した(#813 段③)ので、**全件 × 手動の順**を
    //   実装を参照せずに組んで比べる(別の観測 ── 同じ関数どうしを比べない)
    const expected = [...METAS.values()].sort((p, q) => p.entryOrder - q.entryOrder).map((m) => m.lid);
    expect(expected.length, '前提が崩れている(全ノートが空)').toBe(METAS.size);
    expect(rows(null, { flatten: true })).toEqual(expected);
  });

  it('🔴 フォルダの中で入れると**そのフォルダの配下だけ**(別の枝・自分自身は出ない)', () => {
    const inF1 = rows('f1', { flatten: true });
    expect(inF1).toEqual(['f2', 'b', 'a']);
    // 別の枝(f3 / c)・入れ物の外(x)・自分自身(f1)は出ない
    for (const out of ['f3', 'c', 'x', 'f1']) expect(inF1, `${out} が出ている`).not.toContain(out);
    // 空振り防止 ── 孫(b)まで届いている = 直下(2 件)より多い
    expect(inF1.length).toBeGreaterThan(rows('f1').length);
  });

  it('入れたまま 1 つ降りると、その配下の全部が出る(現在地に追従)', () => {
    expect(rows('f2', { flatten: true })).toEqual(['b']);
    expect(rows('f3', { flatten: true })).toEqual(['c']);
  });

  it('入れたまま末端のフォルダ(空)へ降りると 0 件', () => {
    const metas = new Map(METAS);
    metas.set('empty', meta('empty', 8, 'folder'));
    expect(lids(filerRows('empty', metas, RELS, { ...OPTS, flatten: true }))).toEqual([]);
  });

  it('絞り込みの語が、平らに出した行にも効く', () => {
    // 孫 `b` だけが当たる語(題名は `t-<lid>`)
    expect(rows('f1', { flatten: true, filterQuery: 't-b' })).toEqual(['b']);
    expect(rows(null, { flatten: true, filterQuery: 't-c' })).toEqual(['c']);
    // 切のときは、孫は絞り込みの前から出ていない(直下に居ない)
    expect(rows('f1', { filterQuery: 't-b' })).toEqual([]);
  });

  it('本文検索の当たり(`searchHits`)も平らな行に効く', () => {
    // 題名に当たらない語 + 本文が当たった lid(`c`)
    const hit = rows(null, { flatten: true, filterQuery: '本文の語', searchHits: new Set(['c']) });
    expect(hit).toEqual(['c']);
  });

  it('種類の絞り(`kinds`)が平らな行に効く', () => {
    expect(rows(null, { flatten: true, kinds: new Set(['folder']) })).toEqual(['f1', 'f2', 'f3']);
  });

  it('並び順・向きが平らな行に効く', () => {
    expect(rows(null, { flatten: true, sort: 'title', sortDesc: true })).toEqual([
      'x', 'f3', 'f2', 'f1', 'c', 'b', 'a',
    ]);
  });

  it('スマートフォルダの中は入り切りの対象外(中身は条件の当たりのまま)', () => {
    const metas = new Map(METAS);
    metas.set('s', meta('s', 9, SMART_ARCHETYPE));
    // 当たりの 2 件がそのまま(当たりの順で)出る ── 入でも切でも同じ(空振りでもない)
    for (const flatten of [false, true]) {
      expect(
        lids(filerRows('s', metas, RELS, { ...OPTS, flatten, smartLids: ['c', 'a'] })),
        `flatten=${flatten}`,
      ).toEqual(['c', 'a']);
    }
  });
});

describe('🔴 `getFlatDescendants`(#813 段②)', () => {
  it('環があっても止まる(読み手は防御だけする)', () => {
    // f1 ⇄ f2 の環
    const cyc = [rel('r1', 'f1', 'f2'), rel('r2', 'f2', 'f1')];
    const out = getFlatDescendants('f1', METAS, cyc).map((m) => m.lid);
    expect(out).toEqual(['f2']);
  });

  it('実在しない lid では空(在ることにしない)', () => {
    expect(getFlatDescendants('nope', METAS, RELS)).toEqual([]);
  });

  it('ルートは全件(entryOrder 順)', () => {
    expect(getFlatDescendants(null, METAS, RELS).map((m) => m.lid)).toEqual([
      'f1', 'f2', 'b', 'a', 'f3', 'c', 'x',
    ]);
  });
});

describe('🔴 親フォルダの名前を添える行(`flatParentNames`。#813 残り・🟣 Gemini 裁定 2026-10-01 = A)', () => {
  /** 期待値は**手で書いた木の読み**(題名は `t-<lid>`)。実装の関数を呼ばない。 */
  const names = (
    scope: string | null,
    flatten: boolean,
    metas: ReadonlyMap<string, EntryMeta> = METAS,
  ): Record<string, string> => {
    const list = filerRows(scope, metas, RELS, { ...OPTS, flatten });
    return Object.fromEntries(flatParentNames(scope, list, metas, RELS, flatten));
  };

  it('🔴 切のときは**1 行も**添えない(直下だけなので親は自明)', () => {
    // 空振り防止 ── 入に直した同じ木では添える行が在るので、空なのは「規則」による
    expect(names(null, false)).toEqual({});
    expect(names('f1', false)).toEqual({});
    expect(Object.keys(names(null, true)).length).toBeGreaterThan(0);
  });

  it('🔴 切は「行が直下だけだから空」ではなく**規則として**空(孫の載った行を渡しても添えない)', () => {
    // ⚠ 切の行は直下だけで、親 = いまの場所なので門が無くても空になる(変異 M1 が生き延びた)。
    //   門そのものを見るため、**平らな行**(孫が載っている)を切の印で渡す
    const flatRows = filerRows(null, METAS, RELS, { ...OPTS, flatten: true });
    expect(flatRows.some((m) => m.lid === 'b'), '前提: 孫が載っていない').toBe(true);
    expect(flatParentNames(null, flatRows, METAS, RELS, false).size).toBe(0);
    expect(flatParentNames(null, flatRows, METAS, RELS, true).size).toBeGreaterThan(0);
  });

  it('🔴 ルートで入: 直下(親が無い行)には出さず、フォルダの中に居る行だけ親の名前が付く', () => {
    expect(names(null, true)).toEqual({
      f2: 't-f1',
      b: 't-f2',
      a: 't-f1',
      c: 't-f3',
    });
    // 親が無い 3 行(f1 / f3 / x)は付かない
    for (const root of ['f1', 'f3', 'x']) expect(names(null, true)).not.toHaveProperty(root);
  });

  it('🔴 フォルダの中で入: 直下の行(親 = いま見ているフォルダ)には出さず、孫以深だけ', () => {
    // f1 の配下: f2・a は直下(出さない)/ b は孫(親は f2)
    const inF1 = names('f1', true);
    expect(inF1).toEqual({ b: 't-f2' });
    // 空振り防止 ── 直下の行が実際に平らな行に載っている上で付いていない
    const rowsInF1 = filerRows('f1', METAS, RELS, { ...OPTS, flatten: true }).map((m) => m.lid);
    expect(rowsInF1).toEqual(expect.arrayContaining(['f2', 'a', 'b']));
    expect(inF1).not.toHaveProperty('f2');
    expect(inF1).not.toHaveProperty('a');
    // 降りた先(f2)の直下だけなら 1 つも付かない
    expect(names('f2', true)).toEqual({});
  });

  it('スマートフォルダの中は付けない(入でも。中身は条件の当たりで、親の名前に意味が無い)', () => {
    const metas = new Map(METAS);
    metas.set('s', meta('s', 9, SMART_ARCHETYPE));
    const list = filerRows('s', metas, RELS, { ...OPTS, flatten: true, smartLids: ['b', 'c'] });
    expect(lids(list)).toEqual(['b', 'c']); // 前提: 親の在る行が載っている
    expect(flatParentNames('s', list, metas, RELS, true).size).toBe(0);
  });

  it('題名が空の親は添えない(「─」だけの字を出さない)', () => {
    const metas = new Map(METAS);
    metas.set('f3', meta('f3', 5, 'folder', ''));
    expect(names(null, true, metas)).toEqual({ f2: 't-f1', b: 't-f2', a: 't-f1' });
  });

  it('多重親は正準親(entryOrder 最小)の名前 ── 木の読み方を 2 本にしない', () => {
    // c は f3(order 5)と f1(order 1)の両方の子 → 正準親は f1
    const rels = [...RELS, rel('r5', 'f1', 'c')];
    const list = filerRows(null, METAS, rels, { ...OPTS, flatten: true });
    expect(flatParentNames(null, list, METAS, rels, true).get('c')).toBe('t-f1');
  });
});
