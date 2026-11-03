/** @vitest-environment happy-dom */
/**
 * 選んでいる間のバーを貼り付けてよいかの判定(束 C2 の副作用。実測:一覧 248px・バー 166px で行が覆われた)。
 */
import { describe, expect, it } from 'vitest';
import { barCoversMarked, barFitsSticky, watchBarStick } from '../../src/adapter/ui/render/bar-stick';

describe('barFitsSticky', () => {
  it('バーの 2 倍以上の高さがあるときだけ貼り付ける(境目の両側)', () => {
    expect(barFitsSticky(332, 166)).toBe(true);
    expect(barFitsSticky(331, 166), '2 倍に 1px 足りない').toBe(false);
  });
  it('実測の再現:一覧 248px・バー 166px では貼り付けない', () => {
    expect(barFitsSticky(248, 166)).toBe(false);
  });
  it('高いときは貼り付く(対照群)', () => {
    expect(barFitsSticky(700, 120)).toBe(true);
  });
  it('隠れている面(高さ 0)・バーが 0 でも高さが無ければ貼り付けない', () => {
    expect(barFitsSticky(0, 0)).toBe(false);
  });
});

describe('watchBarStick', () => {
  const make = (view: number, bar: number, bulk: boolean) => {
    const scroller = document.createElement('div');
    const b = document.createElement('div');
    if (bulk) b.setAttribute('data-pkc-bulk', '');
    Object.defineProperty(scroller, 'clientHeight', { value: view });
    Object.defineProperty(b, 'offsetHeight', { value: bar });
    return { scroller, b };
  };
  it('高さが足りて、印があるときだけ data-pkc-bulk-stick を付ける', () => {
    const hi = make(700, 120, true);
    watchBarStick(hi.b, hi.scroller)();
    expect(hi.b.hasAttribute('data-pkc-bulk-stick')).toBe(true);
    const low = make(248, 166, true);
    watchBarStick(low.b, low.scroller)();
    expect(low.b.hasAttribute('data-pkc-bulk-stick'), '低い窓で貼り付く').toBe(false);
    const none = make(700, 120, false);
    watchBarStick(none.b, none.scroller)();
    expect(none.b.hasAttribute('data-pkc-bulk-stick'), '印が無いのに貼り付く').toBe(false);
  });
  it('貼り付く間だけ、一覧に帯の高さの scroll-padding-bottom を付ける(行が帯の下に隠れない)', () => {
    const hi = make(700, 120, true);
    const stop = watchBarStick(hi.b, hi.scroller);
    expect(hi.scroller.style.scrollPaddingBottom).toBe('120px');
    stop();
    expect(hi.scroller.style.scrollPaddingBottom, '観測をやめたら外す').toBe('');
    const low = make(248, 166, true);
    watchBarStick(low.b, low.scroller)();
    expect(low.scroller.style.scrollPaddingBottom).toBe('');
  });
});

describe('貼り付けると印の付いた行を覆うときは貼り付けない(ダブルクリックの 2 回目が帯に落ちる)', () => {
  it('barCoversMarked: 帯の来る帯域(下端から帯の高さ)に掛かる行だけ「覆う」', () => {
    // 見えている下端 700・帯 120 → 帯域は 580〜700
    expect(barCoversMarked([{ top: 600, bottom: 626 }], 700, 120), '帯域の中の行').toBe(true);
    expect(barCoversMarked([{ top: 570, bottom: 596 }], 700, 120), '帯域に半分掛かる行').toBe(true);
    expect(barCoversMarked([{ top: 550, bottom: 580 }], 700, 120), '帯域のすぐ上の行(下端がちょうど帯域の上端)').toBe(false);
    expect(barCoversMarked([{ top: 100, bottom: 126 }], 700, 120), '上のほうの行').toBe(false);
    expect(barCoversMarked([{ top: 720, bottom: 746 }], 700, 120), '画面の外(下)の行').toBe(false);
    expect(barCoversMarked([], 700, 120), '印が無い').toBe(false);
  });

  /** 一覧(高さ 700)・帯(高さ 120・印あり)・印の付いた行 1 本(上端 `rowTop`)。 */
  const board = (rowTop: number) => {
    const scroller = document.createElement('div');
    const table = document.createElement('table');
    table.setAttribute('data-pkc-region', 'filer-table');
    const tr = document.createElement('tr');
    tr.setAttribute('data-pkc-entry', 'f1');
    tr.setAttribute('data-pkc-marked', '');
    table.append(tr);
    const bar = document.createElement('div');
    bar.setAttribute('data-pkc-bulk', '');
    scroller.append(table, bar);
    document.body.append(scroller);
    Object.defineProperty(scroller, 'clientHeight', { value: 700 });
    Object.defineProperty(bar, 'offsetHeight', { value: 120 });
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 700, height: 700 }) as DOMRect;
    let top = rowTop;
    tr.getBoundingClientRect = () => ({ top, bottom: top + 26, height: 26 }) as DOMRect;
    return { scroller, bar, moveRow: (t: number) => (top = t) };
  };

  it('🔴 選んだ行が下のほうにあるときは貼り付けない(帯がその行を覆わない)', () => {
    const t = board(640);
    const stop = watchBarStick(t.bar, t.scroller);
    expect(t.bar.hasAttribute('data-pkc-bulk-stick'), '選んだ行を覆って貼り付いた').toBe(false);
    stop();
    t.scroller.remove();
  });

  it('対照: 選んだ行が上のほうにあれば、これまでどおり貼り付く', () => {
    const t = board(200);
    const stop = watchBarStick(t.bar, t.scroller);
    expect(t.bar.hasAttribute('data-pkc-bulk-stick')).toBe(true);
    stop();
    t.scroller.remove();
  });

  it('送って行が帯域の上へ出たら、次の描画で貼り付く', async () => {
    const t = board(640);
    const stop = watchBarStick(t.bar, t.scroller);
    expect(t.bar.hasAttribute('data-pkc-bulk-stick')).toBe(false);
    t.moveRow(300);
    t.scroller.dispatchEvent(new Event('scroll'));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    expect(t.bar.hasAttribute('data-pkc-bulk-stick'), '送って覆わなくなったのに貼り付かない').toBe(true);
    stop();
    t.scroller.remove();
  });
});
