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
  TASK_LIMITS,
  taskCardKey,
  type KanbanStatus,
  type TaskCard,
} from '@features/kanban/kanban-data';
import { matchesEntry, normalizeQuery } from '@features/filter/title-filter';
import { createTaskCard, patchTaskCard } from './task-card';

export class KanbanRenderer {
  private readonly region: HTMLElement;
  private readonly cards = new Map<string, HTMLElement>();
  /** 札ごとの描画済み参照(札粒度の skip)。 */
  private readonly cardData = new Map<string, TaskCard>();
  private frame: {
    note: HTMLElement;
    /** 「日付のない項目も出す」の切替(2026-08-23)。 */
    undated: HTMLButtonElement;
    columns: Record<KanbanStatus, HTMLElement>;
    /** 見出しの字(件数と開閉の印を塗る所)。 */
    heads: Record<KanbanStatus, HTMLElement>;
  } | null = null;
  private lastScan: AppState['taskScan'] = null;
  private lastFailed = false;
  private lastMetas: AppState['entryMetas'] | null = null;
  private lastFilter: string | null = null;
  private lastHits: AppState['searchHits'] = null;
  private lastShowArchived: boolean | null = null;
  /** ⚠ 「完了」の開閉も指紋(入れないと押しても畳まれたまま)。 */
  private lastShowDone: boolean | null = null;
  /** ⚠ 「日付のない項目も出す」も指紋(同上 ── 押しても何も起きなくなる)。 */
  private lastShowUndated: boolean | null = null;
  /**
   * ⚠ **断りも指紋の一部**(2026-08-19 のレビュー W-2)。押した札が断られたとき、
   * ここを見ていないと**描画器が早期 return して印が戻らない**。
   * 🔑 いまは押した瞬間に印を付けない(binder が `preventDefault`)ので二重の守り。
   */
  private lastError: AppState['error'] = null;
  private lastSelected: string | null = null;

  private readonly now: () => Date;

  /** ⚠ `now` は test 注入用(既定は実時刻)── `CalendarRenderer` と同じ作法。 */
  constructor(region: HTMLElement, now: (() => Date) | undefined = undefined) {
    // ⚠ 既定は実時刻(`CalendarRenderer` と同じ形 ── optional で受ける)
    this.region = region;
    this.now = now ?? ((): Date => new Date());
  }

  render(state: AppState): void {
    if (
      state.taskScan === this.lastScan &&
      state.taskScanFailed === this.lastFailed &&
      state.entryMetas === this.lastMetas &&
      state.filterQuery === this.lastFilter &&
      state.searchHits === this.lastHits &&
      state.showArchived === this.lastShowArchived &&
      state.showDoneTasks === this.lastShowDone &&
      state.showUndatedTasks === this.lastShowUndated &&
      state.error === this.lastError &&
      state.selectedLid === this.lastSelected
    )
      return;
    this.lastScan = state.taskScan;
    this.lastFailed = state.taskScanFailed;
    this.lastMetas = state.entryMetas;
    this.lastFilter = state.filterQuery;
    this.lastHits = state.searchHits;
    this.lastShowArchived = state.showArchived;
    this.lastShowDone = state.showDoneTasks;
    this.lastShowUndated = state.showUndatedTasks;
    this.lastError = state.error;
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
    /**
     * 🔴 **既定で出すのは「日付を書いた行」だけ**(user 指示 2026-08-23)。
     *
     * > 「**すべての本文に存在するチェックリストが…全て看板に出てくる。
     * > これはただのノイズだよ。ただし、日付を入れたチェックリスト、
     * > これが予定として機能する**」
     *
     * ⚠ **落とすのではなく畳む** ── 押せば全部戻る(`showUndatedTasks`)。
     *   「体裁のつもり」と「日付を書き忘れたやること」は本文から見分けられないので、
     *   片方だけ選ぶと必ず取りこぼす。
     */
    const dated = all.filter((c) => c.date !== null);
    const pool = state.showUndatedTasks ? all : dated;
    const visible = pool.filter((c) => {
      const m = state.entryMetas.get(c.lid);
      if (m === undefined) return false;
      /**
       * 🔴 **片付けたノートの項目は、カレンダーと同じ規則で扱う**
       * (2026-08-19 のレビュー)。旧カンバンは `archived` を常に外し、
       * カレンダーは `showArchived` を尊重していた ── **同じ日に直した 2 面で
       * 扱いが割れる**のを避け、判定を 1 つにする(§7)。
       */
      if (m.archived && !state.showArchived) return false;
      return matchesEntry(m.lid, m.title, q, state.searchHits);
    });
    frame.note.textContent = this.noteText(state, all.length, dated.length, visible.length);
    this.paintUndatedToggle(frame.undated, state, all.length - dated.length);
    const grouped = groupTasksByStatus(visible);
    /**
     * 🔴 **畳んでも件数は必ず見せる**(2026-08-20)。⚠ 黙って消すと
     *   「やったはずのものが無い」になる ── 畳むことと隠すことは違う。
     */
    for (const col of KANBAN_COLUMNS) {
      const n = grouped[col.status].length;
      const open = col.status !== 'done' || state.showDoneTasks;
      const head = frame.heads[col.status];
      const text =
        col.status === 'done'
          ? `${open ? '▾' : '▸'} ${col.label}(${n})`
          : `${col.label}(${n})`;
      if (head.textContent !== text) head.textContent = text;
      const btn = head.parentElement;
      if (btn instanceof HTMLButtonElement) {
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.title = open ? '完了した項目を畳みます' : `完了した項目 ${n} 件を開きます`;
      }
      /**
       * ⚠ **札は作ったまま `hidden` にする**(消さない)── 開くたびに組み直すと、
       *   押す寸前の札が作り直されて dead click になる(器を捨てない規律)。
       */
      frame.columns[col.status].hidden = !open;
    }

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
  private noteText(state: AppState, total: number, dated: number, shown: number): string {
    if (state.taskScanFailed)
      return 'チェック項目を集められませんでした。面を開き直すともう一度試します。';
    if (state.taskScan === null) return '集めています…';
    const scan = state.taskScan;
    /**
     * 🔴 **切ったことを先に言う**(2026-08-19 のレビュー D-2)。⚠ 直す前は
     *   「絞り込みに当てはまる項目がありません」「まだありません」が**先**だったので、
     *   **切った結果 0 件になった**ときに「無い」と言い切っていた ──
     *   黙って切らない、の趣旨から外れる。
     */
    if (scan.truncated) {
      const where =
        scan.scannedNotes < scan.totalNotes
          ? `${scan.scannedNotes} 件のノートまで`
          : `${TASK_LIMITS.items} 件の項目まで`;
      return `多いので ${where} を出しています(候補のノートは ${scan.totalNotes} 件)。`;
    }
    if (total === 0)
      return 'チェックの付いた行がまだありません。ノートに「- [ ] やること」と書くと、ここに出ます。';
    /**
     * 🔴 **「日付が無いから出ていない」を、はっきり書く**(2026-08-23)。
     * ⚠ 既定で日付のない項目を畳むので、ここを書かないと user は
     *   「チェックを書いたのに何も出ない」と読む ── **書き方が分からないまま詰まる**。
     * 🔑 だから**書き方をそのまま出す**(探させない)。
     */
    if (dated === 0 && !state.showUndatedTasks)
      return '日付を書いた項目がまだありません。「- [ ] やること @2026-08-25」のように書くと、ここに出ます。';
    if (shown === 0) return '絞り込みに当てはまる項目がありません。';
    return `${shown} 件`;
  }

  private ensureFrame(): {
    note: HTMLElement;
    undated: HTMLButtonElement;
    columns: Record<KanbanStatus, HTMLElement>;
    heads: Record<KanbanStatus, HTMLElement>;
  } {
    if (this.frame) return this.frame;
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'kanban-note');
    /**
     * 🔴 **戻し道は、畳んだ物のそばに置く**(2026-08-20 に「完了」で決めた作法と同じ)。
     * ⚠ 設定画面へ隠すと、既定で消えた項目を**探す手がかりがどこにも無い**
     *   ── 「無くなった」と読まれる。
     */
    const undated = document.createElement('button');
    undated.type = 'button';
    undated.setAttribute('data-pkc-action', 'toggle-show-undated');
    undated.setAttribute('data-pkc-field', 'kanban-undated');
    const board = document.createElement('div');
    board.setAttribute('data-pkc-region', 'kanban-board');
    const columns = {} as Record<KanbanStatus, HTMLElement>;
    const heads = {} as Record<KanbanStatus, HTMLElement>;
    for (const col of KANBAN_COLUMNS) {
      const section = document.createElement('section');
      section.setAttribute('data-pkc-region', 'kanban-column');
      section.setAttribute('data-pkc-kanban-status', col.status);
      const heading = document.createElement('h3');
      /**
       * 🔴 **「完了」の見出しは、畳む口そのものにする**(2026-08-20。設計 doc §4-4)。
       *
       * ⚠ 専用の切替を別の場所に置かない ── 畳んだものを開く口は、
       *   **畳まれている物のところ**に在るのがいちばん短い(探させない)。
       * ⚠ 「やること」側は畳めない(畳んだら面が空になる)ので、押す口も出さない。
       */
      const label = document.createElement('span');
      label.setAttribute('data-pkc-field', 'kanban-column-label');
      const host = document.createElement('div');
      host.setAttribute('data-pkc-region', 'kanban-cards');
      if (col.status === 'done') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-pkc-action', 'toggle-show-done');
        btn.append(label);
        heading.append(btn);
      } else {
        heading.append(label);
      }
      section.append(heading, host);
      board.append(section);
      columns[col.status] = host;
      heads[col.status] = label;
    }
    this.region.append(note, undated, board);
    this.frame = { note, undated, columns, heads };
    return this.frame;
  }

  /**
   * 「日付のない項目も出す」の切替を塗る。
   *
   * ⚠ **押しても何も起きないボタンを出さない** ── 日付の無い項目が 1 つも無ければ
   *   隠す(押す前に「何件戻るか」が分かる形にもなる)。
   * 🔑 ただし**入れている最中は 0 件でも出す** ── 消すと切ったまま戻せなくなる。
   */
  private paintUndatedToggle(btn: HTMLButtonElement, state: AppState, undated: number): void {
    const show = undated > 0 || state.showUndatedTasks;
    btn.hidden = !show;
    if (!show) return;
    btn.setAttribute('aria-pressed', state.showUndatedTasks ? 'true' : 'false');
    const text = state.showUndatedTasks
      ? '日付のない項目を隠す'
      : `日付のない項目も出す(${undated})`;
    if (btn.textContent !== text) btn.textContent = text;
    btn.title = state.showUndatedTasks
      ? '日付を書いた項目だけに戻します'
      : '日付を書いていないチェック項目も盤面に出します';
  }

  private createCard(data: TaskCard): HTMLElement {
    // 🔑 組み立ては `task-card.ts` 1 か所(予定の面と同じ札を出すため。§7)
    const card = createTaskCard(data);
    this.patchCard(card, data, '');
    return card;
  }

  /** ⚠ 板は束が「日」ではないので、**札に日付を出す**(予定の面は出さない)。 */
  private patchCard(card: HTMLElement, data: TaskCard, title: string): void {
    patchTaskCard(card, data, title, this.now().getFullYear(), true);
  }
}
