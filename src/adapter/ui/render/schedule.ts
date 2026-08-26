/**
 * 🔴 **予定の面**(#292 段③。user 指示 2026-08-23)。
 *
 * > 「**カレンダーは挙動の意味がわからなさすぎる / ユーザーはもう一つ PKC が開いて
 * > 混乱すると思う / ちゃんとした導線に作り直しなさい**」
 * > 「**なんで双方向にする発想がでねぇんだよ!**」
 *
 * ## どこに在るか ── **左の列のタブ**
 *
 * 規則は既に決まっている(`browse.ts` の表)── **左 = ノート全体**。
 * 予定は「ノート全体を横断して見る」ものなので左である。
 * 🔴 **中央(本文)は 1 度も消えない** ── ①の実害はそこだった。
 *
 * ## 何ができるか ── **見るだけの面にしない**
 *
 * | 操作 | 何が起きるか |
 * |---|---|
 * | 札の**印**を押す | その行のチェックが反転する |
 * | 札の**字**を押す | そのノートを中央に開く(面はそのまま) |
 * | 札を**日へ落とす** | 🔴 **その行の日付が変わる**(双方向) |
 * | 札を**「日付なし」へ落とす** | 🔴 予定から**外す**(消さない) |
 *
 * ⚠ 落とし先は **①小さな月の升目**と**②束の見出し**の両方 ── 見えているどちらへでも
 *   落とせる(「どちらか片方でしかできない」を作らない)。
 *
 * ## 束ね方
 *
 * **日ごと**(`features/schedule/agenda.ts`)。⚠ 「今週」で束ねると、落としたときに
 * **どの日か決まらない** ── 束 = 落とし先なので、束ね方が操作を決めてしまう。
 */
import type { AppState } from '@adapter/state/app-state';
import {
  buildAgenda,
  itemOfCard,
  itemOfNote,
  type AgendaGroup,
  type AgendaItem,
} from '@features/schedule/agenda';
import { getMonthGrid, dateKey } from '@features/schedule/month-grid';
import { TASK_LIMITS, type TaskCard } from '@features/schedule/task-cards';
import { materializedDates } from '@features/schedule/repeat';
import { entryFilterOf, matchesEntry, type EntryFilter } from '@features/filter/title-filter';
import { createTaskCard, patchTaskCard } from './task-card';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** 落とし先を表す属性。⚠ **空文字 = 日付なし**(属性が無いのとは別物)。 */
export const DROP_DATE = 'data-pkc-drop-date';

export class ScheduleRenderer {
  private readonly region: HTMLElement;
  private readonly now: () => Date;
  private readonly cards = new Map<string, HTMLElement>();
  private readonly cardData = new Map<string, AgendaItem>();
  /** 束の器(日付 → 節)。⚠ **使い回す**(捨てると掴んでいる札が消える)。 */
  private readonly sections = new Map<string, { section: HTMLElement; host: HTMLElement; head: HTMLElement; label: HTMLElement }>();
  private frame: {
    month: HTMLElement;
    grid: HTMLElement;
    note: HTMLElement;
    undated: HTMLButtonElement;
    /**
     * 🔴 **済んだ予定を戻す口**(2026-08-23、変異試験 S7 が教えた)。
     * ⚠ 直す前は済んだ行を**黙って外す**だけで、この面から戻す道が無かった ──
     *   板は「完了」の見出しが戻す口を兼ねていたが、予定の面には列が無いので
     *   **落ちていた**。「置けるなら外せる」の裏返し(片道を作らない)。
     */
    done: HTMLButtonElement;
    /**
     * 🔴 **片付けたノートの予定を戻す口**(段⑤ で移した)。
     * ⚠ 直す前、`toggle-show-archived` の口は**カレンダーの面 1 つだけ**だった
     *   ── その面を落とすと `showArchived` は既定(false)から二度と動かせず、
     *   **片付けたノートの予定が永久に見えなくなる**。
     * 🔑 落とす前に**代わりを立てる**(CLAUDE.md「捨てるものの表は、行ごとに
     *   『代わりに何ができるようになるか』を書く」)。
     */
    archived: HTMLButtonElement;
    groups: HTMLElement;
  } | null = null;
  private last: {
    scan: AppState['taskScan'];
    failed: boolean;
    metas: AppState['entryMetas'];
    filter: string;
    kindFilter: AppState['kindFilter'];
    hits: AppState['searchHits'];
    showArchived: boolean;
    showDone: boolean;
    showUndated: boolean;
    calendarMonth: AppState['calendarMonth'];
    selected: string | null;
    error: string | null;
    today: string;
  } | null = null;

  /** ⚠ `now` は test 注入用(既定は実時刻)── 面ごとに `new Date()` を読まない。 */
  constructor(region: HTMLElement, now: (() => Date) | undefined = undefined) {
    this.region = region;
    this.now = now ?? ((): Date => new Date());
  }

  render(state: AppState): void {
    const at = this.now();
    const today = dateKey(at.getFullYear(), at.getMonth() + 1, at.getDate());
    const next = {
      scan: state.taskScan,
      failed: state.taskScanFailed,
      metas: state.entryMetas,
      filter: state.filterQuery,
      // 🔴 **種類の絞りも指紋**(#411)── 入れないと札を押しても描き直さない
      // ⚠ 鍵は `kindFilter`(`filerRows` へ渡す `kinds:` と**綴りを分ける**)──
      //   同じ綴りだと、指紋を見張る test が options の行に満たされる
      kindFilter: state.kindFilter,
      hits: state.searchHits,
      showArchived: state.showArchived,
      showDone: state.showDoneTasks,
      showUndated: state.showUndatedTasks,
      calendarMonth: state.calendarMonth,
      selected: state.selectedLid,
      error: state.error,
      today,
    };
    // ⚠ 指紋が全部同じなら DOM に触らない(掴んでいる最中に組み直さない)
    const prev = this.last;
    if (
      prev !== null &&
      (Object.keys(next) as (keyof typeof next)[]).every((k) => prev[k] === next[k])
    )
      return;
    this.last = next;

    const frame = this.ensureFrame();
    /**
     * ⚠ **種類の絞りもこの面に効かせる**(#411)── 効かせないと、札を押した
     *   まま予定タブへ移ったときに**そこだけ全部出る**。user からは
     *   「絞りが勝手に解けた」としか見えない(CLAUDE.md §7)。
     * 🔑 札の相手は**行が載っているノート**である(予定の行そのものに種類は無い)。
     */
    const filter = entryFilterOf(state.filterQuery, state.searchHits, state.kindFilter);
    const all = state.taskScan?.cards ?? [];
    /**
     * 🔑 **絞り込みは全部の面に同じ規則で効かせる**(判定は `matchesEntry` 1 か所)。
     * ⚠ 片付けたノートの扱いも 1 か所(`showArchived`)── 面ごとに割らない。
     */
    const visible = all.filter((c) => {
      const m = state.entryMetas.get(c.lid);
      if (m === undefined) return false;
      if (m.archived && !state.showArchived) return false;
      // ⚠ 済んだ行は畳む(板の「完了」と同じ旗)── 予定の面は列が無いので**外す**
      if (c.done && !state.showDoneTasks) return false;
      return matchesEntry(m, filter);
    });
    const dated = visible.filter((c) => c.date !== null);
    /**
     * 🔴 **ノート 1 件が丸ごと予定のものも束ねる**(段④)── frontmatter の `date:`。
     * ⚠ 受けないと、中央のカレンダー(段⑤ で落とす)が消えた瞬間に
     *   **`date:` を書いても どこにも出ない**(動線が 1 つ消える)。
     * ⚠ 絞り込みと片付けの規則は行の札と**同じもの**を通す(面の中で割らない)。
     */
    const notes: AgendaItem[] = [];
    for (const lid of state.order) {
      const m = state.entryMetas.get(lid);
      if (m === undefined || m.date === null) continue;
      if (m.archived && !state.showArchived) continue;
      if (!matchesEntry(m, filter)) continue;
      notes.push(itemOfNote(m));
    }
    const items = [...visible.map(itemOfCard), ...notes];
    /**
     * 🔴 **済んだ回は「絞り込む前」の札から拾う**(#344 段②)。
     *
     * ⚠ `visible` から拾ってはいけない ── 既定では**済んだ札を隠す**ので、
     *   実体の行(`- [x] ゴミ出し @2026-08-31`)は消えている。消えたまま渡すと
     *   **済ませたはずの回がもう一度出る**(しかも押しても「同じ行が既に在る」で
     *   何も起きないので、user から見ると**壊れて見える**)。
     * ⚠ 片付けたノートの札も入れる ── 同じ理由(隠れているだけで実体は在る)。
     */
    const groups = buildAgenda(items, today, state.showUndatedTasks, {
      skip: materializedDates(all),
    });

    // 🔑 点は**束から**引く(下の docstring)── 期間の展開を 2 か所で決めない
    this.paintMonth(frame, state, today, groups);
    frame.note.textContent = this.noteText(
      state,
      all.length + notes.length,
      dated.length + notes.length,
      groups.length,
    );
    this.paintUndatedToggle(frame.undated, state, visible.length - dated.length);
    this.paintDoneToggle(frame.done, state, all, filter);
    this.paintArchivedToggle(frame.archived, state, all);
    this.paintGroups(frame.groups, groups, state);
  }

  /**
   * 小さな月(移動 + 落とし先)。⚠ 升目は**毎回組み直す**(掴めない部品なので安全)。
   *
   * 🔴 **点は「束」から引く**(#344 段①)。⚠ 直す前は札の `date` を集めていたので、
   *   期間(`@2026-08-25..2026-08-28`)は**開始の日にしか点が付かなかった** ──
   *   下の一覧では 4 日に出ているのに、小さな月では 1 日だけ、という食い違いになる。
   * 🔑 束は `buildAgenda` が展開済みなので、**「どの日に予定が在るか」の規則が 1 本**に
   *   なる(CLAUDE.md §7 ── 同じ問いに答える口を 2 つ持たない)。
   */
  private paintMonth(
    frame: NonNullable<ScheduleRenderer['frame']>,
    state: AppState,
    today: string,
    groups: readonly AgendaGroup[],
  ): void {
    const at = this.now();
    const year = state.calendarMonth?.year ?? at.getFullYear();
    const month = state.calendarMonth?.month ?? at.getMonth() + 1;
    frame.month.textContent = `${year}年${month}月`;
    frame.month.setAttribute('data-pkc-month', `${year}-${month < 10 ? '0' : ''}${month}`);
    for (const btn of frame.grid.parentElement?.querySelectorAll<HTMLElement>(
      '[data-pkc-action="schedule-nav"]',
    ) ?? []) {
      const to = btn.getAttribute('data-pkc-nav-step') === '-1' ? month - 1 : month + 1;
      btn.setAttribute('data-pkc-nav-year', String(year));
      btn.setAttribute('data-pkc-nav-month', String(to));
    }
    /** その日に予定が在るか。⚠ **点だけ**(件数は出さない ── 升目が読めなくなる)。 */
    const has = new Set(groups.map((g) => g.date).filter((d): d is string => d !== null));
    frame.grid.textContent = '';
    const head = document.createElement('div');
    head.setAttribute('data-pkc-field', 'schedule-week');
    for (const w of WEEKDAYS) {
      const cell = document.createElement('span');
      cell.textContent = w;
      head.append(cell);
    }
    frame.grid.append(head);
    for (const week of getMonthGrid(year, month)) {
      const row = document.createElement('div');
      row.setAttribute('data-pkc-field', 'schedule-week');
      for (const day of week) {
        if (day === null) {
          // ⚠ 月外は**空の枠**(落とせない)── 落とせるように見せない
          const blank = document.createElement('span');
          blank.setAttribute('data-pkc-field', 'schedule-blank');
          row.append(blank);
          continue;
        }
        const key = dateKey(year, month, day);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.setAttribute('data-pkc-action', 'schedule-pick-day');
        // 🔴 **落とし先**(掴んだ札をここへ落とすと、その日になる)
        cell.setAttribute(DROP_DATE, key);
        cell.textContent = String(day);
        if (key === today) cell.setAttribute('data-pkc-today', '');
        if (has.has(key)) cell.setAttribute('data-pkc-has', '');
        row.append(cell);
      }
      frame.grid.append(row);
    }
  }

  /**
   * 状態の 1 行。⚠ **「まだ」「駄目だった」「無い」「切った」を区別する**。
   */
  private noteText(state: AppState, total: number, dated: number, groups: number): string {
    if (state.taskScanFailed)
      return '予定を集められませんでした。タブを開き直すともう一度試します。';
    if (state.taskScan === null) return '集めています…';
    if (state.taskScan.truncated)
      return `多いので途中まで出しています(候補のノートは ${state.taskScan.totalNotes} 件)。`;
    if (total === 0)
      return 'チェックの付いた行がまだありません。ノートに「- [ ] やること」と書くと、ここに出ます。';
    /**
     * 🔴 **「日付が無いから出ていない」を、はっきり書く。**
     * ⚠ 書かないと user は「チェックを書いたのに何も出ない」と読み、
     *   **書き方が分からないまま詰まる**(既定で畳んだ側の責任である)。
     */
    if (dated === 0 && !state.showUndatedTasks)
      return '日付を書いた予定がまだありません。「- [ ] やること @2026-08-25」のように書くか、日を押して書式の帯の「日付」から入れてください。';
    if (groups === 0) return '絞り込みに当てはまる予定がありません。';
    return '';
  }

  /** 「日付のない項目も出す」の切替。⚠ **押しても何も起きないボタンを出さない**。 */
  private paintUndatedToggle(btn: HTMLButtonElement, state: AppState, undated: number): void {
    const show = undated > 0 || state.showUndatedTasks;
    btn.hidden = !show;
    if (!show) return;
    btn.setAttribute('aria-pressed', state.showUndatedTasks ? 'true' : 'false');
    const text = state.showUndatedTasks
      ? '日付のない項目を隠す'
      : `日付のない項目も出す(${undated})`;
    if (btn.textContent !== text) btn.textContent = text;
  }

  /**
   * 「済んだ予定も出す」の切替。
   * ⚠ **件数は「隠れている分」**(押す前に何件戻るか分かる)── そして
   *   チェックを付けたときに**この数が増える**のが、保存された手応えになる。
   */
  private paintDoneToggle(
    btn: HTMLButtonElement,
    state: AppState,
    all: readonly TaskCard[],
    filter: EntryFilter,
  ): void {
    // ⚠ 数えるのは**この面に出る条件を満たしたうえで済んでいる**もの
    const hidden = all.filter((c) => {
      if (!c.done) return false;
      const m = state.entryMetas.get(c.lid);
      if (m === undefined) return false;
      if (m.archived && !state.showArchived) return false;
      if (c.date === null && !state.showUndatedTasks) return false;
      return matchesEntry(m, filter);
    }).length;
    const show = hidden > 0 || state.showDoneTasks;
    btn.hidden = !show;
    if (!show) return;
    btn.setAttribute('aria-pressed', state.showDoneTasks ? 'true' : 'false');
    const text = state.showDoneTasks ? '済んだ予定を隠す' : `済んだ予定も出す(${hidden})`;
    if (btn.textContent !== text) btn.textContent = text;
  }

  /**
   * 「片付けたノートの予定も出す」の切替(段⑤ でカレンダーから移した)。
   * ⚠ **片付けた物が 1 つも無ければ出さない** ── 押しても何も起きないボタンにしない。
   */
  private paintArchivedToggle(
    btn: HTMLButtonElement,
    state: AppState,
    all: readonly TaskCard[],
  ): void {
    // ⚠ 行の札とノートの予定の**両方**を数える(片方だけ数えると 0 件に見える)
    const lids = new Set<string>();
    for (const c of all) if (state.entryMetas.get(c.lid)?.archived === true) lids.add(c.lid);
    for (const [lid, m] of state.entryMetas)
      if (m.archived && m.date !== null) lids.add(lid);
    const show = lids.size > 0 || state.showArchived;
    btn.hidden = !show;
    if (!show) return;
    btn.setAttribute('aria-pressed', state.showArchived ? 'true' : 'false');
    const text = state.showArchived
      ? '片付けたものを隠す'
      : `片付けたものも出す(${lids.size})`;
    if (btn.textContent !== text) btn.textContent = text;
  }

  /**
   * 束を描く。
   *
   * 🔑 **札も節も使い回す** ── 捨てて作り直すと、①掴んでいる札が途中で消える
   *   ②押す寸前の札が作り直されて dead click になる(器を捨てない規律)。
   */
  private paintGroups(host: HTMLElement, groups: readonly AgendaGroup[], state: AppState): void {
    const wantSections = new Set(groups.map((g) => g.date ?? ''));
    for (const [key, node] of this.sections) {
      if (!wantSections.has(key)) {
        node.section.remove();
        this.sections.delete(key);
      }
    }
    const wantCards = new Set(groups.flatMap((g) => g.cards.map((c) => c.key)));
    for (const [key, el] of this.cards) {
      if (!wantCards.has(key)) {
        el.remove();
        this.cards.delete(key);
        this.cardData.delete(key);
      }
    }
    let cursor: ChildNode | null = host.firstChild;
    for (const g of groups) {
      const key = g.date ?? '';
      let node = this.sections.get(key);
      if (node === undefined) {
        node = this.createSection(key);
        this.sections.set(key, node);
      }
      const label = `${g.label}(${g.cards.length})`;
      /**
       * ⚠ **見出しの字だけを差し替える**(#402 ②)── `head.textContent` に
       *   代入すると、隣に置いた `+` が**毎回の描き直しで消える**
       *   (「押せる物が黙って居なくなる」の典型)。
       */
      if (node.label.textContent !== label) node.label.textContent = label;
      if (g.overdue) node.section.setAttribute('data-pkc-overdue', '');
      else node.section.removeAttribute('data-pkc-overdue');
      if (cursor === node.section) cursor = node.section.nextSibling;
      else host.insertBefore(node.section, cursor);
      this.paintCards(node.host, g, state);
    }
  }

  private createSection(key: string): {
    section: HTMLElement;
    host: HTMLElement;
    head: HTMLElement;
    label: HTMLElement;
  } {
    const section = document.createElement('section');
    section.setAttribute('data-pkc-region', 'schedule-group');
    /**
     * 🔴 **見出しも落とし先**(升目まで運ばなくてよい)。
     * ⚠ 「日付なし」は空文字 ── 落とすと**予定から外す**(消さない)。
     */
    section.setAttribute(DROP_DATE, key);
    const head = document.createElement('h3');
    head.setAttribute('data-pkc-field', 'schedule-group-label');
    // ⚠ 字は**別の器**に持つ(上の注記 ── `+` を巻き添えにしない)
    const label = document.createElement('span');
    label.setAttribute('data-pkc-field', 'schedule-group-text');
    head.append(label);
    /**
     * 🔴 **その日に足す口**(#402 ②)。⚠ ここは**欄を出さない** ── 上の
     *   1 つの欄に日付を入れて焦点を移すだけである(打ちかけを束ごと失わない)。
     * ⚠ 「日付なし」の束(`key === ''`)には出さない ── 日付を決めずに足す口は
     *   上の欄が既に持っている(日付を空のまま押せばよい)。
     */
    if (key !== '') {
      const plus = document.createElement('button');
      plus.type = 'button';
      plus.setAttribute('data-pkc-action', 'schedule-quick-here');
      plus.setAttribute('data-pkc-quick-date', key);
      plus.setAttribute('data-pkc-field', 'schedule-quick-here');
      /**
       * 🔴 **印は字で置かない**(#396 で踏んだのと同じ罠。既存の test が拾った)。
       *
       * ⚠ `textContent = '+'` にすると、**見出しの `textContent` に混ざる**
       *   ── 読み上げ・写し・test の突き合わせが全部汚れる(束の名前が
       *   `今日(1)+` になった)。
       * 🔑 印は **CSS の `::before`**、名前は `aria-label` に置く。
       */
      plus.setAttribute('aria-label', 'この日のやることを足す');
      plus.title = 'この日のやることを足します(上の欄に日付が入ります)';
      head.append(plus);
    }
    const host = document.createElement('div');
    host.setAttribute('data-pkc-region', 'schedule-cards');
    section.append(head, host);
    return { section, host, head, label };
  }

  private paintCards(host: HTMLElement, g: AgendaGroup, state: AppState): void {
    let cursor: ChildNode | null = host.firstChild;
    const year = this.now().getFullYear();
    for (const data of g.cards) {
      const key = data.key;
      const title = state.entryMetas.get(data.lid)?.title ?? '';
      let card = this.cards.get(key);
      if (card === undefined) {
        card = createTaskCard(data);
        this.cards.set(key, card);
      }
      if (this.cardData.get(key) !== data || card.getAttribute('data-pkc-note') !== title) {
        /**
         * ⚠ **日付は札に出さない** ── 見出しに `8/27(木)` と出ているのに
         *   その下の札全部にも同じ日が並ぶのは、ただの重複である。
         * 🔑 ただし**時刻は出す**(束の中の並びの理由がそこに在る)。
         */
        patchTaskCard(card, data, title, year, false);
        this.cardData.set(key, data);
      }
      if (data.lid === state.selectedLid) card.setAttribute('data-pkc-selected', '');
      else card.removeAttribute('data-pkc-selected');
      if (cursor === card) cursor = card.nextSibling;
      else host.insertBefore(card, cursor);
    }
  }

  private ensureFrame(): NonNullable<ScheduleRenderer['frame']> {
    if (this.frame) return this.frame;
    const bar = document.createElement('div');
    bar.setAttribute('data-pkc-field', 'schedule-toolbar');
    const nav = (label: string, step: -1 | 1): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-pkc-action', 'schedule-nav');
      b.setAttribute('data-pkc-nav-step', String(step));
      b.textContent = label;
      return b;
    };
    const month = document.createElement('span');
    month.setAttribute('data-pkc-field', 'schedule-month');
    const todayBtn = document.createElement('button');
    todayBtn.type = 'button';
    todayBtn.setAttribute('data-pkc-action', 'schedule-today');
    todayBtn.textContent = '今月';
    bar.append(nav('‹', -1), month, nav('›', 1), todayBtn);
    /**
     * 🔴 **予定の面から、その場でやることを足す**(#402 ②)。
     *
     * > user の物語: 予定タブで今週を眺めている。「木曜に見積を出す」を足したい。
     * > いまは**足す口が無い** ── ノートを開く(または作る)→ 本文に
     * > `- [ ] 見積を出す @2026-08-28` と手で書く → 予定タブへ戻る。
     *
     * 🔴 **正本は本文のまま**(user 指示 2026-08-23「面は映すだけにしない ──
     *   **双方向**」)。面が別のデータを持つのではなく、**面から本文へ書く**。
     * ⚠ **入力欄は 1 つだけ**にする ── 日付の束ごとに欄を置くと、打ちかけが
     *   どこに在るか分からなくなる(束は描き直しで作り直される)。
     *   束の脇の `+` は、**この欄の日付を埋めて焦点を移す**だけである。
     */
    const quick = document.createElement('div');
    quick.setAttribute('data-pkc-field', 'schedule-quick');
    const qText = document.createElement('input');
    qText.type = 'text';
    qText.setAttribute('data-pkc-field', 'schedule-quick-text');
    qText.placeholder = 'やること';
    qText.setAttribute('aria-label', '足すやること');
    const qDate = document.createElement('input');
    qDate.type = 'date';
    qDate.setAttribute('data-pkc-field', 'schedule-quick-date');
    qDate.setAttribute('aria-label', 'いつのやること');
    const qAdd = document.createElement('button');
    qAdd.type = 'button';
    qAdd.setAttribute('data-pkc-action', 'schedule-quick-add');
    qAdd.textContent = '足す';
    // ⚠ **どこへ書くかを先に言う**(押してから「どこへ入った?」と思わせない)
    qAdd.title = '今日のノートの末尾に、チェック項目として書きます';
    quick.append(qText, qDate, qAdd);
    const grid = document.createElement('div');
    grid.setAttribute('data-pkc-field', 'schedule-grid');
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'schedule-note');
    const undated = document.createElement('button');
    undated.type = 'button';
    undated.setAttribute('data-pkc-action', 'toggle-show-undated');
    undated.setAttribute('data-pkc-field', 'schedule-undated');
    const done = document.createElement('button');
    done.type = 'button';
    // 🔑 板と**同じ action**(旗が 1 つなので、口も 1 つの意味論を共有する)
    done.setAttribute('data-pkc-action', 'toggle-show-done');
    done.setAttribute('data-pkc-field', 'schedule-done');
    // ⚠ 切替は 1 行に並べる(縦に積むと狭い列で嵩む)
    const archived = document.createElement('button');
    archived.type = 'button';
    // 🔑 板 / カレンダーと**同じ action**(旗が 1 つなので、口も同じ意味論を共有する)
    archived.setAttribute('data-pkc-action', 'toggle-show-archived');
    archived.setAttribute('data-pkc-field', 'schedule-archived');
    const toggles = document.createElement('div');
    toggles.setAttribute('data-pkc-field', 'schedule-toggles');
    toggles.append(undated, done, archived);
    const groups = document.createElement('div');
    groups.setAttribute('data-pkc-region', 'schedule-groups');
    this.region.append(bar, quick, grid, note, toggles, groups);
    this.frame = { month, grid, note, undated, done, archived, groups };
    return this.frame;
  }
}

/** 上限に触れたことを画面に出すための参照(切ったら黙らない)。 */
export const SCHEDULE_LIMITS = TASK_LIMITS;
