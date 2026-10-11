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
}

export function scheduleItemsOf(state: AppState): ScheduleItems {
  const filter = entryFilterOf(state.filterQuery, state.searchHits, state.kindFilter);
  const all = state.taskScan?.cards ?? [];
  const visible = all.filter((c) => {
    const m = state.entryMetas.get(c.lid);
    if (m === undefined) return false;
    if (m.archived && !state.showArchived) return false;
    // ⚠ 済んだ行は畳む(板の「完了」と同じ旗)── 予定の面は列が無いので**外す**
    if (c.done && !state.showDoneTasks) return false;
    return matchesEntry(m, filter);
  });
  const notes: AgendaItem[] = [];
  for (const lid of state.order) {
    const m = state.entryMetas.get(lid);
    if (m === undefined || m.date === null) continue;
    if (m.archived && !state.showArchived) continue;
    if (!matchesEntry(m, filter)) continue;
    notes.push(itemOfNote(m));
  }
  return { all, visible, notes, items: [...visible.map(itemOfCard), ...notes] };
}
