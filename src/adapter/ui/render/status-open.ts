/**
 * 🔴 **知らせの隣の「開く」を出し入れする**(#668 A。PR #667 の着地前レビュー)。
 *
 * ## なぜ要るか
 *
 * 添付を取り込んだのに本文へ入れられなかった回(開いているのがフォルダ等)は、
 * 読んでいた物を開いたまま「「見積.pdf」を添付にしました(…本文には入れていません)」
 * と言う ── ⚠ そのとき**その添付へ行く道が画面のどこにも無かった**。一覧は絞りで
 * 隠れていることがあり(#668 D で添付の作成は絞りを外さなくなった)、user は
 * 作られた物を**探す**ことになる。🔑 だから知らせの隣に「開く」を置く。
 *
 * ## ⚠ なぜ `main.ts` に書かないか
 *
 * `main.ts` は**どの test からも実行されない**(CLAUDE.md §2「どの test からも
 * 実行されない file に、判断を書かない」)。出す / 畳むの判断はここに置き、
 * `main.ts` は配線だけにする。
 *
 * ## 🔴 畳む条件は 3 つ。どれか 1 つでも当たれば畳む
 *
 * | 条件 | なぜ |
 * |---|---|
 * | 身元が無い(`noticeOpen === null`) | 添えていない知らせに押す口を残さない |
 * | **もうそれを開いている** | 開いている物を「開く」と言わない(押しても何も起きない口を出さない) |
 * | **字が別の知らせに上書きされた** | 「コピーしました」の隣に前の添付の「開く」が残ると、user は**コピーした物が開く**と読む |
 *
 * 🔑 押した先は `select-entry` の受け手(`binder.ts`)── 実行の口を新しく作らない(§7)。
 *   だから書くのは `data-pkc-entry`(受け手が読む属性)と `hidden` の 2 つだけ。
 */

export interface StatusOpenState {
  /** 「開く」で出す物の lid(`OP_NOTICE` の `open`)。 */
  readonly noticeOpen: string | null;
  readonly selectedLid: string | null;
  /** state が持つ知らせの字(`shownLine` と比べて、上書きされたかを見る)。 */
  readonly notice: string | null;
}

/**
 * @param btn `shell.ts` が 1 度だけ組んだ押し口(`data-pkc-field="status-open"`)
 * @param shownLine いま状態の行に出ている知らせの字(`main.ts` の `noticeLine`)。
 *   ⚠ state の `notice` と食い違っていたら、字だけの知らせ(`showStatus`)が
 *   上書きした後である ── そのときは畳む
 */
export function paintStatusOpen(
  btn: HTMLElement,
  state: StatusOpenState,
  shownLine: string,
): void {
  const lid = state.noticeOpen;
  const show = lid !== null && state.selectedLid !== lid && state.notice === shownLine;
  if (show) btn.setAttribute('data-pkc-entry', lid);
  else btn.removeAttribute('data-pkc-entry');
  // ⚠ 同じ値を書き直さない(状態の行は打鍵ごとに描き直される)
  if (btn.hidden !== !show) btn.hidden = !show;
}

export interface StatusUndoState {
  /** 直前の塊の移動を戻す材料(`lastMove`)。`null` = 戻す物が無い。 */
  readonly lastMove: object | null;
  readonly notice: string | null;
  /**
   * 🔴 **直前に足した行を戻す材料**(#684 ㋑)。⚠ `lid` を持つのが肝で、
   *   **開いていないノートへ足した回**はここだけが戻し方を知っている。
   */
  readonly lastAppend: { readonly lid: string } | null;
  /** その知らせが指している行き先(`OP_NOTICE` の `open`)。 */
  readonly noticeOpen: string | null;
}

import { BLOCK_MOVED_NOTICE } from '@features/markdown/line-move';

/**
 * 🔴 **知らせの隣の「元に戻す」を出し入れする**(#684 段①)。
 *
 * 本文の塊を掴んで動かした直後、「本文の塊を動かしました」の隣に出る。
 * 畳む条件は 2 つ(どちらか 1 つでも当たれば畳む)── 「開く」と同じ作法:
 *
 * | 条件 | なぜ |
 * |---|---|
 * | 戻す材料が無い(`lastMove === null`) | 押しても何も起きない口を残さない(編集に入る / 別の書換で材料は捨てられる) |
 * | **字が別の知らせに上書きされた** | 「コピーしました」の隣に「元に戻す」が残ると、user は**コピーが戻る**と読む |
 *
 * 🔑 押した先は `undo-move` の受け手(`binder.ts`)── 書くのは `hidden` だけ。
 */
export function paintStatusUndo(btn: HTMLElement, state: StatusUndoState, shownLine: string): void {
  /**
   * 🔴 **出ている字が「動かしました」そのものか**を見る(2026-09-09、UX レビューで直した)。
   *
   * ⚠ 直す前は `state.notice === shownLine` だった ── **呼び側はいまの知らせを渡す**ので
   *   これは常に真で、`lastMove` が残っている限り**どの知らせの隣にも**出ていた。
   * 🔴 実害:段③(塊を別のノートへ持っていく)の知らせの隣に出て、押すと
   *   **画面に出ていない別のノートの、前の並べ替え**が戻る(押した字と起きることが違う)。
   * ⚠ `lastMove` はノートを切り替えても捨てられない(捨てるのは編集開始と同じノートの
   *   別の書換だけ)ので、字で見分けるしかない。
   */
  const move = state.lastMove !== null && shownLine === BLOCK_MOVED_NOTICE;
  /**
   * 🔴 **開いていないノートへ足した回も、ここから 1 回で戻せる**(#684 ㋑、
   *   着地前の動線レビュー 欠陥 3・4・6)。
   *
   * ⚠ 追記欄の「元に戻す」は **`lastAppend.lid === selectedLid`** のときだけ出る
   *   (`append-box.ts`)。だから**横に留めた枠へ入れた行**は、そのノートを中央へ
   *   開くまで戻せない ── しかも開くと**読んでいた本文が中央から消える**ので、
   *   戻すために主の作業領域を明け渡すことになる(#300 と同じ形)。
   * 🔑 `UNDO_APPEND` は `lastAppend.lid` で動き、**開いているノートを見ない**
   *   (`app-state.ts`)ので、ここへ出すだけで**画面を 1px も動かさずに**戻せる。
   *
   * ⚠ 出す条件は**字ではなく身元**で見る ── 「入れました」を含むか、のような
   *   字の判定は別の知らせに満たされる(CLAUDE.md §1)。
   *   `noticeOpen` はこの経路(と断り)しか立てず、断りの `open` は**作った添付**なので
   *   `lastAppend.lid` と一致しえない(添付の本文へは足さない)。
   * ⚠ `notice === shownLine` も要る ── 字が別の知らせに上書きされた後に
   *   「元に戻す」だけ残ると、user は**その知らせが戻る**と読む(「開く」と同じ作法)。
   */
  const append =
    !move &&
    state.lastAppend !== null &&
    state.noticeOpen !== null &&
    state.lastAppend.lid === state.noticeOpen &&
    state.notice === shownLine;
  const show = move || append;
  // ⚠ **押し先も切り替える** ── 同じ器で 2 つの取り消しを出すので、
  //    字だけ出して受け手を替え忘れると「押すと別の物が戻る」になる
  if (show) btn.setAttribute('data-pkc-action', move ? 'undo-move' : 'undo-append');
  if (btn.hidden !== !show) btn.hidden = !show;
}
