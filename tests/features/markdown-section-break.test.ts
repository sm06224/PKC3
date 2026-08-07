/** @vitest-environment happy-dom */
/**
 * 🔴 **改頁(`+++` / `:::break`)**(2026-08-07)。
 *
 * ## 直す前に起きていたこと
 *
 * 改頁は前処理で PUA の sentinel 行になり、後処理が `<p …>SENT</p>` を
 * `<hr class="pkc-section-break">` へ置き換える。**sentinel が単独の段落に
 * 入っていることが前提**だった ── ところが前後に空行が無いと markdown-it が
 * 隣の行と 1 つの段落に束ねるので、置換が当たらない。
 *
 * PUA は画面に出ないため、症状は「**改頁が起きず、`auto` という字が本文に出る**」。
 *
 * ```
 * 前            →  <p>前<br>auto<br>後</p>
 * +++
 * 後
 * ```
 *
 * ⚠ **user が素直に書いた形が、まさに壊れる形だった。** 空行を入れて書いた人
 * だけが正しい出力を得ていた。
 * ⚠ 直す前、改頁を見る unit は **1 件も無かった**(goldens と印刷 smoke だけ)。
 *   goldens は `+++` の前後に空行のある本文しか持っておらず、smoke も同様 ──
 *   **壊れている形をどの検査も通っていなかった**。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

/** 改頁の `<hr>` の数。 */
function breaks(html: string): number {
  return [...html.matchAll(/<hr class="pkc-section-break"/g)].length;
}

describe('改頁(`+++` / `:::break`)', () => {
  /**
   * ⚠ **空行の有無で結果が変わらない**ことが本題。
   * 「空行あり」だけを見る test は、直す前の実装でも通る(= 何も守らない)。
   */
  const FORMS: readonly { name: string; body: string }[] = [
    { name: '空行なし(直す前は壊れていた形)', body: '前\n+++\n後\n' },
    { name: '前だけ空行', body: '前\n\n+++\n後\n' },
    { name: '後だけ空行', body: '前\n+++\n\n後\n' },
    { name: '前後とも空行', body: '前\n\n+++\n\n後\n' },
    { name: 'formal(:::break、空行なし)', body: '前\n:::break{kind=page}\n後\n' },
    { name: 'formal(:::break、空行あり)', body: '前\n\n:::break{kind=page}\n\n後\n' },
    { name: '囲いの中(空行なし)', body: ':::section{role=body}\n前\n+++\n後\n:::\n' },
    { name: '囲いの中(空行あり)', body: ':::section{role=body}\n\n前\n\n+++\n\n後\n:::\n' },
  ];

  for (const f of FORMS) {
    it(`改頁が 1 つ出て、本文に role が漏れない: ${f.name}`, () => {
      const html = renderMarkdown(f.body);
      expect(breaks(html), `改頁が出ていない(${html})`).toBe(1);
      /**
       * 🔴 **これが直す前に出ていた字**。role の既定値が本文へ漏れる。
       * ⚠ 「`<hr>` が在るか」だけでは足りない ── 別経路の `<hr>` に救われうる。
       */
      expect(html, 'role の字(auto)が本文に漏れている').not.toContain('auto<');
      expect(html, 'role の字(auto)が本文に漏れている').not.toMatch(/>auto/);
      // 本文が消えていない(空振り防止)
      expect(html, '本文が消えた').toContain('前');
      expect(html, '本文が消えた').toContain('後');
    });
  }

  /**
   * 🔴 **role は属性で運ぶ**(`+++ {role=cover}`)。
   * ⚠ 空行が無い形でも同じ ── 直す前はここでも `cover` という字が本文に出ていた。
   */
  it('role つきの改頁(空行なし)でも属性で運ばれる', () => {
    const html = renderMarkdown('前\n+++ {role=cover}\n後\n');
    expect(html).toContain('data-pkc-role="cover"');
    expect(html, 'role の字が本文に漏れている').not.toMatch(/>cover/);
  });

  /**
   * ⚠ **fence の中の `+++` は改頁ではない**(コードに書いた記号)。
   */
  it('fence の中の `+++` は改頁にならない', () => {
    const html = renderMarkdown('```\n+++\n```\n');
    expect(breaks(html), 'コードの `+++` を改頁にしている').toBe(0);
    expect(html, 'コードの `+++` が消えた').toContain('+++');
  });

  /**
   * ⚠ `:::break{kind=rule}` は**ただの罫線**(改頁ではない)。
   * 見分けが付かなくなると「押しても改頁されない」に戻る。
   */
  it(':::break{kind=rule} は罫線であって改頁ではない', () => {
    const html = renderMarkdown('前\n\n:::break{kind=rule}\n\n後\n');
    expect(breaks(html), '罫線を改頁にしている').toBe(0);
    expect(html, '罫線が出ていない').toContain('<hr>');
  });
});
