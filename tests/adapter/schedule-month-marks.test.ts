/** @vitest-environment happy-dom */
/**
 * 🔴 **小さな月で「いま見ている所」に印を付ける**(#855。Gemini 裁定 = #1163 のコメント 6104130726 の 1・5)。
 *
 * | 見せ方 | 印 |
 * |---|---|
 * | 日 | 見ている日の升目に `data-pkc-viewed`(1 つだけ) |
 * | 週 | 見ている週の行に `data-pkc-viewed-week`(日曜〜土曜の 1 行だけ) |
 * | 一覧 | 無し |
 *
 * ⚠ 色が実際に付くか(計算後のスタイル)は実ブラウザの smoke が見る(`tests/smoke/schedule.smoke.spec.ts`)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';

let region: HTMLElement;
let renderer: ScheduleRenderer;

function show(over: Partial<AppState>): void {
  const base: AppState = { ...initialState, calendarMonth: { year: 2026, month: 10 } };
  renderer.render({ ...base, ...over });
}
const cell = (day: string): HTMLElement =>
  region.querySelector<HTMLElement>(`[data-pkc-field="schedule-week"] > button[data-pkc-drop-date="${day}"]`)!;

beforeEach(() => {
  document.body.innerHTML = '';
  region = document.createElement('div');
  document.body.append(region);
  renderer = new ScheduleRenderer(region, () => new Date(2026, 9, 1));
});

describe('小さな月の「見ている所」', () => {
  it('🔴 「日」で見ている日の升目 1 つに印が付く(広い面)', () => {
    show({ scheduleMode: 'day', scheduleDay: '2026-10-14' });
    const marked = region.querySelectorAll('[data-pkc-viewed]');
    expect(marked.length).toBe(1);
    expect(marked[0]).toBe(cell('2026-10-14'));
    expect(region.querySelector('[data-pkc-viewed-week]'), '日なのに週の帯が出ている').toBeNull();
  });

  it('🔴 日を変えると印が動く(古い升目に残らない)', () => {
    show({ scheduleMode: 'day', scheduleDay: '2026-10-14' });
    show({ scheduleMode: 'day', scheduleDay: '2026-10-20' });
    expect([...region.querySelectorAll('[data-pkc-viewed]')]).toEqual([cell('2026-10-20')]);
  });

  it('🔴 左の列(狭い面)は自分の見せ方 `scheduleNarrowMode` で決める', () => {
    region.setAttribute('data-pkc-browse-pane', 'schedule');
    show({ scheduleMode: 'week', scheduleNarrowMode: 'day', scheduleDay: '2026-10-14' });
    expect([...region.querySelectorAll('[data-pkc-viewed]')]).toEqual([cell('2026-10-14')]);
    expect(region.querySelector('[data-pkc-viewed-week]'), '狭い面は「日」なので週の帯は出ない').toBeNull();
  });

  it('🔴 「週」は見ている週の行(日曜〜土曜)だけに帯が付き、升目の印は付かない', () => {
    show({ scheduleMode: 'week', scheduleDay: '2026-10-14' }); // 水曜 → 10/11〜10/17
    const rows = region.querySelectorAll('[data-pkc-viewed-week]');
    expect(rows.length).toBe(1);
    const days = [...rows[0]!.querySelectorAll('button')].map((b) => b.getAttribute('data-pkc-drop-date'));
    expect(days).toEqual(['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
    expect(region.querySelector('[data-pkc-viewed]'), '週なのに日の升目が印されている').toBeNull();
  });

  it('週の途中で月が替わる行でも、その月の側の升目を含む行に帯が付く', () => {
    show({ scheduleMode: 'week', scheduleDay: '2026-10-01' }); // 木曜 → 9/27〜10/3、10 月の 1 行目は 10/1〜10/3 だけ
    const rows = region.querySelectorAll('[data-pkc-viewed-week]');
    expect(rows.length).toBe(1);
    expect(rows[0]!.querySelector('[data-pkc-drop-date="2026-10-01"]')).not.toBeNull();
  });

  it('一覧には印が付かない', () => {
    show({ scheduleMode: 'list', scheduleDay: '2026-10-14' });
    expect(region.querySelector('[data-pkc-viewed]')).toBeNull();
    expect(region.querySelector('[data-pkc-viewed-week]')).toBeNull();
  });
});
