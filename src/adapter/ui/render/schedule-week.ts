/**
 * 🔴 **予定の面の「週」── 7 日を時間の目盛りに並べる**(#855 段 A-2)。
 *
 * 「日」(`schedule-day.ts`)を 7 列に並べた見せ方。**置き場所の計算も札も「日」と同じ物**
 * (`splitDay` / `placeColumns` / `createTaskCard` / `patchTaskCard`)── ここが足すのは
 * **7 列の器**だけで、繰り返し・期間の規則は持たない(1 日ぶんの束は呼び側が `buildAgenda` で作る)。
 *
 * ## 広い面だけ
 *
 * 左の列は狭く、7 列を並べると 1 日が読めなくなる。だから「週」は**広い面(中央 / 別のウィンドウ)**
 * だけで描き、左の列の「週」は別のウィンドウで開く(`binder.ts` の `schedule-mode`)。
 *
 * ## 作り
 *
 * | 部分 | 中身 |
 * |---|---|
 * | 見出し | 週の範囲 + ‹ › + 今週 |
 * | 曜日の見出し | 7 つのボタン。押すとその日の「日」へ |
 * | 終日 | 7 つの升(時刻のない予定・期間・ノート 1 件の予定) |
 * | 目盛り | 0:00〜24:00 + 7 つの列(1 時間の高さは `--day-hour`) |
 *
 * ## 守ること
 *
 * - 🔑 **札も器も使い回す**(掴んでいる札を作り直さない)。⚠ 札の鍵は**日を含める**
 *   (同じ予定が複数の日に出る ── 期間・繰り返し ── ので、日が違えば別の札)。
 * - 🔴 **落とし先は列全体**(曜日の見出し・終日の升・目盛りの列の全部)── 落とすとその日になる。
 *   ⚠ 時刻を変える落とし方は作らない(「日」と同じ ── 別の段)。
 * - 🔑 **最初に見せる位置は、週を変えたときと開いたときの 1 回だけ**(`pendingMin`)。
 */
import type { AgendaItem } from '@features/schedule/agenda';
import {
  DAY_MINUTES,
  initialScrollMinutes,
  placeColumns,
  splitDay,
  weekColumnLabel,
  weekHeading,
  type DaySlot,
} from '@features/schedule/day-layout';
import { createTaskCard, patchTaskCard } from './task-card';

export interface WeekPaint {
  /** 見せる 7 日(`YYYY-MM-DD`。日曜始まり)。 */
  readonly days: readonly string[];
  readonly today: string;
  /** 1 日ぶんの予定(`buildAgenda` が展開・並べ替え済み)。 */
  readonly itemsOf: (day: string) => readonly AgendaItem[];
  readonly titleOf: (lid: string) => string;
  readonly selectedLid: string | null;
  readonly year: number;
  /** 予定の走査が済んだか(済む前は「最初に見せる位置」を確定させない)。 */
  readonly settled: boolean;
  /** ‹ › 今週の行き先(空 = 今日に追従する状態へ戻る)。 */
  readonly prevTo: string;
  readonly nextTo: string;
  /** いま見せている週が今日を含むか(今週ボタンを押せなくする)。 */
  readonly isThisWeek: boolean;
}

/** 見出しの ‹ › 今週。⚠ 押し口の名前は字で書く(変数で配ると、出口の全数検査が追えない)。 */
function goButton(field: string, label: string, aria: string | null): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('data-pkc-action', 'schedule-day-go');
  b.setAttribute('data-pkc-field', field);
  b.textContent = label;
  if (aria !== null) b.setAttribute('aria-label', aria);
  return b;
}

interface Column {
  readonly head: HTMLButtonElement;
  readonly weekday: HTMLElement;
  readonly date: HTMLElement;
  readonly allDay: HTMLElement;
  readonly lane: HTMLElement;
}

export class ScheduleWeek {
  readonly el: HTMLElement;
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly todayBtn: HTMLButtonElement;
  private readonly label: HTMLElement;
  private readonly allDayRow: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly columns: Column[] = [];
  private readonly cards = new Map<string, { card: HTMLElement; data: AgendaItem }>();
  private shownWeek: string | null = null;
  /** 最初に見せる位置(分)。`null` = 済んでいる。 */
  private pendingMin: number | null = null;
  private settledNow = false;
  /** こちらが最後に当てた位置(user が自分で送ったかを見分ける)。 */
  private lastSetTop: number | null = null;
  private readonly dropAttr: string;

  constructor(dropAttr: string) {
    this.dropAttr = dropAttr;
    const el = document.createElement('div');
    el.setAttribute('data-pkc-region', 'schedule-weekview');
    const head = document.createElement('div');
    head.setAttribute('data-pkc-field', 'schedule-weekview-head');
    this.prev = goButton('schedule-weekview-prev', '‹', '前の週');
    this.next = goButton('schedule-weekview-next', '›', '次の週');
    this.todayBtn = goButton('schedule-weekview-today', '今週', null);
    this.label = document.createElement('span');
    this.label.setAttribute('data-pkc-field', 'schedule-weekview-label');
    head.append(this.prev, this.label, this.next, this.todayBtn);

    // 幅が足りないときは横に動く(列の幅に下限を置く ── 7 日が読めなくなるより動かす)
    const wrap = document.createElement('div');
    wrap.setAttribute('data-pkc-field', 'schedule-weekview-wrap');
    const inner = document.createElement('div');
    inner.setAttribute('data-pkc-field', 'schedule-weekview-inner');

    const heads = document.createElement('div');
    heads.setAttribute('data-pkc-field', 'schedule-weekview-heads');
    heads.append(document.createElement('span'));
    this.allDayRow = document.createElement('div');
    this.allDayRow.setAttribute('data-pkc-field', 'schedule-weekview-allday');
    const allDayLabel = document.createElement('span');
    allDayLabel.setAttribute('data-pkc-field', 'schedule-weekview-allday-label');
    allDayLabel.textContent = '終日';
    this.allDayRow.append(allDayLabel);

    this.scroller = document.createElement('div');
    this.scroller.setAttribute('data-pkc-field', 'schedule-weekview-scroll');
    const grid = document.createElement('div');
    grid.setAttribute('data-pkc-field', 'schedule-weekview-grid');
    for (let h = 0; h < 24; h += 1) {
      const row = document.createElement('div');
      row.setAttribute('data-pkc-field', 'schedule-weekview-hour');
      const t = document.createElement('span');
      t.textContent = `${h}:00`;
      row.append(t);
      grid.append(row);
    }
    const lanes = document.createElement('div');
    lanes.setAttribute('data-pkc-field', 'schedule-weekview-lanes');
    for (let i = 0; i < 7; i += 1) {
      const headBtn = document.createElement('button');
      headBtn.type = 'button';
      headBtn.setAttribute('data-pkc-action', 'schedule-week-pick');
      const weekday = document.createElement('span');
      weekday.setAttribute('data-pkc-field', 'schedule-weekview-weekday');
      const date = document.createElement('span');
      date.setAttribute('data-pkc-field', 'schedule-weekview-date');
      headBtn.append(weekday, date);
      heads.append(headBtn);

      // ⚠ 札の器は一覧と同じ名前(`schedule-cards`)── 掴む・長押しの判定がこの名前の直下の札を見る
      const allDay = document.createElement('div');
      allDay.setAttribute('data-pkc-region', 'schedule-cards');
      allDay.setAttribute('data-pkc-field', 'schedule-weekview-allday-cell');
      this.allDayRow.append(allDay);

      const lane = document.createElement('div');
      lane.setAttribute('data-pkc-region', 'schedule-cards');
      lane.setAttribute('data-pkc-field', 'schedule-weekview-lane');
      lanes.append(lane);
      this.columns.push({ head: headBtn, weekday, date, allDay, lane });
    }
    grid.append(lanes);
    this.scroller.append(grid);
    inner.append(heads, this.allDayRow, this.scroller);
    wrap.append(inner);
    el.append(head, wrap);
    this.el = el;
    // 🔑 表示が決まってから(隠れていた面が開いたとき)最初の位置を当てる。
    // ⚠ 外さない(disconnect しない)── 描画器(`ScheduleRenderer`)と同じ寿命で、面ごとに 1 度だけ作られる
    if (typeof ResizeObserver !== 'undefined')
      new ResizeObserver(() => this.applyScroll()).observe(this.scroller);
    // 🔴 user が自分で送ったら、最初の位置はもう当てない(走査が済む前の描き直しで位置を奪い返さない)
    this.scroller.addEventListener('scroll', () => {
      if (this.pendingMin === null || this.lastSetTop === null) return;
      if (Math.abs(this.scroller.scrollTop - this.lastSetTop) > 1) this.pendingMin = null;
    });
  }

  /** 「週」を離れた(次に入ったとき最初の位置をもう一度当てる)。 */
  leave(): void {
    this.shownWeek = null;
  }

  paint(p: WeekPaint): void {
    const first = p.days[0] ?? '';
    this.el.setAttribute('data-pkc-week', first);
    const heading = weekHeading(p.days, p.today);
    if (this.label.textContent !== heading) this.label.textContent = heading;
    this.prev.setAttribute('data-pkc-day-to', p.prevTo);
    this.next.setAttribute('data-pkc-day-to', p.nextTo);
    // 空 = 今日に追従する状態へ戻る。⚠ 既にこの週なら押しても何も起きない
    this.todayBtn.setAttribute('data-pkc-day-to', '');
    this.todayBtn.disabled = p.isThisWeek;

    const perDay = p.days.map((day) => ({ day, items: p.itemsOf(day) }));
    const want = new Set<string>();
    for (const { day, items } of perDay) for (const i of items) want.add(`${day} ${i.key}`);
    for (const [key, node] of this.cards) {
      if (!want.has(key)) {
        node.card.remove();
        this.cards.delete(key);
      }
    }

    const allSlots: DaySlot[] = [];
    perDay.forEach(({ day, items }, idx) => {
      const col = this.columns[idx]!;
      // 🔴 落とし先は列全体 ── 見出しも終日も目盛りも、落とすとこの日になる
      for (const target of [col.head, col.allDay, col.lane]) target.setAttribute(this.dropAttr, day);
      col.head.setAttribute('data-pkc-day-to', day === p.today ? '' : day);
      if (day === p.today) col.head.setAttribute('data-pkc-today', '');
      else col.head.removeAttribute('data-pkc-today');
      const label = weekColumnLabel(day);
      if (col.weekday.textContent !== label.weekday) col.weekday.textContent = label.weekday;
      if (col.date.textContent !== label.date) col.date.textContent = label.date;
      col.head.setAttribute('aria-label', `${label.date}(${label.weekday})を「日」で見る`);

      const cardOf = (item: AgendaItem): HTMLElement => {
        const key = `${day} ${item.key}`;
        let node = this.cards.get(key);
        const title = p.titleOf(item.lid);
        if (node === undefined) {
          node = { card: createTaskCard(item), data: item };
          this.cards.set(key, node);
          patchTaskCard(node.card, item, title, p.year, false);
        } else if (node.data !== item || node.card.getAttribute('data-pkc-note') !== title) {
          patchTaskCard(node.card, item, title, p.year, false);
          node.data = item;
        }
        if (item.lid === p.selectedLid) node.card.setAttribute('data-pkc-selected', '');
        else node.card.removeAttribute('data-pkc-selected');
        return node.card;
      };

      const split = splitDay(items);
      // 終日(流れに沿って並ぶので順番を揃える)
      let cursor: ChildNode | null = col.allDay.firstChild;
      for (const item of split.allDay) {
        const card = cardOf(item);
        card.style.removeProperty('--day-start');
        card.style.removeProperty('--day-span');
        card.style.removeProperty('--day-col');
        card.style.removeProperty('--day-cols');
        if (cursor === card) cursor = card.nextSibling;
        else col.allDay.insertBefore(card, cursor);
      }
      // 目盛り(絶対位置なので順番は動かさない ── 掴んでいる札の親を動かさない)
      const slots = placeColumns(split.timed.map((t) => t.piece));
      allSlots.push(...slots);
      const slotOf = new Map(slots.map((s) => [s.key, s]));
      for (const { item } of split.timed) {
        const card = cardOf(item);
        const s = slotOf.get(item.key)!;
        const set = (k: string, v: number): void => {
          if (card.style.getPropertyValue(k) !== String(v)) card.style.setProperty(k, String(v));
        };
        set('--day-start', s.startMin);
        set('--day-span', s.endMin - s.startMin);
        set('--day-col', s.col);
        set('--day-cols', s.cols);
        if (card.parentElement !== col.lane) col.lane.append(card);
      }
    });
    this.allDayRow.hidden = perDay.every(({ items }) => splitDay(items).allDay.length === 0);

    // 最初に見せる位置 ── 週を変えたとき / 開いたときの 1 回(走査が済むまでは確定させない)
    if (this.shownWeek !== first) {
      this.shownWeek = first;
      this.pendingMin = 0;
    }
    if (this.pendingMin !== null) {
      this.pendingMin = initialScrollMinutes(allSlots);
      this.applyScroll(p.settled);
    }
  }

  /** 見えているときだけ当てる(隠れた面の `scrollTop` は無視される)。 */
  private applyScroll(settled: boolean = this.settledNow): void {
    this.settledNow = settled;
    if (this.pendingMin === null || this.scroller.clientHeight === 0) return;
    this.scroller.scrollTop = (this.scroller.scrollHeight * this.pendingMin) / DAY_MINUTES;
    this.lastSetTop = this.scroller.scrollTop;
    if (settled) this.pendingMin = null;
  }
}
