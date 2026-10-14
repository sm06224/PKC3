/**
 * 🔴 **押した時点の「その行の中身」を、画面が見ている本文から取る**(#1087)。
 *
 * ## なぜ要るか
 *
 * チェックの切り替え・予定の日付・繰り返しの回・表の升は、書換が**行番号**で行を指す。
 * 窓 A で別のノートを編集している間、窓 B が別のノート Y のチェックリストの上へ 1 行足すと、
 * 窓 A に残っている**古い Y の表示**(横に留めた枠・予定の札)の行番号は、disk では**別の項目**を指す。
 * 編集中のタブは他のノートの変更を取りに行かないので、その表示は古いまま残る。
 * そこで押すと、**押していない項目**が切り替わっていた。
 *
 * 🔑 直しは板の付箋(`place-move` の `openLine`)と同じ作法 ── 押した時点の行の中身を書換へ添え、
 *   disk 側の同じ行と byte 一致しなければ断る。この module は**運び手が行の中身を引く口**を 3 つに
 *   寄せる(§7):押した面によって「いま見えている本文」の置き場が違う。
 *
 * | 押した面 | 見えている本文の置き場 | 口 |
 * |---|---|---|
 * | 本文・横に留めた枠(表の升も) | `openBody` / `splitBodies` | `shownBodyLine` |
 * | 予定の札(押す・掴む・戻す) | `taskScan.cards`(札が焼かれた原文) | `shownCardLine` |
 * | 板の付箋の中のチェック | `placeBodies`(板のための抜粋) | `shownPlacedLine` |
 *
 * ⚠ どれも**引けなければ `null`**(画面に無い・札が走査に無い)。運び手は撃たずに断る
 *   (`SHOWN_LINE_LOST`)── 空文字を運ぶと、書換が「本文が変わっている」と嘘の理由で断る。
 */
import { bodyLineAt } from '@features/markdown/body-rewrite';
import { placeBodiesOf, screenBodyOf, type AppState } from './app-state';

/** 引けなかった回の断り文(運び手が `OP_FAILED` へ出す)。 */
export const SHOWN_LINE_LOST = '押した場所の内容を確かめられませんでした(開き直してください)';

/** 本文の面(主の枠・横に留めた枠)が見ている原文の、その行。 */
export function shownBodyLine(state: AppState, lid: string, line: number): string | null {
  const shown = screenBodyOf(state, lid);
  return shown === null ? null : bodyLineAt(shown, line);
}

/** 予定の札が焼かれた原文の、その行。⚠ 札は `taskScan` から描かれるので、見えているのはこの値である。 */
export function shownCardLine(
  state: Pick<AppState, 'taskScan'>,
  lid: string,
  line: number,
): string | null {
  const card = state.taskScan?.cards.find((c) => c.lid === lid && c.line === line);
  return card === undefined ? null : card.rawLine;
}

/**
 * 板の付箋の中(置いたノートの抜粋)の、その行。
 * ⚠ 抜粋は設定行(frontmatter)を剥がしてあるので、`lineOffset` を引いて抜粋の中の行に直す。
 * ⚠ **切った抜粋の最後の行は断る** ── 長い 1 行を字数で割った切り口かもしれず、原文の行と一致しない。
 */
export function shownPlacedLine(state: AppState, lid: string, line: number): string | null {
  const ex = placeBodiesOf(state).get(lid);
  if (ex === undefined || ex.missing === true || ex.gone === true) return null;
  const at = line - (ex.lineOffset ?? 0);
  if (!Number.isInteger(at) || at < 0) return null;
  if (ex.cut && ex.text.split('\n').length - 1 <= at) return null;
  return bodyLineAt(ex.text, at);
}
