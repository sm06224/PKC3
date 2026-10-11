/** @vitest-environment happy-dom */
/**
 * 🔴 **予定の面の祝日と土日**(#855。Gemini 裁定 = #1163 の依頼 10)。
 *
 * 祝日の規則そのものは `tests/features/jp-holidays.test.ts`。**ここが見るのは繋がり** ──
 * 小さな月・「週」の列の見出し・「日」の見出しに、印と名前が**実際に付くか**。
 * ⚠ 色が画面で赤く見えるかは CSS の話で、happy-dom では測れない ── `tests/smoke/schedule.smoke.spec.ts` が
 *   実ブラウザの計算後の色を見る。
 */
import { describe, expect, it } from 'vitest';
import { initialState } from '../../src/adapter/state/app-state';
import type { AppState } from '../../src/adapter/state/app-state';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';

const TODAY = new Date(2026, 8, 10); // 2026-09-10

function paint(over: Partial<AppState>): HTMLElement {
  const region = document.createElement('div');
  document.body.append(region);
  new ScheduleRenderer(region, () => TODAY).render({ ...initialState, ...over });
  return region;
}

describe('予定の面の祝日と土日(#855)', () => {
  it('小さな月:土日の見出しに印、祝日の升に印と名前(2026-09 は 21 敬老の日 / 22 国民の休日 / 23 秋分の日)', () => {
    const r = paint({ calendarMonth: { year: 2026, month: 9 } });
    const heads = [...r.querySelectorAll<HTMLElement>('[data-pkc-field="schedule-grid"] > [data-pkc-field="schedule-week"]:first-child > span')];
    expect(heads.map((h) => h.textContent)).toEqual(['日', '月', '火', '水', '木', '金', '土']);
    expect(heads.map((h) => h.hasAttribute('data-pkc-weekend'))).toEqual([
      true, false, false, false, false, false, true,
    ]);
    const holidays = [...r.querySelectorAll<HTMLElement>('button[data-pkc-holiday]')].map((b) => [
      b.getAttribute('data-pkc-drop-date'),
      b.title,
    ]);
    expect(holidays).toEqual([
      ['2026-09-21', '敬老の日'],
      ['2026-09-22', '国民の休日'],
      ['2026-09-23', '秋分の日'],
    ]);
    // 対照群:祝日でない升には印も title も無い
    const plain = r.querySelector<HTMLElement>('button[data-pkc-drop-date="2026-09-24"]')!;
    expect(plain.hasAttribute('data-pkc-holiday')).toBe(false);
    expect(plain.title).toBe('');
  });

  it('「日」:祝日の見出しは印と名前、土日は見出しの行に印', () => {
    const hol = paint({ scheduleMode: 'day', scheduleDay: '2026-09-22' });
    const label = hol.querySelector<HTMLElement>('[data-pkc-field="schedule-day-label"]')!;
    expect(label.hasAttribute('data-pkc-holiday')).toBe(true);
    expect(label.title).toBe('国民の休日');
    const sat = paint({ scheduleMode: 'day', scheduleDay: '2026-09-26' }); // 土曜(祝日ではない)
    expect(sat.querySelector('[data-pkc-field="schedule-day-head"]')!.hasAttribute('data-pkc-weekend')).toBe(true);
    expect(sat.querySelector('[data-pkc-field="schedule-day-label"]')!.hasAttribute('data-pkc-holiday')).toBe(false);
    const wed = paint({ scheduleMode: 'day', scheduleDay: '2026-09-09' }); // 水曜
    expect(wed.querySelector('[data-pkc-field="schedule-day-head"]')!.hasAttribute('data-pkc-weekend')).toBe(false);
  });

  it('「週」:列の見出しに土日・祝日の印(2026-09-20〜26 = 日 月 … 土)', () => {
    const r = paint({ scheduleMode: 'week', scheduleDay: '2026-09-22' });
    const heads = [...r.querySelectorAll<HTMLElement>('[data-pkc-field="schedule-weekview-heads"] > button')];
    expect(heads).toHaveLength(7);
    expect(heads.map((h) => h.hasAttribute('data-pkc-weekend'))).toEqual([
      true, false, false, false, false, false, true,
    ]);
    expect(heads.map((h) => h.getAttribute('title'))).toEqual([
      null, '敬老の日', '国民の休日', '秋分の日', null, null, null,
    ]);
    expect(heads.map((h) => h.hasAttribute('data-pkc-holiday'))).toEqual([
      false, true, true, true, false, false, false,
    ]);
  });
});
