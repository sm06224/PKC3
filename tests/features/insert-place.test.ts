/**
 * 🔴 **差し込む所を解く**(#684 段④、`resolveInsertPlace` / `insertLines` の錨)。
 *
 * ## 守る主張
 *
 * 1. 落とした所(`before`)はその行番号。目印(落とした塊の開き行)が合わなければ解けない
 * 2. 🔴 `after` は**いちばん後ろの一致の次** ── まとめて落とした 2 枚目が
 *    1 枚目の**下**へ続く(同じ字が 2 行あっても、さっき入れたほう)
 * 3. 🔴 **書く直前に目印を突き合わせる** ── 落としてから書くまでに行が増えていたら
 *    `insertLines` は書かない(当てずっぽうで段落を割らない)
 * 4. 囲い(fence / `:::`)の中・frontmatter は `null`
 */
import { describe, expect, it } from 'vitest';
import { insertLines, resolveInsertPlace } from '../../src/features/markdown/line-move';

const DOC = ['# 題', '', '段落 A', '', '段落 B', ''].join('\n');
/** 「段落 A」の塊(2 行目)を指す目印。 */
const A = { line: 2, text: '段落 A' };

describe('差し込む所を解く(#684 段④)', () => {
  it('落とした所はその行番号 ── 目印が合わなければ解けない', () => {
    expect(resolveInsertPlace(DOC, { kind: 'before', toBefore: 3, anchor: A })).toEqual({
      to: 3,
      anchor: A,
    });
    // ⚠ 空振り防止 ── その位置は本当に入れられる(規則そのものが成り立っている)
    expect(insertLines(DOC, 3, ['![猫](asset:k1)'])).not.toBeNull();
    expect(
      resolveInsertPlace(DOC, { kind: 'before', toBefore: 3, anchor: { line: 2, text: '別の字' } }),
      '目印が合わないのに解けた',
    ).toBeNull();
    expect(resolveInsertPlace(DOC, { kind: 'before', toBefore: 7, anchor: A }), '行数を超える').toBeNull();
    expect(resolveInsertPlace(DOC, { kind: 'before', toBefore: -1, anchor: A })).toBeNull();
  });

  it('🔴 after は「いちばん後ろの一致の次」── 2 枚目が 1 枚目の下へ続く', () => {
    const one = insertLines(DOC, 3, ['![猫](asset:k1)'])!;
    const hit = resolveInsertPlace(one, { kind: 'after', anchor: '![猫](asset:k1)' });
    expect(hit, '1 枚目の行が見つからない').not.toBeNull();
    expect(hit!.anchor, '目印が 1 枚目の行になっていない').toEqual({
      line: one.split('\n').indexOf('![猫](asset:k1)'),
      text: '![猫](asset:k1)',
    });
    const two = insertLines(one, hit!.to, ['![犬](asset:k2)'])!;
    const rows = two.split('\n');
    expect(
      rows.indexOf('![猫](asset:k1)') < rows.indexOf('![犬](asset:k2)'),
      '2 枚目が 1 枚目の上に入った(落とした順と並びが逆)',
    ).toBe(true);
    // ⚠ 対照群 ── 同じ所(`before`)を使い回すと、実際に逆になる
    const naive = insertLines(one, 3, ['![犬](asset:k2)'])!.split('\n');
    expect(naive.indexOf('![犬](asset:k2)') < naive.indexOf('![猫](asset:k1)')).toBe(true);
    // ⚠ 同じ字が 2 行あるとき(同じ bytes の file)は**さっき入れたほう**
    const twice = insertLines(one, hit!.to, ['![猫](asset:k1)'])!;
    expect(resolveInsertPlace(twice, { kind: 'after', anchor: '![猫](asset:k1)' })!.to).toBe(
      twice.split('\n').lastIndexOf('![猫](asset:k1)') + 1,
    );
    expect(resolveInsertPlace(DOC, { kind: 'after', anchor: 'どこにも無い' })).toBeNull();
  });

  /**
   * 🔴 **落としてから書くまでに行が増えたら書かない**(着地前レビュー D)。
   * ⚠ 兄弟(`move-lines` / `place-move` / `undo-append`)は全部これを持っている ──
   *   差し込みだけが番号しか見ていなかった。
   */
  it('🔴 書く直前に目印を突き合わせる ── 行が増えていたら書かない', () => {
    expect(insertLines(DOC, 3, ['x'], A), '前提: そのままなら書ける').not.toBeNull();
    const grown = `新しい 1 行\n${DOC}`;
    expect(insertLines(grown, 3, ['x'], A), '番号だけで別の所へ書いた').toBeNull();
    // ⚠ 対照群 ── 目印を付けなければ(段②の経路)これまでどおり書ける
    expect(insertLines(grown, 3, ['x']), '目印なしの経路まで止めた').not.toBeNull();
    // ⚠ 対照群 ── 目印を新しい番号へ直せば書ける(止めているのは「ずれ」だけ)
    expect(insertLines(grown, 4, ['x'], { line: 3, text: '段落 A' })).not.toBeNull();
  });

  it('囲いの中・frontmatter へは解かない(書く側と同じ 1 本)', () => {
    const doc = ['---', 'a: 1', '---', '# 題', '', '```js', 'code', '```', ''].join('\n');
    const at = (line: number) => ({ line, text: doc.split('\n')[line]! });
    expect(resolveInsertPlace(doc, { kind: 'before', toBefore: 1, anchor: at(1) }), 'frontmatter').toBeNull();
    expect(resolveInsertPlace(doc, { kind: 'before', toBefore: 6, anchor: at(6) }), 'fence の中').toBeNull();
    expect(resolveInsertPlace(doc, { kind: 'after', anchor: '```js' }), 'fence の開きの次').toBeNull();
    // ⚠ 対照群 ── 囲いの外は解ける(この test が「常に null」で緑になっていない)
    expect(resolveInsertPlace(doc, { kind: 'before', toBefore: 4, anchor: at(4) })!.to).toBe(4);
  });
});
