/**
 * 🔴 **面を開いたあとの後始末を 1 か所に寄せる**(#300 段②のレビュー、2026-08-22)。
 *
 * ⚠ これまで「集計を開いたら、憶えている束ね方を思い出す」は
 * `binder.ts` の `set-view` ハンドラに**べた書き**されていた。
 * そのため**アドレスから開いた集計だけ表が出ない** ── 面は開くが `queryKey` が
 * `null` のままなので、`query.ts` の「上の『束ね方』で項目を選ぶと…」という
 * 案内だけが出る。⚠ タブを押せば出るのに、ブックマークから開くと出ない。
 * 🔑 CLAUDE.md §7「同じ問いに答える口が 2 つあると、片方だけ壊しても届かない」
 * ── だから**開く手続きそのもの**を関数にして、口を 1 つにする。
 */
import type { Dispatcher } from '../../state/dispatcher';
import type { ViewMode } from '../../state/app-state';
import { appQueryKey } from './query-key-store';

/**
 * 面を開く。⚠ **開けたときだけ**後始末をする(編集中は `SET_VIEW_MODE` が
 * 捨てられるので、`SET_QUERY_KEY` だけ飛ぶと走査が無駄に走る ── レビュー B-1)。
 *
 * ⚠ 順序が効く: 先に `SET_VIEW_MODE`(目録を頼む)→ 後に `SET_QUERY_KEY`
 * (表を頼む)。逆にすると同じ走査を 2 回頼むことになる。
 */
export function openView(dispatcher: Dispatcher, mode: ViewMode): void {
  dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode });
  /**
   * 🔴 **集計の束ね方を思い出す**(#184)。⚠ **開いたときだけ**読む ──
   * boot で読むと、集計を一度も開かない user にも全本文の走査を負わせる。
   */
  const state = dispatcher.getState();
  if (state.viewMode === 'query' && state.queryKey === null) {
    const remembered = appQueryKey.get();
    if (remembered !== null) dispatcher.dispatch({ type: 'SET_QUERY_KEY', key: remembered });
  }
}
