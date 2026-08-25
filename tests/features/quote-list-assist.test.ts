/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { quoteOnEnter } from '../../src/features/markdown/quote-assist';
import { renumberLists } from '../../src/features/markdown/list-renumber';

describe('引用を書き続けられる #396', () => {
  it('引用の行で Enter を押すと、次の行も `> ` から始まる', () => {
    const v = '> 引用の 1 行目';
    expect(quoteOnEnter(v, v.length)).toEqual({ kind: 'continue', insert: '\n> ' });
  });

  /** ⚠ **入れ子の深さを保つ** ── `> > ` から続けたら `> > ` である。 */
  it('入れ子の深さを保つ', () => {
    const v = '> > 深い引用';
    expect(quoteOnEnter(v, v.length)).toEqual({ kind: 'continue', insert: '\n> > ' });
  });

  /**
   * 🔴 **片道の操作を作らない**(user 指示 2026-08-23)。
   * ⚠ 続けられるだけだと、**引用から出られない**。
   */
  it('🔴 空の `> ` で Enter を押すと、引用から抜ける', () => {
    const v = '> あ\n> ';
    const r = quoteOnEnter(v, v.length);
    expect(r.kind).toBe('exit');
    if (r.kind !== 'exit') return;
    expect(v.slice(0, r.from) + r.text + v.slice(r.to), '記号が残っている').toBe('> あ\n');
  });

  /** ⚠ 対照群 ── 引用でない行では何もしない(普通の改行を奪わない)。 */
  it('引用でない行では何もしない', () => {
    expect(quoteOnEnter('ただの本文', 5)).toEqual({ kind: 'none' });
    expect(quoteOnEnter('', 0)).toEqual({ kind: 'none' });
  });

  /**
   * 🔑 **行の途中で押しても続ける**(PKC2 は行末だけだった)──
   * 行の途中の Enter は「ここで割る」ことであり、割った先も引用のままがよい。
   */
  it('行の途中で押しても続く(PKC2 より動線が増える側)', () => {
    const v = '> 前半後半';
    expect(quoteOnEnter(v, 4)).toEqual({ kind: 'continue', insert: '\n> ' });
  });
});

describe('番号を振り直す #396', () => {
  it('ずれた番号が続きになる', () => {
    expect(renumberLists('1. あ\n5. い\n2. う')).toBe('1. あ\n2. い\n3. う');
  });

  /** ⚠ **差分が汚れない**書き方(markdown は描画時に数え直す)。 */
  it('全部 1 にもできる', () => {
    expect(renumberLists('1. あ\n2. い', 'uniform')).toBe('1. あ\n1. い');
  });

  it('入れ子は段ごとに数える', () => {
    expect(renumberLists('1. あ\n   9. x\n   9. y\n1. い')).toBe(
      '1. あ\n   1. x\n   2. y\n2. い',
    );
  });

  /** ⚠ 深い段から戻ったら、深い側の数えは捨てる(戻って続けない)。 */
  it('入れ子から戻ってまた入ると 1 から', () => {
    expect(renumberLists('1. あ\n   1. x\n2. い\n   9. y')).toBe(
      '1. あ\n   1. x\n2. い\n   1. y',
    );
  });

  it('別の段落で切れたら数え直す', () => {
    expect(renumberLists('1. あ\n2. い\n\n本文\n\n5. う')).toBe('1. あ\n2. い\n\n本文\n\n1. う');
  });

  /** 🔴 コードの中の `1.` は**コード**である。 */
  it('🔴 コードの中は触らない', () => {
    const src = '1. あ\n\n```\n7. これはコード\n7. これも\n```\n\n1. い';
    expect(renumberLists(src)).toBe(src);
  });

  it('`)` の書き方でも振り直す(記号は保つ)', () => {
    expect(renumberLists('1) あ\n7) い')).toBe('1) あ\n2) い');
  });

  it('番号付きが 1 つも無ければ元のまま', () => {
    const src = '# 見出し\n\n- あ\n- い';
    expect(renumberLists(src)).toBe(src);
  });
});
