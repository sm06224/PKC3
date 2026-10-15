/**
 * 🔴 **DuckDB の答えは、JS の行にする前に上限で切る**(#1087 の見直し)。
 *
 * 直す前は `table.toArray()` で全行を JS の物にしてから切っていた。
 * 守る主張:
 * 1. 上限を超える表は `slice` してから `toArray` する(捨てる行を JS の物にしない)
 * 2. 上限以内 / 上限を渡さないときは切らない(`slice` を呼ばない)
 * 3. 🔑 本物の Arrow の表で、切った行の値が列の名前で読める(`slice` が実在し、行の形が変わらない)
 */
import { describe, expect, it } from 'vitest';
import { tableFromArrays } from 'apache-arrow';
import { rowsOfTable, type ArrowTableLike } from '../../src/adapter/platform/duckdb/duckdb-open';

/** `toArray` が何行を作ったかを数える偽の表。 */
function fakeTable(n: number) {
  const made = { rows: 0, sliced: [] as Array<[number | undefined, number | undefined]> };
  const mk = (count: number): ArrowTableLike => ({
    numRows: count,
    slice: (b, e) => {
      made.sliced.push([b, e]);
      return mk(Math.min(count, (e ?? count) - (b ?? 0)));
    },
    toArray: () => {
      made.rows += count;
      return Array.from({ length: count }, (_, i) => ({ n: i }));
    },
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
  });

  it('上限と同じ行数・それ以下・上限を渡さないときは切らない', () => {
    for (const [n, limit] of [[11, 11], [3, 11], [50, undefined]] as const) {
      const { table, made } = fakeTable(n);
      expect(rowsOfTable(table, ['n'], limit)).toHaveLength(n);
      expect(made.sliced, `${String(n)} 行 / 上限 ${String(limit)}`).toEqual([]);
    }
  });

  it('🔑 本物の Arrow の表:切った行が、列の名前で読めて、順番も保たれる', () => {
    const table = tableFromArrays({ a: Int32Array.from([5, 6, 7, 8]), b: ['x', 'y', 'z', 'w'] });
    expect(rowsOfTable(table as unknown as ArrowTableLike, ['a', 'b'], 3)).toEqual([
      [5, 'x'],
      [6, 'y'],
      [7, 'z'],
    ]);
    expect(rowsOfTable(table as unknown as ArrowTableLike, ['b', 'a'])).toHaveLength(4);
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
