/** @vitest-environment happy-dom */
/**
 * 🔴 **見出しの畳みを器へ当てる**(#396)。
 * ⚠ 範囲の計算は `tests/features/heading-fold.test.ts`。**ここが見るのは器**である。
 */
import { describe, expect, it } from 'vitest';
import { applyHeadingFold, toggleHeadingFold } from '../../src/adapter/ui/render/heading-fold';

function host(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

const DOC = '<h1>章</h1><p>あ</p><h2>節</h2><p>い</p><p>う</p>';
const btns = (h: HTMLElement): HTMLElement[] => [
  ...h.querySelectorAll<HTMLElement>('[data-pkc-field="heading-fold"]'),
];

describe('見出しの畳み(器) #396', () => {
  it('配下がある見出しに、押す口が出る', () => {
    const h = host(DOC);
    expect(applyHeadingFold(h)).toBe(2);
    expect(btns(h)).toHaveLength(2);
    // ⚠ 文言は**起きること**で書く(user 指示 2026-08-21)
    expect(btns(h)[0]!.title).toContain('畳みます');
    expect(btns(h)[0]!.getAttribute('aria-label')).toContain('畳みます');
    /**
     * 🔴 **見出しの字を汚さない**(2026-08-25 に実際に落ちた)。
     * ⚠ ボタンに字を入れると `h1.textContent` に混ざり、
     *   **写し・読み上げ・アンカー・目次が全部汚れる**。印は CSS で出す。
     */
    expect(h.querySelector('h1')!.textContent, '見出しの字にボタンが混ざっている').toBe('章');
    // 🔑 押しの振り分けは既存の作法に乗せる(独自の listener を増やさない)
    expect(btns(h)[0]!.getAttribute('data-pkc-action')).toBe('toggle-heading-fold');
  });

  it('配下が無い見出しには出さない(押せない口を作らない)', () => {
    const h = host('<h1>章</h1><h1>章</h1><p>あ</p>');
    applyHeadingFold(h);
    // 1 つ目の `<h1>` は次が同段なので配下が無い
    expect(btns(h)).toHaveLength(1);
    expect(h.children[1]!.querySelector('[data-pkc-field="heading-fold"]')).not.toBeNull();
  });

  it('⚠ 何度当てても押す口は増えない(描画のたびに呼ぶので)', () => {
    const h = host(DOC);
    applyHeadingFold(h);
    applyHeadingFold(h);
    applyHeadingFold(h);
    expect(btns(h)).toHaveLength(2);
  });

  it('押すと配下が畳まれ、もう一度押すと戻る', () => {
    const h = host(DOC);
    applyHeadingFold(h);
    const h2 = h.children[2]!; // <h2>節</h2>
    toggleHeadingFold(h2);
    expect((h.children[3] as HTMLElement).hidden, '配下が畳まれていない').toBe(true);
    expect((h.children[4] as HTMLElement).hidden).toBe(true);
    expect((h.children[1] as HTMLElement).hidden, '別の節まで畳んでいる').toBe(false);
    toggleHeadingFold(h2);
    expect((h.children[3] as HTMLElement).hidden, '戻っていない').toBe(false);
  });

  /**
   * 🔴 **この test がこの設計の理由そのものである。**
   * ⚠ 「押したら `hidden` を反転する」形だと、外側を開いた瞬間に
   *   **内側の畳みまで開いてしまう**(内側が畳んでいた事実が失われるので)。
   */
  it('🔴 外側を開いても、内側の畳みは残る', () => {
    const h = host(DOC);
    applyHeadingFold(h);
    toggleHeadingFold(h.children[2]!); // 内側(h2)を畳む
    toggleHeadingFold(h.children[0]!); // 外側(h1)を畳む
    expect([...h.children].map((c) => (c as HTMLElement).hidden)).toEqual([
      false, true, true, true, true,
    ]);
    toggleHeadingFold(h.children[0]!); // 外側を開く
    expect(
      [...h.children].map((c) => (c as HTMLElement).hidden),
      '外を開いたら内側の畳みまで開いてしまった',
    ).toEqual([false, false, false, true, true]);
  });

  /**
   * 🔴 **節点を 1 つも動かさない。**
   *
   * ⚠ PKC2 は `<details>` へ入れ子に組み替えていたが、PKC3 でそれをやると
   *   **ライブエディタが死ぬ** ── `row-swap.ts:394` の塊の特定が
   *   「**host の直下である**」ことを前提にしており、入れ子にすると
   *   `view.nodes` に居ない `<details>` へ上りきって `null` が返る
   *   (そして**無言で**押しても編集に入れなくなる)。
   * 🔑 だからこの test は、**畳んだ後も塊が host の直下のまま**であることを見る。
   */
  it('🔴 畳んでも、塊は host の直下のまま(ライブエディタの前提を壊さない)', () => {
    const h = host(DOC);
    const before = [...h.children];
    applyHeadingFold(h);
    toggleHeadingFold(h.children[0]!);
    expect([...h.children], '塊の数か順番が変わった').toEqual(before);
    for (const c of h.children) {
      expect(c.parentElement, 'host の直下でなくなった').toBe(h);
    }
    expect(h.querySelector('details'), '入れ子の器を作っている').toBeNull();
  });

  it('見出しが無ければ何もしない', () => {
    const h = host('<p>あ</p><p>い</p>');
    expect(applyHeadingFold(h)).toBe(0);
    expect(btns(h)).toHaveLength(0);
    expect((h.children[0] as HTMLElement).hidden).toBe(false);
  });
});
