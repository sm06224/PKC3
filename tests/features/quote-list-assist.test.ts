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

/** 適用結果(continue なら caret に挿す / exit なら範囲を置き換える)を文字列で返す。 */
function press(v: string, caret: number = v.length): string | null {
  const r = quoteOnEnter(v, caret);
  if (r.kind === 'none') return null;
  if (r.kind === 'continue') return v.slice(0, caret) + r.insert + v.slice(caret);
  return v.slice(0, r.from) + r.text + v.slice(r.to);
}

describe('リストを書き続けられる #1167', () => {
  it.each([
    ['- 牛乳', '- 牛乳\n- '],
    ['* 牛乳', '* 牛乳\n* '],
    ['+ 牛乳', '+ 牛乳\n+ '],
    ['1. 牛乳', '1. 牛乳\n2. '],
    ['1) 牛乳', '1) 牛乳\n2) '],
    ['- [ ] 牛乳', '- [ ] 牛乳\n- [ ] '],
  ])('%s の行末で Enter → 同じ記号が続く', (v, want) => {
    expect(press(v)).toBe(want);
  });

  /** ⚠ 完了の印を引き継ぐと、書くたびに外す手間が出る。 */
  it('完了済み `- [x] ` の次は未完了の `- [ ] ` で始まる', () => {
    expect(press('- [x] 済')).toBe('- [x] 済\n- [ ] ');
    expect(press('- [X] 済')).toBe('- [X] 済\n- [ ] ');
  });

  it('番号は +1 で続く(桁が増えても)', () => {
    expect(press('9. あ')).toBe('9. あ\n10. ');
    expect(press('0) あ')).toBe('0) あ\n1) ');
    expect(press('1. [ ] あ')).toBe('1. [ ] あ\n2. [ ] ');
  });

  it('字下げを保つ', () => {
    expect(press('  - 入れ子')).toBe('  - 入れ子\n  - ');
    expect(press('    3. 深い')).toBe('    3. 深い\n    4. ');
    expect(press('\t- タブ')).toBe('\t- タブ\n\t- ');
  });

  it('引用の中のリストは `> - ` で続く(入れ子の引用も)', () => {
    expect(press('> - 牛乳')).toBe('> - 牛乳\n> - ');
    expect(press('> > 1. あ')).toBe('> > 1. あ\n> > 2. ');
    expect(press('> - [x] あ')).toBe('> - [x] あ\n> - [ ] ');
  });

  it('行の途中で押したら、割った先にも記号が付く', () => {
    expect(press('- 前半後半', 3)).toBe('- 前\n- 半後半');
  });

  describe('🔴 抜ける(片道にしない)', () => {
    it.each([
      ['あ\n- ', 'あ\n'],
      ['あ\n* ', 'あ\n'],
      ['あ\n3. ', 'あ\n'],
      ['あ\n3) ', 'あ\n'],
      ['あ\n- [ ] ', 'あ\n'],
      ['あ\n- [x] ', 'あ\n'],
      ['あ\n  - ', 'あ\n'],
    ])('空の記号 %j で Enter → 記号が消える', (v, want) => {
      const r = quoteOnEnter(v, v.length);
      expect(r.kind).toBe('exit');
      expect(press(v), '記号が残っている').toBe(want);
    });

    /** 引用の中のリストから抜けても、引用は残る(もう一度で引用も抜けられる)。 */
    it('引用の中の空のリストは、リストだけ抜けて `> ` は残す', () => {
      expect(press('> - あ\n> - ')).toBe('> - あ\n> ');
      // 残った `> ` でもう一度押すと引用から抜ける
      expect(press('> - あ\n> ')).toBe('> - あ\n');
    });
  });

  /** 🔴 コードの中の `- ` はコードである。 */
  it('🔴 fenced code の中では続けない(対照: 閉じた後は続く)', () => {
    for (const v of ['```\n- コード', '```\n1. コード', '~~~\n- コード', '```\n- ']) {
      expect(quoteOnEnter(v, v.length), JSON.stringify(v)).toEqual({ kind: 'none' });
    }
    const closed = '```\nx\n```\n- 外';
    expect(press(closed)).toBe(closed + '\n- ');
  });

  /** ⚠ 対照群 ── リストでない行・記号の途中・水平線では何もしない。 */
  it.each([['ただの本文'], ['-'], ['1.'], ['-牛乳'], ['*強調*'], ['---'], ['* * *'], ['- - -'], ['1.5 倍']])(
    '%j は何もしない',
    (v) => {
      expect(quoteOnEnter(v, v.length)).toEqual({ kind: 'none' });
    },
  );

  it('記号より手前(行頭)で押しても `- - ` にならない', () => {
    expect(quoteOnEnter('- 牛乳', 0)).toEqual({ kind: 'none' });
    expect(quoteOnEnter('- 牛乳', 1)).toEqual({ kind: 'none' });
    // 引用の中なら、引用の規則へ落ちる(`> ` だけ続く)
    expect(quoteOnEnter('> - 牛乳', 3)).toEqual({ kind: 'continue', insert: '\n> ' });
  });

  it('途中の行でも、その行だけで決まる', () => {
    const v = 'a\n- 牛乳\nb';
    expect(press(v, 6)).toBe('a\n- 牛乳\n- \nb');
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

  it('🔴 高速化: 番号付きリスト記号を含まない長文で同一参照のまま即時脱出する (#1110)', () => {
    const text = '箇条書きのみの本文\n- 項目A\n- 項目B\n段落テキスト\n'.repeat(50);
    expect(renumberLists(text)).toBe(text);
  });

  it('🔴 CRLF 改行のノートでも改行コードを保持して正しく振り直す (#1110)', () => {
    const crlfSrc = '1. 行1\r\n5. 行2\r\n3. 行3';
    expect(renumberLists(crlfSrc)).toBe('1. 行1\r\n2. 行2\r\n3. 行3');
  });
});

