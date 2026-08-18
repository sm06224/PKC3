/**
 * 🔴 **フォルダ面に出る行を決める 1 か所**(#240 段②)。
 *
 * ⚠ ここを分けた理由は**範囲選択**である ── `Shift` の範囲は「**表示している並び**」で
 * 採らなければならない(doc §3-2)。描く側(`render/filer.ts`)と選ぶ側(reducer)が
 * 別々に並びを組むと、**目で見た範囲と選ばれる範囲が違う**という、いちばん気づけない
 * 食い違いになる(CLAUDE.md §7「同じ判定が複数の場所にある」)。
 *
 * ⚠ 並び順(#183)を**ここで掛ける**。直す前、フォルダ面は並び順を 1 度も見ておらず、
 * 一覧タブで「題名順」に変えてもフォルダの中は作成順のままだった ── 既定をフォルダに
 * する(段⑤)前に、**効かない操作子を既定の面に出さない**ために揃える。
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import { getRootEntries, getStructuralChildren } from './tree';
import { matchesEntry, normalizeQuery } from '@features/filter/title-filter';
import { sortOrder, type EntrySort } from '@features/filter/entry-sort';

export interface FilerListOptions {
  /** 絞り込みの語(**生の入力**。正規化はここでやる ── 呼び手ごとに書かない)。 */
  readonly filterQuery: string;
  /** 本文が当たった lid(`null` = まだ返っていない)。 */
  readonly searchHits: ReadonlySet<string> | null;
  readonly sort: EntrySort;
}

/**
 * いま見ているフォルダに出る行(絞り込み済み・並べ替え済み)。
 * @param scopeLid `null` = ルート
 */
export function filerRows(
  scopeLid: string | null,
  entryMetas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
  opts: FilerListOptions,
): EntryMeta[] {
  const base =
    scopeLid === null
      ? getRootEntries(entryMetas, relations)
      : getStructuralChildren(scopeLid, entryMetas, relations);
  const q = normalizeQuery(opts.filterQuery);
  const shown = base.filter((m) => matchesEntry(m.lid, m.title, q, opts.searchHits));
  // ⚠ 並べ替えは lid の列で行う(規則は `sortOrder` 1 か所)── ここで比較を書き直さない
  const byLid = new Map(shown.map((m) => [m.lid, m]));
  return sortOrder(
    shown.map((m) => m.lid),
    (lid) => byLid.get(lid),
    opts.sort,
  )
    .map((lid) => byLid.get(lid))
    .filter((m): m is EntryMeta => m !== undefined);
}

/**
 * 🔴 **いま見えている行に絞った印**(#240 の着地前レビュー 2)。
 *
 * ⚠ 印(`selection`)は行が見えなくなっても残る ── 絞り込みで消えた / 別タブが
 * 消した(`SYS_BOOTED` でも落ちるが、絞り込みは落ちない)。残ったまま
 * 「まとめてゴミ箱へ」を押すと、**画面に無いものが消える**。
 * 🔑 だから「帯に出す数」「まとめて消す対象」「掴んで運ぶ対象」は
 * **全部この 1 本**を通す ── 数と対象が食い違うと、確認の文言が嘘になる。
 */
export function visibleSelection(
  rows: readonly EntryMeta[],
  selection: readonly string[],
): string[] {
  const shown = new Set(rows.map((m) => m.lid));
  return selection.filter((lid) => shown.has(lid));
}

/**
 * 表示順で `from` と `to` の間を採る(両端を含む)。
 * ⚠ どちらかが見えていないときは **`to` だけ**を返す ── 見えていない行を
 * 巻き込んで消す事故を作らない。
 */
export function rangeInRows(
  rows: readonly EntryMeta[],
  from: string | null,
  to: string,
): string[] {
  const lids = rows.map((m) => m.lid);
  const b = lids.indexOf(to);
  if (b < 0) return [];
  const a = from === null ? -1 : lids.indexOf(from);
  if (a < 0) return [to];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return lids.slice(lo, hi + 1);
}
