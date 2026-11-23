import { describe, expect, it } from 'vitest';
import { computePopoverPlacement } from '../../src/features/status/popover-placement';

const vp = { width: 1440, height: 900 };
const size = { width: 380, height: 300 };

describe('computePopoverPlacement ── 簡易メッセージ履歴の置き場所', () => {
  it('🔴 左のバーの下のほうの入口は、右へ開き、下端を入口の下端へ揃える', () => {
    const anchor = { left: 4, top: 860, right: 36, bottom: 892 };
    const p = computePopoverPlacement({ anchor, size, viewport: vp });
    expect(p.side).toBe('right');
    expect(p.x).toBe(36 + 8);
    expect(p.y).toBe(892 - 300);
  });
  it('上のほうの入口は、上端を揃える', () => {
    const p = computePopoverPlacement({ anchor: { left: 4, top: 20, right: 36, bottom: 52 }, size, viewport: vp });
    expect(p.y).toBe(20);
  });
  it('🔴 右に収まらない幅(スマホの上の帯)は、下へ・右端を入口の右端へ揃え、画面内へ収める', () => {
    const anchor = { left: 330, top: 2, right: 362, bottom: 34 };
    const p = computePopoverPlacement({ anchor, size: { width: 374, height: 300 }, viewport: { width: 390, height: 844 } });
    expect(p.side).toBe('bottom');
    expect(p.x).toBeGreaterThanOrEqual(8);
    expect(p.x + 374).toBeLessThanOrEqual(390 - 8 + 0.0001);
    expect(p.y).toBe(34 + 8);
  });
  it('下半分の入口で右に収まらないときは上へ', () => {
    const p = computePopoverPlacement({ anchor: { left: 300, top: 780, right: 332, bottom: 812 }, size, viewport: { width: 390, height: 844 } });
    expect(p.side).toBe('top');
    expect(p.y).toBe(780 - 8 - 300);
  });
  it('どの置き方でも画面内へ収める(はみ出さない)', () => {
    const p = computePopoverPlacement({ anchor: { left: 4, top: 700, right: 36, bottom: 890 }, size: { width: 380, height: 880 }, viewport: { width: 1440, height: 900 } });
    expect(p.y).toBeGreaterThanOrEqual(8);
    expect(p.y + 880).toBeLessThanOrEqual(900 - 8 + 0.0001);
  });
});
