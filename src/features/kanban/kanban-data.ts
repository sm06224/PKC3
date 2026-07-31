/**
 * kanban のデータ整形(PKC2 kanban-data の総合的見直し版)。
 *
 * PKC2 は全 todo の JSON body を parse していた(O(N) body parse)。PKC3 は
 * 常駐 EntryMeta の抽出列(status / archived)だけで組む ── body は読まない
 * (設計 doc §4.3。抽出列は保存時に FlavorSpec.extract が書いた値)。
 */
import type { EntryMeta } from '@core/model/entry-meta';

export type KanbanStatus = 'open' | 'done';

/** 列の定義(表示順)。 */
export const KANBAN_COLUMNS: readonly { status: KanbanStatus; label: string }[] = [
  { status: 'open', label: 'Todo' },
  { status: 'done', label: 'Done' },
] as const;

/**
 * todo を status 列に振り分ける。archived は常に除外(PKC2 と同じ意味論:
 * kanban は「動いている todo」だけを見せる)。入力順序を保持する ── caller は
 * entryOrder 順(state.order)で渡すこと。
 */
export function groupTodosByStatus(
  metas: readonly EntryMeta[],
): Record<KanbanStatus, EntryMeta[]> {
  const result: Record<KanbanStatus, EntryMeta[]> = { open: [], done: [] };
  for (const meta of metas) {
    if (meta.archetype !== 'todo') continue;
    if (meta.archived) continue;
    result[meta.status === 'done' ? 'done' : 'open'].push(meta);
  }
  return result;
}
