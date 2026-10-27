/**
 * 🔴 **計算スクラッチパッドの評価器**(#1230)。期待値は issue 本文の例と、手で書いた固定の数で守る
 * (評価器と同じ関数で期待値を作らない)。
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateSheet,
  formatSheetNumber,
  SHEET_MAX_LINES,
  SHEET_NAME_MAX,
  splitLabel,
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

describe('割合の印は名前に入れても保たれる(レビュー 💭)', () => {
  it('🔴 税率 = 10% を名前にしても、100 + 税率 は直接 100 + 10% と書いたときと同じ 110', () => {
    // 期待値は手で書いた固定の数(直接書いた式の結果 110 と、名前を通した結果を突き合わせる)
    expect(shown('100 + 10%')).toEqual(['110']);
    expect(shown('税率 = 10%\n100 + 税率')).toEqual(['10%', '110']);
    expect(shown('税率 = 10%\n100 - 税率')).toEqual(['10%', '90']);
  });
  it('割合の名前を掛けるのは今までどおり(0.1 として掛かる)。割合でない名前は足しても割合にならない', () => {
    expect(shown('税率 = 10%\n小計 = 2000\n小計 * 税率')).toEqual(['10%', '2,000', '200']);
    expect(shown('率 = 0.1\n100 + 率')).toEqual(['0.1', '100.1']);
  });
  it('割合の行の結果を行ごとに見ても、割合は % つきで出る', () => {
    expect(evaluateSheet('x = 10%')[0]!.pct).toBe(true);
    expect(evaluateSheet('x = 10')[0]!.pct).toBe(false);
  });
});

describe('名前の定義の読みが長い行でも線形(レビュー ⚠1)', () => {
  it('🔴 空白が 5 万字続く行も、一瞬で読み終わる(旧い正規表現は 2 次式で何秒もかかった)', () => {
    const t0 = performance.now();
    const rows = evaluateSheet(`a${' '.repeat(50_000)}b`);
    const ms = performance.now() - t0;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('text');
    expect(ms, `${Math.round(ms)}ms かかった`).toBeLessThan(500);
  });
  it('名前の定義の読みは今までと同じ(= か : で区切る・演算子や括弧の手前までが名前・数で始まれば定義でない)', () => {
    expect(evaluateSheet('単価 = 3')[0]!.name).toBe('単価');
    expect(evaluateSheet('単価: 3')[0]!.name).toBe('単価');
    expect(evaluateSheet('  前に空白 =  4')[0]!.name).toBe('前に空白');
    expect(evaluateSheet('a b = 5')[0]!.name).toBe('a b');
    // 演算子・括弧が先に来れば名前の定義ではない
    expect(evaluateSheet('(a) = 5')[0]!.name).toBeNull();
    expect(evaluateSheet('a + b = 5')[0]!.name).toBeNull();
    // 数や記号で始めない
    expect(evaluateSheet('3a = 5')[0]!.name).toBeNull();
    expect(evaluateSheet('= 5')[0]!.name).toBeNull();
  });
});

describe('上限の境目(テストの穴 E)', () => {
  it('名前は 40 字ちょうどまで定義になり、41 字は定義にならない', () => {
    const n40 = 'あ'.repeat(SHEET_NAME_MAX);
    expect(evaluateSheet(`${n40} = 5`)[0]!.name).toBe(n40);
    expect(evaluateSheet(`${n40}あ = 5`)[0]!.name).toBeNull();
  });
  it('2000 行ちょうどまで評価し、2001 行目は評価しない', () => {
    const rows = evaluateSheet(Array.from({ length: SHEET_MAX_LINES + 1 }, () => '1').join('\n'));
    expect(rows).toHaveLength(SHEET_MAX_LINES);
    expect(evaluateSheet(Array.from({ length: SHEET_MAX_LINES }, () => '1').join('\n'))).toHaveLength(SHEET_MAX_LINES);
  });
});

describe('名前の定義の割り方は、旧い正規表現と同じ答えを出す(独立した物差しで突き合わせる)', () => {
  /** 旧い実装そのもの(2 次式になる正規表現)。⚠ 期待値の側にだけ残す。 */
  const OLD = /^\s*([^\s=:+\-*/%()0-9.,][^=:+\-*/%()]*?)\s*[=:]\s*(.*)$/u;
  const alphabet = ['a', 'あ', ' ', '=', ':', '+', '-', '*', '/', '%', '(', ')', '1', '.', ',', '\u3000', '\t'];
  it('短い文字列を総当たりで 4 字まで(全 17^0〜4 通り)と、乱数の長めの列で食い違わない', () => {
    let checked = 0;
    const same = (s: string): void => {
      const m = OLD.exec(s);
      const got = splitLabel(s);
      if (m === null) {
        expect(got, JSON.stringify(s)).toBeNull();
      } else {
        expect(got, JSON.stringify(s)).toEqual({ label: m[1]!.trim(), rest: m[2]! });
      }
      checked += 1;
    };
    const walk = (prefix: string, depth: number): void => {
      same(prefix);
      if (depth === 0) return;
      for (const c of alphabet) walk(prefix + c, depth - 1);
    };
    walk('', 4);
    // 乱数(固定の種)── 長さ 5〜14
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 3000; i++) {
      const len = 5 + Math.floor(rnd() * 10);
      let t = '';
      for (let k = 0; k < len; k++) t += alphabet[Math.floor(rnd() * alphabet.length)]!;
      same(t);
    }
    // 空振り防止: 実際に大量に突き合わせている・定義になる例と、ならない例の両方を通っている
    expect(checked).toBeGreaterThan(80_000);
    expect(splitLabel('x = 1')).not.toBeNull();
    expect(splitLabel('1 = 1')).toBeNull();
  });
});
