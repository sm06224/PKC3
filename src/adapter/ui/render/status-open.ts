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
}

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
  const show = state.lastMove !== null && state.notice === shownLine;
  if (btn.hidden !== !show) btn.hidden = !show;
}
