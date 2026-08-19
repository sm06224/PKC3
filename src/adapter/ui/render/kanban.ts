/**
 * 🔴 **カンバン ── 札 1 枚 = 本文のチェック項目 1 行**(#277 段②-b)。
 *
 * 何が札になるかは `features/kanban/kanban-data.ts` の頭に書いてある
 * (要約:`todo` アーキタイプは封印中で作れないので、盤面の単位を
 * **user が実際に書いているチェックリストの行**へ移した)。
 *
 * ## ここが守る規律
 *
 * - **本文は読まない**。舐めるのは storage worker で、ここに来るのは
 *   `state.taskScan`(項目だけ)である ── 題名は `entryMetas` から引く
 * - **押す先は札の lid**。⚠ 開いているノートではない ── 盤面の札は
 *   いろいろなノートの行なので、`data-pkc-entry` を札に焼いて
 *   binder に**そこから**引かせる(`toggle-task`)
 * - 差分描画(sidebar / 旧カンバンと同じ):断面指紋が一致なら DOM 不触 /
 *   札は鍵で再利用 / 削除 pass が先(cursor 汚染で全札 move にしない)
 * - 🔴 **切ったことは画面に出す**(黙って切ると user は「無い」と読む)
 */
import type { AppState } from '@adapter/state/app-state';
import {
  groupTasksByStatus,
  KANBAN_COLUMNS,
  taskCardKey,
  type KanbanStatus,
  type TaskCard,
} from '@features/kanban/kanban-data';
import { matchesEntry, normalizeQuery } from '@features/filter/title-filter';

export class KanbanRenderer {
  private readonly region: HTMLElement;
  private readonly cards = new Map<string, HTMLElement>();
  /** 札ごとの描画済み参照(札粒度の skip)。 */
  private readonly cardData = new Map<string, TaskCard>();
  private frame: { note: HTMLElement; columns: Record<KanbanStatus, HTMLElement> } | null = null;
  private lastScan: AppState['taskScan'] = null;
  private lastFailed = false;
  private lastMetas: AppState['entryMetas'] | null = null;
  private lastFilter: string | null = null;
  private lastHits: AppState['searchHits'] = null;
  private lastSelected: string | null = null;

  constructor(region: HTMLElement) {
    this.region = region;
  }

  render(state: AppState): void {
    if (
      state.taskScan === this.lastScan &&
      state.taskScanFailed === this.lastFailed &&
      state.entryMetas === this.lastMetas &&
      state.filterQuery === this.lastFilter &&
      state.searchHits === this.lastHits &&
      state.selectedLid === this.lastSelected
    )
      return;
    this.lastScan = state.taskScan;
    this.lastFailed = state.taskScanFailed;
    this.lastMetas = state.entryMetas;
    this.lastFilter = state.filterQuery;
    this.lastHits = state.searchHits;
    this.lastSelected = state.selectedLid;

    const frame = this.ensureFrame();
    /**
     * 🔑 **絞り込みは全部の面に同じ規則で効かせる**。⚠ 判定は 1 か所
     * (`matchesEntry`)── 面ごとに書くと、「りんご」と書かれた欄の隣で
     * 盤面が全件を出す(画面が嘘をつく)。
     * ⚠ 絞るのは**ノート単位**である(本文の当たりは `searchHits` が持つ)。
     */
    const q = normalizeQuery(state.filterQuery);
    const all = state.taskScan?.cards ?? [];
    const visible = all.filter((c) => {
      const m = state.entryMetas.get(c.lid);
      return m !== undefined && matchesEntry(m.lid, m.title, q, state.searchHits);
    });
    frame.note.textContent = this.noteText(state, all.length, visible.length);
    const grouped = groupTasksByStatus(visible);

    // 削除 pass を先に(残った実ノードが cursor を汚すと、以降が全部 move になる)
    const wanted = new Set(visible.map(taskCardKey));
    for (const [key, card] of this.cards) {
      if (!wanted.has(key)) {
        card.remove();
        this.cards.delete(key);
        this.cardData.delete(key);
      }
    }
    // 列を移った札も**先に**移動元から外す(同上)
    for (const col of KANBAN_COLUMNS) {
      const host = frame.columns[col.status];
      for (const c of grouped[col.status]) {
        const card = this.cards.get(taskCardKey(c));
        if (card && card.parentNode !== null && card.parentNode !== host) card.remove();
      }
    }

    for (const col of KANBAN_COLUMNS) {
      const host = frame.columns[col.status];
      let cursor: ChildNode | null = host.firstChild;
      for (const data of grouped[col.status]) {
        const key = taskCardKey(data);
        const title = state.entryMetas.get(data.lid)?.title ?? '';
        let card = this.cards.get(key);
        if (!card) {
          card = this.createCard(data);
          this.cards.set(key, card);
        }
        if (this.cardData.get(key) !== data || card.getAttribute('data-pkc-note') !== title) {
          this.patchCard(card, data, title);
          this.cardData.set(key, data);
        }
        // 🔑 選択は属性の付け替えだけ(札を作り直さない)
        if (data.lid === state.selectedLid) card.setAttribute('data-pkc-selected', '');
        else card.removeAttribute('data-pkc-selected');
        if (cursor === card) cursor = card.nextSibling;
        else host.insertBefore(card, cursor);
      }
    }
  }

  /**
   * 状態の 1 行。⚠ **「まだ」「駄目だった」「無い」「切った」を区別する** ──
   * 混ぜると、集めている最中と項目 0 件が同じ顔になる。
   */
  private noteText(state: AppState, total: number, shown: number): string {
    if (state.taskScanFailed)
      return 'チェック項目を集められませんでした。面を開き直すともう一度試します。';
    if (state.taskScan === null) return '集めています…';
    if (total === 0)
      return 'チェックの付いた行がまだありません。ノートに「- [ ] やること」と書くと、ここに出ます。';
    if (shown === 0) return '絞り込みに当てはまる項目がありません。';
    const scan = state.taskScan;
    // 🔴 切ったなら必ず言う(「無い」と読ませない)
    if (scan.truncated)
      return `多いので ${scan.scannedNotes} 件のノートまでを出しています(候補は ${scan.totalNotes} 件)。`;
    return `${shown} 件`;
  }

  private ensureFrame(): { note: HTMLElement; columns: Record<KanbanStatus, HTMLElement> } {
    if (this.frame) return this.frame;
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'kanban-note');
    const board = document.createElement('div');
    board.setAttribute('data-pkc-region', 'kanban-board');
    const columns = {} as Record<KanbanStatus, HTMLElement>;
    for (const col of KANBAN_COLUMNS) {
      const section = document.createElement('section');
      section.setAttribute('data-pkc-region', 'kanban-column');
      section.setAttribute('data-pkc-kanban-status', col.status);
      const heading = document.createElement('h3');
      heading.textContent = col.label;
      const host = document.createElement('div');
      host.setAttribute('data-pkc-region', 'kanban-cards');
      section.append(heading, host);
      board.append(section);
      columns[col.status] = host;
    }
    this.region.append(note, board);
    this.frame = { note, columns };
    return this.frame;
  }

  private createCard(data: TaskCard): HTMLElement {
    const card = document.createElement('article');
    /**
     * 🔴 **どのノートの行かを札に焼く**。⚠ これが無いと binder は
     * 「いま開いているノート」に書き込む ── 盤面では**別のノートを書き換える**。
     */
    card.setAttribute('data-pkc-entry', data.lid);
    card.setAttribute('data-pkc-action', 'select-entry');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'pkc-task-checkbox';
    box.setAttribute('data-pkc-action', 'toggle-task');
    box.setAttribute('aria-label', 'チェックを切り替え');
    const text = document.createElement('span');
    text.setAttribute('data-pkc-field', 'text');
    const note = document.createElement('span');
    note.setAttribute('data-pkc-field', 'note');
    card.append(box, text, note);
    this.patchCard(card, data, '');
    return card;
  }

  private patchCard(card: HTMLElement, data: TaskCard, title: string): void {
    const box = card.querySelector<HTMLInputElement>('[data-pkc-action="toggle-task"]');
    if (box) {
      // 🔴 **指すのは原文の行番号**(索引ではない ── 別の行を書き換えないため)
      box.setAttribute('data-pkc-task-line', String(data.line));
      box.checked = data.done;
    }
    if (data.done) card.setAttribute('data-pkc-task-done', '');
    else card.removeAttribute('data-pkc-task-done');
    const text = card.querySelector('[data-pkc-field="text"]');
    // ⚠ 中身が空の項目もある(`- [ ]` だけの行)── 札は出すが、字は出ない
    if (text && text.textContent !== data.text) text.textContent = data.text;
    const note = card.querySelector('[data-pkc-field="note"]');
    if (note && note.textContent !== title) note.textContent = title;
    // 🔑 題名は指紋にも使う(ノートを改名したら札の字も直る)
    card.setAttribute('data-pkc-note', title);
  }
}
