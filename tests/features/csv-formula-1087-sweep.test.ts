/**
 * 🔴 **表の式の直し 4 件**(#1087 F-1〜F-4)。
 *
 * 守る主張:
 * 1. F-1 csv の升は全部字だが、**両方が数として読めるなら数で比べる**(`10 > 9` / `1.0 = 1`)。数でない字は従来どおり字で比べる
 * 2. F-2 升の `0` / `0.0` は IF の条件で**偽**(表計算と同じ)。空 / `FALSE` / 数でない字の扱いは従来どおり
 * 3. F-3 巨大な範囲は**表の大きさへ切る** ── 答えは変えず、描くたびの数秒を消す
 * 4. F-4 表 1 枚で評価の入れ物(memo)を共有する ── 累計の列が行数の 2 乗にならない
 */
import { describe, expect, it } from 'vitest';
import {
  createFormulaContext,
  displayCell,
  evaluateFormula,
} from '../../src/features/markdown/csv-formula';
import { rowsToHtml } from '../../src/features/markdown/csv-table';

const ev = (f: string, rows: string[][] = [[]]): string => evaluateFormula(f, rows).text;

describe('F-1 升どうしの比べ', () => {
  // [a, b, >, =, <>]
  const cases: Array<[string, string, string, string, string]> = [
    ['10', '9', 'TRUE', 'FALSE', 'TRUE'],
    ['9', '10', 'FALSE', 'FALSE', 'TRUE'],
    ['1.0', '1', 'FALSE', 'TRUE', 'FALSE'],
    ['-2', '-10', 'TRUE', 'FALSE', 'TRUE'],
    // 数でない字は従来どおり字で比べる(大文字小文字は区別する)
    ['abc', 'ABC', 'TRUE', 'FALSE', 'TRUE'],
    ['abc', 'abc', 'FALSE', 'TRUE', 'FALSE'],
    ['', '', 'FALSE', 'TRUE', 'FALSE'],
    // 片側だけ数なら字で比べる(従来どおり)
    ['10', 'x', 'FALSE', 'FALSE', 'TRUE'],
  ];
  for (const [a, b, gt, eq, ne] of cases) {
    it(`(${JSON.stringify(a)}, ${JSON.stringify(b)})`, () => {
      expect(ev('=A1>B1', [[a, b]])).toBe(gt);
      expect(ev('=A1=B1', [[a, b]])).toBe(eq);
      expect(ev('=A1<>B1', [[a, b]])).toBe(ne);
    });
  }
  it('IF の中でも効く', () => {
    expect(ev('=IF(A1>B1,"big","small")', [['10', '9']])).toBe('big');
  });
});

describe('F-2 IF の条件', () => {
  const cond: Array<[string, string]> = [
    ['0', 'no'],
    ['0.0', 'no'],
    ['1', 'yes'],
    ['-1', 'yes'],
    ['', 'no'],
    ['FALSE', 'no'],
    ['abc', 'yes'],
  ];
  for (const [v, want] of cond) {
    it(`升が ${JSON.stringify(v)} → ${want}`, () => {
      expect(ev('=IF(A1,"yes","no")', [[v]])).toBe(want);
    });
  }
  it('式の結果が 0 でも偽(従来どおり)', () => {
    expect(ev('=IF(A1-1,"yes","no")', [['1']])).toBe('no');
  });
});

describe('F-3 範囲は表の大きさへ切る', () => {
  const table = [['1', '2'], ['3', 'x'], ['5', '']];
  it('巨大な範囲が小さな範囲と同じ答えで、すぐ返る', () => {
    const t0 = performance.now();
    const big = [
      ev('=SUM(A1:A10000000)', table),
      ev('=SUM(A1:ZZ100000)', table),
      ev('=COUNT(A1:ZZ100000)', table),
      ev('=AVERAGE(A1:ZZ100000)', table),
      ev('=MAX(A1:ZZ100000)', table),
      ev('=MIN(A1:ZZ100000)', table),
    ];
    const ms = performance.now() - t0;
    expect(big).toEqual([
      ev('=SUM(A1:A3)', table),
      ev('=SUM(A1:B3)', table),
      ev('=COUNT(A1:B3)', table),
      ev('=AVERAGE(A1:B3)', table),
      ev('=MAX(A1:B3)', table),
      ev('=MIN(A1:B3)', table),
    ]);
    expect(big).toEqual(['9', '11', '4', '2.75', '5', '1']);
    expect(ms).toBeLessThan(200);
  });
  it('表の外だけの範囲は空(SUM は 0・AVERAGE は割れない)', () => {
    expect(ev('=SUM(Z50:ZZ100000)', table)).toBe('0');
    expect(ev('=AVERAGE(Z50:Z60)', table)).toBe('#DIV/0!');
  });
  it('循環は範囲を通っても見つかる', () => {
    expect(ev('=SUM(A1:A9999999)', [['=SUM(A1:A9999999)']])).toBe('#CYCLE!');
    const rows = [['=SUM(B1:B9999999)', '=A1']];
    expect(displayCell('=B1', rows).text).toBe('#CYCLE!');
  });
  it('範囲の先の式も評価される', () => {
    expect(ev('=SUM(A1:A9999999)', [['1'], ['=A1+1'], ['=A2+1']])).toBe('6');
  });
});

describe('F-4 表 1 枚で評価の入れ物を共有する', () => {
  const chain = (n: number): string[][] =>
    Array.from({ length: n }, (_, i) => (i === 0 ? ['1', '=A1'] : [String(i + 1), `=B${i}+A${i + 1}`]));

  it('入れ物を共有しても、升ごとの答えは 1 つずつ評価したものと同じ', () => {
    const rows = chain(300);
    rows.push(['=SUM(B1:B300)', '=A1/0', '=C9'], ['=C2', '=B302', 'x']);
    const ctx = createFormulaContext(rows);
    for (const r of rows) {
      for (const c of r) {
        expect(displayCell(c, rows, ctx)).toEqual(displayCell(c, rows));
      }
    }
  });
  it('入れ物に答えが溜まる', () => {
    const rows = chain(50);
    const ctx = createFormulaContext(rows);
    displayCell(rows[49]![1]!, rows, ctx);
    const size = (ctx as unknown as { memo: Map<string, unknown> }).memo.size;
    expect(size).toBeGreaterThanOrEqual(49);
  });
  it('2000 行の累計が 1 秒かからない', () => {
    const rows = chain(2000);
    const t0 = performance.now();
    const html = rowsToHtml(rows, false);
    const ms = performance.now() - t0;
    expect(html).toContain('>2001000<'); // 1+2+…+2000
    expect(ms).toBeLessThan(1000);
  });
});
