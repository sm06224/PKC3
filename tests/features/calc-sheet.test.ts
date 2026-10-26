/**
 * 🔴 **計算スクラッチパッドの評価器**(#1230)。期待値は issue 本文の例と、手で書いた固定の数で守る
 * (評価器と同じ関数で期待値を作らない)。
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateSheet,
  formatSheetNumber,
  sheetNoteTitle,
  sheetToMarkdown,
  sheetToText,
} from '../../src/features/calc/sheet';

const shown = (src: string): string[] => evaluateSheet(src).map((r) => r.display);
const kinds = (src: string): string[] => evaluateSheet(src).map((r) => r.kind);

describe('issue の例(名前・単位・割合)', () => {
  const SRC = [
    '基本単価 = 3200 円',
    '作業時間 = 40 時間',
    '小計 = 基本単価 * 作業時間',
    '特別値引き = 8000 円',
    '小計2 = 小計 - 特別値引き',
    '消費税 = 小計2 * 0.10',
    '合計 = 小計2 + 消費税',
  ].join('\n');
  it('各行の右に結果が並ぶ(桁区切り・単位は読み飛ばす)', () => {
    expect(shown(SRC)).toEqual(['3,200', '40', '128,000', '8,000', '120,000', '12,000', '132,000']);
  });
  it('🔴 追従する: 上の値を直すと、下の結果が全部変わる', () => {
    const edited = SRC.replace('3200 円', '4000 円');
    expect(shown(edited)).toEqual(['4,000', '40', '160,000', '8,000', '152,000', '15,200', '167,200']);
  });
  it('定義は下にだけ効く(下で定義した名前を上で使っても値にならない)', () => {
    const rows = evaluateSheet('小計 = 単価 * 2\n単価 = 100');
    expect(rows[0]!.kind).not.toBe('value');
    expect(rows[1]!.display).toBe('100');
  });
  it('同じ名前は後の定義が勝つ', () => {
    expect(shown('a = 1\na = 5\nb = a + 1')).toEqual(['1', '5', '6']);
  });
  it('全角で打っても読める(数・記号・× ÷・＝)', () => {
    expect(shown('単価＝３２００\n小計＝単価×４０\n半分＝小計÷２')).toEqual(['3,200', '128,000', '64,000']);
  });
});

describe('単位と文章', () => {
  it('単位は読み飛ばす: 数の後ろ・通貨記号の前・式の途中の 1 語', () => {
    expect(shown('$100 + $50')).toEqual(['150']);
    expect(shown('3 個 + 5 個')).toEqual(['8']);
    expect(shown('1,200円 + 800円')).toEqual(['2,000']);
  });
  it('行の頭の語は項目名・終わりの語はメモとして読む', () => {
    expect(shown('電車 1200円')).toEqual(['1,200']);
    expect(shown('1200円 往復')).toEqual(['1,200']);
  });
  it('🔴 文章を勝手に式にしない', () => {
    expect(kinds('今日は晴れでした')).toEqual(['text']);
    // 単位の付かない数が混じるだけ
    expect(kinds('プロジェクト 2026')).toEqual(['text']);
    // 式の途中に読み飛ばせない語
    expect(kinds('3 を 5')).toEqual(['text']);
    // 項目名だけで式が無い名前の行
    expect(kinds('メモ:')).toEqual(['text']);
  });
  it('🔴 日付・時刻・電話番号・番号つきの箇条書き・見出しは計算しない', () => {
    for (const s of ['2026-10-26', '会議 10:30', '03-1234-5678', '1. 項目 3', '# 見出し 5 + 5']) {
      expect(kinds(s), s).toEqual(['text']);
    }
  });
  it('対照: 同じ数でも、日付に見えなければ計算する', () => {
    expect(shown('2026 - 10')).toEqual(['2,016']);
  });
  it('箇条書きの記号は読み飛ばして計算する', () => {
    expect(shown('- 300 + 200')).toEqual(['500']);
  });
});

describe('割合', () => {
  it('+ - の右の割合は、左を基準にする', () => {
    expect(shown('100 + 10%')).toEqual(['110']);
    expect(shown('200 - 25%')).toEqual(['150']);
  });
  it('* / の割合は 0.01 倍として読む。単独の割合は % つきで出す', () => {
    expect(shown('1000 * 10%')).toEqual(['100']);
    expect(shown('消費税率 = 10%')).toEqual(['10%']);
    expect(shown('消費税率 = 10%\n小計 = 1200 * 消費税率')).toEqual(['10%', '120']);
  });
  it('🔴 本文の計算(inline-calc)の `%` は余りだが、ここは割合 ── 7 % 3 は式にならない', () => {
    expect(kinds('7 % 3')).not.toEqual(['value']);
  });
});

describe('合計', () => {
  it('空行までの行の結果を足す。名前なしの合計は名前を定義しない', () => {
    const rows = evaluateSheet('電車 1200円\nバス 300円\n合計');
    expect(rows.map((r) => r.display)).toEqual(['1,200', '300', '1,500']);
    expect(rows[2]!.kind).toBe('sum');
    expect(rows[2]!.name).toBeNull();
  });
  it('空行で区切ると、別の塊として数える', () => {
    expect(shown('1\n2\nsum\n\n10\n20\ntotal')).toEqual(['1', '2', '3', '', '10', '20', '30']);
  });
  it('合計の後は数え直す(続けて 2 回書いても、前の分を二重に足さない)', () => {
    expect(shown('5\n合計\n7\n合計')).toEqual(['5', '5', '7', '7']);
  });
  it('名前を付けた合計は、あとの式で使える', () => {
    expect(shown('100\n200\n小計 = 合計\n税込 = 小計 * 1.1')).toEqual(['100', '200', '300', '330']);
    expect(shown('100\n合計 =\n消費税 = 合計 * 10%')).toEqual(['100', '100', '10']);
  });
  it('値の行で「合計」を名前にしたら、その後の `合計` は変数の参照', () => {
    expect(shown('合計 = 50\n合計 + 1')).toEqual(['50', '51']);
  });
});

describe('エラー', () => {
  it('0 で割る・式が途中・括弧が閉じない行は、結果の欄に理由を出す(黙って空にしない)', () => {
    const rows = evaluateSheet('1 / 0\n3 +\n(1 + 2');
    expect(rows.map((r) => r.kind)).toEqual(['error', 'error', 'error']);
    expect(rows[0]!.display).toBe('0 では割れません');
    expect(rows[1]!.display).toContain('途中');
    expect(rows[2]!.display).toContain('括弧');
  });
  it('エラーの行は合計に入らない', () => {
    expect(shown('1 / 0\n5\n合計')).toEqual(['0 では割れません', '5', '5']);
  });
  it('空行と CRLF', () => {
    expect(kinds('1\r\n\r\n2')).toEqual(['value', 'blank', 'value']);
  });
});

describe('数の字', () => {
  it('桁区切り・負数・小数の刻みを見せない', () => {
    expect(formatSheetNumber(1234567.891)).toBe('1,234,567.891');
    expect(formatSheetNumber(-1234)).toBe('-1,234');
    expect(formatSheetNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatSheetNumber(0.5, true)).toBe('50%');
    expect(formatSheetNumber(Infinity)).toBe('—');
    expect(formatSheetNumber(-0)).toBe('0');
  });
});

describe('ノートに出す', () => {
  const rows = evaluateSheet('# 見積\n\n単価 = 100\n数量 = 3\n小計 = 単価 * 数量');
  it('表: 空行は捨て、文章の行は結果の欄が空', () => {
    expect(sheetToMarkdown(rows)).toBe(
      '| 式 | 結果 |\n| --- | --- |\n| # 見積 |  |\n| 単価 = 100 | 100 |\n| 数量 = 3 | 3 |\n| 小計 = 単価 * 数量 | 300 |',
    );
    expect(sheetToMarkdown(evaluateSheet('\n\n'))).toBeNull();
  });
  it('テキスト: 結果のある行にだけ「→ 結果」を足す', () => {
    expect(sheetToText(rows)).toBe('# 見積\n\n単価 = 100  → 100\n数量 = 3  → 3\n小計 = 単価 * 数量  → 300');
  });
  it('題名は日時入り', () => {
    expect(sheetNoteTitle(new Date(2026, 9, 26, 9, 5))).toBe('計算メモ 2026-10-26 09:05');
  });
});
