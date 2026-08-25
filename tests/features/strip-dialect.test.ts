/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { stripDialect } from '../../src/features/markdown/strip-dialect';

describe('方言を落として素の CommonMark にする #396', () => {
  /**
   * 🔴 **等価が在る役は記号へ戻す**(PKC2 は素の文字へ潰していた)。
   * ⚠ 「取り出す」の目的は**読める markdown を得ること**であって、
   *   装飾を捨てることではない。
   */
  it('🔴 CommonMark に等価が在る役は、記号になる', () => {
    expect(stripDialect(':strong:[太字] と :emphasis:[斜体]')).toBe('**太字** と *斜体*');
    expect(stripDialect(':code:[x] と :strike:[y]')).toBe('`x` と ~~y~~');
  });

  it('等価が無い役は、中身だけ残る', () => {
    expect(stripDialect('H:sub:[2]O と x:sup:[2]')).toBe('H2O と x2');
    expect(stripDialect(':span:[印]{.hl}')).toBe('印');
  });

  /** ⚠ **知らない役は触らない**(黙って壊さない)。 */
  it('🔴 知らない役はそのまま残す', () => {
    expect(stripDialect(':しらない:[中身]')).toBe(':しらない:[中身]');
    expect(stripDialect(':zzz:[中身]')).toBe(':zzz:[中身]');
  });

  it('強調・圏点・ルビ・行内コメントを落とす', () => {
    expect(stripDialect('==目立つ== と ==[red]赤==')).toBe('目立つ と 赤');
    expect(stripDialect('^^圏点^^ と [[em:旧形]]')).toBe('圏点 と 旧形');
    expect(stripDialect('[[ruby:漢字|かんじ]]')).toBe('漢字');
    expect(stripDialect('本文 %%見せない%% の続き')).toBe('本文  の続き');
  });

  /** ⚠ 枠だけ落として**中身は残す** ── 中身まで消すと user の文章が消える。 */
  it('🔴 `:::` の枠は落ちるが、中身は残る', () => {
    expect(stripDialect(':::note\n大事なこと\n:::')).toBe('大事なこと');
  });

  /** ⚠ `comment` と `toc` は**中身ごと**落とす(見せる物ではない)。 */
  it('`:::comment` と `:::toc` は中身ごと落ちる', () => {
    expect(stripDialect('前\n:::comment\n内緒\n:::\n後')).toBe('前\n\n後');
    expect(stripDialect('前\n:::toc\n:::\n後')).toBe('前\n\n後');
  });

  it('改頁は区切り線になり、空行マーカーは空行になる', () => {
    expect(stripDialect('あ\n+++\nい')).toBe('あ\n---\nい');
    expect(stripDialect('あ\n_\n_3\nい')).toBe('あ\n\nい');
  });

  it('行頭の寄せ・字下げは記号だけ落ちる', () => {
    expect(stripDialect('|>右寄せ')).toBe('右寄せ');
    expect(stripDialect('__字下げ')).toBe('字下げ');
  });

  /** 🔴 `__bold__` を字下げと読まない(user の強調を壊さない)。 */
  it('🔴 `__太字__` は字下げと読まない', () => {
    expect(stripDialect('__太字__')).toBe('__太字__');
  });

  /**
   * 🔴 **fence の中は 1 バイトも触らない。**
   * ⚠ コードの中の `==` や `:::` は**コード**である。
   */
  it('🔴 コードの中は触らない', () => {
    const src = '```js\nconst a = x ==[red]y==;\n:::note\n```';
    expect(stripDialect(src)).toBe(src);
  });

  it('チルダの fence でも触らない', () => {
    const src = '~~~\n==そのまま==\n~~~';
    expect(stripDialect(src)).toBe(src);
  });

  /** ⚠ 落とした行は**空行に置き換える**(詰めない)── 詰めると段落がくっつく。 */
  it('🔴 枠を落としても、前後の段落がくっつかない', () => {
    const out = stripDialect('前の段落\n:::note\n中\n:::\n後の段落');
    expect(out.split('\n\n')).toEqual(['前の段落', '中', '後の段落']);
  });

  it('素の CommonMark は 1 バイトも変わらない', () => {
    const src = '# 見出し\n\n- あ\n- い\n\n**太字** と `code`\n\n> 引用';
    expect(stripDialect(src)).toBe(src);
  });
});
