/**
 * 🔴 **SQL 画面の並び(3 ペイン)の pure な決まり**(#1442 段②)。
 * 🔑 範囲・保存の形・入れる字の組み方 ── どれも「通る値」と「通らない値」の両側を見る。
 */
import { describe, expect, it } from 'vitest';
import {
  clampSqlSplit,
  decodeSqlLayout,
  encodeSqlLayout,
  insertionWithSpacing,
  isSqlLayout,
  selectFromTableSql,
  splitFromDrag,
  splitFromKey,
  SQL_SPLIT_DEFAULT,
  SQL_SPLIT_MAX,
  SQL_SPLIT_MIN,
  treeOpenInitially,
} from '../../src/features/query/sql-layout';
import { SqlLayoutStore } from '../../src/adapter/ui/render/sql-layout';

describe('境目の割合', () => {
  it('範囲へ丸める / 数でない値は既定へ', () => {
    expect(clampSqlSplit(-5)).toBe(SQL_SPLIT_MIN);
    expect(clampSqlSplit(500)).toBe(SQL_SPLIT_MAX);
    expect(clampSqlSplit(40.4)).toBe(40);
    expect(clampSqlSplit(Number.NaN)).toBe(SQL_SPLIT_DEFAULT);
  });
  it('掴んだ量 → 割合(下が正)/ 測れない器では動かさない', () => {
    expect(splitFromDrag(40, 50, 500)).toBe(50);
    expect(splitFromDrag(40, -50, 500)).toBe(30);
    expect(splitFromDrag(40, 9999, 500)).toBe(SQL_SPLIT_MAX);
    expect(splitFromDrag(40, 50, 0), '測れないのに動いた').toBe(40);
  });
  it('矢印キー: ↓ は広がる / Shift は大きく / Home End は端 / 他の鍵は null', () => {
    expect(splitFromKey(40, 'ArrowDown', false)).toBe(42);
    expect(splitFromKey(40, 'ArrowUp', true)).toBe(30);
    expect(splitFromKey(40, 'Home', false)).toBe(SQL_SPLIT_MIN);
    expect(splitFromKey(40, 'End', false)).toBe(SQL_SPLIT_MAX);
    expect(splitFromKey(40, 'a', false)).toBeNull();
  });
});

describe('保存の形', () => {
  it('往復する / 読めない字は「決めていない」へ丸める', () => {
    for (const l of [
      { tree: true, split: 45 },
      { tree: false, split: null },
      { tree: null, split: 20 },
      { tree: null, split: null },
    ] as const) expect(decodeSqlLayout(encodeSqlLayout(l))).toEqual(l);
    expect(decodeSqlLayout('banana')).toEqual({ tree: null, split: null });
    expect(decodeSqlLayout(null)).toEqual({ tree: null, split: null });
  });
  it('検査: 範囲の外・形の違いは断る', () => {
    expect(isSqlLayout('1:45')).toBe(true);
    expect(isSqlLayout(':')).toBe(true);
    expect(isSqlLayout('1:5')).toBe(false);
    expect(isSqlLayout('1:90')).toBe(false);
    expect(isSqlLayout('2:40')).toBe(false);
    expect(isSqlLayout('1:40 junk')).toBe(false);
  });
  it('store: 書けない環境でも控えが効く(`?.` で死んだ枝にしない)', () => {
    const none = new SqlLayoutStore(null);
    none.setTree(false);
    none.setSplit(33);
    expect(none.get()).toEqual({ tree: false, split: 33 });
    const full = new SqlLayoutStore({
      getItem: () => null,
      setItem: () => {
        throw new Error('容量不足');
      },
    });
    full.setSplit(60);
    expect(full.get().split, '書けなかったのに戻った').toBe(60);
  });
  it('木の初期: 決めていれば幅に依らず / 決めていなければ狭い所だけ畳む', () => {
    expect(treeOpenInitially(true, 300)).toBe(true);
    expect(treeOpenInitially(false, 1600)).toBe(false);
    expect(treeOpenInitially(null, 420)).toBe(false);
    expect(treeOpenInitially(null, 1440)).toBe(true);
    expect(treeOpenInitially(null, 0), '測れないときに畳んだ').toBe(true);
  });
});

describe('欄へ入れる字', () => {
  it('SELECT 文: 予約語・記号の名前は引用符で囲う / 日本語は裸', () => {
    expect(selectFromTableSql('売上')).toBe('SELECT * FROM 売上 LIMIT 20');
    expect(selectFromTableSql('order')).toBe('SELECT * FROM "order" LIMIT 20');
    expect(selectFromTableSql('a b"c')).toBe('SELECT * FROM "a b""c" LIMIT 20');
  });
  it('名前: 空・空白・括弧・カンマ・ドットの直後はそのまま、語の直後は空白を挟む', () => {
    expect(insertionWithSpacing('', 'x', 'name')).toBe('x');
    for (const before of ['SELECT ', 'f(', 'a,', 't.', 'a\n']) {
      expect(insertionWithSpacing(before, 'x', 'name'), before).toBe('x');
    }
    expect(insertionWithSpacing('SELECT', 'x', 'name')).toBe(' x');
  });
  it('文: 空ならそのまま、改行で終わっていなければ改行を 1 つ', () => {
    expect(insertionWithSpacing('', 's', 'statement')).toBe('s');
    expect(insertionWithSpacing('select 1', 's', 'statement')).toBe('\ns');
    expect(insertionWithSpacing('select 1\n', 's', 'statement')).toBe('s');
  });
});
