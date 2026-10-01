/**
 * 左の列の「本文ごと探す」欄で、最近探した語の記録(#1172)。**pure module**。
 *
 * 🔴 **アプリのデータに混ぜない。** 置き場は端末ごと(localStorage、
 * `adapter/platform/search-history-store.ts`)── `opened-log.ts` と**同じ判断**で、
 * container に入れると**書き出しに同乗**し、HTML を渡した相手の画面に
 * **こちらが何を探していたか**が並ぶ。
 *
 * 🔴 **`>` で始まる字は憶えない**(#274 段①)── それは操作の名前で、検索語ではない。
 *   候補に混ざると、次に欄を開いたとき**操作を探した跡が検索語として並ぶ**。
 *
 * ⚠ **憶えるのは「語」だけ**(どのノートが出たかは持たない)── 語から探し直せば
 *   いまの本文で引き直せるので、結果を写すと古い物が残る(§7)。
 */

import { commandQueryOf } from '@features/palette/command-query';

/**
 * 憶えておく件数。⚠ 8 件は見立てである(候補の一覧が画面に収まる数)。
 * 🔑 **これが分かったら覆る**:8 件で足りず「前に探した語が出てこない」と言われたとき。
 */
export const SEARCH_HISTORY_MAX = 8;

/** 憶える最小の字数。⚠ 1 字は「途中で離れた」だけのことが多く、候補が雑音になる。 */
export const SEARCH_TERM_MIN = 2;

/**
 * 探した語を積む。**新しい順**の配列を返す。
 *
 * ⚠ **同じ語を 2 行にしない** ── 既に在れば先頭へ動かす。
 * ⚠ **元の配列を壊さない**。
 * ⚠ 短すぎる語(空白だけ・1 字)は積まない ── 渡された配列をそのまま写して返す。
 */
export function pushSearchTerm(
  list: readonly string[],
  term: string,
  max = SEARCH_HISTORY_MAX,
): string[] {
  const t = term.trim();
  if ([...t].length < SEARCH_TERM_MIN) return [...list];
  // 🔴 操作を探した字は検索語ではない(判定は `commandQueryOf` 1 か所 ── 全角の `＞` も)
  if (commandQueryOf(t) !== null) return [...list];
  return [t, ...list.filter((x) => x !== t)].slice(0, max);
}
