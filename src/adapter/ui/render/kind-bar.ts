/**
 * 🔴 **種類で絞る札の帯**(#411 / #478)。
 *
 * ## 🔴 なぜ面(`SidebarRenderer`)から出したか
 *
 * ⚠ 直す前、この帯を描いていたのは**一覧の面の renderer** だった。
 *   ところが `BrowseRouter` は**開いている面だけ**を描く
 *   (`if (mode === 'list') this.list.render(state)`)ので、
 *   🔴 **一覧以外のタブでは 1 度も描き直されなかった**。
 *
 * ⚠ **帯は面の中ではなく左の列(shell)に在る** ── つまり
 *   **面をまたいで居座るのに、描くのは 1 つの面だけ**という食い違いだった。
 *
 * 🔴 **user から見た症状**(2026-08-27 実測):予定タブで札を押すと
 *   **押された印も付かず「解除」も出ない**のに、**絞りは入る** ──
 *   一覧へ戻ると **3 行が 2 行**になっている。
 *   ⚠ つまり**押した瞬間は嘘をつき、戻ったとき初めて本当のことを言う**。
 *   ⚠ しかもその面からは**解除できない**(「解除」が出ないので)。
 *
 * 🔑 だから**帯を持つ器(shell)の側で、面に関係なく毎回描く**。
 *
 * ## ⚠ 効かない面では帯ごと畳む
 *
 * `kindFilter` を実際に読むのは**一覧 / フォルダ / 予定**だけで、
 * **連絡先 / アプリ**は読まない ── そこで押しても**その場では何も起きず、
 * それでいて絞りは入る**(あとで一覧へ行くとノートが消えている)。
 * 🔑 この file の下の規律(「押しても何も変わらない札は dead click」)を、
 *   **面の違いにも当てる**。
 */
import type { AppState } from '@adapter/state/app-state';
import {
  NO_KINDS,
  entryFilterOf,
  matchesEntry,
  type FilterTarget,
} from '@features/filter/title-filter';
import { kindCounts, type KindCount } from '@features/filter/kind-filter';
import { kindFilterApplies, type BrowseMode } from './browse-mode';

export class KindBarRenderer {
  private readonly kindBar: HTMLElement | null;
  private lastKindShape = '';

  constructor(sidebarRegion: HTMLElement) {
    this.kindBar = sidebarRegion.querySelector<HTMLElement>('[data-pkc-region="kind-bar"]');
  }

  /**
   * 🔴 **種類で絞る札**(#411)。
   *
   * ## 数える母集団 ── 「種類で絞る**前**、語で絞った**後**」
   *
   * ⚠ 種類でも絞った後を数えると、**選んだ札だけが残って他が消える** ──
   *   戻す口が画面から無くなる。だから `kinds` を空にした条件で数える。
   *
   * ## 🔴 「解除」は絞っている間ずっと出す
   *
   * ⚠ 札はその場に居る種類しか出さないので、**押した札そのものが消える**場面が
   *   ある(フォルダの中へ入る / 語を変える)。そのとき「0 件です」とだけ出た
   *   画面になり、user には**絞りが効いていることすら見えない**。
   * 🔑 だから解除は札の在り方に依らず、`kindFilter` が空でない限り必ず置く
   *   ── 面ごとに出す条件を書くと、書き忘れた面で user が閉じ込められる。
   */
  render(state: AppState, mode: BrowseMode): void {
    const bar = this.kindBar;
    if (!bar) return;
    /**
     * ⚠ 語だけで絞った集合を数える(`kinds` は空で渡す ── 上の ⚠)。
     * ⚠ **`state.order` を回す**(`entryMetas` の並びではない)── 一覧に出る
     *   のは `order` に居るものだけなので、`entryMetas` を数えると
     *   **画面に無いものまで札の数に入る**。
     */
    const counted = entryFilterOf(state.filterQuery, state.searchHits, NO_KINDS);
    const present: FilterTarget[] = [];
    for (const lid of state.order) {
      const meta = state.entryMetas.get(lid);
      if (meta !== undefined && matchesEntry(meta, counted)) present.push(meta);
    }
    const kinds = kindCounts(present);
    /**
     * ⚠ **種類が 1 つしか無いなら札を出さない** ── 押しても何も変わらない札は
     *   dead click である(「絞れる」と言っておいて絞れない)。
     * ⚠ ただし**絞っている最中は必ず出す** ── 絞った結果 1 種類になった瞬間に
     *   帯ごと消えると、解除できなくなる。
     */
    /**
     * 🔴 **効かない面では出さない**(#478)── 押しても何も変わらない札は
     *   dead click である、という下の規律を**面の違いにも当てる**。
     * ⚠ 「絞っている最中は必ず出す」は**効く面の中でだけ**の話である ──
     *   効かない面に出しても、そこで解除しても**その面は何も変わらない**。
     *   🔑 効く面へ戻れば「解除」は出る(絞りは state に残っている)。
     */
    const show =
      kindFilterApplies(mode) && (kinds.length > 1 || state.kindFilter.size > 0);
    /**
     * 🔴 **効いているのは「畳んだときの指紋を別にしてある」ほう**である
     *   (2026-08-27、変異試験 K3 が SURVIVED で教えた)。
     *
     * ⚠ はじめは「面を指紋に入れないとタブを移っても描き直さない」と書いたが、
     *   **それは嘘だった** ── 畳む面では `show` が false になり、
     *   指紋が `off` 側へ変わるので**そこで必ず描き直される**。
     * 🔑 だから**本当に要るのは `: '' ` ではなく `: `${mode}|off`` のほう**
     *   (畳んだ状態が「空文字」だと、**別の理由で空になった指紋と潰れる**)。
     * ⚠ 面そのものを混ぜてあるのは**保険**である ── 中身が面ごとに違う日が
     *   来たら要る。⚠ **いまは効いていない**と分かったうえで残している
     *   (CLAUDE.md「これが無いと壊れる、と書く前に外して壊れるのを見る」)。
     */
    const shape = show
      ? `${mode}|${kinds.map((k) => `${k.archetype}:${k.count}`).join('|')}#${[...state.kindFilter].sort().join(',')}`
      : `${mode}|off`;
    if (shape === this.lastKindShape) return; // 姿が同じ ── DOM に触れない
    this.lastKindShape = shape;
    bar.hidden = !show;
    bar.textContent = '';
    if (!show) return;
    for (const k of kinds) bar.append(this.kindChip(k, state.kindFilter.has(k.archetype)));
    if (state.kindFilter.size > 0) {
      const off = document.createElement('button');
      off.type = 'button';
      off.setAttribute('data-pkc-action', 'clear-kind-filter');
      off.setAttribute('data-pkc-field', 'kind-clear');
      off.textContent = '解除';
      off.title = '種類の絞りを外して全部出します';
      bar.append(off);
    }
  }

  private kindChip(kind: KindCount, on: boolean): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-action', 'toggle-kind-filter');
    btn.setAttribute('data-pkc-kind', kind.archetype);
    /**
     * 🔴 **押されているかを読み上げにも出す**(`aria-pressed`)── 色だけで
     *   表すと、色を見分けられない人には**どれで絞っているか分からない**。
     */
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    // ⚠ 件数まで出す ── 押す前に何件になるか分かる(押してから驚かない)
    btn.textContent = `${kind.label} ${kind.count}`;
    btn.title = on
      ? `${kind.label}の絞りを外します`
      : `${kind.label}だけにします(${kind.count} 件)`;
    return btn;
  }
}
