/** @vitest-environment node */
/**
 * 題名の並べ方(#1087)── 一覧の題名順・フォルダの面・予定表のノート一覧が同じ照合を使う。
 *
 * 守るもの:数字は数として(「2 件」は「10 件」の前)/ ひらがなとカタカナ・全角と半角・大小は
 * 同じ字として扱う(かな全部が先にカナ全部、にならない)/ 同点は lid で割り、実行のたびに
 * 入れ替わらない / 降順は昇順の逆。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { sortOrder } from '../../src/features/filter/entry-sort';
import { compareTitles } from '../../src/features/filter/title-compare';
import { sortFolderEntries } from '../../src/features/local-folder/folder-entries';

function titled(titles: string[]): { order: string[]; titleOf: (lid: string) => string; metaOf: (lid: string) => EntryMeta | undefined } {
  const lids = titles.map((_, i) => `l${String(i).padStart(2, '0')}`);
  const metas = new Map<string, EntryMeta>(
    lids.map((lid, i) => [
      lid,
      {
        lid,
        title: titles[i]!,
        archetype: 'text',
        createdAt: null,
        updatedAt: null,
        entryOrder: i,
        status: null,
        date: null,
        archived: false,
        bodyChars: null,
      } as EntryMeta,
    ]),
  );
  return { order: lids, titleOf: (l) => metas.get(l)!.title, metaOf: (l) => metas.get(l) };
}

const byTitle = (titles: string[], desc = false): string[] => {
  const t = titled(titles);
  return sortOrder(t.order, t.metaOf, 'title', desc, () => 0).map(t.titleOf);
};

describe('題名順の照合', () => {
  it('🔴 数字は数として読む(2 件は 10 件の前)', () => {
    expect(byTitle(['10 件', '2 件', '1 件'])).toEqual(['1 件', '2 件', '10 件']);
    expect(byTitle(['第10回', '第2回', '第1回'])).toEqual(['第1回', '第2回', '第10回']);
  });

  it('🔴 全角の数字も数として並ぶ(末尾に固まらない)', () => {
    expect(byTitle(['１０', '2', '１', '3'])).toEqual(['１', '2', '3', '１０']);
  });

  it('🔴 ひらがなとカタカナを別の群にしない(読みの順に混ざる)', () => {
    const r = byTitle(['いろは', 'アイウ', 'わ', 'カキ', 'あいう']);
    expect(r.indexOf('アイウ'), 'カタカナが全部ひらがなの後ろに回った').toBeLessThan(r.indexOf('いろは'));
    expect(r.indexOf('カキ')).toBeLessThan(r.indexOf('わ'));
  });

  it('大小・全角半角は同じ字として並べ、同点は lid で割る(順が実行のたびに変わらない)', () => {
    const t = titled(['b', 'A', 'a', 'B']);
    const lids = sortOrder(t.order, t.metaOf, 'title', false, () => 0);
    expect(lids.map(t.titleOf), 'a と A の間に b が割り込んだ').toEqual(['A', 'a', 'b', 'B']);
    // 同じ入力を逆から入れても、同点(a と A)は lid の順で同じ答え
    const rev = sortOrder([...t.order].reverse(), t.metaOf, 'title', false, () => 0);
    expect(rev).toEqual(lids);
  });

  it('降順は昇順の逆(同点の間は lid 昇順のまま)', () => {
    expect(byTitle(['1 件', '10 件', '2 件'], true)).toEqual(['10 件', '2 件', '1 件']);
  });

  it('未知の lid は末尾(降順では先頭)のまま', () => {
    const t = titled(['b', 'a']);
    const order = [...t.order, 'ghost'];
    expect(sortOrder(order, t.metaOf, 'title', false, () => 0)).toEqual(['l01', 'l00', 'ghost']);
    expect(sortOrder(order, t.metaOf, 'title', true, () => 0)[0]).toBe('ghost');
  });
});

describe('同じ照合を使う他の面', () => {
  it('🔴 フォルダの面は、フォルダが先・名前は数として', () => {
    const r = sortFolderEntries([
      { name: '10.md', kind: 'file' as const },
      { name: '2.md', kind: 'file' as const },
      { name: 'z', kind: 'directory' as const },
    ]);
    expect(r.map((e) => e.name)).toEqual(['z', '2.md', '10.md']);
  });

  it('正本の比較関数が数字・かなを同じ規則で比べる(予定表のノート一覧もこれを使う)', () => {
    expect(compareTitles('2 件', '10 件')).toBeLessThan(0);
    expect(compareTitles('ア', 'あ')).toBe(0);
  });
});
