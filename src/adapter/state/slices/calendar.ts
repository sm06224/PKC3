/**
 * reducer の slice: 予定表の表示設定(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceCalendar` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import {
  type AppState,
  type Dispatchable,
  type ReduceResult,
  blockedWithSuffix,
  bodyWriteBlockReason,
} from '../app-state';
import { isRealCalendarDate } from '@features/schedule/schedule-date';

export type CalendarAction = Extract<Dispatchable, { type: 'SET_CALENDAR_MONTH' | 'SET_SCHEDULE_MODE' | 'SET_SCHEDULE_NARROW_MODE' | 'SET_SCHEDULE_DAY' | 'TOGGLE_SHOW_ARCHIVED' | 'TOGGLE_SHOW_DONE_TASKS' | 'SET_ENTRY_OWNER' | 'SET_SCHEDULE_OWNER' | 'TOGGLE_SHOW_UNDATED_TASKS' | 'TOGGLE_SCHEDULE_NOTE' }>;

export function reduceCalendar(state: AppState, action: CalendarAction): ReduceResult {
  switch (action.type) {
    case 'SET_CALENDAR_MONTH': {
      // 月送りの正規化(binder は 0 や 13 を送ってよい)
      let { year, month } = action;
      if (month < 1) {
        year -= 1;
        month = 12;
      } else if (month > 12) {
        year += 1;
        month = 1;
      }
      return { state: { ...state, calendarMonth: { year, month } }, events: [] };
    }
    case 'SET_SCHEDULE_MODE':
      return { state: { ...state, scheduleMode: action.mode }, events: [] };
    case 'SET_SCHEDULE_NARROW_MODE':
      return { state: { ...state, scheduleNarrowMode: action.mode }, events: [] };
    case 'SET_SCHEDULE_DAY': {
      // ⚠ 今日に戻るときは小さな月も今月へ戻す(日と月が別の場所を指したままにしない)
      if (action.date === null)
        return { state: { ...state, scheduleDay: null, calendarMonth: null }, events: [] };
      if (!isRealCalendarDate(action.date)) return { state, events: [] };
      // 🔑 見ている日の月を小さな月も映す(‹ › で月をまたいだとき、升目が置いて行かれない)
      return {
        state: {
          ...state,
          scheduleDay: action.date,
          calendarMonth: {
            year: Number(action.date.slice(0, 4)),
            month: Number(action.date.slice(5, 7)),
          },
        },
        events: [],
      };
    }
    case 'TOGGLE_SHOW_ARCHIVED':
      return { state: { ...state, showArchived: !state.showArchived }, events: [] };
    case 'TOGGLE_SHOW_DONE_TASKS':
      // ⚠ 選択も走査も動かさない ── 見え方だけを変える
      return { state: { ...state, showDoneTasks: !state.showDoneTasks }, events: [] };
    case 'SET_ENTRY_OWNER': {
      const blocked = bodyWriteBlockReason(state, action.lid);
      if (blocked !== null)
        return {
          state: {
            ...state,
            error: blockedWithSuffix(blocked, action.owner === null ? '担当を外してください' : '担当を付けてください'),
          },
          events: [],
        };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      const owner = action.owner === null ? null : action.owner.replace(/\s+/g, ' ').trim();
      if (owner === '') return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            // ⚠ 書換は既存の `frontmatter` 1 本(鍵を足す / 書き換える / `undefined` で消す)── 新しい書込経路を作らない
            rewrite: { kind: 'frontmatter', keys: { owner: owner ?? undefined } },
          },
        ],
      };
    }
    case 'SET_SCHEDULE_OWNER':
      return state.scheduleOwner === action.owner
        ? { state, events: [] }
        : { state: { ...state, scheduleOwner: action.owner }, events: [] };
    case 'TOGGLE_SHOW_UNDATED_TASKS':
      /**
       * ⚠ **走査を頼み直さない**(2026-08-23)── 日付の無い札も `taskScan` に
       *   載っているので、切替は**描画側の絞り**だけで済む。
       * 🔑 頼み直す形にすると、押すたびに worker を叩き、しかも
       *   **戻ってくるまで盤面が空になる**(押した手応えが消える)。
       */
      return { state: { ...state, showUndatedTasks: !state.showUndatedTasks }, events: [] };
    case 'TOGGLE_SCHEDULE_NOTE': {
      // ⚠ 走査は頼み直さない(隠すのは描画側の絞り)。選択も動かさない
      const hidden = state.scheduleHiddenNotes;
      return {
        state: {
          ...state,
          scheduleHiddenNotes: hidden.includes(action.lid)
            ? hidden.filter((l) => l !== action.lid)
            : [...hidden, action.lid],
        },
        events: [],
      };
    }
  }
}
