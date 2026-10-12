/**
 * 🔴 **予定の面の「月」── 1 か月を大きな升目で見る**(#855。Gemini 裁定 = #1163 の依頼 30 の Q1)。
 *
 * 「日」(`schedule-day.ts`)「週」(`schedule-week.ts`)と同じ並びの見せ方。左上の小さな月は**移動の部品のまま**で、
 * 「月」を押すと、時間の目盛りが出る場所(中央)に**大きな升目**が出る。
 *
 * ## 作り
 *
 * | 部分 | 中身 |
 * |---|---|
 * | 見出し | 年月 + ‹ › + 今月 |
 * | 曜日の行 | 日〜土(土日は薄く沈める) |
 * | 1 日の升 | 日付の数字(押すとその日の「日」へ)+ 予定の題名を 3 件まで + 4 件目からは「ほか N 件」 |
 *
 * ## 守ること
 *
 * - 🔑 **札は一覧と同じ札**(`createTaskCard` / `patchTaskCard`)── チェック・開く・掴んで日へ落とす、がそのまま効く。
 *   ⚠ 札の左の縦線の色も同じ口(`patchItemColor`。行のタグの色 > ノートの色)。
 * - 🔴 **落とし先は升全体**(`data-pkc-drop-date`)── 落とすとその日になる。月外の空き枠は落とせない。
 * - 🔑 **何を何件出すかは `features/schedule/month-cells.ts` 1 か所**。
 * - 🔑 **札も升も使い回す**(掴んでいる札を作り直さない)。⚠ 札の鍵は**日を含める**(期間・繰り返しは複数の日に出る)。
 * - 🔴 「ほか N 件」は**押せる**(その日の「日」へ)── 押せない字にして、残りを読む道を断たない。
 */
import type { AgendaItem } from '@features/schedule/agenda';
import { getMonthGrid, dateKey } from '@features/schedule/month-grid';
import { holidayName } from '@features/schedule/jp-holidays';
import { moreLabel, pickCellItems } from '@features/schedule/month-cells';
import { createTaskCard, patchItemColor, patchTaskCard, placeCardInGrid } from './task-card';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

export interface MonthPaint {
  readonly year: number;
  /** 1 始まり。 */
  readonly month: number;
  readonly today: string;
  /** その日に出る予定(`buildAgenda` が展開・並べ替え済み)。 */
  readonly itemsOf: (day: string) => readonly AgendaItem[];
  readonly titleOf: (lid: string) => string;
  readonly selectedLid: string | null;
  readonly thisYear: number;
}

interface Cell {
  readonly box: HTMLElement;
  readonly num: HTMLButtonElement;
  readonly holiday: HTMLElement;
  readonly list: HTMLElement;
  readonly more: HTMLButtonElement;
}

export class ScheduleMonth {
  readonly el: HTMLElement;
  private readonly label: HTMLElement;
  private readonly body: HTMLElement;
  private readonly dropAttr: string;
  private readonly cells = new Map<string, Cell>();
  private readonly cards = new Map<string, { card: HTMLElement; data: AgendaItem }>();
  private shownMonth: string | null = null;

  constructor(dropAttr: string) {
    this.dropAttr = dropAttr;
    const el = document.createElement('div');
    el.setAttribute('data-pkc-region', 'schedule-monthview');
    const head = document.createElement('div');
    head.setAttribute('data-pkc-field', 'schedule-monthview-head');
    // ⚠ 口(`data-pkc-action`)は字で書く(変数で配ると、出口の全数検査が追えない)。
    //   行き先の年月は `ScheduleRenderer.paintMonth` が、小さな月の ‹ › と一緒に焼く(月の送りの規則を 2 つ持たない)
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.setAttribute('data-pkc-action', 'schedule-nav');
    prev.setAttribute('data-pkc-nav-step', '-1');
    prev.setAttribute('aria-label', '前の月');
    prev.textContent = '‹';
    const next = document.createElement('button');
    next.type = 'button';
    next.setAttribute('data-pkc-action', 'schedule-nav');
    next.setAttribute('data-pkc-nav-step', '1');
    next.setAttribute('aria-label', '次の月');
    next.textContent = '›';
    const todayBtn = document.createElement('button');
    todayBtn.type = 'button';
    todayBtn.setAttribute('data-pkc-action', 'schedule-today');
    todayBtn.textContent = '今月に戻る';
    this.label = document.createElement('span');
    this.label.setAttribute('data-pkc-field', 'schedule-monthview-label');
    head.append(prev, this.label, next, todayBtn);

    const weekdays = document.createElement('div');
    weekdays.setAttribute('data-pkc-field', 'schedule-monthview-weekdays');
    WEEKDAYS.forEach((w, i) => {
      const s = document.createElement('span');
      s.textContent = w;
      if (i === 0 || i === 6) s.setAttribute('data-pkc-weekend', '');
      weekdays.append(s);
    });
    this.body = document.createElement('div');
    this.body.setAttribute('data-pkc-field', 'schedule-monthview-body');
    el.append(head, weekdays, this.body);
    this.el = el;
  }

  /** 「月」を離れた(次に入ったとき升を組み直す)。 */
  leave(): void {
    this.shownMonth = null;
  }

  private cellOf(key: string): Cell {
    let c = this.cells.get(key);
    if (c !== undefined) return c;
    const box = document.createElement('div');
    box.setAttribute('data-pkc-field', 'schedule-monthview-cell');
    // 🔴 落とし先は升全体(掴んだ札をここへ落とすと、その日になる)
    box.setAttribute(this.dropAttr, key);
    const num = document.createElement('button');
    num.type = 'button';
    num.setAttribute('data-pkc-action', 'schedule-week-pick');
    num.setAttribute('data-pkc-field', 'schedule-monthview-num');
    const holiday = document.createElement('span');
    holiday.setAttribute('data-pkc-field', 'schedule-monthview-holiday');
    holiday.hidden = true;
    const top = document.createElement('div');
    top.setAttribute('data-pkc-field', 'schedule-monthview-cell-head');
    top.append(num, holiday);
    // ⚠ 札の器は一覧と同じ名前(`schedule-cards`)── 掴む・長押しの判定がこの名前の直下の札を見る
    const list = document.createElement('div');
    list.setAttribute('data-pkc-region', 'schedule-cards');
    list.setAttribute('data-pkc-field', 'schedule-monthview-cards');
    const more = document.createElement('button');
    more.type = 'button';
    more.setAttribute('data-pkc-action', 'schedule-week-pick');
    more.setAttribute('data-pkc-field', 'schedule-monthview-more');
    more.hidden = true;
    box.append(top, list, more);
    c = { box, num, holiday, list, more };
    this.cells.set(key, c);
    return c;
  }

  paint(p: MonthPaint): void {
    const { year, month } = p;
    const label = `${year}年${month}月`;
    if (this.label.textContent !== label) this.label.textContent = label;
    const monthKey = `${year}-${month}`;
    const rebuild = this.shownMonth !== monthKey;
    this.shownMonth = monthKey;

    const weeks = getMonthGrid(year, month);
    const days: string[] = [];
    for (const w of weeks) for (const d of w) if (d !== null) days.push(dateKey(year, month, d));
    // 別の月へ移ったら、使わない升を捨てる
    const wantDays = new Set(days);
    for (const [k, c] of this.cells) {
      if (!wantDays.has(k)) {
        c.box.remove();
        this.cells.delete(k);
      }
    }

    const perDay = days.map((day) => ({ day, picked: pickCellItems(p.itemsOf(day)) }));
    const wantCards = new Set<string>();
    for (const { day, picked } of perDay) for (const i of picked.shown) wantCards.add(`${day} ${i.key}`);
    for (const [k, n] of this.cards) {
      if (!wantCards.has(k)) {
        n.card.remove();
        this.cards.delete(k);
      }
    }

    if (rebuild) {
      this.body.textContent = '';
      for (const w of weeks) {
        const row = document.createElement('div');
        row.setAttribute('data-pkc-field', 'schedule-monthview-week');
        for (const d of w) {
          if (d === null) {
            // ⚠ 月外は空の枠(落とせない)── 落とせるように見せない
            const blank = document.createElement('span');
            blank.setAttribute('data-pkc-field', 'schedule-monthview-blank');
            row.append(blank);
          } else row.append(this.cellOf(dateKey(year, month, d)).box);
        }
        this.body.append(row);
      }
    }

    for (const { day, picked } of perDay) {
      const c = this.cellOf(day);
      const dayNum = String(Number(day.slice(8)));
      if (c.num.textContent !== dayNum) c.num.textContent = dayNum;
      // 空 = 今日に追従する状態へ戻る(「週」の見出しと同じ)
      c.num.setAttribute('data-pkc-day-to', day === p.today ? '' : day);
      c.num.setAttribute('aria-label', `${month}月${dayNum}日を「日」で見る`);
      if (day === p.today) c.box.setAttribute('data-pkc-today', '');
      else c.box.removeAttribute('data-pkc-today');
      const col = new Date(year, month - 1, Number(dayNum)).getDay();
      if (col === 0 || col === 6) c.box.setAttribute('data-pkc-weekend', '');
      else c.box.removeAttribute('data-pkc-weekend');
      const holiday = holidayName(day);
      if (holiday !== null) {
        c.box.setAttribute('data-pkc-holiday', '');
        if (c.holiday.textContent !== holiday) c.holiday.textContent = holiday;
        c.holiday.hidden = false;
      } else {
        c.box.removeAttribute('data-pkc-holiday');
        c.holiday.textContent = '';
        c.holiday.hidden = true;
      }

      let cursor: ChildNode | null = c.list.firstChild;
      for (const item of picked.shown) {
        const key = `${day} ${item.key}`;
        const title = p.titleOf(item.lid);
        let node = this.cards.get(key);
        if (node === undefined) {
          node = { card: createTaskCard(item), data: item };
          this.cards.set(key, node);
          patchTaskCard(node.card, item, title, p.thisYear, false);
        } else if (node.data !== item || node.card.getAttribute('data-pkc-note') !== title) {
          patchTaskCard(node.card, item, title, p.thisYear, false);
          node.data = item;
        }
        patchItemColor(node.card, item);
        placeCardInGrid(node.card, false);
        if (item.lid === p.selectedLid) node.card.setAttribute('data-pkc-selected', '');
        else node.card.removeAttribute('data-pkc-selected');
        if (cursor === node.card) cursor = node.card.nextSibling;
        else c.list.insertBefore(node.card, cursor);
      }

      c.more.hidden = picked.more === 0;
      if (picked.more > 0) {
        const t = moreLabel(picked.more);
        if (c.more.textContent !== t) c.more.textContent = t;
        c.more.setAttribute('data-pkc-day-to', day === p.today ? '' : day);
        c.more.setAttribute('data-pkc-more', String(picked.more));
      }
    }
  }
}
