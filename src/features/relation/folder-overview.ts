/**
 * 🔴 **フォルダを選んだとき、中央に出す「概要」の材料**(#1222。Gemini 裁定 2026-10-01 = A)。
 *
 * > user の物語:左の列でフォルダを 1 回押した。中央にはフォルダの説明(本文)しか出ず、
 * > **中に何が入っているか**を見るには左の列を見に行くしかなかった。
 *
 * ⚠ **行を決めるのは `filerRows` 1 本** ── 左の列の「フォルダ」の表と**同じ並び**を引く
 *   (自前で `getStructuralChildren` と `sortOrder` を書き直すと、左と中央で順番が割れる。§7)。
 * ⚠ **絞り込み・種類の絞り・「中まで全部出す」は掛けない** ── 概要は「直下に何が在るか」の
 *   全体像で、左の列の見え方(検索中・絞り中)に引きずられない。**常に直下だけ**
 *   (入れ子は左の列の「中まで全部出す」)。
 * ⚠ pure module。browser API を持たない。
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import { archetypeLabel } from '@features/flavor/archetype-label';
import { SMART_ARCHETYPE } from '@features/smart/smart-spec';
import type { EntrySort } from '@features/filter/entry-sort';
import { filerRows } from './filer-list';

/**
 * 概要に出す行の上限。⚠ **暫定の数 ── 測って決める**。「先頭だけ見えれば足りる」側の
 * 見積もりで、直下 2,000 件でも描画が long task を作らないことは実ブラウザで測ってある
 * (PR 本文の実測)。user が不足を言ったら上げてよい。
 */
export const FOLDER_OVERVIEW_LIMIT = 100;

/** 概要を出す種類。⚠ スマートフォルダは対象外(中身は条件の当たりで、直下の概念が違う)。 */
export const hasFolderOverview = (archetype: string | undefined): boolean => archetype === 'folder';

export interface FolderOverview {
  /** 直下のノートの数(フォルダ以外の全部)。 */
  readonly notes: number;
  /** 直下のフォルダの数(スマートフォルダを含む)。 */
  readonly folders: number;
  /** 先頭から `FOLDER_OVERVIEW_LIMIT` 件までの行(左の列と同じ並び)。 */
  readonly rows: readonly EntryMeta[];
  /** 上限で切れた残りの数(`0` = 切れていない)。 */
  readonly more: number;
}

/** 並びの材料。⚠ `filerRows` が要る物のうち、**並びに効くものだけ**(絞りは渡さない)。 */
export interface FolderOverviewView {
  readonly sort: EntrySort;
  readonly sortDesc: boolean;
  readonly openedAt: ReadonlyMap<string, number>;
}

const isFolderLike = (archetype: string): boolean =>
  archetype === 'folder' || archetype === SMART_ARCHETYPE;

export function folderOverview(
  lid: string,
  entryMetas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
  view: FolderOverviewView,
): FolderOverview {
  const all = filerRows(lid, entryMetas, relations, {
    filterQuery: '',
    searchHits: null,
    kinds: new Set<string>(),
    flatten: false,
    smartLids: null,
    sort: view.sort,
    sortDesc: view.sortDesc,
    openedAt: view.openedAt,
  });
  let folders = 0;
  for (const m of all) if (isFolderLike(m.archetype)) folders += 1;
  return {
    notes: all.length - folders,
    folders,
    rows: all.slice(0, FOLDER_OVERVIEW_LIMIT),
    more: Math.max(0, all.length - FOLDER_OVERVIEW_LIMIT),
  };
}

/** 件数の 1 行。⚠ 種類の名前は `archetype-label.ts` から引く(ここで綴らない)。 */
export const overviewSummary = (o: Pick<FolderOverview, 'notes' | 'folders'>): string =>
  `直下 ${archetypeLabel('text')} ${o.notes} 件 / ${archetypeLabel('folder')} ${o.folders} 件`;

/** 上限で切れたときの 1 行。 */
export const overviewMore = (more: number): string => `ほか ${more} 件は左のペインで`;
