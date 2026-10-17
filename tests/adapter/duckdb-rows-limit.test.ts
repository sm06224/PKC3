/** @vitest-environment node */
/**
 * 🔴 **DuckDB の答えは、JS の行にする前に上限で切る**(#1087 の見直し)。
 *
 * 直す前は `table.toArray()` で全行を JS の物にしてから切っていた。
 * 守る主張:
 * 1. 上限を超える表は `slice` してから `toArray` する(捨てる行を JS の物にしない)
 * 2. 上限以内 / 上限を渡さないときは切らない(`slice` を呼ばない)
 * 3. 🔑 本物の Arrow の表で、切った行の値が列の位置で読める(`slice` が実在し、行の形が変わらない)
 * 4. 🔴 同じ名前の列(`SELECT 1 AS x, 2 AS x` / `a.id, b.id`)が、それぞれ自分の値で読める
 */
import { describe, expect, it } from 'vitest';
import { Field, Int32, RecordBatch, Schema, Struct, Table, makeData, tableFromArrays, vectorFromArray } from 'apache-arrow';
import { rowsOfTable, type ArrowTableLike } from '../../src/adapter/platform/duckdb/duckdb-open';

/** 値を読んだ行の数を数える偽の表(行を作るのは `getChildAt(i).get(row)` ── `toArray` は使わない)。 */
function fakeTable(n: number) {
  const made = { rows: 0, sliced: [] as Array<[number | undefined, number | undefined]> };
  const mk = (count: number): ArrowTableLike => ({
    numRows: count,
    slice: (b, e) => {
      made.sliced.push([b, e]);
      return mk(Math.min(count, (e ?? count) - (b ?? 0)));
    },
    toArray: () => {
      throw new Error('全行を JS の物にしている');
    },
    getChildAt: () => ({
      get: (i: number) => {
        made.rows += 1;
        return i;
      },
    }),
  });
  return { table: mk(n), made };
}

describe('rowsOfTable', () => {
  it('🔴 上限を超える表は、切ってから行にする(行を作った数が上限 + 1 で止まる)', () => {
    const { table, made } = fakeTable(1000);
    const rows = rowsOfTable(table, ['n'], 11);
    expect(rows).toHaveLength(11);
    expect(made.sliced).toEqual([[0, 11]]);
    expect(made.rows, '捨てる行まで JS の物にしている').toBe(11);
    expect(rows[10], '位置(行番号)で読めている').toEqual([10]);
  });

  it('上限と同じ行数・それ以下・上限を渡さないときは切らない', () => {
    for (const [n, limit] of [[11, 11], [3, 11], [50, undefined]] as const) {
      const { table, made } = fakeTable(n);
      expect(rowsOfTable(table, ['n'], limit)).toHaveLength(n);
      expect(made.sliced, `${String(n)} 行 / 上限 ${String(limit)}`).toEqual([]);
    }
  });

  it('🔑 本物の Arrow の表:切った行が、列の位置で読めて、順番も保たれる', () => {
    const table = tableFromArrays({ a: Int32Array.from([5, 6, 7, 8]), b: ['x', 'y', 'z', 'w'] });
    expect(rowsOfTable(table as unknown as ArrowTableLike, ['a', 'b'], 3)).toEqual([
      [5, 'x'],
      [6, 'y'],
      [7, 'z'],
    ]);
    expect(rowsOfTable(table as unknown as ArrowTableLike, ['b', 'a'])).toHaveLength(4);
  });

  it('🔴 同じ名前の列は、それぞれ自分の値で読める(名前で読むと片方の値が 2 回出る)', () => {
    const schema = new Schema([new Field('x', new Int32()), new Field('x', new Int32())]);
    const a = vectorFromArray([1, 2, 3], new Int32());
    const b = vectorFromArray([10, 20, 30], new Int32());
    const data = makeData({ type: new Struct(schema.fields), length: 3, nullCount: 0, children: [a.data[0]!, b.data[0]!] });
    const table = new Table([new RecordBatch(schema, data)]);
    // ⚠ 前提:名前で読む道では 1 行目の 2 つの値が一致してしまう(= 空振りでない)
    const byName = table.toArray()[0] as Record<string, unknown>;
    expect(new Set([byName['x']]).size).toBe(1);
    const want = [
      [1, 10],
      [2, 20],
    ];
    expect(rowsOfTable(table as unknown as ArrowTableLike, ['x', 'x'], 2)).toEqual(want);
    expect(rowsOfTable(table as unknown as ArrowTableLike, ['x', 'x'])).toHaveLength(3);
  });

  it('🔴 INTERVAL は素の 16 byte から [月, 日, ns 下位, ns 上位] で読む(Arrow の読み手は月しか読めない)', () => {
    // 実エンジンの値(2026-10-17):'1 year 2 months 3 days 04:05:06.5' = [14, 3, 531978496, 3424]
    const values = Int32Array.from([5, 0, 0, 0, 14, 3, 531978496, 3424]);
    const table = {
      numRows: 2,
      slice: () => table,
      toArray: () => [],
      getChildAt: () => ({ get: () => ({}), data: [{ length: 2, offset: 0, values }] }),
    } as unknown as ArrowTableLike;
    const rows = rowsOfTable(table, ['i'], undefined, ['Interval<MONTH_DAY_NANO>']);
    expect(Array.from(rows[0]?.[0] as Int32Array)).toEqual([5, 0, 0, 0]);
    expect(Array.from(rows[1]?.[0] as Int32Array)).toEqual([14, 3, 531978496, 3424]);
  });

  it('⚠ 「上限を超えたか」は 1 行余分に取って言う(上限ちょうどは超えていない)', () => {
    const LIMIT = 4;
    const exact = rowsOfTable(fakeTable(LIMIT).table, ['n'], LIMIT + 1);
    const over = rowsOfTable(fakeTable(LIMIT + 10).table, ['n'], LIMIT + 1);
    expect(exact.length > LIMIT, '上限ちょうどを超えたと言っている').toBe(false);
    expect(over.length > LIMIT, '超えたのに言えない').toBe(true);
    expect(over).toHaveLength(LIMIT + 1);
  });
});
