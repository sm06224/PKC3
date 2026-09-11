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
