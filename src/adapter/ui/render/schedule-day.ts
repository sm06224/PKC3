/**
 * 🔴 **予定の面の「日」── 1 日を時間の目盛りに並べる**(#855 段 A-1)。
 *
 * 予定の面(`schedule.ts`)の「一覧 / 日」のうち、「日」の描き手。**札は一覧と同じ札**
 * (`createTaskCard` / `patchTaskCard`)なので、チェック・開く・掴んで日へ落とす、が
 * そのまま効く。ここが足すのは**置き場所**だけである。
 *
 * ## 作り
 *
 * | 部分 | 中身 |
 * |---|---|
 * | 見出し | 日付 + ‹ › + 今日 |
 * | 終日 | 時刻のない予定・期間・ノート 1 件の予定 |
 * | 目盛り | 0:00〜24:00。1 時間の高さは `--day-hour`(`tokens.css`) |
 *
 * 置き場所の計算(重なりの並べ方・30 分の既定・24:00 での切り)は `day-layout.ts`(pure)。
 * ここは**結果を CSS の変数(`--day-start` など)に焼く**だけで、`top` / `height` / `left` /
 * `width` は CSS が決める(1 時間の高さを TS に書かない)。
 *
 * ## 守ること
 *
 * - 🔑 **札も器も使い回す** ── 捨てて作り直すと、掴んでいる札が途中で消える。
 * - 🔴 **落とし先は日全体**(見出し・終日・目盛りの全部)── 落とすとその日になる。
 *   ⚠ 時刻を変える落とし方は、ここでは作らない(別の段)。
 * - 🔑 **最初に見せる位置は、日を変えたときと開いたときの 1 回だけ**(`pendingMin`)。
 *   描き直しのたびに戻すと、読んでいる最中の位置が奪われる。
 */
import type { AgendaItem } from '@features/schedule/agenda';
import {
  DAY_MINUTES,
  dayHeading,
  initialScrollMinutes,
  placeColumns,
  splitDay,
} from '@features/schedule/day-layout';
import { addDays } from '@features/datetime/date-math';
import { createTaskCard, patchTaskCard } from './task-card';

export interface DayPaint {
  /** 見る日(`YYYY-MM-DD`)。 */
  readonly day: string;
  readonly today: string;
  /** その日に出る予定(`buildAgenda` が展開・並べ替え済み)。 */
  readonly items: readonly AgendaItem[];
  readonly titleOf: (lid: string) => string;
  readonly selectedLid: string | null;
  readonly year: number;
  /** 予定の走査が済んだか(済む前は「最初に見せる位置」を確定させない)。 */
  readonly settled: boolean;
}

/** 見出しの ‹ › 今日。⚠ 押し口の名前は字で書く(変数で配ると、出口の全数検査が追えない)。 */
function button(field: string, label: string, aria: string | null): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('data-pkc-action', 'schedule-day-go');
  b.setAttribute('data-pkc-field', field);
  b.textContent = label;
  if (aria !== null) b.setAttribute('aria-label', aria);
  return b;
}

export class ScheduleDay {
  readonly el: HTMLElement;
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly todayBtn: HTMLButtonElement;
  private readonly label: HTMLElement;
  private readonly allDay: HTMLElement;
  private readonly allDayHost: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly lane: HTMLElement;
  private readonly cards = new Map<string, { card: HTMLElement; data: AgendaItem }>();
  private shownDay: string | null = null;
  /** 最初に見せる位置(分)。`null` = 済んでいる。 */
  private pendingMin: number | null = null;

  constructor(dropAttr: string) {
    this.dropAttr = dropAttr;
    const el = document.createElement('div');
    el.setAttribute('data-pkc-region', 'schedule-day');
    const head = document.createElement('div');
    head.setAttribute('data-pkc-field', 'schedule-day-head');
    this.prev = button('schedule-day-prev', '‹', '前の日');
    this.next = button('schedule-day-next', '›', '次の日');
    this.todayBtn = button('schedule-day-today', '今日', null);
    this.label = document.createElement('span');
    this.label.setAttribute('data-pkc-field', 'schedule-day-label');
    head.append(this.prev, this.label, this.next, this.todayBtn);

    this.allDay = document.createElement('div');
    this.allDay.setAttribute('data-pkc-field', 'schedule-day-allday');
    const allDayLabel = document.createElement('span');
    allDayLabel.setAttribute('data-pkc-field', 'schedule-day-allday-label');
    allDayLabel.textContent = '終日';
    // ⚠ 札の器は一覧と同じ名前(`schedule-cards`)── 掴む・長押しの判定がこの名前の直下の札を見る
    this.allDayHost = document.createElement('div');
    this.allDayHost.setAttribute('data-pkc-region', 'schedule-cards');
    this.allDay.append(allDayLabel, this.allDayHost);

    this.scroller = document.createElement('div');
    this.scroller.setAttribute('data-pkc-field', 'schedule-day-scroll');
    const grid = document.createElement('div');
    grid.setAttribute('data-pkc-field', 'schedule-day-grid');
    for (let h = 0; h < 24; h += 1) {
      const row = document.createElement('div');
      row.setAttribute('data-pkc-field', 'schedule-day-hour');
      const t = document.createElement('span');
      t.textContent = `${h}:00`;
      row.append(t);
      grid.append(row);
    }
    this.lane = document.createElement('div');
    this.lane.setAttribute('data-pkc-region', 'schedule-cards');
    this.lane.setAttribute('data-pkc-field', 'schedule-day-lane');
    grid.append(this.lane);
    this.scroller.append(grid);

    el.append(head, this.allDay, this.scroller);
    this.el = el;
    // 🔑 表示が決まってから(隠れていた面が開いたとき)最初の位置を当てる
    if (typeof ResizeObserver !== 'undefined')
      new ResizeObserver(() => this.applyScroll()).observe(this.scroller);
  }

  private readonly dropAttr: string;

  /** 「日」を離れた(次に入ったとき最初の位置をもう一度当てる)。 */
  leave(): void {
    this.shownDay = null;
  }

  paint(p: DayPaint): void {
    const { split, slots } = this.layout(p.items);
    this.el.setAttribute('data-pkc-day', p.day);
    // 🔴 落とし先は日全体 ── 見出しも終日も目盛りも、落とすとこの日になる
    this.el.setAttribute(this.dropAttr, p.day);
    const tomorrow = addDays(p.today, 1) ?? '';
    const heading = dayHeading(p.day, p.today, tomorrow);
    if (this.label.textContent !== heading) this.label.textContent = heading;
    this.prev.setAttribute('data-pkc-day-to', addDays(p.day, -1) ?? p.day);
    this.next.setAttribute('data-pkc-day-to', addDays(p.day, 1) ?? p.day);
    // 空 = 今日(日付が変わったら追従する状態へ戻る)。⚠ 既に今日なら押しても何も起きない
    this.todayBtn.setAttribute('data-pkc-day-to', '');
    this.todayBtn.disabled = p.day === p.today;

    const want = new Set(p.items.map((i) => i.key));
    for (const [key, node] of this.cards) {
      if (!want.has(key)) {
        node.card.remove();
        this.cards.delete(key);
      }
    }
    const cardOf = (item: AgendaItem): HTMLElement => {
      let node = this.cards.get(item.key);
      const title = p.titleOf(item.lid);
      if (node === undefined) {
        node = { card: createTaskCard(item), data: item };
        this.cards.set(item.key, node);
        patchTaskCard(node.card, item, title, p.year, false);
      } else if (node.data !== item || node.card.getAttribute('data-pkc-note') !== title) {
        // ⚠ 日付は札に出さない(見出しに出ている)。時刻は出す
        patchTaskCard(node.card, item, title, p.year, false);
        node.data = item;
      }
      if (item.lid === p.selectedLid) node.card.setAttribute('data-pkc-selected', '');
      else node.card.removeAttribute('data-pkc-selected');
      return node.card;
    };

    // 終日(流れに沿って並ぶので順番を揃える)
    this.allDay.hidden = split.allDay.length === 0;
    let cursor: ChildNode | null = this.allDayHost.firstChild;
    for (const item of split.allDay) {
      const card = cardOf(item);
      card.style.removeProperty('--day-start');
      card.style.removeProperty('--day-span');
      card.style.removeProperty('--day-col');
      card.style.removeProperty('--day-cols');
      if (cursor === card) cursor = card.nextSibling;
      else this.allDayHost.insertBefore(card, cursor);
    }

    // 目盛り(絶対位置なので順番は動かさない ── 掴んでいる札の親を動かさない)
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
      if (card.parentElement !== this.lane) this.lane.append(card);
    }

    // 最初に見せる位置 ── 日を変えたとき / 開いたときの 1 回(走査が済むまでは確定させない)
    if (this.shownDay !== p.day) {
      this.shownDay = p.day;
      this.pendingMin = 0;
    }
    if (this.pendingMin !== null) {
      this.pendingMin = initialScrollMinutes(slots);
      this.applyScroll(p.settled);
    }
  }

  private layout(items: readonly AgendaItem[]): {
    split: ReturnType<typeof splitDay>;
    slots: ReturnType<typeof placeColumns>;
  } {
    const split = splitDay(items);
    return { split, slots: placeColumns(split.timed.map((t) => t.piece)) };
  }

  private settledNow = false;

  /** 見えているときだけ当てる(隠れた面の `scrollTop` は無視される)。 */
  private applyScroll(settled: boolean = this.settledNow): void {
    this.settledNow = settled;
    if (this.pendingMin === null || this.scroller.clientHeight === 0) return;
    this.scroller.scrollTop = (this.scroller.scrollHeight * this.pendingMin) / DAY_MINUTES;
    if (settled) this.pendingMin = null;
  }
}
