/**
 * 🔴 **表の升の式**(#418 段②)。
 *
 * 守る主張:
 * 1. **正本は本文** ── 評価は描くときだけ。結果を本文へ書き戻さない
 * 2. 🔴 **黙って 0 にしない** ── 割れない / 循環 / 知らない関数は**升に理由**が出る
 * 3. 🔴 **`'` で始めれば字のまま** ── `=` で始まる字を書く道を失わない
 */
import { describe, expect, it } from 'vitest';
import {
  FORMULA_FUNCTIONS,
  displayCell,
  evaluateFormula,
  isFormula,
  parseCellRef,
} from '../../src/features/markdown/csv-formula';

const R = (...rows: string[][]): string[][] => rows;
const ev = (f: string, rows: string[][] = [[]]): string => evaluateFormula(f, rows).text;
/** ⚠ 理由も見る(`#NAME?` の 5 文字だけでは、どの関数が駄目か分からない)。 */
const why = (f: string, rows: string[][] = [[]]): string => evaluateFormula(f, rows).why ?? '';

describe('升の名前', () => {
  it('A1 は左上(0,0)', () => {
    expect(parseCellRef('A1')).toEqual({ row: 0, col: 0 });
  });
  it('列は 26 進(Z / AA / AB)', () => {
    expect(parseCellRef('Z1')).toEqual({ row: 0, col: 25 });
    expect(parseCellRef('AA1')).toEqual({ row: 0, col: 26 });
    expect(parseCellRef('AB3')).toEqual({ row: 2, col: 27 });
  });
  it('小文字でも読む(user に大文字を強いない)', () => {
    expect(parseCellRef('b2')).toEqual({ row: 1, col: 1 });
  });
  it('升の名前でないものは null', () => {
    expect(parseCellRef('SUM')).toBeNull();
    expect(parseCellRef('A0')).toBeNull();
    expect(parseCellRef('1A')).toBeNull();
  });
});

describe('式かどうか', () => {
  it('`=` で始まれば式', () => {
    expect(isFormula('=1+1')).toBe(true);
    expect(isFormula('1+1')).toBe(false);
  });
  it("🔴 `'` で始めれば字のまま(`=` を書く道を失わない)", () => {
    expect(isFormula("'=1+1")).toBe(false);
    expect(displayCell("'=1+1", [[]]).text).toBe('=1+1');
  });
  it("⚠ `'` は 1 つだけ外す(`''x` は `'x`)", () => {
    expect(displayCell("''x", [[]]).text).toBe("'x");
  });
});

describe('計算', () => {
  it('四則と括弧', () => {
    expect(ev('=1+2*3')).toBe('7');
    expect(ev('=(1+2)*3')).toBe('9');
    expect(ev('=10-4-3')).toBe('3');
    expect(ev('=8/2/2')).toBe('2');
  });
  it('べき乗は右結合', () => {
    expect(ev('=2^3^2')).toBe('512');
  });
  it('符号', () => {
    expect(ev('=-3+1')).toBe('-2');
    expect(ev('=--3')).toBe('3');
  });
  it('比べる', () => {
    expect(ev('=1<2')).toBe('TRUE');
    expect(ev('=2<=2')).toBe('TRUE');
    expect(ev('=1<>1')).toBe('FALSE');
    expect(ev('="あ"="あ"')).toBe('TRUE');
  });
  it('⚠ 浮動小数の刻みを見せない', () => {
    expect(ev('=0.1+0.2')).toBe('0.3');
  });
});

describe('升を読む', () => {
  const rows = R(['1', '2', '3'], ['4', '5', '6'], ['あ', '', '7']);

  it('1 つ読む', () => {
    expect(evaluateFormula('=A1+B2', rows).text).toBe('6');
  });
  it('範囲を読む(縦・横・矩形)', () => {
    expect(evaluateFormula('=SUM(A1:C1)', rows).text).toBe('6');
    expect(evaluateFormula('=SUM(A1:A2)', rows).text).toBe('5');
    expect(evaluateFormula('=SUM(A1:B2)', rows).text).toBe('12');
  });
  it('⚠ 逆向きに書いても同じ(A2:A1)', () => {
    expect(evaluateFormula('=SUM(A2:A1)', rows).text).toBe('5');
  });
  it('⚠ 無い升は空として読む(表の外を指しても落ちない)', () => {
    expect(evaluateFormula('=SUM(A1:Z9)', rows).text).toBe('28');
  });
  it('🔴 見出しの有無で番号が動かない(1 行目が 1 行目)', () => {
    // ⚠ 動くと `noheader` を切り替えた瞬間に全部の式がずれる
    expect(evaluateFormula('=A1', rows).text).toBe('1');
  });
});

describe('関数', () => {
  const rows = R(['1', '2'], ['3', 'あ'], ['', '4']);
  const f = (s: string): string => evaluateFormula(s, rows).text;

  it('SUM / AVERAGE / MIN / MAX', () => {
    expect(f('=SUM(A1:A3)')).toBe('4');
    expect(f('=AVERAGE(A1:A2)')).toBe('2');
    expect(f('=MIN(A1:A2)')).toBe('1');
    expect(f('=MAX(A1:A2)')).toBe('3');
  });
  it('⚠ COUNT は数として読めるものだけ数える', () => {
    expect(f('=COUNT(A1:B3)')).toBe('4');
  });
  it('IF', () => {
    expect(f('=IF(A1<A2,"小さい","大きい")')).toBe('小さい');
    expect(f('=IF(A2<A1,"小さい","大きい")')).toBe('大きい');
    // ⚠ 3 つ目を書かなければ空
    expect(f('=IF(A2<A1,"小さい")')).toBe('');
  });
  it('ABS / ROUND / CONCAT / LEN', () => {
    expect(f('=ABS(0-5)')).toBe('5');
    expect(f('=ROUND(3.14159,2)')).toBe('3.14');
    expect(f('=ROUND(3.7)')).toBe('4');
    expect(f('=CONCAT("あ",A1,"い")')).toBe('あ1い');
    expect(f('=LEN("あいう")')).toBe('3');
  });
  it('⚠ 一覧は 10 個(PKC2 と同じところから始める)', () => {
    expect(FORMULA_FUNCTIONS).toHaveLength(10);
  });
});

describe('🔴 黙って 0 にしない ── 升に理由を出す', () => {
  it('0 で割ったら #DIV/0!', () => {
    expect(ev('=1/0')).toBe('#DIV/0!');
  });
  it('知らない関数は #NAME?', () => {
    expect(ev('=VLOOKUP(1)')).toBe('#NAME?');
    expect(ev('=A')).toBe('#NAME?');
  });
  it('書き方が壊れていたら #ERR!', () => {
    expect(ev('=1+')).toBe('#ERR!');
    expect(ev('=(1')).toBe('#ERR!');
    expect(ev('=1 2')).toBe('#ERR!');
    expect(ev('=#')).toBe('#ERR!');
  });
  it('数として読めない字を足したら #ERR!', () => {
    expect(evaluateFormula('=A1+1', R(['あ'])).text).toBe('#ERR!');
  });
  it('範囲の終わりが升でなければ #REF!', () => {
    expect(ev('=SUM(A1:SUM)')).toBe('#REF!');
  });

  it('🔴 自分を指したら #CYCLE!(ぐるぐる回らない)', () => {
    expect(evaluateFormula('=A1+1', R(['=A1+1'])).text).toBe('#CYCLE!');
  });
  it('🔴 2 つで回しても #CYCLE!', () => {
    const rows = R(['=B1', '=A1']);
    expect(evaluateFormula('=B1', rows).text).toBe('#CYCLE!');
  });
  it('⚠ 深いだけの参照は通る(循環ではない)', () => {
    // A1=1 / B1==A1+1 / C1==B1+1 …
    const rows = R(['1', '=A1+1', '=B1+1', '=C1+1']);
    expect(evaluateFormula('=D1', rows).text).toBe('4');
  });
  it('⚠ 1 つの升の誤りで、表全体は消えない(投げない)', () => {
    expect(() => evaluateFormula('=1/0', [[]]).text).not.toThrow();
  });
});

describe('升を描く形にする', () => {
  const rows = R(['2', '3', '=A1*B1']);
  it('式は結果になる', () => {
    expect(displayCell('=A1*B1', rows).text).toBe('6');
  });
  it('式でない字はそのまま(1 バイトも変えない)', () => {
    expect(displayCell('ふつうの字', rows).text).toBe('ふつうの字');
    expect(displayCell('', rows).text).toBe('');
    expect(displayCell('=', rows).text).toBe('#ERR!');
  });
});

/**
 * 🔴 **範囲の中の字は飛ばす / 直接書いた字は飛ばさない**(表計算の作法)。
 *
 * ⚠ ここを区別しないと、どちらかが user を裏切る ── 範囲で落ちると
 *   「表に 1 つ注記を書いたら合計が消えた」、直接で飛ばすと
 *   「打ち間違いが黙って 0 として足される」。
 */
describe('数として集めるときの飛ばし方', () => {
  const rows = R(['1', 'あ'], ['2', ''], ['3', 'メモ']);

  it('🔴 範囲に字が混ざっても足せる', () => {
    expect(evaluateFormula('=SUM(A1:B3)', rows).text).toBe('6');
  });
  it('🔴 直接書いた字は誤りになる(黙って 0 にしない)', () => {
    expect(evaluateFormula('=SUM(1,"あ")', rows).text).toBe('#ERR!');
  });
  it('⚠ AVERAGE も範囲では字を飛ばす(分母に数えない)', () => {
    // 1 / 2 / 3 の 3 つで割る(空とメモは数えない)
    expect(evaluateFormula('=AVERAGE(A1:B3)', rows).text).toBe('2');
  });
  it('⚠ MIN / MAX も字を飛ばす', () => {
    expect(evaluateFormula('=MIN(A1:B3)', rows).text).toBe('1');
    expect(evaluateFormula('=MAX(A1:B3)', rows).text).toBe('3');
  });
  it('⚠ 数が 1 つも無い範囲の AVERAGE は #DIV/0!(0 と言わない)', () => {
    expect(evaluateFormula('=AVERAGE(B1:B3)', rows).text).toBe('#DIV/0!');
  });
  it('⚠ 空文字は数として数えない', () => {
    expect(evaluateFormula('=COUNT(B1:B3)', rows).text).toBe('0');
  });
});

/**
 * 🔴 **理由を捨てない**(#418 段②の 2 稿目)。
 *
 * ⚠ `#NAME?` の 5 文字だけでは、**どの関数が駄目なのか**が分からない ──
 *   1 稿目は理由を作っておきながら**返さずに捨てて**いた
 *   (誰も読まない値は、そのうち嘘になる)。
 */
describe('誤りの理由が返る', () => {
  it('🔴 どの関数が駄目かが分かる', () => {
    expect(why('=VLOOKUP(1)')).toContain('VLOOKUP');
    // 🔑 使えるものも並べる ── 「駄目」だけでは次に何を打てばよいか分からない
    expect(why('=VLOOKUP(1)')).toContain('SUM');
  });
  it('🔴 何が起きたかが分かる', () => {
    expect(why('=1/0')).toContain('0 で割');
    expect(why('=(1')).toContain(')');
    expect(evaluateFormula('=A1', R(['=A1'])).why).toContain('ぐるぐる');
  });
  it('⚠ 正しい式では理由が付かない(誤りのない升に字を足さない)', () => {
    expect(evaluateFormula('=1+1', [[]]).why).toBeUndefined();
  });
});
