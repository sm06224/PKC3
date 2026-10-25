/**
 * 🔴 **予定表の「カンバン」── 状態を列に並べる**(#277。user 指示 2026-08-19「カンバンとカレンダーを復活」)。
 *
 * 「日」「週」「月」と同じ並びの見せ方で、**別ウィンドウの予定表**にだけ出る(左の列は幅が無い)。
 * 列は 2 つ ── **未完了 / 完了**。札は「日付付きのチェック項目」(何を札にするかは `features/schedule/board.ts`)。
 *
 * ## 掴んで列の間を動かすと、本文の `[ ]`↔`[x]` が切り替わる
 *
 * - 🔑 札は一覧と同じ札(`createTaskCard` / `patchTaskCard`)── 印を押す・開く・掴む、がそのまま効く。
 * - 🔴 **落とし先は列全体**(`data-pkc-drop-status` = `open` / `done`)。落とした後の書換は
 *   `schedule-drag.ts` の `dropTaskToStatus` が**札の印を押す**のと同じ道(`toggle-task`)に乗せる ──
 *   書換の門(編集中の断り・別のタブの編集・押した時点の行の照合)も「元に戻す」も**1 本のまま**。
 * - ⚠ 札の器の名前は一覧と同じ `schedule-cards`(掴む・長押しの判定がこの名前の直下の札を見る)。
 */
import type { AgendaItem } from '@features/schedule/agenda';
import { buildBoard } from '@features/schedule/board';
import { createTaskCard, patchItemColor, patchTaskCard, placeCardInGrid } from './task-card';

export interface BoardPaint {
  readonly items: readonly AgendaItem[];
  readonly titleOf: (lid: string) => string;
  readonly selectedLid: string | null;
  readonly thisYear: number;
  /** 予定を集め終えているか(`false` の間は「ありません」と言わない)。 */
  readonly settled: boolean;
}

/** 落とし先の列の印。⚠ 綴りはここ 1 か所(落とす側は import する)。 */
export const DROP_STATUS_ATTR = 'data-pkc-drop-status';

interface Column {
  readonly box: HTMLElement;
  readonly head: HTMLElement;
  readonly list: HTMLElement;
  readonly more: HTMLElement;
}

export class ScheduleBoard {
  readonly el: HTMLElement;
  private readonly note: HTMLElement;
  private readonly open: Column;
  private readonly done: Column;
  private readonly cards = new Map<string, { card: HTMLElement; data: AgendaItem }>();

  constructor() {
    const el = document.createElement('div');
    el.setAttribute('data-pkc-region', 'schedule-board');
    el.setAttribute('data-pkc-field', 'schedule-board');
    this.note = document.createElement('p');
    this.note.setAttribute('data-pkc-field', 'schedule-board-note');
    const cols = document.createElement('div');
    cols.setAttribute('data-pkc-field', 'schedule-board-columns');
    this.open = this.column('open', '未完了');
    this.done = this.column('done', '完了');
    cols.append(this.open.box, this.done.box);
    el.append(this.note, cols);
    this.el = el;
  }

  private column(status: 'open' | 'done', label: string): Column {
    const box = document.createElement('section');
    box.setAttribute('data-pkc-field', 'schedule-board-column');
    box.setAttribute('data-pkc-board-status', status);
    // 🔴 落とし先は列全体(掴んだ札をここへ落とすと、その状態になる)
    box.setAttribute(DROP_STATUS_ATTR, status);
    const head = document.createElement('h3');
    head.setAttribute('data-pkc-field', 'schedule-board-head');
    head.textContent = label;
    const list = document.createElement('div');
    list.setAttribute('data-pkc-region', 'schedule-cards');
    list.setAttribute('data-pkc-field', 'schedule-board-cards');
    const more = document.createElement('p');
    more.setAttribute('data-pkc-field', 'schedule-board-more');
    more.hidden = true;
    box.append(head, list, more);
    return { box, head, list, more };
  }

  /** 「カンバン」を離れた(札は使い回すので捨てない)。 */
  leave(): void {}

  paint(p: BoardPaint): void {
    const b = buildBoard(p.items);
    const want = new Set<string>();
    for (const i of [...b.open, ...b.done]) want.add(i.key);
    for (const [k, n] of this.cards) {
      if (!want.has(k)) {
        n.card.remove();
        this.cards.delete(k);
      }
    }
    this.fill(this.open, b.open, b.openMore, '未完了', p);
    this.fill(this.done, b.done, b.doneMore, '完了', p);
    const parts: string[] = [];
    if (!p.settled) parts.push('予定を集めています…');
    else if (b.open.length + b.done.length === 0)
      parts.push('日付付きのチェック項目(- [ ] やること @2026-10-30)がまだありません。書くとカードになって、ここに並びます');
    else parts.push('カードを反対の列へドラッグすると、本文のチェック([ ] と [x])が切り替わります');
    if (b.skipped > 0)
      parts.push(`繰り返しの予定 ${b.skipped} 件は、ここには出しません(一覧・日・週・月で扱えます)`);
    const text = parts.join('。');
    if (this.note.textContent !== text) this.note.textContent = text;
  }

  private fill(
    col: Column,
    items: readonly AgendaItem[],
    more: number,
    label: string,
    p: BoardPaint,
  ): void {
    const head = `${label}(${items.length + more})`;
    if (col.head.textContent !== head) col.head.textContent = head;
    let cursor: ChildNode | null = col.list.firstChild;
    for (const item of items) {
      const title = p.titleOf(item.lid);
      let node = this.cards.get(item.key);
      if (node === undefined) {
        node = { card: createTaskCard(item), data: item };
        this.cards.set(item.key, node);
        patchTaskCard(node.card, item, title, p.thisYear, true);
      } else if (node.data !== item || node.card.getAttribute('data-pkc-note') !== title) {
        patchTaskCard(node.card, item, title, p.thisYear, true);
        node.data = item;
      }
      patchItemColor(node.card, item);
      placeCardInGrid(node.card, false);
      if (item.lid === p.selectedLid) node.card.setAttribute('data-pkc-selected', '');
      else node.card.removeAttribute('data-pkc-selected');
      if (cursor === node.card) cursor = node.card.nextSibling;
      else col.list.insertBefore(node.card, cursor);
    }
    // 札が減った分の余りは、使い回しの掃除(上の `want`)で既に外れている
    col.more.hidden = more === 0;
    if (more > 0) {
      const t = `ほか ${more} 件(上限のため出していません。予定表の「一覧」で全部見られます)`;
      if (col.more.textContent !== t) col.more.textContent = t;
    }
  }
}
