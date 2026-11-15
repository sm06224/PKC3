/** #1163 依頼 133(推薦 C): ノートへ書き出すのはセル 200,000 個(SQL の画面から引き直せる大きさ)まで。 */
import { describe, expect, it } from 'vitest';
import { sqlNoteBody, sqlNoteCutNote, sqlNoteRowLimit } from '../../src/features/query/sql-to-note';
import { CSV_TABLE_CELLS_MAX, csvCellsOverBudget } from '../../src/features/query/csv-tables';
import { allFences } from '../../src/features/markdown/source-blocks';
import { parseCsv } from '../../src/features/markdown/csv-table';

const base = { sql: 'SELECT 1', truncated: false } as const;

/** 本文の csv の囲みの中身を、読み手(`parseCsv`)で行に割る。 */
function csvRowsOf(body: string): string[][] {
  expect(allFences(body).map((f) => f.name.toLowerCase())).toEqual(['sql', 'csv']);
  const m = /\n```csv\n([\s\S]*?)\n```\n/.exec(body);
  expect(m, 'csv の囲みが無い').not.toBeNull();
  return parseCsv(m![1]!, ',') ?? [];
}

describe('ノートへ書き出す行の上限(依頼 133)', () => {
  it('行の上限はセル上限 ÷ 列数(1 行は必ず入る)', () => {
    expect(sqlNoteRowLimit(8)).toBe(25_000);
    expect(sqlNoteRowLimit(1)).toBe(CSV_TABLE_CELLS_MAX);
    expect(sqlNoteRowLimit(CSV_TABLE_CELLS_MAX + 5)).toBe(1);
    expect(sqlNoteRowLimit(0)).toBe(CSV_TABLE_CELLS_MAX);
  });

  it('🔴 上限を超える行は入れず、本文にそう書く。入った表は SQL の画面から引き直せる大きさ', () => {
    const columns = ['a', 'b', 'c', 'd'];
    const limit = sqlNoteRowLimit(columns.length);
    const rows = Array.from({ length: limit + 7 }, (_, i) => [String(i), 'x', 'y', 'z']);
    const body = sqlNoteBody({ ...base, columns, rows });
    const parsed = csvRowsOf(body);
    expect(parsed.length - 1, '見出しを除いた行数が上限と違う').toBe(limit);
    expect(parsed[parsed.length - 1]![0]).toBe(String(limit - 1));
    expect(body).toContain(`先頭 ${String(limit)} 行だけです`);
    expect(body).toContain(sqlNoteCutNote(7));
    // 🔑 引き直す側の門(csvCellsOverBudget)を通る大きさになっている
    expect(csvCellsOverBudget([{ name: 't', columns, rows: parsed.slice(1) } as never])).toBeNull();
  });

  it('上限ちょうどなら切らない・何も言わない(対照群)', () => {
    const columns = ['a', 'b'];
    const limit = sqlNoteRowLimit(columns.length);
    const rows = Array.from({ length: limit }, (_, i) => [String(i), 'x']);
    const body = sqlNoteBody({ ...base, columns, rows });
    expect(csvRowsOf(body).length - 1).toBe(limit);
    expect(body).not.toContain('ノートに入れていません');
  });

  it('知らせの文は数を含み、0 なら空', () => {
    expect(sqlNoteCutNote(0)).toBe('');
    expect(sqlNoteCutNote(12)).toContain('12 行');
    expect(sqlNoteCutNote(12)).toContain('ファイルへ書き出す');
  });
});
