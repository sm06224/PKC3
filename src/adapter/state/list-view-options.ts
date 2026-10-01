/**
 * 一覧の「見え方」を state から 1 か所で組む(2026-09-11、#215 残り①)。
 *
 * 🔴 **同じ 4 つを 6 か所で書いていた** ── `sort` / `sortDesc` / `kinds` に
 * `openedAt`(最近開いた時刻)を足そうとしたら、**6 か所とも直す**ことになった。
 * ⚠ それは「次に 1 つ足す人は 6 か所を探す」という意味で、**探し漏らした面だけ
 * 静かに違う並びになる**(CLAUDE.md §7「同じ値が複数の場所にある」)。
 *
 * 🔑 だからここへ寄せる。⚠ **絞り込みの語は含めない** ── 2 ペインは面ごとに
 * 別の語を持つ(`paneFilterOptions`)ので、ここに混ぜると使えなくなる。
 */
import type { AppState } from './app-state';
import type { EntrySort } from '@features/filter/entry-sort';
import { smartLidsOf, type FilerRowsOptions } from '@features/relation/filer-list';

export interface ListViewOptions {
  readonly sort: EntrySort;
  readonly sortDesc: boolean;
  readonly kinds: ReadonlySet<string>;
  readonly openedAt: ReadonlyMap<string, number>;
}

/** 一覧・フォルダ・2 ペインが**同じ**並び方をするための 1 か所。 */
export function listViewOptions(state: AppState): ListViewOptions {
  return {
    sort: state.entrySort,
    sortDesc: state.entrySortDesc,
    kinds: state.kindFilter,
    openedAt: state.openedAt,
  };
}

/**
 * 🔴 **左の列の「フォルダ」の表に出る行を決める材料は、ここ 1 か所**(#813 段②)。
 *
 * ⚠ 描く側(`render/filer.ts`)・範囲選択と全選択(reducer)・鍵と一括操作の対象
 *   (`binder.ts` の `visibleFilerRows`)の 4 か所が、同じ 5 つの材料を手で組んでいた。
 *   「中まで全部出す」(`filerFlatten`)を足すとき 4 か所を探すことになり、**書き忘れた
 *   経路だけ階層どおりの行で数える**(目で見た範囲と選ばれる範囲が食い違う ── §7)。
 * ⚠ 2 ペインは**この関数を使わない**(面ごとに絞り込みの語が別で、入り切りも持たない)。
 */
export function filerRowOptions(state: AppState): FilerRowsOptions {
  return {
    smartLids: smartLidsOf(state.scopeLid, state.smartHits),
    filterQuery: state.filterQuery,
    searchHits: state.searchHits,
    flatten: state.filerFlatten,
    ...listViewOptions(state),
  };
}
