/**
 * 文書内検索の一致を、文字の層の span ごとの範囲へ割り付ける(`public/pdf/text-hits.js`。#275 段①の残り)。
 *
 * 🔴 守るもの:一致が **span 2 つ以上にまたがる**とき、またがる**全部の span** に、その span の中の範囲として
 * 強調が割り付く。⚠ 先頭の span だけへ割り付けると、検索は「1 件」と数えるのに画面では何も光らない
 * (「あい」が span「あ」+「い」にまたがる ── pdf.js は書体が変わる / 間が空くところで文字を別の塊に分ける)。
 *
 * ⚠ **この file の原文を読んで走らせる**(`public/` は bundle を通らないので import できない)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Ranges = Map<number, Array<[number, number]>>;
interface Api {
  rangesBySpan(strs: string[], query: string, eols?: boolean[]): Ranges;
  countHits(strs: string[], query: string, eols: boolean[] | undefined, limit: number): number;
  markIndexOfHits(strs: string[], query: string, eols?: boolean[]): number[];
}

function load(): Api {
  const root: { PkcPdfTextHits?: Api } = {};
  new Function('self', readFileSync('public/pdf/text-hits.js', 'utf-8'))(root);
  expect(root.PkcPdfTextHits, '原文が API を公開していない(空振り)').toBeDefined();
  return root.PkcPdfTextHits as Api;
}

const obj = (m: Ranges): Record<number, Array<[number, number]>> => Object.fromEntries(m);

describe('rangesBySpan ── 一致の範囲を span ごとの範囲にする', () => {
  const { rangesBySpan } = load();

  it('対照群: 1 つの span に収まる一致は、その span の中の範囲だけ', () => {
    expect(obj(rangesBySpan(['Hello page 3 marker3'], 'marker3'))).toEqual({ 0: [[13, 20]] });
  });

  it('🔴 2 つの span にまたがる一致は、両方の span に部分範囲が付く(「あい」= 「あ」+「い」)', () => {
    expect(obj(rangesBySpan(['あ', 'い'], 'あい'))).toEqual({ 0: [[0, 1]], 1: [[0, 1]] });
  });

  it('🔴 またがる範囲は、各 span の中の部分だけ(span 全体を光らせない)', () => {
    // 「split」+「match」の「litma」→ split の末尾 3 字 + match の先頭 2 字
    expect(obj(rangesBySpan(['split', 'match'], 'litma'))).toEqual({ 0: [[2, 5]], 1: [[0, 2]] });
  });

  it('3 つ以上にまたがっても、途中の span は全部光る', () => {
    expect(obj(rangesBySpan(['a', 'bc', 'd', 'e'], 'abcd'))).toEqual({
      0: [[0, 1]],
      1: [[0, 2]],
      2: [[0, 1]],
    });
  });

  it('同じ span の中の複数の一致は、昇順で別の範囲になる(隣り合えば 1 つにつなぐ)', () => {
    expect(obj(rangesBySpan(['abab x ab'], 'ab'))).toEqual({ 0: [[0, 4], [7, 9]] });
    expect(obj(rangesBySpan(['aa'], 'a'))).toEqual({ 0: [[0, 2]] });
  });

  it('空の span(字が無い塊)を挟んでもずれない / 字を持たない span には範囲が付かない', () => {
    expect(obj(rangesBySpan(['あ', '', 'い'], 'あい'))).toEqual({ 0: [[0, 1]], 2: [[0, 1]] });
  });

  it('大文字小文字を区別しない(検索語は小文字化済みで渡る)', () => {
    expect(obj(rangesBySpan(['Fo', 'OBar'], 'foob'))).toEqual({ 0: [[0, 2]], 1: [[0, 2]] });
  });

  it('一致が無い / 検索語が空なら、範囲は 0 件', () => {
    expect(rangesBySpan(['あ', 'い'], 'う').size).toBe(0);
    expect(rangesBySpan(['あ', 'い'], '').size).toBe(0);
  });

  it('🔴 頁の本文(span の連結)で数えた一致の数と、割り付けの一致の数が揃う(数えたのに光らない、を作らない)', () => {
    const strs = ['ab', 'ab', 'a', 'b', 'xab'];
    const query = 'ab';
    // 検索が数える方法(reader.js の search と同じ: 連結して、一致の長さずつ進める)
    const text = strs.join('');
    let counted = 0;
    for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + query.length)) counted += 1;
    expect(counted).toBe(4);
    // 割り付けの側: span ごとの範囲の長さの合計 = 一致の数 × 検索語の長さ
    let covered = 0;
    for (const list of rangesBySpan(strs, query).values()) for (const [a, b] of list) covered += b - a;
    expect(covered).toBe(counted * query.length);
  });
});

describe('行末(hasEOL)── 欧文では空白・日本語どうしの間では無し', () => {
  const { rangesBySpan, countHits } = load();
  const latin = ['The quick brown fox jumps over the', 'lazy dog'];
  const eol = [true, false];

  it('🔴 行をまたぐ語句が見つかる(「the lazy」)/ 行末を空白にしないと見つからなかった', () => {
    expect(countHits(latin, 'the lazy', eol, 100)).toBe(1);
    expect(obj(rangesBySpan(latin, 'the lazy', eol))).toEqual({ 0: [[31, 34]], 1: [[0, 4]] });
  });

  it('🔴 行末は空白であって「無し」ではない: 「thelazy」は見つからない(偽の結合を作らない)', () => {
    expect(countHits(latin, 'thelazy', eol, 100)).toBe(0);
    expect(rangesBySpan(latin, 'thelazy', eol).size).toBe(0);
  });

  it('🔴 日本語どうしの行末は何も無し: 「文章」が見つかる / 「文 章」は見つからない', () => {
    const ja = ['日本語の文', '章です'];
    expect(countHits(ja, '文章', [true, false], 100)).toBe(1);
    expect(obj(rangesBySpan(ja, '文章', [true, false]))).toEqual({ 0: [[4, 5]], 1: [[0, 1]] });
    expect(countHits(ja, '文 章', [true, false], 100)).toBe(0);
  });

  it('検索語の連続する空白は 1 つに畳む / 本文の連続する空白も(「a  b」= 「a b」)', () => {
    expect(countHits(['a   b'], 'a  b', undefined, 100)).toBe(1);
  });

  it('行末の情報が無ければ従来どおり連結(対照群)/ 数は上限で止まる', () => {
    expect(countHits(latin, 'thelazy', undefined, 100)).toBe(1);
    expect(countHits(['aaaa'], 'a', undefined, 3)).toBe(3);
  });

  it('reader.js は 5000 件で止めたとき「件以上」と言う(黙って切らない)', () => {
    const src = readFileSync('public/pdf/reader.js', 'utf-8');
    expect(src).toContain("hitsCapped ? '以上' : ''");
    expect(src).toContain('const HIT_CAP = 5000;');
  });
});

describe('markIndexOfHits ── 「n / m 件」の一致と光っている印(mark.hit)の番号を揃える', () => {
  const { rangesBySpan, markIndexOfHits } = load();
  const marks = (strs: string[], q: string): number =>
    [...rangesBySpan(strs, q).values()].reduce((n, l) => n + l.length, 0);

  it.each([
    { name: 'span をまたぐ一致(一致 3 件・印 4 つ)', strs: ['あ', 'い', 'xあいx', 'あい'], q: 'あい', want: [0, 2, 3], nMarks: 4 },
    { name: '隣り合う一致(一致 4 件・印 1 つ)', strs: ['aaaa'], q: 'a', want: [0, 0, 0, 0], nMarks: 1 },
    { name: '離れた一致(一致 = 印)', strs: ['a b a'], q: 'a', want: [0, 1], nMarks: 2 },
  ])('🔴 $name', ({ strs, q, want, nMarks }) => {
    expect(marks(strs, q)).toBe(nMarks);
    expect(markIndexOfHits(strs, q)).toEqual(want);
  });

  it('一致が無い / 検索語が空なら空', () => {
    expect(markIndexOfHits(['あ'], 'い')).toEqual([]);
    expect(markIndexOfHits(['あ'], '')).toEqual([]);
  });

  it('reader.js は一致の番号ではなくこの対応表で印へ送る', () => {
    const src = readFileSync('public/pdf/reader.js', 'utf-8');
    expect(src).toContain('textHits.markIndexOfHits(L.strs, hitQuery, L.eols)');
    expect(src).not.toContain('marks[Math.min(nth, marks.length - 1)]');
  });
});
