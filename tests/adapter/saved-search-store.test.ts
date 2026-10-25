/** @vitest-environment node */
/**
 * #1038 C1: 保存した検索の置き場。
 *
 * 規則は `tests/features/saved-search.test.ts`。ここは
 * 「保存が使えない端末でも効くか」「壊れた保存で落ちないか」「書込の中身」「通知」「別のタブの読み直し」。
 */
import { describe, expect, it } from 'vitest';
import { SavedSearchStore, type SavedSearchStorage } from '../../src/adapter/platform/saved-search-store';

const label = (a: string): string => a;

function fake(initial: string | null = null): SavedSearchStorage & { writes: string[]; value: () => string | null; put: (v: string) => void } {
  let value = initial;
  const writes: string[] = [];
  return {
    writes,
    value: () => value,
    put: (v) => {
      value = v;
    },
    get: () => value,
    set: (_k, v) => {
      value = v;
      writes.push(v);
    },
  };
}

function ids(): () => string {
  let n = 0;
  return () => `id${++n}`;
}

describe('保存した検索の置き場(#1038 C1)', () => {
  it('保存すると書き込み、別の store(= 再起動)でも同じ物が読める', () => {
    const s = fake();
    const store = new SavedSearchStore(s, ids());
    store.add('請求書', ['text'], label);
    store.add('議事録', [], label);
    expect(s.writes).toHaveLength(2);
    expect(JSON.parse(s.writes[1]!).map((x: { id: string }) => x.id)).toEqual(['id2', 'id1']);
    expect(new SavedSearchStore(s).list().map((x) => x.query)).toEqual(['議事録', '請求書']);
  });

  it('🔴 保存が無い端末でも、その場では保存・名前を直す・削除が効く(控えが死んだ枝でない)', () => {
    const store = new SavedSearchStore(null, ids());
    store.add('請求書', [], label);
    store.add('議事録', [], label);
    expect(store.list()).toHaveLength(2);
    store.rename('id1', '毎週の請求');
    expect(store.list().find((x) => x.id === 'id1')?.name).toBe('毎週の請求');
    store.remove('id2');
    expect(store.list().map((x) => x.id)).toEqual(['id1']);
    store.refresh(); // 保存が無くても落ちない・控えを消さない
    expect(store.list()).toHaveLength(1);
  });

  it('書込が投げても、控え(メモリ)には積まれて画面は動く', () => {
    const s: SavedSearchStorage = {
      get: () => null,
      set: () => {
        throw new Error('quota');
      },
    };
    const store = new SavedSearchStore(s, ids());
    expect(() => store.add('請求書', [], label)).not.toThrow();
    expect(store.list()).toHaveLength(1);
  });

  it('壊れた保存を読んでも落ちず、空から始まる', () => {
    expect(new SavedSearchStore(fake('{broken'), ids()).list()).toEqual([]);
    expect(new SavedSearchStore(fake('"str"'), ids()).list()).toEqual([]);
  });

  it('変わらないときは書かない(同じ組の保存・存在しない id の削除)', () => {
    const s = fake();
    const store = new SavedSearchStore(s, ids());
    store.add('請求書', [], label);
    store.add('請求書', [], label);
    store.remove('zzz');
    store.rename('zzz', 'x');
    expect(s.writes).toHaveLength(1);
  });

  it('変わったときだけ通知する / 解除したら通知しない', () => {
    const store = new SavedSearchStore(fake(), ids());
    let n = 0;
    const off = store.onChange(() => void n++);
    store.add('請求書', [], label);
    store.add('請求書', [], label); // 重複 ── 変わらない
    expect(n).toBe(1);
    store.rename('id1', '請求');
    store.remove('id1');
    expect(n).toBe(3);
    off();
    store.add('議事録', [], label);
    expect(n).toBe(3);
  });

  it('🔴 別のタブが書いた物は refresh で読み直し、変わったときだけ通知する', () => {
    const s = fake();
    const store = new SavedSearchStore(s, ids());
    let n = 0;
    store.onChange(() => void n++);
    s.put(JSON.stringify([{ id: 'x1', name: '他タブ', query: '他', kinds: [] }]));
    store.refresh();
    expect(store.list().map((x) => x.id)).toEqual(['x1']);
    expect(n).toBe(1);
    store.refresh(); // 同じ ── 通知しない
    expect(n).toBe(1);
    s.put(JSON.stringify([])); // 別のタブが全部消した
    store.refresh();
    expect(store.list()).toEqual([]);
    expect(n).toBe(2);
  });
});
