/**
 * 🔴 **全文検索が見る字**(台帳 #1852 の束 B2、依頼 196・197・258・335・194・260・115-1・115-2)── 純粋部分。
 *
 * 守るもの:
 * ① 揃える(`foldWidth` / `foldText`)── 全角と半角・半角カナ・濁点の持ち方。ひらがなとカタカナは揃えない
 * ② 検索に当てる本文(`searchableBody`)── 隠したメモの中・リンクの宛先の字は当たらない / 見える字は残る
 * ③ 揃えた字 ⇄ 書いた字の位置合わせ(`foldMapped` / `unfoldRange`)── 長さが変わる揃えでも抜粋と塗りの位置が合う
 * ④ 抜粋は書いた字で出す(`excerptAroundFolded`)
 * ⑤ 題名の絞りは空白(全角も)で区切った語を全部含む(`matchesTitle`)
 */
import { describe, expect, it } from 'vitest';
import { foldText, foldWidth, splitWords } from '../../src/features/filter/fold-text';
import {
  excerptAroundFolded,
  foldMapped,
  foldedColumns,
  searchableBody,
  unfoldRange,
} from '../../src/features/filter/search-text';
import { matchesTitle, normalizeQuery } from '../../src/features/filter/title-filter';
import { SNIPPET_MARK_CLOSE, SNIPPET_MARK_OPEN } from '../../src/features/filter/search-snippet';

const NFD_GA = 'が'; // 「か」+ 結合の濁点(見た目は「が」)

describe('揃える(依頼 258・335・115-2)', () => {
  it.each([
    ['ＡＢＣ', 'ABC'],
    ['１２３４５', '12345'],
    ['ﾊﾝｶｸ', 'ハンカク'],
    ['ﾊﾞｯｸ', 'バック'],
    [NFD_GA, 'が'],
  ])('%s と %s は同じ字', (a, b) => {
    expect(foldWidth(a)).toBe(foldWidth(b));
    expect(foldText(a)).toBe(foldText(b));
  });

  it('🔴 対照群: ひらがなとカタカナは揃えない / 大文字小文字は題名側(foldText)だけが畳む', () => {
    expect(foldWidth('りんご')).not.toBe(foldWidth('リンゴ'));
    expect(foldText('りんご')).not.toBe(foldText('リンゴ'));
    expect(foldWidth('ABC')).toBe('ABC');
    expect(foldText('ABC')).toBe('abc');
  });

  it('語の区切りは空白(全角も)/ 空は落とす / `-` と `"` は読まない', () => {
    expect(splitWords('  田中　見積 ')).toEqual(['田中', '見積']);
    expect(splitWords('a  -b "c')).toEqual(['a', '-b', '"c']);
    expect(splitWords('   ')).toEqual([]);
  });
});

describe('検索に当てる本文(依頼 196・197)', () => {
  it('🔴 隠したメモ(行内 / ブロック / :::comment)は当たらない字になる', () => {
    expect(searchableBody('公開 %% 秘密のメモ %% 続き')).not.toContain('秘密');
    expect(searchableBody('公開 %% 秘密のメモ %% 続き')).toContain('公開');
    expect(searchableBody('前\n%%%\n極秘事項\n%%%\n後')).not.toContain('極秘');
    expect(searchableBody('前\n:::comment\n社外秘\n:::\n後')).not.toContain('社外秘');
    // 対照群: メモの外の字は残る
    expect(searchableBody('前\n%%%\n極秘事項\n%%%\n後')).toContain('前');
    expect(searchableBody('前\n%%%\n極秘事項\n%%%\n後')).toContain('後');
  });

  it('🔴 `\\%%` で字のまま書いた %% はメモではない(依頼 256 と同じ読み方)', () => {
    const t = searchableBody('100\\%% done と 50\\%% more');
    expect(t).toContain('done');
    expect(t).toContain('more');
  });

  it('🔴 リンク・画像の宛先の字(entry: / asset: / pkc://)は消え、見える字だけ残る', () => {
    const t = searchableBody('[議事録](entry:abc123) と ![図](asset:xyz789) と [社外](https://example.org/x)');
    expect(t).toContain('議事録');
    expect(t).toContain('図');
    expect(t).not.toContain('entry');
    expect(t).not.toContain('abc123');
    expect(t).not.toContain('asset');
    expect(t).not.toContain('xyz789');
    expect(t, 'リンクの `[` が残っている').not.toContain('[議事録');
    expect(t, '画像の `![` が残っている').not.toContain('![');
    // 対照群: 外の URL は書いてある字のまま残す(見える字・探されうる字)
    expect(t).toContain('https://example.org/x');
  });

  it('入れ子(画像のリンク)・参照形式・HTML の宛先も除く', () => {
    expect(searchableBody('[![図](asset:a1b2)](entry:c3d4)')).toBe('図');
    const ref = searchableBody('文 [ラベル][r1]\n\n[r1]: entry:zzz999');
    expect(ref).not.toContain('zzz999');
    expect(searchableBody('<img src="asset:img555" alt="x">')).not.toContain('img555');
  });

  it('コードの中に書いた entry: はリンクではない ── 字のまま残る(描かれる字だから)', () => {
    expect(searchableBody('`[x](entry:abc)`')).toContain('entry:abc');
  });

  it('宛先の無い本文は 1 バイトも変わらない(素通り)', () => {
    const body = '# 題\n\n本文 ＡＢＣ\n';
    expect(searchableBody(body)).toBe(body);
    expect(searchableBody('')).toBe('');
  });

  it('索引の元の字: 揃えても同じなら null(列に重ねて持たない)/ 違えば揃えた字', () => {
    expect(foldedColumns('題', '日本語だけ')).toEqual({ titleF: null, bodyF: null });
    expect(foldedColumns('ＡＢＣ', 'a')).toEqual({ titleF: 'ABC', bodyF: null });
    expect(foldedColumns('題', '１２３')).toEqual({ titleF: null, bodyF: '123' });
    // メモを除くと本文と違う字になる
    expect(foldedColumns('題', 'a %%x%% b').bodyF).toBe('a       b');
  });
});

describe('揃えた字 ⇄ 書いた字の位置(依頼 258・335)', () => {
  it('foldMapped: 長さが変わる揃え(か+濁点 → が)でも、揃えた字の各位置が書いた字の範囲を指す', () => {
    const m = foldMapped(`x${NFD_GA}y`);
    expect(m.folded).toBe('xがy');
    expect([m.from[1], m.to[1]]).toEqual([1, 3]); // 「が」は書いた字の 1〜3(2 字ぶん)
    expect([m.from[2], m.to[2]]).toEqual([3, 4]);
  });

  it('unfoldRange: 塊をまたぐ長い文字列でも、書いた字の範囲に戻る', () => {
    const text = `${'あ'.repeat(1500)}${NFD_GA}い${'う'.repeat(700)}`;
    const folded = foldText(text);
    const at = folded.indexOf('がい');
    expect(at).toBe(1500);
    const [s, e] = unfoldRange(text, at, at + 2);
    expect(text.slice(s, e)).toBe(`${NFD_GA}い`);
    expect(e - s).toBe(3);
  });

  it('unfoldRange: 前に 2 字 → 1 字の揃えがあっても、ずれずに指す', () => {
    const text = `${NFD_GA.repeat(40)}ここ`;
    const folded = foldText(text);
    const at = folded.indexOf('ここ');
    const [s, e] = unfoldRange(text, at, at + 2);
    expect(text.slice(s, e)).toBe('ここ');
  });
});

describe('抜粋は書いた字で出す(依頼 258・335)', () => {
  const marked = (s: string): string[] => {
    const a = s.indexOf(SNIPPET_MARK_OPEN);
    const b = s.indexOf(SNIPPET_MARK_CLOSE);
    return a < 0 ? [] : [s.slice(a + 1, b)];
  };

  it('🔴 全角で書いた所を半角の語で探しても、抜粋は書いたまま(ＰＫＣ)', () => {
    const ex = excerptAroundFolded('前置き ＰＫＣ の本文 後ろ', ['pkc']);
    expect(marked(ex)).toEqual(['ＰＫＣ']);
    expect(ex).not.toContain('PKC');
  });

  it('濁点の持ち方が違っても、印は書いた字(か+゛)を囲む', () => {
    const ex = excerptAroundFolded(`あ${NFD_GA}いど`, ['がい']);
    expect(marked(ex)).toEqual([`${NFD_GA}い`]);
  });

  it('語が本文に無ければ(題名だけが当たった)先頭を切る / 先頭の語から順に探す', () => {
    const ex = excerptAroundFolded('はじまりの本文', ['ない語']);
    expect(ex).toBe('はじまりの本文');
    expect(marked(excerptAroundFolded('りんごとみかん', ['ない', 'みかん']))).toEqual(['みかん']);
  });

  it('隠したメモは抜粋に出ない(検索に当てる本文を渡す)', () => {
    const ex = excerptAroundFolded(searchableBody('公開の文 %% 秘密のメモ %% 続き'), ['公開']);
    expect(ex).not.toContain('秘密');
  });
});

describe('題名の絞りは、空白(全角も)で区切った語を全部含む(依頼 194・260・115-1)', () => {
  it('🔴 「東京 タワー」と題名「東京 タワー」/ 離れた 2 語 / 全角の空白', () => {
    const q = (s: string): string => normalizeQuery(s);
    expect(matchesTitle('東京 タワー', q('東京 タワー'))).toBe(true);
    expect(matchesTitle('東京タワーの写真', q('東京 タワー'))).toBe(true); // 空白は区切り(続けて書いてなくてよい)
    expect(matchesTitle('タワーから見る東京', q('東京　タワー'))).toBe(true);
    expect(matchesTitle('東京の天気', q('東京 タワー')), '片方しか含まないのに当たった').toBe(false);
  });

  it('normalizeQuery は空白の連なりを 1 つにし、全角の空白も半角にする / 1 語は従来どおり', () => {
    expect(normalizeQuery('  田中 　 見積  ')).toBe('田中 見積');
    expect(matchesTitle('ＡＢＣ報告', normalizeQuery('abc'))).toBe(true);
    expect(matchesTitle('りんご', normalizeQuery('リンゴ')), 'ひらがなとカタカナは別').toBe(false);
  });
});
