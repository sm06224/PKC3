/**
 * 🔴 **開いた窓で、予定の見せ方の合図(`sched=week&day=`)を当てる**(#855 段 A-2 の直し)。
 *
 * ⚠ `main.ts` はどの test からも実行されないので、判断(日が無ければ見せ方だけ / 日があれば見せ方 + 日)は
 *   ここに置いて test する(`tests/adapter/schedule-week.test.ts`)。main.ts は呼ぶだけ。
 * 🔑 触るのは広い面の見せ方(`scheduleMode`)と見ている日(`scheduleDay`)だけ ──
 *   左の列の見せ方(`scheduleNarrowMode`)は動かさない。
 */
export interface ScheduleDispatch {
  readonly dispatch: (
    action:
      | { type: 'SET_SCHEDULE_MODE'; mode: 'week' }
      | { type: 'SET_SCHEDULE_DAY'; date: string },
  ) => void;
}

export function applyScheduleDeepLink(
  target: ScheduleDispatch,
  mode: 'week',
  day: string | null,
): void {
  target.dispatch({ type: 'SET_SCHEDULE_MODE', mode });
  // 日が無い合図は「今日に追従する」まま(null を撃たない ── 見ている日を巻き戻さない)
  if (day !== null) target.dispatch({ type: 'SET_SCHEDULE_DAY', date: day });
}
