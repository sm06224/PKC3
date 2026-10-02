/**
 * 🔴 **色コードの読み方**(#1224)── 見本を出す形 / 押して直せる形 / 1 行の中の数え方と差し替え。
 *
 * 描く側(`markdown-render.ts`)との**一致**は `body-rewrite-color.test.ts`(別の観測で突き合わせる)。
 * ここは**純関数の規則**だけを見る。
 */
import { describe, expect, it } from 'vitest';
import {
  colorSpansOfLine,
  confirmColorSpan,
  inlineCodeSpans,
  isColorCode,
  isEditableColor,
  replaceColorSpan,
} from '@features/markdown/color-code';

describe('見本を出す形 / 押して直せる形(Gemini 裁定 Q1 = A / Q2 = B)', () => {
  it.each([
    ['#fff', true, false],
    ['#FFF', true, false],
    ['#3b82f6', true, true],
    ['#3B82F6', true, false], // 大文字は見本だけ(書いた綴りを変えない)
    ['#3b82f680', true, false], // 8 桁(透明度つき)は見本だけ
    ['#3b82f68', false, false], // 7 桁
    ['#fffa', false, false], // 4 桁
    ['#ggg', false, false],
    ['3b82f6', false, false],
    ['#3b82f6 ', false, false], // 前後に字が在る
    ['', false, false],
  ])('%s → 見本 %s / 押して直せる %s', (code, swatch, editable) => {
    expect(isColorCode(code)).toBe(swatch);
    expect(isEditableColor(code)).toBe(editable);
  });
});

describe('1 行の中のインラインコード', () => {
  it('中身の範囲を返す(囲みのバッククォートを含まない)', () => {
    const line = '色は `#3b82f6` です';
    const [s] = inlineCodeSpans(line);
    expect(line.slice(s!.start, s!.end)).toBe('#3b82f6');
    expect(s!.content).toBe('#3b82f6');
  });

  it('同じ長さのバッククォートで閉じる(長い囲みの中の短い並びは字)', () => {
    expect(inlineCodeSpans('``a`b`` と `c`').map((s) => s.content)).toEqual(['a`b', 'c']);
  });

  it('閉じが無い並びは字のまま(コードにならない)', () => {
    expect(inlineCodeSpans('`#3b82f6 です')).toEqual([]);
  });

  it('`\\` の直後のバッククォートは囲みではない(コードの外で)', () => {
    // 1 つ目の並びは字になり、2 つ目と 3 つ目が対になる(「と」がコード)── 色コードは 0 件
    expect(inlineCodeSpans('\\`#3b82f6` と `#ef4444`').map((s) => s.content)).toEqual(['と']);
    expect(colorSpansOfLine('\\`#3b82f6` と `#ef4444`')).toEqual([]);
    // 対照群: 先頭の `\` が無ければ 2 つとも色コード
    expect(colorSpansOfLine('`#3b82f6` と `#ef4444`').map((s) => s.content)).toEqual([
      '#3b82f6',
      '#ef4444',
    ]);
  });

  it('前後が空白 1 つずつなら、その 1 つずつは中身に含めない(markdown-it と同じ)', () => {
    expect(inlineCodeSpans('` #fff `').map((s) => s.content)).toEqual(['#fff']);
    // 空白だけのコードは剥がさない
    expect(inlineCodeSpans('`  `').map((s) => s.content)).toEqual(['  ']);
  });
});

describe('色コードだけを左から数える', () => {
  it('色でないコードは数に入らない(「何番目」は色コードの中の番号)', () => {
    const line = '`a` `#111111` `b` `#222222`';
    expect(colorSpansOfLine(line).map((s) => s.content)).toEqual(['#111111', '#222222']);
  });
});

describe('confirmColorSpan(描く側の確認)', () => {
  it('数えた番号の字が同じなら true、違う・無い・行が無いなら false', () => {
    const line = '`#111111` と `#222222`';
    expect(confirmColorSpan(line, 1, '#222222')).toBe(true);
    expect(confirmColorSpan(line, 1, '#111111')).toBe(false);
    expect(confirmColorSpan(line, 2, '#222222')).toBe(false);
    expect(confirmColorSpan(undefined, 0, '#111111')).toBe(false);
  });
});

describe('replaceColorSpan(その色コードの字だけを入れ替える)', () => {
  it('同じ色が 1 行に 2 つ在るとき、指した番号のほうだけが変わる', () => {
    const line = '`#3b82f6` と `#3b82f6`';
    expect(replaceColorSpan(line, 1, '#3b82f6', '#ef4444')).toBe('`#3b82f6` と `#ef4444`');
    expect(replaceColorSpan(line, 0, '#3b82f6', '#ef4444')).toBe('`#ef4444` と `#3b82f6`');
  });

  it('前後の字(空白 1 つずつの囲みも)は 1 バイトも動かない', () => {
    expect(replaceColorSpan('- a ` #3b82f6 ` b', 0, '#3b82f6', '#000000')).toBe('- a ` #000000 ` b');
  });

  it.each([
    ['字が違う(別の窓で書き換わっている)', '`#111111`', 0, '#222222', '#000000'],
    ['番号の先が無い', '`#111111`', 1, '#111111', '#000000'],
    ['押して直せない綴り(大文字)', '`#3B82F6`', 0, '#3B82F6', '#000000'],
    ['押して直せない綴り(3 桁)', '`#fff`', 0, '#fff', '#000000'],
    ['押して直せない綴り(8 桁)', '`#3b82f680`', 0, '#3b82f680', '#000000'],
    ['書き込む色が 6 桁小文字でない', '`#111111`', 0, '#111111', '#FFF'],
  ])('断る(null): %s', (_n, line, nth, from, to) => {
    expect(replaceColorSpan(line, nth, from, to)).toBeNull();
  });
});
