/**
 * 一覧の並び順(#183 / 台帳 #180 の A-3)。
 *
 * 🔴 **pure module**。並びの規則はここ 1 か所 ── 面ごとに書くと、一覧・後継選択・
 * ランチャーが**別の答え**を返す(絞り込みで実際に踏んだ型。`title-filter.ts` の
 * 冒頭に記録が在る)。
 *
 * ⚠ **手で並べ替える導線(`move-order-up/down`)を置き換えるものではない。**
 * 既定は手動の順(`entry_order`)で、これはその上に載る「見え方」である。
 */
import type { EntryMeta } from '@core/model/entry-meta';

export const ENTRY_SORTS = ['manual', 'updated', 'title', 'archetype'] as const;
export type EntrySort = (typeof ENTRY_SORTS)[number];
export const DEFAULT_ENTRY_SORT: EntrySort = 'manual';

export function isEntrySort(v: string): v is EntrySort {
  return (ENTRY_SORTS as readonly string[]).includes(v);
}

/**
 * 並べ替える。⚠ **元の配列を壊さない**(`order` は state が持つ参照で、
 * reducer の指紋にもなっている ── その場で書き換えると再描画が飛ぶ)。
 *
 * ⚠ **同点は必ず lid で割る**(全モード)。割らないと、同じ題名・同じ時刻の行の
 * 並びが実行のたびに変わり、user から見て「行が勝手に入れ替わる」画面になる。
 *
 * @param metaOf 未知の lid は `undefined` を返してよい(落とさず末尾へ回す ──
 *   一覧から**黙って消える**ほうが害が大きい)
 */
export function sortOrder(
  order: readonly string[],
  metaOf: (lid: string) => EntryMeta | undefined,
  sort: EntrySort,
): string[] {
  if (sort === 'manual') return [...order];
  const key = (lid: string): string => {
    const m = metaOf(lid);
    if (!m) return '￿'; // 未知は末尾
    if (sort === 'title') return m.title.toLowerCase();
    if (sort === 'archetype') return m.archetype;
    return m.updatedAt ?? ''; // updated: 時刻文字列(ISO なので辞書順 = 時刻順)
  };
  const desc = sort === 'updated'; // 更新は**新しい順**(他は昇順)
  return [...order].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return desc ? (ka < kb ? 1 : -1) : ka < kb ? -1 : 1;
    return a.localeCompare(b); // 同点は lid で割る(並びを決定的にする)
  });
}
