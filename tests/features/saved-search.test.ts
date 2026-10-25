/**
 * #1038 C1: 保存した検索の規則(pure)。
 *
 * 見るのは: 保存できる形か / 同じ組を 2 つ憶えない / 上限は断る(黙って捨てない)/
 * 名前の自動付けと直し / 削除 / 壊れた保存を読んでも落ちない。
 */
import { describe, expect, it } from 'vitest';
import {
  SAVED_SEARCH_MAX,
  addSavedSearch,
  autoSearchName,
  findSavedSearch,
  isSavable,
  normalizeKinds,
  parseSavedSearches,
  removeSavedSearch,
  renameSavedSearch,
  sameSearch,
  type SavedSearch,
} from '../../src/features/history/saved-search';

const label = (a: string): string => ({ text: 'ノート', csv: '表', todo: 'タスク' })[a] ?? a;

describe('保存できる形か', () => {
  it('語か札のどちらかがあれば保存できる / どちらも無い・操作を探す字は保存できない', () => {
    expect(isSavable('請求書', [])).toBe(true);
    expect(isSavable('', ['text'])).toBe(true);
    expect(isSavable('  ', [])).toBe(false);
    expect(isSavable('', [])).toBe(false);
    expect(isSavable('>ノート', [])).toBe(false);
    expect(isSavable('＞ノート', ['text'])).toBe(false); // 全角の > も同じ判定
  });
});

describe('同じ組の判定', () => {
  it('語の前後の空白と札の順序は無視する / 札が違えば別', () => {
    expect(sameSearch({ query: ' 請求書 ', kinds: ['text', 'csv'] }, { query: '請求書', kinds: ['csv', 'text'] })).toBe(true);
    expect(sameSearch({ query: '請求書', kinds: ['text'] }, { query: '請求書', kinds: [] })).toBe(false);
    expect(sameSearch({ query: '請求書', kinds: [] }, { query: '請求', kinds: [] })).toBe(false);
    expect(normalizeKinds(['csv', 'text', 'csv'])).toEqual(['csv', 'text']);
  });
});

describe('名前の自動付け', () => {
  it('語 + 札 / 語だけ / 札だけ / 長い語は切る', () => {
    // 札は綴り順にそろえてから呼び名にする(csv → 表、text → ノート)
    expect(autoSearchName('請求書', ['text', 'csv'], label)).toBe('請求書(表・ノート)');
    expect(autoSearchName('請求書', [], label)).toBe('請求書');
    expect(autoSearchName('', ['todo'], label)).toBe('タスク');
    const long = autoSearchName('あ'.repeat(100), [], label);
    expect([...long].length).toBe(40);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('保存(addSavedSearch)', () => {
  it('新しい順に先頭へ積み、語と札を正規化して持つ / 元の配列は壊さない', () => {
    const first = addSavedSearch([], ' 請求書 ', ['text', 'csv'], 'a', label);
    expect(first.kind).toBe('added');
    if (first.kind !== 'added') return;
    expect(first.added).toMatchObject({ id: 'a', query: '請求書', kinds: ['csv', 'text'] });
    const orig = first.list;
    const second = addSavedSearch(orig, '議事録', [], 'b', label);
    expect(second.kind === 'added' && second.list.map((s) => s.id)).toEqual(['b', 'a']);
    expect(orig.map((s) => s.id)).toEqual(['a']);
  });

  it('🔴 同じ組は 2 つ憶えない(既存を返す)', () => {
    const a = addSavedSearch([], '請求書', ['text'], 'a', label);
    const dup = addSavedSearch(a.list, ' 請求書 ', ['text'], 'b', label);
    expect(dup.kind).toBe('exists');
    expect(dup.list).toHaveLength(1);
    expect(dup.kind === 'exists' && dup.existing.id).toBe('a');
  });

  it('語も札も無い絞りは断る(empty)', () => {
    const r = addSavedSearch([], '', [], 'a', label);
    expect(r).toMatchObject({ kind: 'refused', reason: 'empty' });
  });

  it('🔴 上限を超えるときは古い物を捨てずに断る(full)', () => {
    let list: SavedSearch[] = [];
    for (let i = 0; i < SAVED_SEARCH_MAX; i++) {
      const r = addSavedSearch(list, `語${i}`, [], `id${i}`, label);
      list = r.list;
    }
    expect(list).toHaveLength(SAVED_SEARCH_MAX);
    const over = addSavedSearch(list, '新しい語', [], 'new', label);
    expect(over).toMatchObject({ kind: 'refused', reason: 'full' });
    expect(over.list.map((s) => s.id)).toEqual(list.map((s) => s.id)); // 1 件も消えていない
  });
});

describe('名前を直す・削除(双方向)', () => {
  const base: SavedSearch[] = [
    { id: 'a', name: '請求書', query: '請求書', kinds: [] },
    { id: 'b', name: '議事録', query: '議事録', kinds: [] },
  ];
  it('名前だけが変わる / 空にしたら変えない / 長い名前は切る', () => {
    expect(renameSavedSearch(base, 'a', '毎週の請求')[0]).toEqual({ ...base[0], name: '毎週の請求' });
    expect(renameSavedSearch(base, 'a', '  ')).toEqual(base);
    expect([...renameSavedSearch(base, 'a', 'x'.repeat(80))[0]!.name].length).toBe(40);
    expect(renameSavedSearch(base, 'zzz', 'x')).toEqual(base);
  });
  it('削除すると、その 1 件だけが無くなる', () => {
    expect(removeSavedSearch(base, 'a').map((s) => s.id)).toEqual(['b']);
    expect(removeSavedSearch(base, 'zzz')).toHaveLength(2);
    expect(findSavedSearch(removeSavedSearch(base, 'a'), '請求書', [])).toBeUndefined();
  });
});

describe('保存の読み(壊れていても落ちない)', () => {
  it('正しい形は読める / 壊れた JSON・配列でない・不正な行は捨てる', () => {
    const ok = JSON.stringify([{ id: 'a', name: '請求書', query: '請求書', kinds: ['text'] }]);
    expect(parseSavedSearches(ok)).toHaveLength(1);
    expect(parseSavedSearches(null)).toEqual([]);
    expect(parseSavedSearches('')).toEqual([]);
    expect(parseSavedSearches('{not json')).toEqual([]);
    expect(parseSavedSearches('{"a":1}')).toEqual([]);
    const mixed = JSON.stringify([
      { id: 'a', name: 'ok', query: 'x', kinds: [] },
      { id: 'a', name: '同じ id', query: 'y', kinds: [] },
      { id: '', name: '空 id', query: 'y', kinds: [] },
      { id: 'c', name: '', query: 'y', kinds: [] },
      { id: 'd', name: '語も札も無い', query: ' ', kinds: [] },
      { id: 'e', name: '札が文字列でない', query: 'y', kinds: [1] },
      42,
      null,
    ]);
    expect(parseSavedSearches(mixed).map((s) => s.id)).toEqual(['a']);
  });
  it('上限を超えて入っていても上限で切る', () => {
    const many = Array.from({ length: SAVED_SEARCH_MAX + 5 }, (_, i) => ({ id: `i${i}`, name: `n${i}`, query: `q${i}`, kinds: [] }));
    expect(parseSavedSearches(JSON.stringify(many))).toHaveLength(SAVED_SEARCH_MAX);
  });
});
