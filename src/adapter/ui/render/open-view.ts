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
import { homeTabOf, type BrowseMode } from './browse-mode';

/**
 * 面を開く。⚠ **開けたときだけ**後始末をする(編集中は `SET_VIEW_MODE` が
 * 捨てられるので、`SET_QUERY_KEY` だけ飛ぶと走査が無駄に走る ── レビュー B-1)。
 *
 * ⚠ 順序が効く: 先に `SET_VIEW_MODE`(目録を頼む)→ 後に `SET_QUERY_KEY`
 * (表を頼む)。逆にすると同じ走査を 2 回頼むことになる。
 *
 * @returns 🔴 **本当に開いたか**(#300 段③ の直し、2026-08-22)。
 *   ⚠ 編集中は `SET_VIEW_MODE` が**断られる**(`app-state.ts` が
 *   「編集中は…を開けません」を立てて面は動かさない)。呼び側がこれを見ずに
 *   「この画面で開きました」と言うと**嘘になる**ので、**結果を返す**。
 *   🔑 判定は増やさない ── **既にある 1 か所の結果を読むだけ**である(§7)。
 */
export function openView(dispatcher: Dispatcher, mode: ViewMode): boolean {
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
  /**
   * 🔴 **予定表を開いたら、その場で集める**(#673 段②)。
   * ⚠ 左の列の「予定」タブは `setBrowse` が集めを頼むが、中央の面(別窓の
   *   ディープリンク / 退避)は**この関数しか通らない** ── 頼まないと別窓は
   *   「集めています…」で**永久に止まる**。⚠ 開けたときだけ(編集中に断られた回に
   *   走査だけ走らせない ── 上の集計と同じ理由)。
   */
  if (state.viewMode === 'schedule' && mode === 'schedule')
    dispatcher.dispatch({ type: 'REFRESH_TASK_SCAN' });
  // 🔴 連絡先も同じ流儀(#278 段③)── 開いたときに集める(boot では集めない)
  if (state.viewMode === 'contacts' && mode === 'contacts')
    dispatcher.dispatch({ type: 'REFRESH_CONTACT_SCAN' });
  return state.viewMode === mode;
}

/**
 * 🔴 **別窓が塞がれたときの退避先**(#673 段②)。
 *
 * ⚠ 予定表の退避は**中央の面ではなく左の列の「予定」タブ**へ ── 中央に開くと
 *   本文が消える(#292 段⑤ で左へ移した当の理由)。同じものが在る場所へ送る。
 * 🔑 「同じものが左に在るか」の判定は `browse-mode.ts` の `homeTabOf` 1 か所 ──
 *   ここは**呼ぶだけ**。左に無い面(2 ペイン)は今までどおり中央の面へ。
 * ⚠ 探す面(#680)だけは表に無い 3 つ目の退避 ── 左の**欄**へ焦点(下の引数)。
 * @returns 開けたか(左のタブは編集中でも開けるので、送れたら `true`)。
 */
export function openViewHere(
  dispatcher: Dispatcher,
  mode: ViewMode,
  openBrowse: (tab: BrowseMode) => void,
  /**
   * 🔴 **探す面の退避先は「左の列の欄に焦点」**(#680)── 左に同じ面は無いが、
   *   同じ**仕事**(語で探す)は左の欄でできる。中央に開くと本文が消える。
   *   口は `binder.ts` の `focus-search`(畳んだ列を戻してから焦点を入れる)と同じ物を
   *   渡す ── ここで `querySelector` を書き直さない(§7)。
   * @returns 焦点を入れられたか(欄が無い面では `false` ── そのときは理由が出る)
   */
  focusSearch: () => boolean,
): boolean {
  if (mode === 'search') return focusSearch();
  const tab = homeTabOf(mode);
  if (tab !== null) {
    openBrowse(tab);
    return true;
  }
  return openView(dispatcher, mode);
}
