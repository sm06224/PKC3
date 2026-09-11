/**
 * 「最近開いた」を憶える配線(#215 残り①)。
 *
 * 🔴 **reducer には置けない** ── 時刻(`Date.now()`)も localStorage も副作用である。
 * 🔑 だから state を見て**外で**記録し、出来上がった表を `SET_OPENED_AT` で戻す。
 *
 * ⚠ **`main.ts` に直書きしない**(CLAUDE.md「どの test からも実行されない file に
 * 判断を書かない」)── ここへ出せば、時計も保存も差して test できる。
 */
import type { AppState } from '@adapter/state/app-state';
import type { Dispatcher } from '@adapter/state/dispatcher';
import { appOpenedStore, type OpenedStore } from './opened-store';
import { openedMap } from '@features/history/opened-log';

/**
 * 開いたノートを憶え、state に載せる。返り値は購読を切る口。
 *
 * @param now 時計。⚠ **差せる形にする**(test が「新しい順」を作れない)
 */
export function connectOpenedEffects(
  dispatcher: Dispatcher,
  store: OpenedStore = appOpenedStore,
  now: () => number = () => Date.now(),
): () => void {
  // 起動時に、憶えている記録を画面へ載せる(これが無いと初回の並べ替えが効かない)
  dispatcher.dispatch({ type: 'SET_OPENED_AT', openedAt: store.map() });

  let last: string | null = null;
  /**
   * 🔴 **掃除は 1 度だけ**(起動して一覧が届いた最初の 1 回)。
   * ⚠ 毎回やると、開くたびに localStorage へ書くことになる。
   * ⚠ **`entryMetas` が空のうちにやらない** ── 起動直後は 0 件なので、
   *   そこで掃除すると**記録が丸ごと消える**(いちばん気づけない壊れ方)。
   */
  let pruned = false;
  /**
   * 🔴 **並びが変わったときだけ送る**(2026-09-11、変異試験で判明)。
   *
   * ⚠ この配線は `onState` の中から `dispatch` する ── **自分の出した変化が自分に
   *   返ってくる**。⚠ `Dispatcher` は drain 中の dispatch を**待ち行列に積む**ので、
   *   「再入を弾く」形の門では止まらない(実際に試して**固まった**)。
   * 🔴 止まらない理由は 1 つ:**押すたびに時刻が動く**ので、送る表が毎回違う。
   * 🔑 だから**時刻だけの違いでは送らない** ── 並べ替えが見るのは**順番**だけなので、
   *   順番が同じなら送る必要が無い。これで「送る → 返ってくる → また送る」の輪が
   *   **構造から消える**(§7「検出するより起こらなくする」)。
   * ⚠ 帰結:`state.openedAt` の**時刻は store より古いことがある**(順番は同じ)。
   *   ここを「最後に開いた時刻を画面に出す」用途へ使うなら、その時点で送り方を変える。
   */
  const sameOrder = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean => {
    if (a.size !== b.size) return false;
    const ak = [...a.keys()];
    const bk = [...b.keys()];
    return ak.every((k, i) => k === bk[i]);
  };
  const publish = (next: ReadonlyMap<string, number>, cur: ReadonlyMap<string, number>): void => {
    if (sameOrder(cur, next)) return;
    dispatcher.dispatch({ type: 'SET_OPENED_AT', openedAt: next });
  };

  const onState = (s: AppState): void => {
    if (!pruned && s.entryMetas.size > 0) {
      pruned = true;
      const next = store.prune((lid) => s.entryMetas.has(lid));
      publish(openedMap(next), s.openedAt);
    }
    const lid = s.selectedLid;
    // ⚠ 同じノートを見続けている間は書かない(描画のたびに書込が走る)
    if (lid === null || lid === last) {
      last = lid;
      return;
    }
    last = lid;
    /**
     * ⚠ **二重の門である**(単独では観測できない)── 上流の `SELECT_ENTRY` が
     *   既に「一覧に無い lid は選ばない」を持つ(`app-state.ts` の
     *   `if (!state.entryMetas.has(action.lid)) return …`)。
     * 🔑 だからここを外しても test は緑のままである ── **「これが無いと壊れる」
     *   とは書かない**(CLAUDE.md「外して壊れるのを見ないなら書かない」)。
     *   残す理由は、書き込む直前でもう一度検めるのが安いからだけである。
     */
    if (!s.entryMetas.has(lid)) return;
    publish(openedMap(store.push(lid, now())), s.openedAt);
  };

  return dispatcher.onState(onState);
}
