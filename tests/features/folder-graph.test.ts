/**
 * P6c 段⑤: `folders[]` → folder 木の正規化。
 *
 * 🔴 ここが緩いと **filer からフォルダごと消える**。`resolveCanonicalParents` は
 * 「正準親を持たない entry」を root 直下として出すので、循環があると循環上の
 * folder が 1 つも root に出ず、配下ごと不可視になる(無言のデータ不可視)。
 *
 * PKC2 の writer は循環・自己親・重複 lid・dangling parent を**一切防いでいない**
 * (実地確認 2026-08-01)ので、来る前提で正規化する。
 */
import { describe, expect, it } from 'vitest';
import { buildFolderGraph, type FolderNode } from '../../src/features/import/folder-graph';

const F = (lid: string, parentLid: string | null, title = lid): FolderNode => ({
  lid,
  title,
  parentLid,
});
/** child → parent(木として読む)。 */
const parentOf = (r: ReturnType<typeof buildFolderGraph>): Record<string, string> =>
  Object.fromEntries(r.edges.map((e) => [e.toLid, e.fromLid]));

/** 親をたどって循環しないこと = 木であること。 */
function expectAcyclic(t: Record<string, string>, lids: readonly string[]): void {
  for (const start of lids) {
    const seen = new Set<string>([start]);
    let cur = t[start];
    while (cur !== undefined) {
      expect(seen.has(cur)).toBe(false);
      seen.add(cur);
      cur = t[cur];
    }
  }
}

describe('buildFolderGraph — 正常系', () => {
  it('親子を structural relation にする(fromLid = 親)', () => {
    const r = buildFolderGraph([F('root', null), F('a', 'root'), F('b', 'a')], new Map());
    expect(r.edges).toEqual([
      { fromLid: 'root', toLid: 'a' },
      { fromLid: 'a', toLid: 'b' },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('🔑 順序に依存しない(PKC2 は親が先に来る保証を持たない)', () => {
    // writer はトポロジカルソートしていない ── 子が先に並ぶ書出しが実在しうる
    const r = buildFolderGraph([F('b', 'a'), F('a', 'root'), F('root', null)], new Map());
    expect(parentOf(r)).toEqual({ a: 'root', b: 'a' });
    expect(r.warnings).toEqual([]);
  });

  it('空フォルダも entry として作る(PKC2 は無言で消していた)', () => {
    const r = buildFolderGraph([F('root', null), F('empty', 'root')], new Map());
    expect(r.entries.map((e) => e.lid)).toEqual(['root', 'empty']);
    expect(r.entries.every((e) => e.archetype === 'folder')).toBe(true);
  });

  it('本体 entry を親フォルダの下に置く', () => {
    const r = buildFolderGraph([F('root', null), F('a', 'root')], new Map([['n1', 'a']]));
    expect(parentOf(r)).toEqual({ a: 'root', n1: 'a' });
  });

  it('タイトルが空なら見える名前を与える(無題のフォルダが名無しで並ばない)', () => {
    const r = buildFolderGraph([F('root', null, '')], new Map());
    expect(r.entries[0]!.title).toBe('(無題のフォルダ)');
  });
});

describe('buildFolderGraph — 壊れた入力を「直して見せる」', () => {
  it('🔴 2 者の循環を 1 本だけ切る(全部平坦にしない)', () => {
    const r = buildFolderGraph([F('A', 'B'), F('B', 'A')], new Map());
    expectAcyclic(parentOf(r), ['A', 'B']);
    // 木は残る ── PKC2 はここで階層を丸ごと捨てていた
    expect(r.edges).toHaveLength(1);
    expect(r.warnings).toEqual([
      'フォルダの親子関係が循環していたので 1 か所外しました: B → A',
    ]);
  });

  it('🔴 3 者の循環でも切るのは 1 本', () => {
    const r = buildFolderGraph([F('A', 'B'), F('B', 'C'), F('C', 'A')], new Map());
    expectAcyclic(parentOf(r), ['A', 'B', 'C']);
    expect(r.edges).toHaveLength(2);
    expect(r.warnings).toHaveLength(1);
  });

  it('🔴 循環があっても root が必ず 1 つ以上残る(全部不可視にしない)', () => {
    // これが崩れると filer から**全部消える** ── この不変条件が段⑤ の核心
    const r = buildFolderGraph([F('A', 'B'), F('B', 'A'), F('C', 'D'), F('D', 'C')], new Map());
    const t = parentOf(r);
    const roots = ['A', 'B', 'C', 'D'].filter((l) => t[l] === undefined);
    expect(roots).toHaveLength(2); // 独立した循環 2 つ → root 2 つ
    expectAcyclic(t, ['A', 'B', 'C', 'D']);
  });

  it('非循環ノードから循環へ入る形でも木になる', () => {
    const r = buildFolderGraph([F('A', 'B'), F('B', 'C'), F('C', 'B')], new Map());
    expectAcyclic(parentOf(r), ['A', 'B', 'C']);
    expect(r.warnings).toHaveLength(1);
  });

  it('自己参照は循環検出の前に外す', () => {
    const r = buildFolderGraph([F('A', 'A', 'じぶん')], new Map());
    expect(r.edges).toEqual([]);
    expect(r.warnings).toEqual([
      '自分自身を親にしているフォルダの親子関係を外しました: じぶん',
    ]);
  });

  it('重複 lid は先を採って言う(export root が 2 回出る形が実在する)', () => {
    // 循環で root が自分の子孫になっていると writer が root を 2 回書く
    const r = buildFolderGraph([F('root', null, '一つ目'), F('root', 'x', '二つ目')], new Map());
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.title).toBe('一つ目');
    expect(r.warnings[0]).toMatch(/同じ lid のフォルダが 2 つ/);
  });

  it('親フォルダが書出しに無いときは最上位へ寄せて言う(平坦化しない)', () => {
    const r = buildFolderGraph([F('a', 'いない', 'ノート置き場'), F('b', 'a')], new Map());
    // a は root 直下、b は a の下 ── **残りの木は保つ**
    expect(parentOf(r)).toEqual({ b: 'a' });
    expect(r.warnings).toEqual([
      '親フォルダが書出しに含まれていません: ノート置き場(最上位に置きます)',
    ]);
  });

  it('本体 entry が未知フォルダを指していても最上位へ寄せる', () => {
    // PKC2 はこの 1 件で **bundle 全体を平坦取込**に落としていた
    const r = buildFolderGraph([F('root', null)], new Map([['n1', 'いない']]));
    expect(r.edges).toEqual([]);
    expect(r.warnings[0]).toMatch(/ノートの親フォルダが書出しに含まれていません/);
  });

  it('lid の無いフォルダは無視して言う', () => {
    const r = buildFolderGraph([F('', null)], new Map());
    expect(r.entries).toEqual([]);
    expect(r.warnings).toEqual(['lid の無いフォルダを無視しました']);
  });
});
