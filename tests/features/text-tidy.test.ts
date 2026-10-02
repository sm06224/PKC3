/**
 * 🔴 **選んだ字を整える 5 つ**(#1233)の規則。
 *
 * ⚠ 守るのは**変わる側**(整う)と**変わらない側**(選んでいなければ何もしない / もう整っていれば
 *   1 byte も変えない / 触ってはいけない字は触らない)の両方。
 * ⚠ **対応表は実装を種にしない** ── 全角 → 半角 91 字と半角カナ 61 字 + 濁点 / 半濁点 26 通りを、
 *   Unicode の字の名前から**独立に引いて**ここへ手で並べてある(実装の表を `for` で回すと、
 *   表から 1 字落とした日に期待も同時に縮んで緑のままになる)。
 */
import { describe, expect, it } from 'vitest';
import {
  joinLines,
  kanaToFullwidth,
  squeezeBlankLines,
  stripBullets,
  tidySelection,
  toHalfwidth,
  TIDY_NOTES,
  type TidyOp,
} from '../../src/features/markdown/text-tidy';
import type { TextSelection } from '../../src/features/markdown/text-ops';

/** 全角 → 半角(英数 62 + 記号 28 + 全角空白 1)。 */
const HALFWIDTH_TABLE: readonly (readonly [string, string])[] = [
  ['\uFF10', '0'],
  ['\uFF11', '1'],
  ['\uFF12', '2'],
  ['\uFF13', '3'],
  ['\uFF14', '4'],
  ['\uFF15', '5'],
  ['\uFF16', '6'],
  ['\uFF17', '7'],
  ['\uFF18', '8'],
  ['\uFF19', '9'],
  ['\uFF21', 'A'],
  ['\uFF22', 'B'],
  ['\uFF23', 'C'],
  ['\uFF24', 'D'],
  ['\uFF25', 'E'],
  ['\uFF26', 'F'],
  ['\uFF27', 'G'],
  ['\uFF28', 'H'],
  ['\uFF29', 'I'],
  ['\uFF2A', 'J'],
  ['\uFF2B', 'K'],
  ['\uFF2C', 'L'],
  ['\uFF2D', 'M'],
  ['\uFF2E', 'N'],
  ['\uFF2F', 'O'],
  ['\uFF30', 'P'],
  ['\uFF31', 'Q'],
  ['\uFF32', 'R'],
  ['\uFF33', 'S'],
  ['\uFF34', 'T'],
  ['\uFF35', 'U'],
  ['\uFF36', 'V'],
  ['\uFF37', 'W'],
  ['\uFF38', 'X'],
  ['\uFF39', 'Y'],
  ['\uFF3A', 'Z'],
  ['\uFF41', 'a'],
  ['\uFF42', 'b'],
  ['\uFF43', 'c'],
  ['\uFF44', 'd'],
  ['\uFF45', 'e'],
  ['\uFF46', 'f'],
  ['\uFF47', 'g'],
  ['\uFF48', 'h'],
  ['\uFF49', 'i'],
  ['\uFF4A', 'j'],
  ['\uFF4B', 'k'],
  ['\uFF4C', 'l'],
  ['\uFF4D', 'm'],
  ['\uFF4E', 'n'],
  ['\uFF4F', 'o'],
  ['\uFF50', 'p'],
  ['\uFF51', 'q'],
  ['\uFF52', 'r'],
  ['\uFF53', 's'],
  ['\uFF54', 't'],
  ['\uFF55', 'u'],
  ['\uFF56', 'v'],
  ['\uFF57', 'w'],
  ['\uFF58', 'x'],
  ['\uFF59', 'y'],
  ['\uFF5A', 'z'],
  ['\uFF01', '!'],
  ['\uFF03', '#'],
  ['\uFF05', '%'],
  ['\uFF06', '&'],
  ['\uFF08', '('],
  ['\uFF09', ')'],
  ['\uFF0A', '*'],
  ['\uFF0B', '+'],
  ['\uFF0C', ','],
  ['\uFF0D', '-'],
  ['\uFF0E', '.'],
  ['\uFF0F', '/'],
  ['\uFF1A', ':'],
  ['\uFF1B', ';'],
  ['\uFF1C', '<'],
  ['\uFF1D', '='],
  ['\uFF1E', '>'],
  ['\uFF1F', '?'],
  ['\uFF20', '@'],
  ['\uFF3B', '['],
  ['\uFF3D', ']'],
  ['\uFF3E', '^'],
  ['\uFF3F', '_'],
  ['\uFF40', '`'],
  ['\uFF5B', '{'],
  ['\uFF5C', '|'],
  ['\uFF5D', '}'],
  ['\uFF5E', '~'],
  ['\u3000', ' '],
];

/** 半角カナ(`ｦ`〜`ﾝ` + 句読点・括弧・中点 + `ｰ`)→ 全角。濁点・半濁点は含まない。 */
const KANA_TABLE: readonly (readonly [string, string])[] = [
  ['\uFF61', '\u3002'],
  ['\uFF62', '\u300C'],
  ['\uFF63', '\u300D'],
  ['\uFF64', '\u3001'],
  ['\uFF65', '\u30FB'],
  ['\uFF66', '\u30F2'],
  ['\uFF67', '\u30A1'],
  ['\uFF68', '\u30A3'],
  ['\uFF69', '\u30A5'],
  ['\uFF6A', '\u30A7'],
  ['\uFF6B', '\u30A9'],
  ['\uFF6C', '\u30E3'],
  ['\uFF6D', '\u30E5'],
  ['\uFF6E', '\u30E7'],
  ['\uFF6F', '\u30C3'],
  ['\uFF70', '\u30FC'],
  ['\uFF71', '\u30A2'],
  ['\uFF72', '\u30A4'],
  ['\uFF73', '\u30A6'],
  ['\uFF74', '\u30A8'],
  ['\uFF75', '\u30AA'],
  ['\uFF76', '\u30AB'],
  ['\uFF77', '\u30AD'],
  ['\uFF78', '\u30AF'],
  ['\uFF79', '\u30B1'],
  ['\uFF7A', '\u30B3'],
  ['\uFF7B', '\u30B5'],
  ['\uFF7C', '\u30B7'],
  ['\uFF7D', '\u30B9'],
  ['\uFF7E', '\u30BB'],
  ['\uFF7F', '\u30BD'],
  ['\uFF80', '\u30BF'],
  ['\uFF81', '\u30C1'],
  ['\uFF82', '\u30C4'],
  ['\uFF83', '\u30C6'],
  ['\uFF84', '\u30C8'],
  ['\uFF85', '\u30CA'],
  ['\uFF86', '\u30CB'],
  ['\uFF87', '\u30CC'],
  ['\uFF88', '\u30CD'],
  ['\uFF89', '\u30CE'],
  ['\uFF8A', '\u30CF'],
  ['\uFF8B', '\u30D2'],
  ['\uFF8C', '\u30D5'],
  ['\uFF8D', '\u30D8'],
  ['\uFF8E', '\u30DB'],
  ['\uFF8F', '\u30DE'],
  ['\uFF90', '\u30DF'],
  ['\uFF91', '\u30E0'],
  ['\uFF92', '\u30E1'],
  ['\uFF93', '\u30E2'],
  ['\uFF94', '\u30E4'],
  ['\uFF95', '\u30E6'],
  ['\uFF96', '\u30E8'],
  ['\uFF97', '\u30E9'],
  ['\uFF98', '\u30EA'],
  ['\uFF99', '\u30EB'],
  ['\uFF9A', '\u30EC'],
  ['\uFF9B', '\u30ED'],
  ['\uFF9C', '\u30EF'],
  ['\uFF9D', '\u30F3'],
];

/** 濁点 / 半濁点を付けた 2 字 → 結合した 1 字(21 + 5)。 */
const KANA_COMBO_TABLE: readonly (readonly [string, string])[] = [
  ['\uFF73\uFF9E', '\u30F4'],
  ['\uFF76\uFF9E', '\u30AC'],
  ['\uFF77\uFF9E', '\u30AE'],
  ['\uFF78\uFF9E', '\u30B0'],
  ['\uFF79\uFF9E', '\u30B2'],
  ['\uFF7A\uFF9E', '\u30B4'],
  ['\uFF7B\uFF9E', '\u30B6'],
  ['\uFF7C\uFF9E', '\u30B8'],
  ['\uFF7D\uFF9E', '\u30BA'],
  ['\uFF7E\uFF9E', '\u30BC'],
  ['\uFF7F\uFF9E', '\u30BE'],
  ['\uFF80\uFF9E', '\u30C0'],
  ['\uFF81\uFF9E', '\u30C2'],
  ['\uFF82\uFF9E', '\u30C5'],
  ['\uFF83\uFF9E', '\u30C7'],
  ['\uFF84\uFF9E', '\u30C9'],
  ['\uFF8A\uFF9E', '\u30D0'],
  ['\uFF8B\uFF9E', '\u30D3'],
  ['\uFF8C\uFF9E', '\u30D6'],
  ['\uFF8D\uFF9E', '\u30D9'],
  ['\uFF8E\uFF9E', '\u30DC'],
  ['\uFF8A\uFF9F', '\u30D1'],
  ['\uFF8B\uFF9F', '\u30D4'],
  ['\uFF8C\uFF9F', '\u30D7'],
  ['\uFF8D\uFF9F', '\u30DA'],
  ['\uFF8E\uFF9F', '\u30DD'],
];

/** `|` で選択範囲を書く(1 つなら caret)。 */
function sel(marked: string): TextSelection {
  const start = marked.indexOf('|');
  const second = marked.indexOf('|', start + 1);
  const end = second === -1 ? start : second - 1;
  return { text: marked.replace(/\|/g, ''), start, end };
}
function show(s: TextSelection): string {
  if (s.start === s.end) return `${s.text.slice(0, s.start)}|${s.text.slice(s.start)}`;
  return `${s.text.slice(0, s.start)}|${s.text.slice(s.start, s.end)}|${s.text.slice(s.end)}`;
}
/** 整えて、結果の「本文 + 選択」を `|` 付きで見る。⚠ 何も起きなければ文言で落とす。 */
function tidy(marked: string, op: TidyOp): string {
  const before = sel(marked);
  const r = tidySelection(before, op);
  expect(r.kind, `整うはずの場面で none(${marked})`).toBe('edit');
  if (r.kind !== 'edit') throw new Error('unreachable');
  // 呼び側が書く形(`from`〜`to` を `insert` へ置き換える)で作った本文が、`text` と一致すること
  expect(before.text.slice(0, r.edit.from) + r.edit.insert + before.text.slice(r.edit.to)).toBe(
    r.edit.text,
  );
  return show(r.edit);
}

describe('全角を半角にそろえる ── 全数の対応表', () => {
  it('対応表は 91 字(英数 62 + 記号 28 + 全角空白 1)で、全部が 1 字 → 1 字へ変わる', () => {
    expect(HALFWIDTH_TABLE).toHaveLength(91);
    for (const [full, half] of HALFWIDTH_TABLE) {
      expect(toHalfwidth(full), `U+${full.codePointAt(0)!.toString(16)} が半角にならない`).toBe(half);
    }
  });

  it('表の全字を並べた 1 本の文字列でも、字ごとの結果と同じになる(字の間で混ざらない)', () => {
    const fulls = HALFWIDTH_TABLE.map(([f]) => f).join('');
    const halfs = HALFWIDTH_TABLE.map(([, h]) => h).join('');
    expect(toHalfwidth(fulls)).toBe(halfs);
  });

  it('🔴 カナ・漢字・長音・波ダッシュ・合成済みの字は 1 字も変えない(NFKC ではない)', () => {
    const keep = 'アイウエオ ひらがな 漢字 ー〜、。「」・ ㈱ ① ㌔ ㎏ ℡ Ⅳ ﬁ ｱｲｳ';
    // ※ `ｱｲｳ`(半角カナ)は別の操作の持ち物 ── ここでは触らない
    expect(toHalfwidth(keep)).toBe(keep);
  });

  it('🔴 指定に無い全角記号(＂ ＄ ＇ ＼ ￥)は半角にしない(本文の記法の字)', () => {
    const keep = '＂＄＇＼￥';
    expect(toHalfwidth(keep)).toBe(keep);
  });

  it('日本語の中の全角英数・空白だけが変わる', () => {
    expect(toHalfwidth('ＰＫＣ３の\u3000価格は１，２００円（税込）')).toBe('PKC3の 価格は1,200円(税込)');
  });

  it('半角のものは 1 byte も変えない(もう整っている)', () => {
    const s = 'PKC3 (abc) 1,200!';
    expect(toHalfwidth(s)).toBe(s);
  });
});

describe('半角カナを全角にそろえる ── 全数の対応表', () => {
  it('単独の 61 字(ｦ〜ﾝ・ｰ・句読点 5)がそれぞれ全角 1 字になる', () => {
    expect(KANA_TABLE).toHaveLength(61);
    for (const [half, full] of KANA_TABLE) {
      expect(kanaToFullwidth(half), `U+${half.codePointAt(0)!.toString(16)} が全角にならない`).toBe(full);
    }
  });

  it('濁点・半濁点が付いた 26 通りが、結合した 1 字になる(字数が 2 → 1)', () => {
    expect(KANA_COMBO_TABLE).toHaveLength(26);
    for (const [two, one] of KANA_COMBO_TABLE) {
      expect(two).toHaveLength(2);
      expect(kanaToFullwidth(two), `U+${two.codePointAt(0)!.toString(16)} + 濁点が結合しない`).toBe(one);
    }
  });

  it('🔴 結合できない濁点は字を落とさず全角の濁点 / 半濁点にする', () => {
    // ｱ(濁点を付けられない字)・行頭・半濁点を付けられない字
    expect(kanaToFullwidth('ｱﾞ')).toBe('ア゛');
    expect(kanaToFullwidth('ﾞ')).toBe('゛');
    expect(kanaToFullwidth('ﾟ')).toBe('゜');
    expect(kanaToFullwidth('ｶﾟ')).toBe('カ゜');
  });

  it('濁点は直前の 1 字にだけ付く(ｶﾞｶ → ガカ。連続した濁点の 2 つ目は単独)', () => {
    expect(kanaToFullwidth('ｶﾞｶ')).toBe('ガカ');
    expect(kanaToFullwidth('ｶﾞﾞ')).toBe('ガ゛');
  });

  it('全角のカナ・ひらがな・漢字・半角英数は 1 byte も変えない', () => {
    const keep = 'アイウ ガギグ あいう 漢字 ABC 123 ー';
    expect(kanaToFullwidth(keep)).toBe(keep);
  });

  it('文の中の半角カナだけが変わる', () => {
    expect(kanaToFullwidth('ﾋﾟﾛｰ ok')).toBe('ピロー ok');
  });
});

describe('改行を詰める', () => {
  it('日本語どうしは空白なしで結ぶ', () => {
    expect(joinLines('今日は\n晴れです。\n明日は雨。')).toBe('今日は晴れです。明日は雨。');
  });

  it('英数字どうしは半角空白 1 つで結ぶ(記号で終わる行も)', () => {
    expect(joinLines('hello,\nworld\nand 42\nmore')).toBe('hello, world and 42 more');
  });

  it('日本語と英数字の境は空白を入れない(日本語が一方でも在れば)', () => {
    expect(joinLines('これは\nPKC です\nok')).toBe('これはPKC ですok');
  });

  it('行末の空白(半角・tab・全角)は落とす。つなぎ目の行頭の空白も落とす', () => {
    expect(joinLines('a  \t\n  b\u3000\n\u3000c')).toBe('a b c');
  });

  it('先頭の行の字下げは残す', () => {
    expect(joinLines('  a\nb')).toBe('  a b');
  });

  it('空の行は捨てて 1 行にする', () => {
    expect(joinLines('a\n\n\nb')).toBe('a b');
  });

  it('🔴 改行が 1 つも無いとき(結ぶ相手が無い)は 1 byte も変えない', () => {
    expect(joinLines('a  ')).toBe('a  ');
  });
});

describe('空行を減らす', () => {
  it('連続する空行を 1 つにする', () => {
    expect(squeezeBlankLines('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('空白だけの行も空行として数える。残すのは最初の 1 行そのまま', () => {
    expect(squeezeBlankLines('a\n  \n\n\t\nb')).toBe('a\n  \nb');
  });

  it('空行が 1 つの所は変えない', () => {
    const s = 'a\n\nb\n\nc';
    expect(squeezeBlankLines(s)).toBe(s);
  });

  it('空行が無ければ 1 byte も変えない', () => {
    expect(squeezeBlankLines('a\nb')).toBe('a\nb');
  });
});

describe('箇条書きの記号を外す', () => {
  it('🔴 一部の行にだけ付いていても、付いている行すべてから外す', () => {
    expect(stripBullets('- あ\nい\n- う')).toBe('あ\nい\nう');
  });

  it('- * + の 3 つとも外し、記号の手前の字下げも外す', () => {
    expect(stripBullets('- a\n* b\n+ c\n    - d')).toBe('a\nb\nc\nd');
  });

  it('チェック項目(- [ ] / - [x])は触らない', () => {
    const s = '- [ ] やる\n- [x] やった';
    expect(stripBullets(s)).toBe(s);
  });

  it('区切り線(--- / * * * / - - -)と強調(**太字**)は触らない', () => {
    const s = '---\n* * *\n- - -\n**太字**\n*斜体*';
    expect(stripBullets(s)).toBe(s);
  });

  it('番号付き(1. )は外さない(別の操作)', () => {
    expect(stripBullets('1. あ\n- い')).toBe('1. あ\nい');
  });

  it('付いている行が 1 つも無ければ 1 byte も変えない', () => {
    expect(stripBullets('あ\nい')).toBe('あ\nい');
  });
});

describe('tidySelection ── 選択範囲の扱い', () => {
  const OPS: readonly TidyOp[] = [
    'join-lines',
    'to-halfwidth',
    'kana-to-fullwidth',
    'squeeze-blank-lines',
    'strip-bullets',
  ];
  // どの操作でも整う本文(5 つとも変わる材料を 1 つに持つ)
  const MESSY = '- ＡＢＣ\n\n\n- ｶﾞ\n';

  it('🔴 選んでいなければ、5 つとも何もしない(本文全体へ勝手に効かせない)', () => {
    for (const op of OPS) {
      const r = tidySelection({ text: MESSY, start: 3, end: 3 }, op);
      expect(r, `${op}: 選んでいないのに edit が返った`).toEqual({
        kind: 'none',
        reason: 'no-selection',
      });
    }
  });

  it('🔴 もう整っているとき(対照群: 同じ操作が整える本文では edit になる)は 1 byte も変えない', () => {
    const tidy1: Readonly<Record<TidyOp, string>> = {
      'join-lines': 'abc',
      'to-halfwidth': 'abc アイウ',
      'kana-to-fullwidth': 'abc アイウ',
      'squeeze-blank-lines': 'a\n\nb',
      'strip-bullets': 'あ\nい',
    };
    const messy: Readonly<Record<TidyOp, string>> = {
      'join-lines': 'a\nb',
      'to-halfwidth': 'ａｂｃ',
      'kana-to-fullwidth': 'ｱ',
      'squeeze-blank-lines': 'a\n\n\nb',
      'strip-bullets': '- あ',
    };
    for (const op of OPS) {
      const clean = tidy1[op];
      expect(tidySelection({ text: clean, start: 0, end: clean.length }, op), op).toEqual({
        kind: 'none',
        reason: 'unchanged',
      });
      const dirty = messy[op];
      expect(tidySelection({ text: dirty, start: 0, end: dirty.length }, op).kind, `${op}(対照群)`).toBe(
        'edit',
      );
    }
  });

  it('字の操作は選んだ範囲そのものだけを変え、外の字は変えない。選択は結果に合わせて動く', () => {
    // ｢Ａ１｣ だけを選ぶ ── 前後の ＢＣ は全角のまま
    expect(tidy('Ｂ|Ａ１|Ｃ', 'to-halfwidth')).toBe('Ｂ|A1|Ｃ');
    // 濁点の結合で字数が減っても、選択は結果の全体を指す
    expect(tidy('x|ｶﾞｱ|y', 'kana-to-fullwidth')).toBe('x|ガア|y');
  });

  it('行の操作は、行の途中から選んでも行頭〜行末を使う', () => {
    // 2 行目の途中から 3 行目の途中まで ── 1 行目は触らない
    expect(tidy('a\nb|b\ncc|c\nd', 'join-lines')).toBe('a\n|bb ccc|\nd');
  });

  it('🔴 下の行の頭まで選んでも、その行は巻き込まない', () => {
    // 行をまるごと選んで(末尾の改行まで)押しても、次の行とはつながらない
    expect(tidy('|a\nb\n|c', 'join-lines')).toBe('|a b|\nc');
    expect(tidy('|- あ\n- い\n|- う', 'strip-bullets')).toBe('|あ\nい|\n- う');
  });

  it('空行を減らす: 選んだ行の中だけで数える(外の空行は触らない)', () => {
    expect(tidy('\n\n|a\n\n\nb|\n\n\nc', 'squeeze-blank-lines')).toBe('\n\n|a\n\nb|\n\n\nc');
  });

  it('箇条書きの記号を外す: 混在のとき全部外れ、選択は書き換えた行の全体', () => {
    expect(tidy('前\n|- あ\nい\n* う|\n後', 'strip-bullets')).toBe('前\n|あ\nい\nう|\n後');
  });

  it('改行を詰める: 1 行だけの選択(結ぶ相手が無い)は unchanged', () => {
    expect(tidySelection(sel('a|bc|d'), 'join-lines')).toEqual({ kind: 'none', reason: 'unchanged' });
  });

  it('画面に出す理由の字は 2 つ(選んでいない / 整える所が無い)', () => {
    expect(TIDY_NOTES['no-selection']).toContain('選んで');
    expect(TIDY_NOTES.unchanged).toContain('ありません');
  });
});
