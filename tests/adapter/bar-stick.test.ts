/** @vitest-environment happy-dom */
/**
 * 選んでいる間のバーを貼り付けてよいかの判定(束 C2 の副作用。実測:一覧 248px・バー 166px で行が覆われた)。
 */
import { describe, expect, it } from 'vitest';
import { barFitsSticky, watchBarStick } from '../../src/adapter/ui/render/bar-stick';

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
});
