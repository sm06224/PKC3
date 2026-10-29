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
import { buildBoard, buildSignalBoard, type SignalColor } from '@features/schedule/board';
import { createTaskCard, patchItemColor, patchTaskCard, placeCardInGrid } from './task-card';

export interface BoardPaint {
  readonly items: readonly AgendaItem[];
  readonly titleOf: (lid: string) => string;
  readonly selectedLid: string | null;
  readonly thisYear: number;
  /** 予定を集め終えているか(`false` の間は「ありません」と言わない)。 */
  readonly settled: boolean;
  /** 今日(`YYYY-MM-DD`)。信号機の列で期限切れ・3 日以内を決める。⚠ 内部で時計を読まない(test が年を跨いで落ちない)。 */
  readonly today: string;
}

/**
 * 🔴 **カンバンの列の組み方**(#1457)。`status` = 未完了 / 完了(既定・今までどおり)、`signal` = 赤 / 黄 / 緑 / 完了。
 * ⚠ 端末の好み(localStorage)。保存できない端末ではその session の中だけ効く(`?.` で書かない ── `null` は `catch` に入らない)。
 */
export type BoardLayout = 'status' | 'signal';
export const BOARD_LAYOUT_KEY = 'pkc3.board-layout';
/** 保存が使えない / 書けなかった端末の控え(この session では効いている)。 */
let layoutFallback: BoardLayout | null = null;
/** 🔴 直近の書き込みが失敗したか。真の間だけ読みも控えを返す(保存が正本。控えが保存を覆わない)。 */
let layoutSaveFailed = false;

function layoutStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function currentBoardLayout(): BoardLayout {
  const st = layoutStorage();
  if (st === null || layoutSaveFailed) return layoutFallback ?? 'status';
  try {
    const v = st.getItem(BOARD_LAYOUT_KEY);
    return v === 'signal' || v === 'status' ? v : 'status';
  } catch {
    return layoutFallback ?? 'status';
  }
}

export function chooseBoardLayout(layout: BoardLayout): void {
  layoutFallback = layout;
  layoutSaveFailed = false;
  const st = layoutStorage();
  if (st === null) {
    layoutSaveFailed = true;
    return;
  }
  try {
    st.setItem(BOARD_LAYOUT_KEY, layout);
  } catch {
    // 書けなかった ── 次に書けるまで、読みは控え(選んだ値)を返す
    layoutSaveFailed = true;
  }
}

/** test 用 ── 控えを捨てる。 */
export function resetBoardLayoutFallbackForTest(): void {
  layoutFallback = null;
  layoutSaveFailed = false;
}

/** 信号機の列の見出し(色の意味を字でも言う ── 色だけに頼らない)。 */
const SIGNAL_HEADS: Readonly<Record<SignalColor, string>> = {
  red: '赤(期限切れ・止まっている)',
  yellow: '黄(3 日以内・進行中)',
  green: '緑(余裕あり・順調)',
};

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
  /** 🔴 信号機の 3 列(#1457)。⚠ 状態の列(`open`)と同じ器の作り ── 落とし先は「未完了」。 */
  private readonly signals: Readonly<Record<SignalColor, Column>>;
  private readonly switcher: HTMLElement;
  private layout: BoardLayout = currentBoardLayout();
  private last: BoardPaint | null = null;
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
    this.signals = {
      red: this.column('open', SIGNAL_HEADS.red, 'red'),
      yellow: this.column('open', SIGNAL_HEADS.yellow, 'yellow'),
      green: this.column('open', SIGNAL_HEADS.green, 'green'),
    };
    cols.append(
      this.open.box,
      this.signals.red.box,
      this.signals.yellow.box,
      this.signals.green.box,
      this.done.box,
    );
    /**
     * 🔴 **列の組み方の切り替え**(#1457)。⚠ 端末の好みを変えるだけ(本文には触れない)── 押したら描き直す。
     * ⚠ 器は 1 度だけ組む。押した状態は `aria-pressed` と CSS(`[data-pkc-choice-btn]`)で見分けが付く。
     */
    this.switcher = document.createElement('div');
    this.switcher.setAttribute('data-pkc-field', 'schedule-board-layout');
    for (const [id, label, hint] of [
      ['status', '状態', '未完了と完了の 2 列で見ます'],
      ['signal', '信号機', '赤(期限切れ・止まっている)/ 黄(3 日以内・進行中)/ 緑(余裕あり・順調)/ 完了 の列で見ます'],
    ] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-pkc-field', 'schedule-board-layout-btn');
      b.setAttribute('data-pkc-board-layout', id);
      b.setAttribute('data-pkc-choice-btn', '');
      b.textContent = label;
      b.title = hint;
      b.addEventListener('click', () => {
        if (this.layout === id) return;
        this.layout = id;
        chooseBoardLayout(id);
        if (this.last !== null) this.paint(this.last);
      });
      this.switcher.append(b);
    }
    el.append(this.switcher, this.note, cols);
    this.el = el;
  }

  private column(status: 'open' | 'done', label: string, signal?: SignalColor): Column {
    const box = document.createElement('section');
    box.setAttribute('data-pkc-field', 'schedule-board-column');
    box.setAttribute('data-pkc-board-status', status);
    // 🔴 信号機の列には色の名前を焼く(CSS が見出しの丸に使う)
    if (signal !== undefined) box.setAttribute('data-pkc-signal', signal);
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
    this.last = p;
    this.el.setAttribute('data-pkc-board-columns', this.layout);
    for (const btn of this.switcher.querySelectorAll<HTMLElement>('[data-pkc-board-layout]')) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-pkc-board-layout') === this.layout ? 'true' : 'false');
    }
    const signal = this.layout === 'signal';
    this.open.box.hidden = signal;
    for (const c of Object.values(this.signals)) c.box.hidden = !signal;
    const status = signal ? null : buildBoard(p.items);
    const sig = signal ? buildSignalBoard(p.items, p.today) : null;
    const shown = signal
      ? [...sig!.red, ...sig!.yellow, ...sig!.green, ...sig!.done]
      : [...status!.open, ...status!.done];
    const want = new Set<string>();
    for (const i of shown) want.add(i.key);
    for (const [k, n] of this.cards) {
      if (!want.has(k)) {
        n.card.remove();
        this.cards.delete(k);
      }
    }
    let total: number;
    let skipped: number;
    if (signal) {
      this.fill(this.signals.red, sig!.red, sig!.more.red, SIGNAL_HEADS.red, p);
      this.fill(this.signals.yellow, sig!.yellow, sig!.more.yellow, SIGNAL_HEADS.yellow, p);
      this.fill(this.signals.green, sig!.green, sig!.more.green, SIGNAL_HEADS.green, p);
      this.fill(this.done, sig!.done, sig!.more.done, '完了', p);
      total = shown.length;
      skipped = sig!.skipped;
    } else {
      this.fill(this.open, status!.open, status!.openMore, '未完了', p);
      this.fill(this.done, status!.done, status!.doneMore, '完了', p);
      total = shown.length;
      skipped = status!.skipped;
    }
    const parts: string[] = [];
    if (!p.settled) parts.push('予定を集めています…');
    else if (total === 0)
      parts.push('日付付きのチェック項目(- [ ] やること @2026-10-30)がまだありません。書くとカードになって、ここに並びます');
    else if (signal)
      parts.push(
        '色は期限の近さです(行に #赤 #黄 #緑 と書くと、その色の列に置けます)。カードを完了の列へドラッグすると、本文のチェック([ ] と [x])が切り替わります',
      );
    else parts.push('カードを反対の列へドラッグすると、本文のチェック([ ] と [x])が切り替わります');
    if (skipped > 0)
      parts.push(`繰り返しの予定 ${skipped} 件は、ここには出しません(一覧・日・週・月で扱えます)`);
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
