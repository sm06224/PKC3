/**
 * 🔴 **予定の「月」の 1 日ぶんの升に、何を出すか**(#855。Gemini 裁定 = #1163 の依頼 30 の Q1)。
 *
 * 升は狭いので、出すのは**題名 3 件まで**。4 件目からは出さずに「ほか N 件」と数だけ言い、
 * 押すとその日の「日」へ移る(残りはそこで読める)。
 *
 * 🔑 並びは**呼び側が渡した順のまま**(`buildAgenda` が時刻順に並べたもの ── 「日」「週」「一覧」と同じ並び)。
 *   ここで並べ直すと、同じ日が面によって違う順に見える(CLAUDE.md §7)。
 * 🔑 **pure module**。browser API を使わない。
 */

/** 1 日の升に出す題名の数。 */
export const MONTH_CELL_LIMIT = 3;

export interface MonthCellPick<T> {
  /** 升に並べる分(先頭から `limit` 件まで)。 */
  readonly shown: readonly T[];
  /** 出さなかった件数(0 のときは「ほか」を出さない)。 */
  readonly more: number;
}

export function pickCellItems<T>(items: readonly T[], limit: number = MONTH_CELL_LIMIT): MonthCellPick<T> {
  const n = Math.max(0, Math.floor(limit));
  return { shown: items.slice(0, n), more: Math.max(0, items.length - n) };
}

/** 「ほか N 件」のボタンの字。 */
export function moreLabel(more: number): string {
  return `ほか ${more} 件`;
}
