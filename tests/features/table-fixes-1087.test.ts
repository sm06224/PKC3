/**
 * 🔴 **表と式の直し**(#1087)── 式の連鎖 / csv の引用符 / 並べ替えの数 / ROUND。
 *
 * 守る主張:
 * 1. 循環していない長い連鎖は答えが出る。本物の循環だけが `#CYCLE!`
 * 2. 升の答えは覚える ── 前の 2 つを足す連鎖が指数にならない
 * 3. 引用が始まるのは升の先頭の `"` だけ。先頭の BOM は見出しに混ざらない
 * 4. 並べ替えは全角の数を数と読み、16 進・指数の形は数にしない
 * 5. ROUND は 0 から遠ざかる側へ丸める
 */
import { describe, expect, it } from 'vitest';
import { evaluateFormula } from '../../src/features/markdown/csv-formula';
import { parseCsv, type CsvPositions } from '../../src/features/markdown/csv-table';
import { parseComparable } from '../../src/adapter/ui/render/table-sort';

const f = (formula: string, rows: string[][] = [[]]): string => evaluateFormula(formula, rows).text;

describe('式の連鎖(#1087)', () => {
  it('🔴 200 行の累計(循環していない)が正しく出る', () => {
    const rows: string[][] = [['1']];
    for (let r = 1; r < 200; r += 1) rows.push([`=A${r}+1`]);
    expect(f('=A200', rows)).toBe('200');
    expect(f(rows[199]![0]!, rows)).toBe('200');
  });

  it('🔴 5000 行つながっても呼び出しの深さで落ちない', () => {
    const rows: string[][] = [['1']];
    for (let r = 1; r < 5000; r += 1) rows.push([`=A${r}+1`]);
    expect(f('=A5000', rows)).toBe('5000');
  });

  it('本物の循環は #CYCLE! のまま(自分 / 2 つ / 3 つ / 範囲の中)', () => {
    expect(f('=A1+1', [['=A1+1']])).toBe('#CYCLE!');
    expect(f('=B1', [['=B1', '=A1']])).toBe('#CYCLE!');
    expect(f('=A1', [['=B1', '=C1', '=A1']])).toBe('#CYCLE!');
    expect(f('=SUM(A1:B2)', [['=B2', '1'], ['2', '=A1']])).toBe('#CYCLE!');
  });

  it('循環の外の升は巻き込まれず答えが出る', () => {
    expect(f('=A2+1', [['=B1', '=A1'], ['5']])).toBe('6');
  });

  it('🔴 フィボナッチ状の連鎖(60 行)が 100ms 未満で出る', () => {
    const rows: string[][] = [['1'], ['1']];
    for (let r = 2; r < 60; r += 1) rows.push([`=A${r - 1}+A${r}`]);
    const t0 = performance.now();
    const out = f('=A60', rows);
    const ms = performance.now() - t0;
    expect(out).toBe('1548008755920');
    expect(ms).toBeLessThan(100);
  });
});

describe('ROUND(#1087)', () => {
  it('0.5 は 0 から遠ざかる側へ', () => {
    expect(f('=ROUND(-2.5)')).toBe('-3');
    expect(f('=ROUND(2.5)')).toBe('3');
    expect(f('=ROUND(-0.5)')).toBe('-1');
  });
  it('2 進数の刻みで落ちる 1.005 も Excel と同じ', () => {
    expect(f('=ROUND(1.005,2)')).toBe('1.01');
    expect(f('=ROUND(-1.005,2)')).toBe('-1.01');
    expect(f('=ROUND(2.675,2)')).toBe('2.68');
  });
  it('桁の指定(0 / 負)と、既存の丸め', () => {
    expect(f('=ROUND(1234,-2)')).toBe('1200');
    expect(f('=ROUND(3.14159,2)')).toBe('3.14');
    expect(f('=ROUND(3.7)')).toBe('4');
  });
});

describe('csv の引用符(#1087)', () => {
  it('🔴 升の途中の " は字そのもの(残りの行を飲み込まない)', () => {
    expect(parseCsv('a,b\n5"x,y\n6,7', ',')).toEqual([['a', 'b'], ['5"x', 'y'], ['6', '7']]);
  });
  it('先頭の " だけが引用を開く(従来どおり)', () => {
    expect(parseCsv('a,b\n"x,1",y\n"p""q",r', ',')).toEqual([['a', 'b'], ['x,1', 'y'], ['p"q', 'r']]);
  });
  it('閉じていない引用は最後まで飲み、unterminated を立てる', () => {
    const pos: CsvPositions = { rowLines: [], cellSpans: [] };
    const rows = parseCsv('a,b\n"x,1\n2,3', ',', pos);
    expect(rows).toEqual([['a', 'b'], ['x,1\n2,3']]);
    expect(pos.unterminated).toBe(true);
    const mid: CsvPositions = { rowLines: [], cellSpans: [] };
    parseCsv('a,b\n5"x,y', ',', mid);
    expect(mid.unterminated).toBe(false);
  });
  it('升の位置は原文の添字のまま(途中の " があってもずれない)', () => {
    const src = 'a,b\n5"x,y\n6,7';
    const pos: CsvPositions = { rowLines: [], cellSpans: [] };
    parseCsv(src, ',', pos);
    const spans = pos.cellSpans!;
    expect(src.slice(spans[1]![0]!.start, spans[1]![0]!.end)).toBe('5"x');
    expect(src.slice(spans[1]![1]!.start, spans[1]![1]!.end)).toBe('y');
    expect(src.slice(spans[2]![0]!.start, spans[2]![0]!.end)).toBe('6');
    expect(pos.rowLines).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 1 },
      { start: 2, end: 2 },
    ]);
  });
  it('🔴 先頭の BOM は最初の見出しに混ざらない(位置は原文の添字)', () => {
    const src = '\uFEFFname,age\nx,1';
    const pos: CsvPositions = { rowLines: [], cellSpans: [] };
    const rows = parseCsv(src, ',', pos);
    expect(rows![0]![0]).toBe('name');
    expect(src.slice(pos.cellSpans![0]![0]!.start, pos.cellSpans![0]![0]!.end)).toBe('name');
    expect(parseCsv('\uFEFF"a b",c\n1,2', ',')![0]).toEqual(['a b', 'c']);
  });
});

describe('並べ替えの数の読み(#1087)', () => {
  const n = (s: string): number | null => {
    const c = parseComparable(s);
    return c.isNum ? c.num : null;
  };
  it('🔴 全角の数字・通貨・マイナス(U+2212)を数と読む', () => {
    expect(n('１０')).toBe(10);
    expect(n('¥１００')).toBe(100);
    expect(n('\u22125')).toBe(-5);
    expect(n('１，２３４')).toBe(1234);
    expect(n('５０％')).toBe(50);
  });
  it('従来の読み方(通貨 / カンマ / % / 円 / 小数)は変わらない', () => {
    expect(n('¥1,234')).toBe(1234);
    expect(n('$12.5')).toBe(12.5);
    expect(n('1,234円')).toBe(1234);
    expect(n('12%')).toBe(12);
    expect(n('-45.6')).toBe(-45.6);
    expect(n('.5')).toBe(0.5);
  });
  it('🔴 16 進・指数・無限大の形は数にしない(部品番号を数として並べない)', () => {
    for (const s of ['0x1F', '1e3', '12E5', 'Infinity', '1_000', '1,2,3', '12abc', '--5']) {
      expect(n(s)).toBeNull();
    }
  });
});
