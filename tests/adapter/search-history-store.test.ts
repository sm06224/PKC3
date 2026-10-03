/**
 * 🔴 **最近探した語の置き場**(#1172)。
 *
 * ⚠ 規則は `tests/features/search-log.test.ts` が見る ── ここは
 *   「**保存が使えない端末でも効くか**」「**壊れた保存で落ちないか**」「**無駄に書かないか**」だけ。
 */
import { describe, expect, it } from 'vitest';
import {
  SearchHistoryStore,
  type SearchHistoryStorage,
} from '../../src/adapter/platform/search-history-store';

/** 偽の保存 ── 書込の**回数と中身**まで観測する。 */
function fake(
  initial: string | null = null,
): SearchHistoryStorage & { writes: string[]; keys: string[]; removed: number } {
  let value = initial;
  const writes: string[] = [];
  const keys: string[] = [];
  return {
    writes,
    keys,
    removed: 0,
    get: (k) => {
      keys.push(k);
      return value;
    },
    set(_k, v) {
      value = v;
      writes.push(v);
    },
    remove(this: { removed: number }) {
      value = null;
      this.removed += 1;
    },
  };
}

describe('最近探した語の置き場(#1172)', () => {
  it('積むと保存へ書き、読み直すと同じ物が返る(新しい順)', () => {
    const s = fake();
    const store = new SearchHistoryStore(s);
    store.push('あいう');
    store.push('かきく');
    expect(s.writes).toHaveLength(2);
    expect(JSON.parse(s.writes[1]!)).toEqual(['かきく', 'あいう']);
    expect(store.list()).toEqual(['かきく', 'あいう']);
    // ⚠ 別の store(= 再起動)でも同じ物が読める
    expect(new SearchHistoryStore(s).list()).toEqual(['かきく', 'あいう']);
  });

  /**
   * 🔴 **保存が使えない端末でも、その session の中では効く**(#278 段②の教訓)。
   * ⚠ `?.` で書くと `null` は例外を投げないので、控えが**死んだ枝**になる ── その形だと落ちる。
   */
  it('🔴 保存が無い端末でも、積んだ物をその場で読み直せる', () => {
    const store = new SearchHistoryStore(null);
    store.push('あいう');
    store.push('かきく');
    expect(store.list(), '控えが読まれていない(候補が出ない = 無言の dead click)').toEqual([
      'かきく',
      'あいう',
    ]);
    store.clear();
    expect(store.list(), '消したのに控えが残っている').toEqual([]);
  });

  /**
   * 🔴 **保存は在るが、書込だけ失敗する端末**(容量いっぱい / 私用ウィンドウ)。
   * ⚠ 上の `null` の test は**この枝を通らない**。実際の口は投げずに**黙って捨てる**ので、
   *   保存は空のまま・控えだけが積まれる(直す前は候補が 1 度も出なかった)。
   * 🔑 偽の保存は書込を**捨てる**(実物と同じ意味論)。
   */
  it('🔴 書込だけ失敗する保存でも、積んだ語がその session の中で読める', () => {
    const dropped: SearchHistoryStorage = { get: () => null, set: () => {}, remove: () => {} };
    const store = new SearchHistoryStore(dropped);
    store.push('あいう');
    store.push('かきく');
    expect(store.list(), '書込が失敗した回の控えが読まれていない').toEqual(['かきく', 'あいう']);
    store.clear();
    expect(store.list(), '消したのに控えが残っている').toEqual([]);
  });

  it('🔴 保存に 1 件でも在れば保存が正(別のタブの書込が控えに負けない。対照群)', () => {
    const s = fake();
    const store = new SearchHistoryStore(s);
    store.push('あいう');
    s.set('pkc3.search-history', JSON.stringify(['other']));
    expect(store.list()).toEqual(['other']);
  });

  it('🔴 短すぎる語・先頭と同じ語は書かない(毎回の書込を作らない)', () => {
    const s = fake();
    const store = new SearchHistoryStore(s);
    store.push('あ');
    store.push('  ');
    expect(s.writes, '積まれない語を書いた').toHaveLength(0);
    store.push('あいう');
    store.push('あいう');
    expect(s.writes, '変わらないのに書いた').toHaveLength(1);
  });

  /** ⚠ 別のタブが積んだ語も次の読みで見える(読むたびに保存を引く)。 */
  it('読むたびに保存を引く(別のタブの書込が見える)', () => {
    const s = fake();
    const store = new SearchHistoryStore(s);
    s.set('pkc3.search-history', JSON.stringify(['other']));
    expect(store.list()).toEqual(['other']);
  });

  it('保存の鍵は `pkc3.search-history`', () => {
    const s = fake();
    new SearchHistoryStore(s).list();
    expect(new Set(s.keys)).toEqual(new Set(['pkc3.search-history']));
  });

  it('消すと、保存からも控えからも消える', () => {
    const s = fake();
    const store = new SearchHistoryStore(s);
    store.push('あいう');
    store.clear();
    expect(s.removed).toBe(1);
    expect(store.list()).toEqual([]);
  });

  /** ⚠ 壊れた JSON で画面ごと落とさない(空として読む)。 */
  it('壊れた保存は空として読む', () => {
    expect(new SearchHistoryStore(fake('{{{')).list()).toEqual([]);
    expect(new SearchHistoryStore(fake('"not an array"')).list()).toEqual([]);
  });

  it('形の違う行・重複・上限超えは落とす', () => {
    const many = Array.from({ length: 12 }, (_, i) => `語${i}`);
    const s = fake(JSON.stringify([1, null, '', 'ok', 'ok', ...many]));
    const list = new SearchHistoryStore(s).list();
    expect(list.slice(0, 2)).toEqual(['ok', '語0']);
    expect(list).toHaveLength(8);
  });
});
