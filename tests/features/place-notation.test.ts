/**
 * 🔴 **自由配置の板の記法**(#283 P4)── 数え方と、位置だけの書き換え。
 *
 * ## 守る主張
 *
 * 1. 数えるのは `.pkc-place` を持つ `:::format` の開き行だけ(fence・frontmatter の
 *    中は数えない ── 描画も描かない場所)
 * 2. 🔴 書き換えるのは **x= / y= だけ**(他は 1 byte も変えない)
 * 3. 🔴 掴んだ時点の開き行と **byte 一致しなければ書かない**(別の窓の書込を
 *    巻き戻さない ── `undo-append` と同じ作法)
 * 4. 値が変わらないときは null(同じ本文を書き直して更新日時だけ動かさない)
 */
import { describe, expect, it } from 'vitest';
import {
  isPlaceOpen,
  movePlace,
  placeOpenLineAt,
  placeOpenLines,
} from '../../src/features/markdown/place-notation';

const BOARD = [
  ':::format{#p1 .pkc-place x=120 y=40 w=320 h=200}',
  '### 買い出し',
  '- 牛乳',
  ':::',
  '',
  ':::format{#p2 .pkc-place entry=n2 x=460 y=40}',
  ':::',
].join('\n');

describe('板の塊を数える(placeOpenLines)', () => {
  it('.pkc-place を持つ開き行だけを、上から順に数える', () => {
    expect(placeOpenLines(BOARD)).toEqual([0, 5]);
    expect(placeOpenLineAt(BOARD, 1)).toBe(':::format{#p2 .pkc-place entry=n2 x=460 y=40}');
  });

  it('.pkc-place の無い :::format は数えない(板ではない装飾箱)', () => {
    expect(placeOpenLines(':::format{align=center}\n中身\n:::')).toEqual([]);
  });

  it('frontmatter の中は数えない(行番号は原文基準のまま)', () => {
    const body = `---\ntitle: 板\n---\n${BOARD}`;
    expect(placeOpenLines(body)).toEqual([3, 8]);
  });

  it('🔴 fence の中は数えない(描画も描かない)', () => {
    const body = ['```', ':::format{.pkc-place x=1}', '```', BOARD].join('\n');
    expect(placeOpenLines(body)).toEqual([3, 8]);
  });

  /**
   * 🔴 **囲み(directive)の中の fence も fence である** ── `scanContainers` は
   * 囲みを丸ごと飲むので、そこに置いた偽の開き行が見えない。自前の fence 歩きが
   * これを数えないことを pin する(数えると DOM の並びとずれ、**別の塊が動く**)。
   */
  it('🔴 囲みの中の fence に書いた偽の開き行も数えない', () => {
    const body = [':::note', '```', ':::format{.pkc-place x=1}', '```', ':::', BOARD].join('\n');
    expect(placeOpenLines(body)).toEqual([5, 10]);
  });

  it('isPlaceOpen ── クラス札の判定(前後に別の札があってもよい)', () => {
    expect(isPlaceOpen(':::format{.pkc-place}')).toBe(true);
    expect(isPlaceOpen(':::format{#a .pkc-place x=1}')).toBe(true);
    expect(isPlaceOpen(':::format{.pkc-placeholder}')).toBe(false);
    expect(isPlaceOpen(':::format{x=1}')).toBe(false);
    expect(isPlaceOpen('::: format{.pkc-place}')).toBe(false);
  });
});

describe('位置だけの書き換え(movePlace)', () => {
  const line0 = BOARD.split('\n')[0]!;

  it('🔴 x= / y= だけが変わり、他は 1 byte も変わらない', () => {
    const next = movePlace(BOARD, { ordinal: 0, openLine: line0, x: 10, y: 20 });
    expect(next).not.toBeNull();
    const lines = next!.split('\n');
    expect(lines[0]).toBe(':::format{#p1 .pkc-place x=10 y=20 w=320 h=200}');
    // ⚠ 他の行は無傷
    expect(lines.slice(1)).toEqual(BOARD.split('\n').slice(1));
  });

  it('x= / y= が無い塊には足す', () => {
    const body = ':::format{.pkc-place}\n:::';
    const next = movePlace(body, { ordinal: 0, openLine: ':::format{.pkc-place}', x: 5, y: 6 });
    expect(next!.split('\n')[0]).toBe(':::format{.pkc-place x=5 y=6}');
  });

  it('引用つき(x="120")も受けて、引用なしへ揃える(2 つ目の x= を作らない)', () => {
    const body = ':::format{.pkc-place x="120" y=4}\n:::';
    const next = movePlace(body, {
      ordinal: 0,
      openLine: ':::format{.pkc-place x="120" y=4}',
      x: 7,
      y: 8,
    });
    expect(next!.split('\n')[0]).toBe(':::format{.pkc-place x=7 y=8}');
  });

  it('🔴 開き行が掴んだ時点と違えば書かない(別の窓の書込を巻き戻さない)', () => {
    expect(movePlace(BOARD, { ordinal: 0, openLine: ':::format{.pkc-place x=999}', x: 1, y: 2 })).toBeNull();
  });

  it('🔴 同じ字の塊が 2 つあっても、指した番目だけが変わる', () => {
    const twin = ':::format{.pkc-place x=1 y=1}';
    const body = [twin, ':::', twin, ':::'].join('\n');
    const next = movePlace(body, { ordinal: 1, openLine: twin, x: 9, y: 9 });
    const lines = next!.split('\n');
    expect(lines[0]).toBe(twin);
    expect(lines[2]).toBe(':::format{.pkc-place x=9 y=9}');
  });

  it('番目が範囲の外 / 値が負・小数 / 変わらない ── どれも null(書かない)', () => {
    const l = BOARD.split('\n')[0]!;
    expect(movePlace(BOARD, { ordinal: 9, openLine: l, x: 1, y: 2 })).toBeNull();
    expect(movePlace(BOARD, { ordinal: 0, openLine: l, x: -1, y: 2 })).toBeNull();
    expect(movePlace(BOARD, { ordinal: 0, openLine: l, x: 1.5, y: 2 })).toBeNull();
    expect(movePlace(BOARD, { ordinal: 0, openLine: l, x: 120, y: 40 })).toBeNull();
  });
});
