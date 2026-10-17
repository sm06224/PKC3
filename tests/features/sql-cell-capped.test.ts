/** @vitest-environment node */
/**
 * 🔴 **畳んだ値の数を言う**(#1087 の見直し)。
 *
 * worker は 2000 字を超える値を `capCellText` で畳んで運ぶ。「ファイルへ」「ノートへ」はその升をそのまま書くので、
 * **畳んだ数を書き出し先でも言う**。判定は `capCellText` が付ける印と同じ書式で見る(§7)。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_CELL_CHARS,
  capCellText,
  cappedCellsNote,
  countCappedCells,
  isCappedCellText,
} from '../../src/features/query/sql-cell';
import { sqlNoteBody } from '../../src/features/query/sql-to-note';

describe('畳んだ升の判定', () => {
  it('capCellText が畳んだ字は畳んだ升と読む / 畳まない字は読まない', () => {
    const long = 'x'.repeat(MAX_CELL_CHARS + 1);
    expect(capCellText(long).length, '前提:畳まれている').toBeGreaterThan(MAX_CELL_CHARS);
    expect(isCappedCellText(capCellText(long))).toBe(true);
    expect(isCappedCellText(capCellText('x'.repeat(MAX_CELL_CHARS)))).toBe(false);
    expect(isCappedCellText('短い')).toBe(false);
  });

  it('⚠ たまたま印に似た字・長いだけの字・字でない値は数えない', () => {
    expect(isCappedCellText('…(全 3 字)')).toBe(false);
    expect(isCappedCellText(`${'a'.repeat(3000)}`)).toBe(false);
    // 先頭が 2000 字でも、印の字数が上限以下なら畳んだ物ではない
    expect(isCappedCellText(`${'a'.repeat(MAX_CELL_CHARS)}…(全 5 字)`)).toBe(false);
    expect(isCappedCellText(12)).toBe(false);
    expect(isCappedCellText(null)).toBe(false);
  });

  it('行の中の畳んだ升を数える', () => {
    const c = capCellText('y'.repeat(5000));
    expect(countCappedCells([[c, 'a', null], [1, c]])).toBe(2);
    expect(countCappedCells([['a', 1]])).toBe(0);
    expect(countCappedCells([])).toBe(0);
  });

  it('言い方は 0 のとき空 / あるとき個数と字数', () => {
    expect(cappedCellsNote(0)).toBe('');
    expect(cappedCellsNote(3)).toBe('長い値 3 個は先頭 2000 字で切ってあります');
  });
});

describe('ノートの本文', () => {
  const base = { sql: 'select 1', columns: ['a'], truncated: false };

  it('畳んだ升が在れば、末尾で数を言う', () => {
    const rows = [[capCellText('z'.repeat(4000))], ['b']];
    const body = sqlNoteBody({ ...base, rows, capped: countCappedCells(rows) });
    expect(body).toContain('長い値 1 個は先頭 2000 字で切ってあります');
  });

  it('畳んだ升が無ければ、言わない', () => {
    expect(sqlNoteBody({ ...base, rows: [['b']], capped: 0 })).not.toContain('先頭 2000 字');
    expect(sqlNoteBody({ ...base, rows: [['b']] })).not.toContain('先頭 2000 字');
  });
});
