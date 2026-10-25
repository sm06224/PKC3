/**
 * 🔴 **一覧で選んだ N 件だけを持ち出す**(#1038 A1)。
 *
 * > user の物語: 一覧で数件を選んだ。その数件だけを相手に渡したい(閲覧用 HTML)/ 手元へ取っておきたい
 * > (バックアップ)。いまできるのは **①全件** か **②1 件ずつ**(5 件なら 5 回押して 5 ファイル)だけだった。
 *
 * 実装は `folderSource` と**同じ道**(`subsetSource`)── lid の集合で絞るだけで、writer も読み戻しも既存のまま。
 * 形式が増えないので「選んだ分だけ壊れている」が起きようがない。
 *
 * ## フォルダを選んだときの決め(マニュアル「選んだノートだけを書き出す」と揃える)
 *
 * | 書き出し | 選んだフォルダ |
 * |---|---|
 * | バックアップ(`.pkc3-notes.zip`) | 🔑 **中のノートも入れる**(「このフォルダをバックアップ」と同じ。取っておく物は欠けない方へ倒す) |
 * | 閲覧用 HTML | 🔑 **フォルダ自身は入れない**(1 件のときの `FOLDER_EXPORT_NOTE` と同じ向き ── 中のノートは入らない)。件数を言う |
 */
import { collectSubtreeLids } from '../relation/tree';
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import type { ArchiveSource } from './pkc3-archive';
import { subsetSource, type FolderSourceResult } from './folder-source';

export type SelectionMode = 'archive' | 'html';

export interface SelectionSourceResult extends FolderSourceResult {
  /** 選んでいたフォルダのうち、入れなかった件数(`html` のとき)。 */
  skippedFolders: number;
}

/** 選んだノートが何も残らなかった(`html` でフォルダだけ選んでいた等)。呼び側が断りの字を出す。 */
export class EmptySelectionError extends Error {
  readonly skippedFolders: number;
  constructor(skippedFolders: number) {
    super('書き出すノートが残りませんでした');
    this.name = 'EmptySelectionError';
    this.skippedFolders = skippedFolders;
  }
}

/** 題名(ファイル名になる)。1 件はそのノートの題名、複数は件数。 */
export function selectionTitle(firstTitle: string, count: number): string {
  return count === 1 ? firstTitle : `選んだノート${count}件`;
}

/**
 * 選んだ lid だけを含む `ArchiveSource` を作る。
 * @throws 選んだ lid がどれも居ない / `html` で全部フォルダのとき(`EmptySelectionError`)
 */
export async function selectionSource(
  base: ArchiveSource,
  selected: readonly string[],
  mode: SelectionMode,
): Promise<SelectionSourceResult> {
  const rawMetas = await base.listEntryMetas();
  const byLid = new Map(rawMetas.map((m) => [m.lid, m]));
  const picked = selected.filter((l, i) => byLid.has(l) && selected.indexOf(l) === i);
  if (picked.length === 0) throw new Error('書き出すノートが見つかりません');

  const rawRelations = await base.listRelations();
  const lids = new Set<string>();
  let skippedFolders = 0;
  const folders = picked.filter((l) => byLid.get(l)?.archetype === 'folder');
  for (const l of picked) {
    if (byLid.get(l)?.archetype !== 'folder') lids.add(l);
  }
  if (mode === 'archive' && folders.length > 0) {
    // ⚠ 木の規則は `features/relation/tree.ts` の 1 本(`folderSource` と同じ綴りの写し)
    const metaMap = new Map<string, EntryMeta>(
      rawMetas.map((m) => [
        m.lid,
        {
          lid: m.lid,
          title: m.title,
          archetype: m.archetype,
          createdAt: m.created_at,
          updatedAt: m.updated_at,
          entryOrder: m.entry_order,
          status: m.status,
          date: m.date,
          archived: m.archived !== 0,
          bodyChars: null,
        },
      ]),
    );
    const relations: Relation[] = rawRelations.map((r) => ({
      id: r.id,
      fromLid: r.from_lid,
      toLid: r.to_lid,
      kind: r.kind,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    for (const f of folders) for (const l of collectSubtreeLids(f, metaMap, relations)) lids.add(l);
  } else {
    skippedFolders = folders.length;
  }
  if (lids.size === 0) throw new EmptySelectionError(skippedFolders);

  const firstLid = picked.find((l) => lids.has(l)) ?? picked[0]!;
  const first = byLid.get(firstLid);
  const result = await subsetSource(base, {
    rawMetas,
    rawRelations,
    lids,
    title: selectionTitle(first?.title || firstLid, mode === 'archive' ? picked.length : lids.size),
    danglingWarning: (n) =>
      `選んだノートの外へ向かうつながり ${n} 件は含まれません(つなぐ先のノートが入らないため)`,
  });
  const warnings = [...result.warnings];
  if (skippedFolders > 0) {
    warnings.push(
      `選んだフォルダ ${skippedFolders} 件は入りません(フォルダの中のノートは入りません。ノートを選んでください)`,
    );
  }
  return { ...result, warnings, skippedFolders };
}
