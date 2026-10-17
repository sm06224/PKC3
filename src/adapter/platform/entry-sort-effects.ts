/**
 * 一覧の並び順を端末に憶える配線(依頼 82-3)。
 *
 * ⚠ **`main.ts` に直書きしない**(どの test からも実行されない file に判断を書かない)。
 * 憶えている並びを起動で 1 度だけ state へ写し、以後は変わるたびに憶える。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { appEntrySort, type EntrySortStore } from '@adapter/ui/render/entry-sort-memory';

/** 返り値は購読を切る口。⚠ `SYS_BOOTED` の**後**に呼ぶ(前だと boot が state を組み直して消える)。 */
export function connectEntrySortMemory(
  dispatcher: Dispatcher,
  store: EntrySortStore = appEntrySort,
): () => void {
  const remembered = store.get();
  if (remembered !== null) {
    dispatcher.dispatch({ type: 'SET_ENTRY_SORT', sort: remembered.sort, desc: remembered.desc });
  }
  let lastSort = dispatcher.getState().entrySort;
  let lastDesc = dispatcher.getState().entrySortDesc;
  return dispatcher.onState((s) => {
    if (s.entrySort === lastSort && s.entrySortDesc === lastDesc) return;
    lastSort = s.entrySort;
    lastDesc = s.entrySortDesc;
    store.set(s.entrySort, s.entrySortDesc);
  });
}
