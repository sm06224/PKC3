/**
 * 🔴 **予定の面が「いま出している予定」を決める口**(#855 段 D)。
 *
 * 面の描画(`schedule.ts`)と `.ics` の書き出し(`binder.ts` の `export-schedule-ics`)が
 * **同じ 1 本**を呼ぶ(CLAUDE.md §7)── 別々に絞ると「画面は 3 件なのに書き出しは 5 件」になる。
 * 絞りの規則は 3 つ:片付けたノート(`showArchived`)/ 済んだ行(`showDoneTasks`)/
 * 検索・種類の絞り(`matchesEntry`)。
 */
import type { AppState } from '@adapter/state/app-state';
import type { TaskCard } from '@features/schedule/task-cards';
import { itemOfCard, itemOfNote, type AgendaItem } from '@features/schedule/agenda';
import { entryFilterOf, matchesEntry } from '@features/filter/title-filter';

export interface ScheduleItems {
  /** 絞る前の札(済んだ回の実体の拾い直しに要る)。 */
  readonly all: readonly TaskCard[];
  /** 絞った後の札(日付なしを含む)。 */
  readonly visible: readonly TaskCard[];
  /** ノート 1 件が丸ごと予定のもの(frontmatter の `date:`)。 */
  readonly notes: readonly AgendaItem[];
  /** 面が束ねる材料(`visible` の札 + `notes`)。 */
  readonly items: readonly AgendaItem[];
  /**
   * 🔴 **「出すもの」のノートの一覧の材料**(#855 20-A)。ノートごとの、**いま出ている予定の数**
   * (隠しているノートは「隠さなければ出る数」)。予定の無いノートは載せない。
   */
  readonly byNote: readonly { readonly lid: string; readonly count: number }[];
  /** ノートを隠したせいで出ていない予定の数(「出すもの(N)」に足す)。他の絞りで出ない分は数えない。 */
  readonly hiddenByNote: number;
  /** 済んでいるノートの予定の数(「済み(N)」に足す)。他の絞りを通り、ノートで隠していない分。 */
  readonly doneNotes: number;
}

export function scheduleItemsOf(state: AppState): ScheduleItems {
  const filter = entryFilterOf(state.filterQuery, state.searchHits, state.kindFilter);
  const all = state.taskScan?.cards ?? [];
  const hiddenNotes = new Set(state.scheduleHiddenNotes);
  // ⚠ ノートを隠す前の札(他の絞りは掛けてある)── 「出すもの」のノートの一覧と、隠した数がここから出る
  const unhidden = all.filter((c) => {
    const m = state.entryMetas.get(c.lid);
    if (m === undefined) return false;
    if (m.archived && !state.showArchived) return false;
    // ⚠ 済んだ行は畳む(板の「完了」と同じ旗)── 予定の面は列が無いので**外す**
    if (c.done && !state.showDoneTasks) return false;
    return matchesEntry(m, filter);
  });
  const visible = unhidden.filter((c) => !hiddenNotes.has(c.lid));
  const notes: AgendaItem[] = [];
  const noteItems: AgendaItem[] = [];
  let doneNotes = 0;
  let hiddenDoneByNote = 0;
  for (const lid of state.order) {
    const m = state.entryMetas.get(lid);
    if (m === undefined || m.date === null) continue;
    if (m.archived && !state.showArchived) continue;
    if (!matchesEntry(m, filter)) continue;
    const item = itemOfNote(m);
    // ⚠ 済んだノートは行の札と同じ旗で畳む(`showDoneTasks`)。畳んだ分は数だけ持つ
    if (item.done && !state.showDoneTasks) {
      // 🔴 隠したノートの済んだ予定は「済み(N)」ではなく「隠したノートの分」に数える(#1163 の依頼 247 案 C)
      if (hiddenNotes.has(m.lid)) hiddenDoneByNote++;
      else doneNotes++;
      continue;
    }
    if (item.done && !hiddenNotes.has(m.lid)) doneNotes++;
    noteItems.push(item);
  }
  for (const n of noteItems) if (!hiddenNotes.has(n.lid)) notes.push(n);
  // 🔑 日付の無い札は「日付のないもの」を出しているときだけ数える(出ていない物を「隠した」とは言わない)
  const counts = new Map<string, number>();
  let hiddenByNote = hiddenDoneByNote;
  /**
   * 🔴 **隠したノートの済んだ札は、「済み」を畳んでいるとき「隠したノートの分」に数える**(#1163 の依頼 247 案 C)。
   * ⚠ 「済み(N)」からは外す(`schedule.ts` の `paintDoneToggle`)── 押して出る数と合計の数を両方合わせる。
   *   「済み」を出しているときは下の `unhidden` の走査が数える(二重に足さない)。
   */
  if (!state.showDoneTasks)
    for (const c of all) {
      if (!c.done || !hiddenNotes.has(c.lid)) continue;
      const m = state.entryMetas.get(c.lid);
      if (m === undefined || (m.archived && !state.showArchived)) continue;
      if (c.date === null && !state.showUndatedTasks) continue;
      if (matchesEntry(m, filter)) hiddenByNote++;
    }
  for (const c of unhidden) {
    if (c.date === null && !state.showUndatedTasks) continue;
    counts.set(c.lid, (counts.get(c.lid) ?? 0) + 1);
    if (hiddenNotes.has(c.lid)) hiddenByNote++;
  }
  for (const n of noteItems) {
    counts.set(n.lid, (counts.get(n.lid) ?? 0) + 1);
    if (hiddenNotes.has(n.lid)) hiddenByNote++;
  }
  const byNote = [...counts].map(([lid, count]) => ({ lid, count }));
  return { all, visible, notes, items: [...visible.map(itemOfCard), ...notes], byNote, hiddenByNote, doneNotes };
}
