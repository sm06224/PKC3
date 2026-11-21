/**
 * 🔴 **色ラベルが変わったら、色で絞るスマートフォルダ(`smart-label`)を集め直す配線**(#1982 残り 1)。
 *
 * - きっかけは `NoteLabelStore.onWritten`(付け外しの書込が済んだ / 正本を読み直して中身が変わった ── 取り込み・取り消しを含む)。
 * - 🔴 **1 回の続きの変化は 1 回の集め直しにまとめる**(50ms の間に重なった通知は 1 本へ畳む。20 件を続けて付け替えても全件走査は 1 本)。
 * - 集め直すのは、いま集めた結果の条件に色を持つスマートフォルダだけ(色の無い条件は走査しない)。
 * @returns 配線を外す関数
 */
export interface LabelSmartStore {
  onWritten(cb: () => void): () => void;
}

export function wireLabelSmartRescan(
  store: LabelSmartStore,
  smartHits: () => ReadonlyMap<string, { readonly spec: { readonly label: number | null } }>,
  dispatch: (a: { type: 'SMART_RESCAN'; lid: string }) => void,
  schedule: (fn: () => void) => void = (fn) => void setTimeout(fn, 50),
): () => void {
  let pending = false;
  return store.onWritten(() => {
    if (pending) return;
    pending = true;
    schedule(() => {
      pending = false;
      for (const [lid, hit] of smartHits()) {
        if (hit.spec.label !== null) dispatch({ type: 'SMART_RESCAN', lid });
      }
    });
  });
}
