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
  type AgendaGroup,
  type AgendaItem,
  withTodayGroup,
} from '@features/schedule/agenda';
import { getMonthGrid, dateKey, viewedMarks } from '@features/schedule/month-grid';
import type { TaskCard } from '@features/schedule/task-cards';
import { holidayName } from '@features/schedule/jp-holidays';
import { materializedDates } from '@features/schedule/repeat';
import { isRealCalendarDate } from '@features/schedule/schedule-date';
import { entryFilterOf, matchesEntry, type EntryFilter } from '@features/filter/title-filter';
import { scheduleItemsOf } from './schedule-items';
import { passesOwnerFilter } from '@features/schedule/owner';
import { ScheduleBoard } from './schedule-board';
import { buildPressedButton } from './choice-buttons';
import { ScheduleDay } from './schedule-day';
import { ScheduleWeek } from './schedule-week';
import { ScheduleMonth } from './schedule-month';
import { weekOf } from '@features/schedule/day-layout';
import { addDays } from '@features/datetime/date-math';
import { createTaskCard, patchItemColor, patchTaskCard } from './task-card';
import { currentTagColors } from './tag-color';
import { noteColorVar } from '@features/schedule/item-color';
import { leadLabel, SCHEDULE_LEAD_OPTIONS } from '@features/schedule/schedule-notify';
import { appScheduleNotify } from './schedule-notify';
import { appAlarmEnabled } from './alarm-enabled';
import { appScheduleWeekStart } from './schedule-week-start';
import {
  weekdayHeads,
  weekStartLabel,
  WEEK_START_OPTIONS,
  type WeekStart,
} from '@features/schedule/week-start';
import { compareTitles } from '@features/filter/title-compare';

/**
 * 🔴 **「日」に出す 1 日ぶん**(#855 段 A-1)── **その日を「起点の日」にして** `buildAgenda` に束ねさせる。
 *
 * ⚠ 一覧の束(今日を起点に 62 日先まで)から拾わない ── 拾うと、繰り返しは**過ぎた日に 1 枚も出ず**、
 *   先の日も**回の上限(200)で途切れる**(`毎日` は 200 日先から空になる。着地前レビューが読んで指摘)。
 * 🔑 起点をその日にすると、繰り返しは**その日から**数えるので(`firstIndexFrom` が直に飛ぶ)、何年先でも
 *   過ぎた日でも 1 回ぶんだけ展開する。展開の規則は `buildAgenda` 1 本のまま(規則を 2 つ持たない)。
 * ⚠ 一覧が過ぎた回を出さないのは「期限切れが 340 個並ぶ」からで、1 日だけを見る面にその理由は当たらない。
 */
function dayItems(
  items: readonly AgendaItem[],
  day: string,
  skip: ReadonlyMap<string, ReadonlySet<string>>,
): readonly AgendaItem[] {
  return buildAgenda(items, day, false, { skip, horizonDays: 0 }).find((g) => g.date === day)?.cards ?? [];
}

/** 切替 1 つの行(チェックを包む `label`)。 */
function optionOf(box: HTMLInputElement): HTMLElement {
  return box.parentElement as HTMLElement;
}

/** 切替 1 つを描く。⚠ 出さないときは行ごと隠す。`checked` は旗にそろえる(押した直後の見た目と旗を食い違わせない)。 */
function setOption(box: HTMLInputElement, show: boolean, on: boolean, text: string): void {
  const row = optionOf(box);
  row.hidden = !show;
  if (!show) return;
  if (box.checked !== on) box.checked = on;
  const span = row.lastElementChild as HTMLElement;
  if (span.textContent !== text) span.textContent = text;
}

/**
 * 「出すもの」の脇の 1 行(既定に加えて出しているもの)。何も加えていなければ空(行ごと出さない)。
 * 🔑 既定のままなら黙る ── 「何も足していません」を毎回言うと、畳んだ意味が薄れる。
 */
export function shownExtrasText(state: {
  showDoneTasks: boolean;
  showArchived: boolean;
  showUndatedTasks: boolean;
}): string {
  const on: string[] = [];
  if (state.showDoneTasks) on.push('済み');
  if (state.showArchived) on.push('片付けたもの');
  if (state.showUndatedTasks) on.push('日付のないもの');
  return on.length === 0 ? '' : `${on.join('・')}も表示中`;
}

/** 「出すもの」のボタンの字。隠れている分が 1 件でもあれば `(N)` を添える(0 のときは付けない)。 */
export function foldButtonText(hidden: number): string {
  return hidden > 0 ? `出すもの(${hidden})` : '出すもの';
}

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
    /**
     * 🔴 **絞りで 0 件になったときの「絞りを外す」**(#1650 項目 1。Gemini 裁定 = #1163 の依頼 42-1 A)。
     * ⚠ 出すのは「予定が 1 件も出ていない」かつ「語か種類の札が在る」ときだけ(外す物が無いのに出すと dead click)。
     *   受け手は一覧・アプリ・連絡先と同じ `clear-entry-filter`(受け口を増やさない)。
     */
    clearFilter: HTMLButtonElement;
    undated: HTMLInputElement;
    /**
     * 🔴 **済んだ予定を戻す口**(2026-08-23、変異試験 S7 が教えた)。
     * ⚠ 直す前は済んだ行を**黙って外す**だけで、この面から戻す道が無かった ──
     *   板は「完了」の見出しが戻す口を兼ねていたが、予定の面には列が無いので
     *   **落ちていた**。「置けるなら外せる」の裏返し(片道を作らない)。
     */
    done: HTMLInputElement;
    /**
     * 🔴 **片付けたノートの予定を戻す口**(段⑤ で移した)。
     * ⚠ 直す前、`toggle-show-archived` の口は**カレンダーの面 1 つだけ**だった
     *   ── その面を落とすと `showArchived` は既定(false)から二度と動かせず、
     *   **片付けたノートの予定が永久に見えなくなる**。
     * 🔑 落とす前に**代わりを立てる**(CLAUDE.md「捨てるものの表は、行ごとに
     *   『代わりに何ができるようになるか』を書く」)。
     */
    archived: HTMLInputElement;
    /**
     * 🔴 **3 つの切替を 1 つに畳んだボタン「出すもの」**(#855。Gemini 裁定 = #1163 の依頼 10)と、
     *   いま既定に加えて出しているものを言う 1 行。
     */
    fold: HTMLDetailsElement;
    foldNote: HTMLElement;
    foldButton: HTMLElement;
    /**
     * 🔴 **「出すもの」の中のノートの一覧**(#855 20-A)。ノートごとにチェックがあり、外すとそのノートの予定が面から外れる。
     * `signature` は中身の指紋(同じなら DOM に触らない ── 開いている最中に作り直さない)。
     */
    notes: HTMLElement;
    notesList: HTMLElement;
    notesSignature: string;
    /**
     * 🔴 **予定の知らせ**(#855 20-C)。「知らせる時間」(`.ics` のアラーム)と「見逃した予定を知らせるか」。
     * 好みは端末の保存(`schedule-notify.ts`)にあり、ここは映すだけ。
     */
    lead: HTMLSelectElement;
    missed: HTMLInputElement;
    /** 🔴 予定の時刻に音で知らせるか(#1654 項 4。設定の「予定の知らせ」と同じ 1 つの設定を映す) */
    alarm: HTMLInputElement;
    /** 切替 3 つの行(1 つも出ないときは行ごと隠す ── `[hidden]`。CSS の `:has()` には頼らない、#1467 段 3-d) */
    toggles: HTMLElement;
    groups: HTMLElement;
    /** 「一覧 / 日 / 週」の 3 つ(#855 段 A-1 / A-2)。 */
    modes: HTMLButtonElement[];
    /** 「予定を足す」の日付の欄(「日」では見ている日に合わせる)。 */
    quickDate: HTMLInputElement;
    /** 🔴 週の始まり(日曜 / 月曜。#1163 の依頼 191)。 */
    weekStart: HTMLSelectElement;
    /** 🔴 担当で絞る(#283)。担当を書いた予定が 1 件も無い間は隠す。 */
    owner: HTMLSelectElement;
  } | null = null;
  /** 「予定を足す」の日付を最後に合わせた日(`null` = 合わせていない)。 */
  private quickDay: string | null = null;
  /** 「日」の描き手(#855 段 A-1)。一覧のときは隠すだけで捨てない(札と位置を使い回す)。 */
  private readonly day = new ScheduleDay(DROP_DATE);
  /** 「週」の描き手(#855 段 A-2)。広い面だけで描く(左の列は別のウィンドウで開く)。同じく隠すだけで捨てない。 */
  private readonly week = new ScheduleWeek(DROP_DATE);
  /** 「月」の描き手(#855)。広い面だけで描く。同じく隠すだけで捨てない。 */
  private readonly monthView = new ScheduleMonth(DROP_DATE);
  /** 「カンバン」の描き手(#277)。広い面だけで描く。同じく隠すだけで捨てない。 */
  private readonly board = new ScheduleBoard();
  private last: {
    scan: AppState['taskScan'];
    failed: boolean;
    /** 🔑 `entryMetas` の参照ではなく、**この面が読む列だけの指紋**(`metaSignature`)。 */
    metas: string;
    /** 予定の並び(`scheduleItemsOf` が `state.order` を辿る)── 参照で見る。 */
    order: AppState['order'];
    filter: string;
    kindFilter: AppState['kindFilter'];
    hits: AppState['searchHits'];
    showArchived: boolean;
    showDone: boolean;
    showUndated: boolean;
    hiddenNotes: AppState['scheduleHiddenNotes'];
    owner: AppState['scheduleOwner'];
    tagColors: ReturnType<typeof currentTagColors>;
    calendarMonth: AppState['calendarMonth'];
    mode: AppState['scheduleMode'];
    shownDay: string | null;
    selected: string | null;
    error: string | null;
    today: string;
    weekStart: WeekStart;
  } | null = null;

  /** `metaSignature` の控え(同じ `entryMetas` の参照なら前の答えを返す)。 */
  private metaMemo: { metas: AppState['entryMetas']; sig: string } | null = null;

  /**
   * 🔑 **この面が `entryMetas` から読む列だけの指紋**(#1087)。
   * 保存の ack は `entryMetas` を**必ず新しい Map** に差し替え(`updatedAt` が動く)、参照で比べると
   * **字が 1 つも変わらないのに** `scheduleItemsOf` と DOM の組み直しが毎回走る(3,000 件で約 39 ms)。
   * ⚠ 読む列は `lid`(札の相手)/ `title`(行の題・絞り込み)/ `archetype`(種類の札)/
   *   `date`(ノート丸ごとの予定)/ `archived`(片付けた)の 5 つ。`status` / `entryOrder` /
   *   `bodyChars` / `createdAt` / `updatedAt` は読まない(並びは `state.order` を別に見る)。
   *   ここに無い列をこの面が読み始めたら、**先にここへ足す**(足さないと描き直さない)。
   * ⚠ 区切りは NUL のエスケープ(題名に現れない。生バイトで埋めない)。
   * 🔑 同じ参照なら前の答え(選ぶだけの描画で全件を回さない)。
   */
  private metaSignature(metas: AppState['entryMetas']): string {
    if (this.metaMemo !== null && this.metaMemo.metas === metas) return this.metaMemo.sig;
    const SEP = '\u0000';
    const parts: string[] = [];
    for (const m of metas.values())
      parts.push(m.lid, m.title, m.archetype, m.date ?? '', m.archived ? '1' : '0');
    const sig = parts.join(SEP);
    this.metaMemo = { metas, sig };
    return sig;
  }

  /** ⚠ `now` は test 注入用(既定は実時刻)── 面ごとに `new Date()` を読まない。 */
  constructor(region: HTMLElement, now: (() => Date) | undefined = undefined) {
    this.region = region;
    this.now = now ?? ((): Date => new Date());
  }

  /**
   * 🔴 **次の 0 時に 1 回だけ描き直す予約**(#1163 の依頼 288 案 A)。
   * ⚠ 直す前は、日が変わったときの描き直しが「隠れていた窓がまた見えたとき」(`watchRelativeDays`)にしか無く、
   *   別のウィンドウに予定表を出しっぱなしにすると、0 時を過ぎても「今日」の印と期限切れの赤が前の日のままだった。
   * 🔑 常駐のタイマーではない ── 予定表が出ているあいだだけ、次の 0 時の 1 回ぶんを置く(描くたびに置き直し、
   *   隠れたら消す)。1 日 1 回なので重くならない。
   */
  private midnightTimer: ReturnType<typeof setTimeout> | null = null;
  private lastState: AppState | null = null;

  private shownNow(): boolean {
    return this.region.isConnected && this.region.closest('[hidden]') === null;
  }

  private armMidnight(at: Date): void {
    if (this.midnightTimer !== null) {
      clearTimeout(this.midnightTimer);
      this.midnightTimer = null;
    }
    if (!this.shownNow()) return;
    const next = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, 0, 0, 1);
    const wait = Math.max(1000, next.getTime() - at.getTime());
    this.midnightTimer = setTimeout(() => {
      this.midnightTimer = null;
      // 指紋の「今日」が変わるので、同じ状態でも描き直される。出ていないなら、次に見えたときに描く
      this.last = null;
      if (this.lastState !== null && this.shownNow()) this.render(this.lastState);
    }, wait);
  }

  private weekStartWatched = false;

  /** 🔴 週の始まりを変えたら、いま出ている面を描き直す(状態は動かないので、自分で受ける)。 */
  private watchWeekStart(): void {
    if (this.weekStartWatched) return;
    this.weekStartWatched = true;
    appScheduleWeekStart.subscribe(() => {
      this.last = null;
      if (this.lastState !== null && this.shownNow()) this.render(this.lastState);
    });
  }

  render(state: AppState): void {
    const at = this.now();
    this.lastState = state;
    this.armMidnight(at);
    const today = dateKey(at.getFullYear(), at.getMonth() + 1, at.getDate());
    const weekStart = appScheduleWeekStart.get();
    // 🔴 見せ方は**この面の器**で選ぶ(狭い面 = 左の列は `scheduleNarrowMode` / 広い面は `scheduleMode`)
    const narrow = this.region.hasAttribute('data-pkc-browse-pane');
    const next = {
      scan: state.taskScan,
      failed: state.taskScanFailed,
      metas: this.metaSignature(state.entryMetas),
      order: state.order,
      filter: state.filterQuery,
      // 🔴 **種類の絞りも指紋**(#411)── 入れないと札を押しても描き直さない
      // ⚠ 鍵は `kindFilter`(`filerRows` へ渡す `kinds:` と**綴りを分ける**)──
      //   同じ綴りだと、指紋を見張る test が options の行に満たされる
      kindFilter: state.kindFilter,
      hits: state.searchHits,
      showArchived: state.showArchived,
      showDone: state.showDoneTasks,
      showUndated: state.showUndatedTasks,
      // 🔴 隠したノートと、タグの色も指紋(縦線の色が変わる ── 入れないと描き直さない)
      hiddenNotes: state.scheduleHiddenNotes,
      // 🔴 担当の絞りも指紋(#283。入れないと選んでも描き直さない)
      owner: state.scheduleOwner,
      tagColors: currentTagColors(),
      calendarMonth: state.calendarMonth,
      // 🔴 見せ方と見ている日も指紋(入れないと「日」を押しても描き直さない)
      mode: narrow ? state.scheduleNarrowMode : state.scheduleMode,
      shownDay: state.scheduleDay,
      selected: state.selectedLid,
      error: state.error,
      today,
      // 🔴 週の始まりも指紋(変えたのに描き直さない、を作らない ── #1163 の依頼 191)
      weekStart,
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
    this.watchWeekStart();
    // 🔴 知らせの好みを映す(押された値は binder が保存する ── ここは読み戻すだけ)
    const leadValue = String(appScheduleNotify.lead());
    if (frame.lead.value !== leadValue) frame.lead.value = leadValue;
    const missedOn = appScheduleNotify.missedOn();
    if (frame.missed.checked !== missedOn) frame.missed.checked = missedOn;
    const alarmOn = appAlarmEnabled.enabled();
    if (frame.alarm.checked !== alarmOn) frame.alarm.checked = alarmOn;
    /**
     * ⚠ **種類の絞りもこの面に効かせる**(#411)── 効かせないと、札を押した
     *   まま予定タブへ移ったときに**そこだけ全部出る**。user からは
     *   「絞りが勝手に解けた」としか見えない(CLAUDE.md §7)。
     * 🔑 札の相手は**行が載っているノート**である(予定の行そのものに種類は無い)。
     */
    const filter = entryFilterOf(state.filterQuery, state.searchHits, state.kindFilter);
    /**
     * 🔑 **何を出すかは `scheduleItemsOf` 1 か所**(`.ics` の書き出しも同じ口を呼ぶ ── §7)。
     * 絞り込み・片付けた・済んだ行の規則と、ノート 1 件が丸ごと予定のもの(frontmatter の `date:`、段④)もそこにある。
     */
    const { all, visible, notes, items, byNote, hiddenByNote, doneNotes, owners } = scheduleItemsOf(state);
    this.paintOwner(frame.owner, owners, state.scheduleOwner);
    const dated = visible.filter((c) => c.date !== null);
    /**
     * 🔴 **済んだ回は「絞り込む前」の札から拾う**(#344 段②)。
     *
     * ⚠ `visible` から拾ってはいけない ── 既定では**済んだ札を隠す**ので、
     *   実体の行(`- [x] ゴミ出し @2026-08-31`)は消えている。消えたまま渡すと
     *   **済ませたはずの回がもう一度出る**(しかも押しても「同じ行が既に在る」で
     *   何も起きないので、user から見ると**壊れて見える**)。
     * ⚠ 片付けたノートの札も入れる ── 同じ理由(隠れているだけで実体は在る)。
     */
    /**
     * 🔴 **「週」は広い面だけ**(#855 段 A-2)。左の列(`data-pkc-browse-pane`)は 7 日を並べる幅が無く、
     *   `scheduleNarrowMode`(一覧 / 日だけ)を自分の見せ方に持つ ── 「週」を押すと別のウィンドウで開く(`binder.ts`)。
     */
    const mode = narrow ? state.scheduleNarrowMode : state.scheduleMode;
    const dayMode = mode === 'day';
    const weekMode = mode === 'week';
    const monthMode = mode === 'month';
    const boardMode = mode === 'board';
    const shown = state.scheduleDay ?? today;
    const skip = materializedDates(all);
    const groups = buildAgenda(items, today, state.showUndatedTasks, { skip });

    // 🔑 点は**束から**引く(下の docstring)── 期間の展開を 2 か所で決めない
    this.paintMonth(
      frame,
      state,
      today,
      groups,
      viewedMarks(mode, shown, weekOf(shown, weekStart) ?? weekOf(today, weekStart) ?? []),
      weekStart,
    );
    if (frame.weekStart.value !== String(weekStart)) frame.weekStart.value = String(weekStart);
    frame.note.textContent = this.noteText(
      state,
      all.length + notes.length,
      dated.length + notes.length,
      groups.length,
      hiddenByNote,
    );
    const filterOn = state.filterQuery.trim() !== '' || state.kindFilter.size > 0;
    const showClear = groups.length === 0 && filterOn;
    if (frame.clearFilter.hidden === showClear) frame.clearFilter.hidden = !showClear;
    const undatedCount = this.paintUndatedToggle(frame.undated, state, visible.length - dated.length);
    const doneCount = this.paintDoneToggle(frame.done, state, all, filter, doneNotes);
    const archivedCount = this.paintArchivedToggle(frame.archived, state, all);
    /**
     * 🔴 **「出すもの(N)」= いま隠れている分の合計**(#855。Gemini 裁定 = #1163 の依頼 12-C)。
     * ⚠ 3 つのチェックと**同じ数**から足す(別に数え直すと、中の `(N)` と食い違う)。出している切替の分は隠れていないので足さない。
     */
    const hiddenTotal =
      (state.showDoneTasks ? 0 : doneCount) +
      (state.showArchived ? 0 : archivedCount) +
      (state.showUndatedTasks ? 0 : undatedCount) +
      // 🔴 ノートを隠したせいで出ていない予定(上の 3 つとは重ならない ── 数えるのは他の絞りを通った分だけ)
      hiddenByNote;
    const foldLabel = foldButtonText(hiddenTotal);
    if (frame.foldButton.textContent !== foldLabel) frame.foldButton.textContent = foldLabel;
    const foldText = shownExtrasText(state);
    if (frame.foldNote.textContent !== foldText) frame.foldNote.textContent = foldText;
    frame.foldNote.hidden = foldText === '';
    /**
     * 🔴 **切替が 1 つも出ないときは行ごと隠す ── JS で決める**(#1467 段 3-d)。
     * ⚠ 直す前は CSS の `[data-pkc-field='schedule-toggles']:not(:has(button:not([hidden])))` が
     *   決めていた。`:has(button:not([hidden]))` は**文書のどこで button が入っても / `hidden` が
     *   動いても**祖先を遡って再評価されるので、長いノートの描き直しのたびに MAIN まで
     *   1,000 件の無効化を予約していた(trace、追記 1 回)。この行の中身を知っているのはここなので、
     *   ここで `hidden` を決める。
     */
    this.paintNoteList(frame, state, byNote);
    const anyToggle =
      !optionOf(frame.undated).hidden ||
      !optionOf(frame.done).hidden ||
      !optionOf(frame.archived).hidden ||
      !frame.notes.hidden;
    if (frame.toggles.hidden !== !anyToggle) frame.toggles.hidden = !anyToggle;
    /**
     * 一覧は日ごとの束、「日」は 1 日の目盛り。⚠ 「日」のときも**日付のない束**は一覧の器に残す
     * (「日付のない項目も出す」の切替が、どちらの見せ方でも効く)。
     */
    for (const m of frame.modes) {
      const on = m.getAttribute('data-pkc-mode') === mode;
      const pressed = on ? 'true' : 'false';
      if (m.getAttribute('aria-pressed') !== pressed) m.setAttribute('aria-pressed', pressed);
    }
    this.day.el.hidden = !dayMode;
    this.week.el.hidden = !weekMode;
    this.monthView.el.hidden = !monthMode;
    this.board.el.hidden = !boardMode;
    /**
     * 🔴 **「日」では、「予定を足す」の日付を見ている日に合わせる**(#499 の「見ているところに足したら、
     *   見ているところに出る」を「日」でも保つ。動線レビューの指摘)。⚠ 合わせるのは**日が変わったときだけ** ──
     *   描き直しのたびに入れ直すと、user が欄を直した字(空にする = 日付なしで足す、も含む)を奪う。
     */
    const weekDays = weekMode ? (weekOf(shown, weekStart) ?? weekOf(today, weekStart) ?? []) : [];
    if (dayMode && this.quickDay !== shown) {
      frame.quickDate.value = shown;
      this.quickDay = shown;
    } else if (weekMode && this.quickDay !== `week ${weekDays[0] ?? ''}`) {
      // 🔑 「週」では、週が変わったときだけ合わせる(今日を含む週は今日 / 他の週はその週の最初の日)
      frame.quickDate.value = weekDays.includes(today) ? today : (weekDays[0] ?? today);
      this.quickDay = `week ${weekDays[0] ?? ''}`;
    } else if (!dayMode && !weekMode) this.quickDay = null;
    if (weekMode) {
      const thisWeek = weekOf(today, weekStart) ?? [];
      // 🔑 行き先が今日を含む週なら空(= 今日に追従する状態へ戻る)── 「日」と同じ
      const goTo = (n: number): string => {
        const d = addDays(shown, n);
        if (d === null) return '';
        return (weekOf(d, weekStart) ?? []).includes(today) ? '' : d;
      };
      this.week.paint({
        days: weekDays,
        today,
        itemsOf: (d) => dayItems(items, d, skip),
        titleOf: (lid) => state.entryMetas.get(lid)?.title ?? '',
        selectedLid: state.selectedLid,
        year: at.getFullYear(),
        settled: state.taskScan !== null,
        prevTo: goTo(-7),
        nextTo: goTo(7),
        isThisWeek: weekDays[0] !== undefined && weekDays[0] === thisWeek[0],
      });
    } else this.week.leave();
    if (monthMode) {
      this.monthView.paint({
        year: state.calendarMonth?.year ?? at.getFullYear(),
        month: state.calendarMonth?.month ?? at.getMonth() + 1,
        today,
        itemsOf: (d) => dayItems(items, d, skip),
        titleOf: (lid) => state.entryMetas.get(lid)?.title ?? '',
        selectedLid: state.selectedLid,
        thisYear: at.getFullYear(),
        weekStart,
      });
    } else this.monthView.leave();
    if (boardMode) {
      /**
       * 🔴 **カンバンは「済み」を畳む旗に関わらず、未完了と完了の両方を出す**(#277)── 列が状態そのものだから。
       * ⚠ 絞り込み(探す欄・種類・片付けた・隠したノート)は他の見せ方と同じ口(`scheduleItemsOf`)を通す。
       */
      this.board.paint({
        items: scheduleItemsOf({ ...state, showDoneTasks: true }).items,
        titleOf: (lid) => state.entryMetas.get(lid)?.title ?? '',
        selectedLid: state.selectedLid,
        thisYear: at.getFullYear(),
        settled: state.taskScan !== null,
      });
    } else this.board.leave();
    if (dayMode) {
      this.day.paint({
        day: shown,
        today,
        items: dayItems(items, shown, skip),
        titleOf: (lid) => state.entryMetas.get(lid)?.title ?? '',
        selectedLid: state.selectedLid,
        year: at.getFullYear(),
        settled: state.taskScan !== null,
      });
    } else this.day.leave();
    /**
     * 🔴 **「日 / 週 / 月」でも、暦に無い日付(`@2026-02-30`)の束は一覧の器に残す**(#1087)。
     * ⚠ 直す前は日付なしの束だけを残したので、暦に無い日の予定は**一覧には出るのに、
     *   日・週・月では黙って消えた**(どの日の目盛りにも載らず、理由も出ない)。
     * 🔑 日付なしの束と同じ場所に出す ── 目盛りに置けない予定の置き場は 1 つにする。
     */
    this.paintGroups(
      frame.groups,
      dayMode || weekMode || monthMode || boardMode
        ? groups.filter((g) => g.date === null || !isRealCalendarDate(g.date))
        : // 🔴 一覧だけ「今日」の見出しを 0 件でも出す(#1626)── 点・件数の文・空の判定は上の `groups` のまま
          state.taskScan !== null
          ? withTodayGroup(groups, today)
          : groups,
      state,
    );
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
    /** 🔴 いま見ている日 / 週(#855。`viewedMarks`)── 升目と行に印を付ける。 */
    marks: ReturnType<typeof viewedMarks>,
    weekStart: WeekStart,
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
    for (const w of weekdayHeads(weekStart)) {
      const cell = document.createElement('span');
      cell.textContent = w.label;
      // 🔴 土日の見出しは薄く沈める(#855。地は無彩色のまま ── 色は情報にだけ使う)。⚠ 並びの位置ではなく曜日で決める(月曜始まりでも土日)
      if (w.dow === 0 || w.dow === 6) cell.setAttribute('data-pkc-weekend', '');
      head.append(cell);
    }
    frame.grid.append(head);
    for (const week of getMonthGrid(year, month, weekStart)) {
      const row = document.createElement('div');
      row.setAttribute('data-pkc-field', 'schedule-week');
      // 🔴 見ている週は行ごと色を付ける(月外の空き枠も含めて 1 行 ── 週の途中で月が替わっても帯が切れない)
      if (week.some((d) => d !== null && marks.week.includes(dateKey(year, month, d))))
        row.setAttribute('data-pkc-viewed-week', '');
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
        // 🔴 祝日は数字を赤くして名前を `title` に出す(#855。`jp-holidays.ts`)
        const holiday = holidayName(key);
        if (holiday !== null) {
          cell.setAttribute('data-pkc-holiday', '');
          cell.title = holiday;
        }
        if (has.has(key)) cell.setAttribute('data-pkc-has', '');
        // 🔴 「日」で見ている日の升目(#855)── 押した結果がその場で見える
        if (key === marks.day) cell.setAttribute('data-pkc-viewed', '');
        row.append(cell);
      }
      frame.grid.append(row);
    }
  }

  /**
   * 状態の 1 行。⚠ **「まだ」「駄目だった」「無い」「切った」を区別する**。
   */
  private noteText(
    state: AppState,
    total: number,
    dated: number,
    groups: number,
    hiddenByNote: number,
  ): string {
    if (state.taskScanFailed)
      return '予定を集められませんでした。開き直すともう一度試します。';
    if (state.taskScan === null) return '予定を集めています…';
    if (state.taskScan.truncated)
      return `多いので途中まで出しています(候補のノートは ${state.taskScan.totalNotes} 件)。`;
    if (total === 0)
      return 'チェックリストの行(- [ ] やること)がまだありません。ノートに「- [ ] やること」と書くと、ここに出ます。';
    /**
     * 🔴 **「日付が無いから出ていない」を、はっきり書く。**
     * ⚠ 書かないと user は「チェックを書いたのに何も出ない」と読み、
     *   **書き方が分からないまま詰まる**(既定で畳んだ側の責任である)。
     */
    // 🔴 ノートを隠したせいで 1 件も出ていないときは、そう言う(「日付を書いてください」と読ませない)
    if (groups === 0 && hiddenByNote > 0)
      return '「出すもの」でノートを外しているため、予定が出ていません。';
    /**
     * 🔴 **何も出ていない理由が「探す欄の語」「済みを隠している」なら、そう言う**(#1087 S5)。
     * ⚠ 言わないと下の「日付を書いた予定がまだありません」と読めてしまい、**在る予定を「無い」と言う**。
     */
    if (groups === 0 && state.filterQuery.trim() !== '')
      return '探す欄の語に合う予定がありません。';
    if (
      groups === 0 &&
      !state.showDoneTasks &&
      state.taskScan.cards.some((c) => c.done && (c.date !== null || state.showUndatedTasks))
    )
      return '済んだ予定は隠れています。「出すもの」で「済み」を出すと見えます。';
    /**
     * 🔴 **日付を書いた予定が「片付けたノート」にだけ在るなら、そう言う**(#1087)。
     * ⚠ 言わないと下の「日付を書いた予定がまだありません」になり、**在る予定を「無い」と言う**。
     *   ボタンの字は「出すもの」の中の「片付けたもの(N)」(`paintArchivedToggle`)。
     */
    if (
      groups === 0 &&
      !state.showArchived &&
      (state.taskScan.cards.some(
        (c) =>
          state.entryMetas.get(c.lid)?.archived === true &&
          (c.date !== null || state.showUndatedTasks),
      ) ||
        [...state.entryMetas.values()].some((m) => m.archived && m.date !== null))
    )
      return '片付けたノートの予定は隠れています。「出すもの」で「片付けたもの」を出すと見えます。';
    if (dated === 0 && !state.showUndatedTasks)
      // ⚠ 書式バーは編集中にしか無い ── 予定の画面で使える入口(「予定を足す」)を言う(#1087)
      return '日付を書いた予定がまだありません。「- [ ] やること @2026-08-25」のように書くか、上の「予定を足す」で日付を選んで足してください。';
    if (groups === 0) return '絞り込みに当てはまる予定がありません。';
    return '';
  }

  /**
   * 🔴 **「出すもの」の中のノートの一覧**(#855。Gemini 裁定 = #1163 の依頼 20-A「このカレンダーだけ」)。
   *
   * 予定のあるノートを 1 行ずつ並べ、チェックを外すとそのノートの予定が面から外れる(ノートは消えない)。
   * 行頭の細い四角は、そのノートの縦線の色(行にタグの色があるときはタグの色が勝つ)。
   * ⚠ **選ぶ物が無い一覧は出さない**(予定を持つノートが 2 件に満たなければ枠ごと隠す)。
   * ⚠ 隠したノートは、予定が 0 件に見えても**一覧に残す**(戻す口を消さない ── 片道にしない)。
   */
  private paintNoteList(
    frame: NonNullable<ScheduleRenderer['frame']>,
    state: AppState,
    byNote: readonly { readonly lid: string; readonly count: number }[],
  ): void {
    const hidden = new Set(state.scheduleHiddenNotes);
    // 隠したが予定が 0 件になったノート(検索の絞りで外れた等)は、隠したままなので載せる
    const rows = byNote.map((n) => ({ ...n, title: state.entryMetas.get(n.lid)?.title ?? '' }));
    rows.sort((a, b) => compareTitles(a.title, b.title) || (a.lid < b.lid ? -1 : 1));
    const sig = rows
      .map((r) => `${r.lid}\t${r.title}\t${r.count}\t${hidden.has(r.lid) ? 1 : 0}`)
      .join('\n');
    // 🔑 ノートが 1 つしか無いなら出さない(1 つを隠しても「全部隠す」になるだけ ── 選ぶ物が無い)。隠した後も 2 つ以上のまま残る
    const show = rows.length >= 2;
    if (frame.notes.hidden !== !show) frame.notes.hidden = !show;
    if (frame.notesSignature === sig) return;
    frame.notesSignature = sig;
    const list = frame.notesList;
    list.textContent = '';
    for (const r of rows) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !hidden.has(r.lid);
      // ⚠ 口(`data-pkc-action`)は字で書く(`tests/action-outlets.test.ts` が静的に追う)
      box.setAttribute('data-pkc-action', 'toggle-schedule-note');
      box.setAttribute('data-pkc-note-lid', r.lid);
      box.setAttribute('data-pkc-field', 'schedule-note-toggle');
      const swatch = document.createElement('span');
      swatch.setAttribute('data-pkc-field', 'schedule-note-swatch');
      swatch.style.setProperty('--pkc-item-color', noteColorVar(r.lid));
      const name = document.createElement('span');
      name.setAttribute('data-pkc-field', 'schedule-note-name');
      name.textContent = `${r.title === '' ? '(無題)' : r.title}(${r.count})`;
      name.title = r.title;
      const label = document.createElement('label');
      label.setAttribute('data-pkc-field', 'schedule-option');
      label.append(box, swatch, name);
      list.append(label);
    }
  }

  /**
   * 🔴 **担当の選択肢を詰める**(#283)。⚠ **担当を書いた予定が無く、絞ってもいないなら出さない**
   * (押しても何も起きない口を作らない)。いま絞っている名前が選択肢から消えても、選んだ行は残す
   * (黙って「全員」に戻すと、絞ったつもりの画面が突然増える)。
   */
  private paintOwner(sel: HTMLSelectElement, owners: readonly string[], current: string | null): void {
    const show = owners.length > 0 || current !== null;
    if (sel.hidden === show) sel.hidden = !show;
    const names = current !== null && current !== '' && !owners.includes(current) ? [...owners, current] : [...owners];
    const rows: Array<[string, string]> = [
      ['\u0000all', '担当: すべて'],
      ['\u0000none', '担当なし'],
      ...names.map((n): [string, string] => [n, n]),
    ];
    const sig = rows.map((r) => r[0]).join('\n');
    if (sel.getAttribute('data-pkc-sig') !== sig) {
      sel.textContent = '';
      for (const [value, label] of rows) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        sel.append(o);
      }
      sel.setAttribute('data-pkc-sig', sig);
    }
    const want = current === null ? '\u0000all' : current === '' ? '\u0000none' : current;
    if (sel.value !== want) sel.value = want;
  }

  /** 「日付のない項目も出す」の切替。⚠ **押しても何も起きないボタンを出さない**。 */
  private paintUndatedToggle(box: HTMLInputElement, state: AppState, undated: number): number {
    const show = undated > 0 || state.showUndatedTasks;
    setOption(box, show, state.showUndatedTasks, `日付のないもの(${undated})`);
    return undated;
  }

  /**
   * 「済んだ予定も出す」の切替。
   * ⚠ **件数は「隠れている分」**(押す前に何件戻るか分かる)── そして
   *   チェックを付けたときに**この数が増える**のが、保存された手応えになる。
   */
  private paintDoneToggle(
    box: HTMLInputElement,
    state: AppState,
    all: readonly TaskCard[],
    filter: EntryFilter,
    doneNotes: number,
  ): number {
    // ⚠ 数えるのは**この面に出る条件を満たしたうえで済んでいる**もの
    // (隠したノートの済んだ札は、ここではなく「隠したノートの分」に数える ── 依頼 247 案 C。`schedule-items.ts`)
    const hidden = doneNotes + all.filter((c) => {
      if (!c.done) return false;
      // 🔴 隠したノートの分は「済み(N)」に入れない(押して出る数に合わせる。隠したノートの分に数える ── 依頼 247 案 C)
      if (state.scheduleHiddenNotes.includes(c.lid)) return false;
      const m = state.entryMetas.get(c.lid);
      if (m === undefined) return false;
      if (m.archived && !state.showArchived) return false;
      if (c.date === null && !state.showUndatedTasks) return false;
      // 🔴 担当の絞り(#283)── 押して出る数に合わせる
      if (!passesOwnerFilter(c.owner, state.scheduleOwner)) return false;
      return matchesEntry(m, filter);
    }).length;
    const show = hidden > 0 || state.showDoneTasks;
    setOption(box, show, state.showDoneTasks, `済み(${hidden})`);
    return hidden;
  }

  /**
   * 「片付けたノートの予定も出す」の切替(段⑤ でカレンダーから移した)。
   * ⚠ **片付けた物が 1 つも無ければ出さない** ── 押しても何も起きないボタンにしない。
   */
  private paintArchivedToggle(
    box: HTMLInputElement,
    state: AppState,
    all: readonly TaskCard[],
  ): number {
    // ⚠ 行の札とノートの予定の**両方**を数える(片方だけ数えると 0 件に見える)
    const lids = new Set<string>();
    for (const c of all) if (state.entryMetas.get(c.lid)?.archived === true) lids.add(c.lid);
    for (const [lid, m] of state.entryMetas)
      if (m.archived && m.date !== null) lids.add(lid);
    const show = lids.size > 0 || state.showArchived;
    setOption(box, show, state.showArchived, `片付けたもの(${lids.size})`);
    return lids.size;
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
      plus.setAttribute('aria-label', 'この日の予定を足す');
      plus.title = 'この日の予定を足します(上の欄に日付が入ります)';
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
      patchItemColor(card, data);
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
      // 見えている字は ‹ › だけ。この送りは月単位(`schedule-month.ts` の大きな月の送りと同じ字)
      b.setAttribute('aria-label', step === -1 ? '前の月' : '次の月');
      return b;
    };
    const month = document.createElement('span');
    month.setAttribute('data-pkc-field', 'schedule-month');
    const todayBtn = document.createElement('button');
    todayBtn.type = 'button';
    todayBtn.setAttribute('data-pkc-action', 'schedule-today');
    todayBtn.textContent = '今月に戻る';
    /**
     * 🔴 **いま見ている範囲を紙に出す**(#855。Gemini 裁定 = #1163 の依頼 30 の Q2)。
     * 出るのは見せ方ごとの範囲だけ(月 = 大きな升目 / 週 = 1 週間の目盛り / 日 = その日 / 一覧 = 日ごとの一覧)。
     * 何を残すかは押した時に `binder.ts` が決め、紙の組みは `app.css` 末尾の `@media print` にある。
     * ⚠ 字は「印刷」(ノートの「PDF」と同じ、ブラウザの印刷画面を開くだけ)。
     */
    const printBtn = document.createElement('button');
    printBtn.type = 'button';
    printBtn.setAttribute('data-pkc-action', 'schedule-print');
    printBtn.setAttribute('data-pkc-field', 'schedule-print');
    printBtn.textContent = '印刷';
    printBtn.title = 'いま見ている範囲(月・週・日・一覧)だけを、白い紙 1 枚に収めて印刷します';
    bar.append(nav('‹', -1), month, nav('›', 1), todayBtn, printBtn);
    /**
     * 🔴 **見せ方 2 つ ── 一覧 / 日**(#855 段 A-1)。既定は一覧(いままでの見え方)。
     * ⚠ 押している側は `aria-pressed` + 濃さ(`data-pkc-choice-btn` の規則)で示す。
     */
    const modeRow = document.createElement('div');
    modeRow.setAttribute('data-pkc-field', 'schedule-modes');
    modeRow.setAttribute('role', 'group');
    modeRow.setAttribute('aria-label', '予定の見せ方');
    const modes = (
      [
        ['list', '一覧', '日ごとの一覧で見ます'],
        ['day', '日', '1 日を時間の目盛りに並べて見ます'],
        [
          'week',
          '週',
          this.region.hasAttribute('data-pkc-browse-pane')
            ? '別のウィンドウで、1 週間を時間の目盛りに並べて開きます'
            : '1 週間を時間の目盛りに並べて見ます',
        ],
        [
          'month',
          '月',
          // 🔑 左の列は 7 列の升目を並べる幅が無い ── 「週」と同じく別のウィンドウで開く
          this.region.hasAttribute('data-pkc-browse-pane')
            ? '別のウィンドウで、1 か月を日ごとの欄に分けて開きます'
            : '1 か月を、日ごとの欄に分けて見ます',
        ],
        /**
         * 🔴 **カンバン**(#277。user 指示 2026-08-19「カンバンとカレンダーを復活」)。状態(未完了 / 完了)を列に並べ、
         * 札を掴んで列の間を動かすと本文のチェックが切り替わる。⚠ **別のウィンドウの予定表だけ**(左の列は2 列を並べる幅が無い)。
         */
        ...(this.region.hasAttribute('data-pkc-browse-pane')
          ? []
          : ([
              ['board', 'カンバン', '未完了と完了を列に並べて見ます(カードを列の間でドラッグすると、チェックが切り替わります)'],
            ] as const)),
      ] as const
    )
      .map(([mode, label, title]) =>
      buildPressedButton({
        action: 'schedule-mode',
        dataAttr: 'data-pkc-mode',
        value: mode,
        label,
        pressed: mode === 'list',
        title,
      }),
    );
    /**
     * 🔴 **週の始まり**(#1163 の依頼 191)。「週」と「月」と小さな月の並びが変わる(日付・予定は変わらない)。
     * ⚠ 口は字で書く(`tests/action-outlets.test.ts` が静的に追う)。保存は端末の好み ── `schedule-week-start.ts`。
     */
    const weekStartSel = document.createElement('select');
    weekStartSel.setAttribute('data-pkc-field', 'schedule-week-start');
    weekStartSel.setAttribute('data-pkc-action', 'set-schedule-week-start');
    weekStartSel.setAttribute('aria-label', '週の始まり');
    weekStartSel.title = '週と月の並びを、日曜から始めるか月曜から始めるかを選びます(日付や予定は変わりません)';
    for (const n of WEEK_START_OPTIONS) {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = weekStartLabel(n);
      weekStartSel.append(o);
    }
    /**
     * 🔴 **担当で絞る**(#283。エントリ / グループをタスクとして扱う)。選択肢は予定の面に出うる担当だけ
     * (`scheduleItemsOf` の `owners`)── 中身は描くたびに `paintOwner` が詰める。
     * ⚠ 口は字で書く(`tests/action-outlets.test.ts` が静的に追う)。見え方だけ ── 本文にも保存にも触れない。
     */
    const ownerSel = document.createElement('select');
    ownerSel.setAttribute('data-pkc-field', 'schedule-owner');
    ownerSel.setAttribute('data-pkc-action', 'set-schedule-owner');
    ownerSel.setAttribute('aria-label', '担当で絞る');
    ownerSel.title = '担当で絞ります(ノートの前書きの owner: か、チェック項目の「担当:名前」)';
    ownerSel.hidden = true;
    modeRow.append(...modes, weekStartSel, ownerSel);
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
    // 🔴 欄・ボタン・断り文の呼び名を「予定」にそろえた(#1163 の依頼 57-3。以前は「やること」「予定を足す」「予定の字」の 3 通り)
    qText.placeholder = '予定(例: 打ち合わせ)';
    qText.setAttribute('aria-label', '足す予定');
    const qDate = document.createElement('input');
    qDate.type = 'date';
    qDate.setAttribute('data-pkc-field', 'schedule-quick-date');
    // 🔴 押すと、本文に日付を差すときと同じ近道つきの選び方が開く(#1635 項 2)
    qDate.setAttribute('data-pkc-action', 'schedule-pick-date');
    qDate.setAttribute('aria-label', 'いつの予定');
    /**
     * 🔴 **最初から今日を入れておく**(#499。user 指摘 2026-08-28
     * 「**カレンダー表示してるのに、「足す」のところにもカレンダーインプットが
     * あったりで意味不明**」)。
     *
     * ⚠ 直す前は**空**だった。空のまま押すと `binder.ts` は
     * **日付を書かずに**今日のノートへ足すので、🔴 **いま見ているカレンダーには
     * 1 つも出てこない** ── しかも「日付のない項目」は既定で畳んでいるので、
     * **何も起きなかったように見える**。
     *
     * 🔑 「カレンダーを見ながら足したら、見ているところに出る」を既定にする。
     * ⚠ **日付なしで足す道は残る** ── 欄を空にしてから押せばよい
     *   (だから「空なら今日を入れ直す」はしない。入れ直すと**空にできなくなる**)。
     * ⚠ 束の見出しの `+`(その日を欄に入れる)は**そのまま生きる**。
     */
    qDate.value = dateKey(
      this.now().getFullYear(),
      this.now().getMonth() + 1,
      this.now().getDate(),
    );
    /**
     * 🔴 **時刻の欄**(#1163 の依頼 57-4。Gemini の裁定:推薦どおり = 空けておける時刻の欄を足す)。
     * ⚠ 直す前は「打ち合わせ 14:00」と打っても 14:00 は題名の一部になり、時刻として読まれなかった(音も鳴らない)。
     *   字の中の時刻を推し量らず、欄で選ぶ。空のままなら終日(これまでどおり)。
     */
    const qTime = document.createElement('input');
    qTime.type = 'time';
    qTime.setAttribute('data-pkc-field', 'schedule-quick-time');
    qTime.setAttribute('aria-label', '予定の時刻(空なら終日)');
    qTime.title = '時刻を選ぶと、その時刻の予定になります(空のままなら終日です。日付も選んでください)';
    const qAdd = document.createElement('button');
    qAdd.type = 'button';
    qAdd.setAttribute('data-pkc-action', 'schedule-quick-add');
    qAdd.textContent = '予定を足す';
    // ⚠ **どこへ書くか**と**どの日に出るか**を両方言う(#499)── 日付の欄が
    //    何を決めているのかが読めないと、「足したのに出てこない」になる
    qAdd.title =
      '今日のノートの末尾に、チェック項目として書きます。左の日付の日に出ます(空にすると日付なしで足します)';
    quick.append(qText, qDate, qTime, qAdd);
    const grid = document.createElement('div');
    grid.setAttribute('data-pkc-field', 'schedule-grid');
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'schedule-note');
    const clearFilter = document.createElement('button');
    clearFilter.type = 'button';
    clearFilter.hidden = true;
    clearFilter.setAttribute('data-pkc-action', 'clear-entry-filter');
    clearFilter.setAttribute('data-pkc-field', 'schedule-clear-filter');
    clearFilter.textContent = '絞りを外す';
    clearFilter.title = '一覧の絞り込みを空にして、予定を全部出します。';
    /**
     * 🔴 **3 つの切替は 1 つのボタン「出すもの」に畳む**(#855。Gemini 裁定 = #1163 の依頼 10)。
     * ⚠ 押すとチェックが 3 つ開く(中央を奪わない小さな枠。モーダルにしない)。**口(`data-pkc-action`)は
     *   前のまま** ── 3 つとも板 / カレンダーと同じ action を共有する(旗が 1 つなので意味論も 1 つ)。
     * 🔑 器は `<details>`(キーボードで開け閉めでき、開いているかをこちらで持たない)。
     * ⚠ **押しても何も起きない切替は出さない**(前からの規則)── 3 つとも出ないときは行ごと隠す。
     */
    // ⚠ 口(`data-pkc-action`)は**字で書く**(変数で配ると `tests/action-outlets.test.ts` が静的に追えなくなる)
    const option = (field: string): HTMLInputElement => {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.setAttribute('data-pkc-field', field);
      const text = document.createElement('span');
      const label = document.createElement('label');
      label.setAttribute('data-pkc-field', 'schedule-option');
      label.append(box, text);
      return box;
    };
    const undated = option('schedule-undated');
    undated.setAttribute('data-pkc-action', 'toggle-show-undated');
    const done = option('schedule-done');
    done.setAttribute('data-pkc-action', 'toggle-show-done');
    const archived = option('schedule-archived');
    archived.setAttribute('data-pkc-action', 'toggle-show-archived');
    const fold = document.createElement('details');
    fold.setAttribute('data-pkc-field', 'schedule-fold');
    const summary = document.createElement('summary');
    summary.setAttribute('data-pkc-field', 'schedule-fold-button');
    summary.textContent = '出すもの';
    summary.title = '済み・片付けたもの・日付のないもの・ノートごとの予定を、出すかどうかを選びます';
    const panel = document.createElement('div');
    panel.setAttribute('data-pkc-field', 'schedule-fold-panel');
    /**
     * 🔴 **ノートごとの出し入れ**(#855 20-A「このカレンダーだけ」)。3 つの切替の下に、予定のあるノートを 1 行ずつ並べる。
     * 外したノートの予定は面から外れる(ノートそのものは消えない)。見出しは字だけ(押せない)。
     */
    const notes = document.createElement('div');
    notes.setAttribute('data-pkc-field', 'schedule-notes');
    notes.hidden = true;
    const notesHead = document.createElement('span');
    notesHead.setAttribute('data-pkc-field', 'schedule-notes-head');
    notesHead.textContent = 'ノート';
    const notesList = document.createElement('div');
    notesList.setAttribute('data-pkc-field', 'schedule-notes-list');
    notes.append(notesHead, notesList);
    panel.append(optionOf(done), optionOf(archived), optionOf(undated), notes);
    fold.append(summary, panel);
    // 🔑 既定に加えて出しているものを 1 行で言う(何も加えていないときは出さない)
    const foldNote = document.createElement('span');
    foldNote.setAttribute('data-pkc-field', 'schedule-fold-note');
    foldNote.hidden = true;
    const toggles = document.createElement('div');
    toggles.setAttribute('data-pkc-field', 'schedule-toggles');
    toggles.append(fold, foldNote);
    /**
     * 🔴 **予定を .ics(iCalendar)で書き出す**(#855 段 D)。出るのは**いま一覧に出している予定**
     * (「出すもの」の選びと検索の絞りが効く。日付のないものは外の予定表に置き場が無いので出ない)。
     * ⚠ 押した 1 回だけ file を落とす ── 自動でどこかへ渡さない。
     */
    const exportIcs = document.createElement('button');
    exportIcs.type = 'button';
    exportIcs.setAttribute('data-pkc-action', 'export-schedule-ics');
    exportIcs.setAttribute('data-pkc-field', 'schedule-export');
    exportIcs.textContent = '予定を .ics で書き出す';
    exportIcs.title =
      'いま一覧に出している予定を、カレンダー形式(.ics)のファイル 1 つに書き出します。' +
      '「出すもの」で隠している分と、日付のないものは入りません。繰り返しは繰り返しのまま入ります';
    /**
     * 🔴 **予定の知らせ**(#855 20-C)。閉じている間は鳴らせないので、①書き出す `.ics` にアラームを入れ(外の予定表が鳴らす)、
     * ②次に開いたとき見逃した予定を 1 行で言う。⚠ 終日の予定には付けない・数えない(始まる瞬間が無い)。
     * 器は「出すもの」と同じ `<details>`(中央を奪わない小さな枠)。
     */
    const notify = document.createElement('details');
    notify.setAttribute('data-pkc-field', 'schedule-notify');
    const notifySummary = document.createElement('summary');
    notifySummary.textContent = '知らせ';
    notifySummary.title = '予定を .ics で書き出すときのアラームと、次に開いたときの「見逃した予定」の知らせを決めます';
    const leadLabelEl = document.createElement('label');
    leadLabelEl.setAttribute('data-pkc-field', 'schedule-option');
    // 🔴 **.ics にだけ効くことを字で言う**(#1087 の見直し 2026-10-13)── 「知らせる時間: 15 分前」だけだと、
    //   PKC3 の中で 15 分前に鳴ると読める(中の音は時刻ちょうど。説明はマウスを合わせたときにしか出ていなかった)
    leadLabelEl.append('書き出す .ics の知らせる時間: ');
    const lead = document.createElement('select');
    lead.setAttribute('data-pkc-field', 'schedule-lead');
    lead.setAttribute('data-pkc-action', 'set-schedule-lead');
    lead.title = '書き出す .ics に入れるアラームです。時刻のある予定だけに付き、終日の予定には付きません';
    for (const n of SCHEDULE_LEAD_OPTIONS) {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = leadLabel(n);
      lead.append(o);
    }
    leadLabelEl.append(lead);
    const missedLabelEl = document.createElement('label');
    missedLabelEl.setAttribute('data-pkc-field', 'schedule-option');
    const missed = document.createElement('input');
    missed.type = 'checkbox';
    missed.setAttribute('data-pkc-field', 'schedule-missed');
    missed.setAttribute('data-pkc-action', 'set-schedule-missed');
    missed.title = '閉じている間に始まった、時刻のある予定の件数を、次に開いたときに 1 行で知らせます(終日の予定は数えません)';
    missedLabelEl.append(missed, ' 次に開いたとき、見逃した予定を知らせる');
    /**
     * 🔴 **予定の時刻に音で知らせる**(#1654 項 4)。⚠ 設定(システム → 設定 → 通知)にしか無く、予定の画面の
     *   「知らせ」には音の切替が無かった(「知らせる時間」が音のことに読めた)。同じ 1 つの設定 `set-alarm-enabled` を
     *   ここからも切り替える(設定を 2 つにしない)。⚠ 入にすると起動のたびに予定を数える ── 説明に書く。
     */
    const alarmLabelEl = document.createElement('label');
    alarmLabelEl.setAttribute('data-pkc-field', 'schedule-option');
    const alarm = document.createElement('input');
    alarm.type = 'checkbox';
    alarm.setAttribute('data-pkc-field', 'schedule-alarm');
    alarm.setAttribute('data-pkc-action', 'set-alarm-enabled');
    alarm.title =
      '本文の行に時刻まで書いた予定の時刻になったら、音と帯で知らせます(押すとそのノートを開きます)。PKC3 を開いている間だけ鳴ります。入にすると、起動したときに予定を数えます';
    alarmLabelEl.append(alarm, ' 予定の時刻に音で知らせる');
    const notifyPanel = document.createElement('div');
    notifyPanel.setAttribute('data-pkc-field', 'schedule-notify-panel');
    notifyPanel.append(alarmLabelEl, leadLabelEl, missedLabelEl);
    notify.append(notifySummary, notifyPanel);
    const groups = document.createElement('div');
    groups.setAttribute('data-pkc-region', 'schedule-groups');
    /**
     * 🔴 **この面であることの印**(#673 段②)。
     * ⚠ 予定の面は**同じ document に 2 つ在りうる**(左の列の「予定」タブと、
     *   別窓が塞がれて中央へ退避した面 / 中央に開いた面)。`binder.ts` の
     *   `schedule-quick-add` 等は、押されたボタンから **`closest` でこの印まで
     *   上がって**欄を読む ── `root.querySelector` で document 全体から引くと、
     *   **先に描かれた左の面の空の欄**を読んで「やることを入力してください」になる。
     * ⚠ 器は左の列(`data-pkc-browse-pane`)と中央(`data-pkc-view-pane`)で
     *   属性が違うので、器の属性ではなく**描画器が自分の印を焼く**。
     */
    this.region.setAttribute('data-pkc-region', 'schedule');
    this.day.el.hidden = true;
    this.week.el.hidden = true;
    this.monthView.el.hidden = true;
    this.board.el.hidden = true;
    this.region.append(bar, modeRow, quick, grid, note, clearFilter, toggles, exportIcs, notify, this.day.el, this.week.el, this.monthView.el, this.board.el, groups);
    this.frame = { month, grid, note, clearFilter, undated, done, archived, fold, foldNote, foldButton: summary, notes, notesList, notesSignature: '', lead, missed, alarm, toggles, groups, modes, quickDate: qDate, weekStart: weekStartSel, owner: ownerSel };
    return this.frame;
  }
}

