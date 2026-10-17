/**
 * 左の一覧で開いていたフォルダと種類の札を端末に憶える配線(依頼 277)。
 *
 * ⚠ **`main.ts` に直書きしない**(どの test からも実行されない file に判断を書かない)。
 * 憶えている場所を起動で 1 度だけ state へ写し、以後は変わるたびに憶える。
 * ⚠ `SYS_BOOTED` の**後**に呼ぶ(前だと boot が state を組み直して消える。cid もそれまで無い)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import type { AppState } from '@adapter/state/app-state';
import { appListPlace, type ListPlaceStore } from '@adapter/ui/render/list-place-memory';

/** 返り値は購読を切る口。 */
export function connectListPlaceMemory(
  dispatcher: Dispatcher,
  store: ListPlaceStore = appListPlace,
): () => void {
  const first = dispatcher.getState();
  const remembered = store.get();
  // ⚠ 別のコレクションの記憶は読まない(lid の偶然の一致を持ち越さない)
  if (remembered !== null && first.cid !== null && remembered.cid === first.cid) {
    /**
     * ⚠ 開いているノートが在る起動(リンクで来た等)では、場所は動かさない ── 開いているノートの行が
     *   見えない場所へ戻すと、左の一覧に居場所が無くなる(依頼 277 が直したい症状そのもの)。
     */
    if (first.selectedLid === null && remembered.scope !== null && first.entryMetas.has(remembered.scope)) {
      dispatcher.dispatch({ type: 'SET_SCOPE', lid: remembered.scope });
    }
    // ⚠ 札は**いま在る種類**だけ戻す ── 無い種類の札は画面に出ないので、外せずに空の一覧が残る
    const present = new Set([...first.entryMetas.values()].map((m) => m.archetype));
    for (const k of remembered.kinds) {
      if (present.has(k) && !dispatcher.getState().kindFilter.has(k)) {
        dispatcher.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: k });
      }
    }
  }
  const keyOf = (s: AppState): string =>
    `${s.cid ?? ''}|${s.scopeLid ?? ''}|${[...s.kindFilter].sort().join(',')}`;
  let last = keyOf(dispatcher.getState());
  return dispatcher.onState((s) => {
    const now = keyOf(s);
    if (now === last) return;
    last = now;
    if (s.cid === null) return;
    store.set({ cid: s.cid, scope: s.scopeLid, kinds: [...s.kindFilter].sort() });
  });
}
