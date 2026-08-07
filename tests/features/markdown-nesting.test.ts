/** @vitest-environment happy-dom */
/**
 * 🔴 **`:::` の入れ子の全数**(2026-08-07)。
 *
 * ## 何が壊れていたか
 *
 * `:::` の囲いを畳む前処理は 7 つ在るが、入れ子を数えていたのは **2 つだけ**だった。
 * 残りは「開いたら**最初に出会った `:::`** まで」の平坦な走査だったので、
 * 中に別の `:::` を書くと**内側の閉じを自分の閉じとして食い**、外側の閉じが
 * 最上位へ漏れる。出てくる HTML は 2 通りの壊れ方をしていた:
 *
 * | 壊れ方 | 例 | 出力 |
 * |---|---|---|
 * | **交差** | `:::quote` > `:::note` | `</blockquote>` が `</section>` **より先**に出る |
 * | **literal 漏れ** | `:::.outer` > `:::.inner` | 内側が `<p>:::.inner</p>` のまま残る |
 *
 * 実測(外 14 形 × 内 8 形 = 112 通り)で **48 通りが壊れていた**。表に記録が
 * あったのは 4 件だけである ── **数えていなかったから記録も無かった**。
 *
 * ## この test の作り
 *
 * 🔑 **下流の結果(釣り合うか)ではなく、壊れる当の振る舞い(タグが入れ子か)を見る**
 * (CLAUDE.md「下流の結果だけを見る test は別経路が救って変異を見逃す」)。
 * 釣り合い(ライブエディタが開くか)は `live-editor-balance.test.ts` の担当。
 *
 * ⚠ **空振り防止**: 「交差していない」は**何も描かなくても成立する**ので、
 *   ① 外側の要素が実在すること ② 中身の文字が届いていること を先に確かめる。
 * ⚠ 記法を足したら `OUTER` / `INNER` にも足す ── 足さないと、その組は誰も見ない。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

interface Form {
  readonly name: string;
  readonly open: string;
  /** 畳まれたときに出る要素(交差の判定に使う)。 */
  readonly tag: string;
}

/** 外側に置ける形。⚠ `if` は器が消える(中身だけ残る)ので `tag` を持たない。 */
const OUTER: readonly Form[] = [
  { name: 'quote', open: ':::quote{author=x}', tag: 'blockquote' },
  { name: 'section', open: ':::section{role=body}', tag: 'section' },
  { name: 'note(alias)', open: ':::note', tag: 'section' },
  { name: 'format', open: ':::format{.a}', tag: 'div' },
  { name: 'details', open: ':::details{summary=x}', tag: 'details' },
  { name: 'figure', open: ':::figure{#f1}', tag: 'figure' },
  { name: 'region-body', open: ':::body', tag: 'section' },
  { name: 'tier0', open: ':::red', tag: 'div' },
  { name: 'tier1-dot', open: ':::.outer', tag: 'div' },
  { name: 'tier1-brace', open: ':::{.outer}', tag: 'div' },
  { name: 'tier1-bare', open: '::: bareOuter', tag: 'div' },
];

/** 内側に置ける形。 */
const INNER: readonly Form[] = [
  { name: 'note', open: ':::note', tag: 'section' },
  { name: 'section', open: ':::section{role=body}', tag: 'section' },
  { name: 'details', open: ':::details{summary=x}', tag: 'details' },
  { name: 'quote', open: ':::quote{author=y}', tag: 'blockquote' },
  { name: 'tier0', open: ':::blue', tag: 'div' },
  { name: 'tier1-dot', open: ':::.inner', tag: 'div' },
  { name: 'tier1-brace', open: ':::{.inner}', tag: 'div' },
  { name: 'tier1-bare', open: '::: bareInner', tag: 'div' },
];

/**
 * 開きタグ / 閉じタグの出現順を並べる。⚠ **文字列で見る** ── happy-dom に
 * 食わせると、ブラウザの寛容な木の組み直しが**交差を勝手に直してしまう**
 * (壊れた HTML を配っている事実が消える)。
 */
function tagOrder(html: string, tags: readonly string[]): string[] {
  const uniq = [...new Set(tags)];
  const re = new RegExp(`</?(${uniq.join('|')})(?=[\\s>/])`, 'g');
  return [...html.matchAll(re)].map((m) => m[0]!.replace(/[\s>/]*$/, ''));
}

describe('`:::` の入れ子(全数)', () => {
  for (const o of OUTER) {
    for (const inn of INNER) {
      it(`入れ子が交差しない: ${o.name} > ${inn.name}`, () => {
        const html = renderMarkdown(`${o.open}\n${inn.open}\n中身\n:::\n:::\n`);

        // ── 空振り防止 ①:外側も内側も実際に畳まれている
        expect(html, `${o.name} が畳まれていない`).toContain(`<${o.tag}`);
        expect(html, `${inn.name} が畳まれていない`).toContain(`<${inn.tag}`);
        // ── 空振り防止 ②:中身が届いている
        expect(html, '中身が消えている').toContain('中身');
        // ── 空振り防止 ③:閉じが literal で漏れていない
        expect(html, '閉じの `:::` が literal で漏れている').not.toContain('<p>:::</p>');
        expect(html, '開きが literal で漏れている').not.toMatch(/<p>:::[^<]/);

        /**
         * 🔴 **本題** ── 開いた順の逆順で閉じているか(交差していないか)。
         * 例: 壊れていた頃の `:::quote > :::note` は
         *     `<blockquote>` `<section>` `</blockquote>` `</section>` を出していた。
         */
        const order = tagOrder(html, [o.tag, inn.tag]);
        const stack: string[] = [];
        for (const t of order) {
          if (t.startsWith('</')) {
            expect(stack.pop(), `閉じが交差している(${order.join(' ')})`).toBe(t.slice(2));
          } else {
            stack.push(t.slice(1));
          }
        }
        expect(stack, `閉じ忘れが残っている(${order.join(' ')})`).toEqual([]);
      });
    }
  }

  /**
   * 🔴 **数えるものを間違えない**(`classifyDirectiveOpen` の担当)。
   *
   * ⚠ `:::foo` のような**どの処理も畳まない名前**を「開き」として数えると、
   *   閉じないものの閉じを待って `:::` を 1 つ余計に食う ── これは上の 112 件の
   *   どれでも起きないので、**専用に見る**。
   */
  it('🔴 畳まれない名前(:::foo)を開きとして数えない', () => {
    /**
     * 🔑 **見分けの勘所**: 閉じ `:::` は 1 つだけ置き、その**後ろに本文を続ける**。
     * - 正しい(数えない): `:::` が section を閉じ、`後` は section の**外**
     * - 誤り(数える): `:::` を `:::foo` の閉じとして食い、section は末尾まで飲むので
     *   `後` が section の**中**に入る
     * ⚠ 「`:::foo` が literal で残るか」だけを見ると、どちらでも通ってしまう。
     */
    const html = renderMarkdown(':::section{role=body}\n:::foo\n中身\n:::\n\n後\n');
    expect(html, 'section が畳まれていない').toContain('<section');
    expect(html, ':::foo が畳まれてしまっている').toContain(':::foo');
    const after = html.slice(html.lastIndexOf('</section>'));
    expect(after, '`:::foo` を開きとして数えている(section が閉じ損ねた)').toContain('後');
  });

  /**
   * 🔴 **`:::break` は閉じを持たない**ので数えない(数えると `:::` を 1 つ食う)。
   */
  it('🔴 :::break を開きとして数えない', () => {
    const html = renderMarkdown(':::section{role=body}\n:::break{kind=page}\n中身\n:::\n');
    expect(html, 'section が畳まれていない').toContain('<section');
    expect(html, '改頁が出ていない').toContain('pkc-section-break');
    expect(html, 'section の閉じが食われて `:::` が漏れている').not.toContain('<p>:::</p>');
  });

  /**
   * 🔴 **fence の中の `:::` は記法ではない**。
   * ⚠ 直す前は囲いの中身を平坦に読んでいたので、コードに書いた `:::` で
   *   囲いが閉じていた。
   */
  it('🔴 fence の中に書いた `:::` で囲いが閉じない', () => {
    const html = renderMarkdown(
      ':::section{role=body}\n```\n:::\n```\n中身\n:::\n',
    );
    expect(html, 'section が畳まれていない').toContain('<section');
    expect(html, 'コードの `:::` が消えている').toContain(':::');
    // 中身は section の**中**に在る(閉じが早いと外へ出る)
    const inside = html.slice(html.indexOf('<section'), html.lastIndexOf('</section>'));
    expect(inside, '中身が section の外へ出ている').toContain('中身');
  });

  /**
   * 🔴 **図の中の fence も同じ**(2026-08-07 の変異試験で判明)。
   *
   * ⚠ 上の test は `scanContainerDirective`(stack の走査)を通るが、**図だけは
   * 別の経路**(`findMatchingClose`)である ── だから上の 1 件では
   * 「fence の中を数えない」の変異が**生き延びた**。
   * CLAUDE.md「同じ値を複数の描画経路へ渡すものは、経路ごとに pin する」。
   */
  it('🔴 図の中の fence に書いた `:::` で図が閉じない', () => {
    const html = renderMarkdown(
      ':::figure{#f1}\n```\n:::\n```\n^^^ 題\n:::\n\n後\n',
    );
    expect(html, '図が畳まれていない').toContain('<figure');
    expect(html, 'コードの `:::` が消えている').toContain(':::');
    expect(html, '説明が付いていない').toContain('題');
    // ⚠ 図が早く閉じると、説明も後続も図の外へこぼれる
    const inside = html.slice(html.indexOf('<figure'), html.lastIndexOf('</figure>'));
    expect(inside, '説明が図の外へ出ている').toContain('題');
    expect(html.slice(html.lastIndexOf('</figure>')), '後続が図に飲まれている').toContain('後');
  });

  /**
   * 🔴 **`:::toc` は中を飲まない**ので、深さを 1 つ増やしてはいけない。
   *
   * ⚠ 増やすと「その分の閉じ」を待ってしまい、**外側の閉じを食う**。
   * `:::if{format=docx}`(捨てる側)で見ると差がはっきり出る ──
   * 正しければ最後の `:::` で if が閉じて `後` は生き残り、
   * 数え間違えると if が末尾まで飲んで `後` ごと消える。
   */
  it('🔴 :::toc を「中を飲む囲い」として数えない', () => {
    const html = renderMarkdown(':::if{format=docx}\n:::toc\n捨てる\n:::\n\n後\n');
    expect(html, '捨てるはずの中身が残っている').not.toContain('捨てる');
    expect(html, 'if が末尾まで飲んで後続まで消した').toContain('後');
  });

  /**
   * 🔴 **閉じを書いた `:::toc` の `:::` は toc のもの**(2026-08-07 の変異試験で判明)。
   *
   * ⚠ 上の test は toc に閉じが**無い**形なので、「直後の閉じを飛ばす」処理を
   *   消しても通ってしまった(実際に変異が生き延びた)。差が出るのは**閉じを
   *   書いた形**だけ ── 飛ばさないと、その `:::` を外側の閉じとして食う。
   */
  it('🔴 閉じつきの :::toc の `:::` を、外側の閉じとして食わない', () => {
    const html = renderMarkdown(':::if{format=docx}\n:::toc\n:::\n捨てる\n:::\n\n後\n');
    expect(html, 'if が早く閉じて中身が漏れている').not.toContain('捨てる');
    expect(html, '後続まで消えた').toContain('後');
  });

  /**
   * 🔴 **捨てる側(`:::if{format=docx}`)で Tier 1 の中身が漏れていた**
   * (2026-08-07 実測)。`processIfBlocks` の深さ数えが Tier 0 / Tier 1 の開きを
   * 見ておらず、内側の閉じで if が終わってしまい、残りが画面に出ていた。
   */
  it('🔴 捨てる側の :::if の中の Tier 0 / Tier 1 が漏れない', () => {
    for (const inner of [':::.hl', ':::{.hl}', '::: bareCls', ':::red']) {
      const html = renderMarkdown(`:::if{format=docx}\n${inner}\n捨てる\n:::\n:::\n\n後\n`);
      expect(html, `${inner}: 捨てるはずの中身が残っている`).not.toContain('捨てる');
      expect(html, `${inner}: 器だけ漏れている`).not.toContain('pkc-format-block');
      expect(html, `${inner}: 後続まで消えた`).toContain('後');
    }
  });
});
