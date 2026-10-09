/** @vitest-environment happy-dom */
/**
 * P8 段⑫: **同じ面に戻ったら、同じ場所に戻る**。
 *
 * > user 指示 2026-08-03「**サイドバーも同じ、スクロールが発生するすべての画面が
 * > 対象だよ**」
 *
 * 🔴 ここは**順番が本体**なので、そこを観測点にする:
 *  ① 退避は**書き換える前**(後だと、縮んで 0 に丸められた値を保存する)
 *  ② 復元は**入れ終わってから**(前だと `scrollHeight` が足りず丸められる)
 * ⚠ 「値を覚えている」だけを見る test では、順番の間違いが素通りする。
 */
import { describe, expect, it } from 'vitest';
import { ScrollMemory } from '../../src/adapter/ui/render/scroll-memory';

/** happy-dom は `scrollTop` を素の数値として持つので、丸めは自分で真似る。 */
function container() {
  const el = document.createElement('div');
  let content = 1000;
  let top = 0;
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    // ⚠ **本物と同じく丸める** ── 中身より下は指せない。ここを素通しにすると
    //    「空の器に書いても効く」ことになり、実装の間違いが test に写らない
    set: (v: number) => {
      top = Math.max(0, Math.min(v, content));
    },
    configurable: true,
  });
  return {
    el,
    /** 中身の高さ(= 指せる上限)を変える。 */
    setContent(h: number) {
      content = h;
      if (top > h) top = h;
    },
  };
}

describe('スクロール位置の記憶', () => {
  /** user が送った / ブラウザが丸めた、の後に届く `scroll`(⚠ 本物は非同期 ── 描き直しの後に届く)。 */
  const scrolled = (el: HTMLElement): void => {
    el.dispatchEvent(new Event('scroll'));
  };

  it('同じ面に戻ったら同じ位置', () => {
    const c = container();
    const m = new ScrollMemory(c.el);
    m.use('a');
    c.el.scrollTop = 250;
    scrolled(c.el);
    m.use('b');
    expect(c.el.scrollTop, '別の面は先頭から').toBe(0);
    c.el.scrollTop = 100;
    scrolled(c.el);
    m.use('a');
    expect(c.el.scrollTop, 'a の位置に戻っていない').toBe(250);
  });

  /**
   * 🔴 **縮んで丸められた `scroll` は、描き直しの後(= 鍵を切り替えた後)に届く**(#1467 段 3-e)。
   * ⚠ これが「絞り込み → 戻す」で飛んでいた形そのもの ── 丸められた 0 を**前の面の鍵**で覚えると飛ぶ。
   *   本物のブラウザは `scroll` を非同期に出すので、描き直し(`use(newKey)`)の後に届く。
   */
  it('🔴 縮んで丸められた分の scroll が描き直しの後に届いても、元の面の位置を失わない', () => {
    const c = container();
    const m = new ScrollMemory(c.el);
    m.use('all');
    c.el.scrollTop = 250;
    scrolled(c.el); // user が送った
    // 絞り込み = 中身が縮む(ブラウザが 0 へ丸める)→ 描き直し → 鍵を切り替える
    c.setContent(0);
    expect(c.el.scrollTop).toBe(0);
    m.use('filtered');
    scrolled(c.el); // ⚠ 丸められた分の scroll はここで届く(鍵は既に filtered)
    // 戻す = 中身が伸びる
    c.setContent(1000);
    m.use('all');
    expect(c.el.scrollTop, '縮んだ後の 0 を前の面の鍵で覚えてしまった').toBe(250);
  });

  /** 🔴 描き直しの中で `scrollTop` を読まない(読むと強制レイアウトを払う ── #1467 段 3-e)。 */
  it('🔴 use() は scrollTop を読まない(書くだけ)── 位置は scroll イベントでしか覚えない', () => {
    const el = document.createElement('div');
    let top = 0;
    let reads = 0;
    Object.defineProperty(el, 'scrollTop', {
      get: () => {
        reads += 1;
        return top;
      },
      set: (v: number) => {
        top = v;
      },
      configurable: true,
    });
    const m = new ScrollMemory(el);
    m.use('a');
    el.scrollTop = 250;
    reads = 0;
    m.use('a');
    m.use('b');
    m.use('a');
    expect(reads, 'use() が scrollTop を読んでいる(描き直しの中で強制レイアウトを払う)').toBe(0);
    // 対照群: scroll が届いたときだけ読む
    el.dispatchEvent(new Event('scroll'));
    expect(reads).toBe(1);
  });

  it('🔴 同じ面を描き直しただけでも戻す(ログのように作り直す面)', () => {
    const c = container();
    const m = new ScrollMemory(c.el);
    m.use('log');
    c.el.scrollTop = 250;
    scrolled(c.el);
    c.setContent(0); // 作り直しで一瞬空になる
    c.setContent(1000);
    m.use('log');
    expect(c.el.scrollTop, '同じ鍵だからと戻さなかった').toBe(250);
  });

  it('覚えていない面は先頭から', () => {
    const c = container();
    const m = new ScrollMemory(c.el);
    m.use('x');
    expect(c.el.scrollTop).toBe(0);
  });

  it('⚠ 覚える面の数に上限がある(辞書が伸び続けない)', () => {
    const c = container();
    const m = new ScrollMemory(c.el);
    for (let i = 0; i < 20; i++) {
      m.use(`k${i}`);
      c.el.scrollTop = 10 + i;
      scrolled(c.el);
    }
    expect(m.peek('k0'), '古い面を捨てていない').toBeUndefined();
    expect(m.peek('k19')).toBe(29);
  });
});
