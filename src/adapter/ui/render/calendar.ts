/**
 * calendar の描画(P3-6)。月グリッド + 日付セル内の todo リスト。
 * 指紋: (entryMetas, calendarMonth, showArchived, selectedLid)。月の再構築は
 * O(表示分)(セル数 + 当月 todo 数)なので、変化時はグリッドごと作り直す
 * (kanban / sidebar のような常時 patch 対象ではない)。body は読まない。
 */
import type { EntryMeta } from '@core/model/entry-meta';
import type { AppState } from '@adapter/state/app-state';
import {
  groupTodosByDate,
  getMonthGrid,
  dateKey,
} from '@features/calendar/calendar-data';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

export class CalendarRenderer {
  private readonly region: HTMLElement;
  private readonly now: () => Date;
  private lastMetas: ReadonlyMap<string, EntryMeta> | null = null;
  private lastMonth: AppState['calendarMonth'] = null;
  private lastShowArchived: boolean | null = null;
  private lastSelected: string | null = null;

  /** now は test 注入用(既定は実時刻)。 */
  constructor(region: HTMLElement, now: () => Date = () => new Date()) {
    this.region = region;
    this.now = now;
  }

  render(state: AppState): void {
    if (
      state.entryMetas === this.lastMetas &&
      state.calendarMonth === this.lastMonth &&
      state.showArchived === this.lastShowArchived &&
      state.selectedLid === this.lastSelected
    )
      return;
    this.lastMetas = state.entryMetas;
    this.lastMonth = state.calendarMonth;
    this.lastShowArchived = state.showArchived;
    this.lastSelected = state.selectedLid;

    const today = this.now();
    const year = state.calendarMonth?.year ?? today.getFullYear();
    const month = state.calendarMonth?.month ?? today.getMonth() + 1;

    // kanban と同じく state.order 順で組む(Map 挿入順に依存しない ── review #8)
    const metas: EntryMeta[] = [];
    for (const lid of state.order) {
      const m = state.entryMetas.get(lid);
      if (m) metas.push(m);
    }
    const byDate = groupTodosByDate(metas, state.showArchived);

    this.region.textContent = '';

    const bar = document.createElement('div');
    bar.setAttribute('data-pkc-field', 'calendar-toolbar');
    // 遷移先は描画時に焼き込む ── binder に「今表示している月」の別ソース
    // (実時刻)を持たせない(reducer が 0 / 13 を正規化する)
    const navButton = (label: string, toMonth: number): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-pkc-action', 'calendar-nav');
      b.setAttribute('data-pkc-nav-year', String(year));
      b.setAttribute('data-pkc-nav-month', String(toMonth));
      b.textContent = label;
      return b;
    };
    const prev = navButton('‹', month - 1);
    const label = document.createElement('span');
    label.setAttribute('data-pkc-field', 'calendar-month');
    label.setAttribute('data-pkc-month', `${year}-${String(month).padStart(2, '0')}`);
    label.textContent = `${year}年${month}月`;
    const next = navButton('›', month + 1);
    const todayBtn = document.createElement('button');
    todayBtn.type = 'button';
    todayBtn.setAttribute('data-pkc-action', 'calendar-today');
    todayBtn.textContent = '今月';
    const archivedLabel = document.createElement('label');
    const archived = document.createElement('input');
    archived.type = 'checkbox';
    archived.checked = state.showArchived;
    archived.setAttribute('data-pkc-action', 'toggle-show-archived');
    archivedLabel.append(archived, document.createTextNode(' archived も表示'));
    bar.append(prev, label, next, todayBtn, archivedLabel);
    this.region.append(bar);

    const table = document.createElement('table');
    table.setAttribute('data-pkc-region', 'calendar-grid');
    const thead = document.createElement('thead');
    const hrow = document.createElement('tr');
    for (const wd of WEEKDAYS) {
      const th = document.createElement('th');
      th.textContent = wd;
      hrow.append(th);
    }
    thead.append(hrow);
    const tbody = document.createElement('tbody');
    for (const week of getMonthGrid(year, month)) {
      const tr = document.createElement('tr');
      for (const day of week) {
        const td = document.createElement('td');
        if (day !== null) {
          const key = dateKey(year, month, day);
          td.setAttribute('data-pkc-date', key);
          const num = document.createElement('div');
          num.setAttribute('data-pkc-field', 'day-number');
          num.textContent = String(day);
          td.append(num);
          for (const meta of byDate[key] ?? []) {
            const item = document.createElement('div');
            item.setAttribute('data-pkc-entry', meta.lid);
            item.setAttribute('data-pkc-action', 'select-entry');
            item.setAttribute('data-pkc-todo-status', meta.status ?? 'open');
            if (meta.archived) item.setAttribute('data-pkc-archived', '');
            if (meta.lid === state.selectedLid)
              item.setAttribute('data-pkc-selected', '');
            item.textContent = meta.title;
            td.append(item);
          }
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    this.region.append(table);
  }
}
