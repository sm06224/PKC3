/**
 * #1017 段④b(coordinator 追補): 取込前に「何が入っているか」を言う。
 *
 * 🔴 **「3 か所で中身を言う」の 3 つ目**(設計 doc §5)── ①ボタンの下の 1 行
 * ②file 名の末尾 に続く③取込の確認の窓。①②は `archive-kind.ts` で足したが、
 * ③(取り込む側の確認)が抜けていた。
 *
 * ## zip を丸ごと展開しない
 *
 * `manifest.json` を JSON.parse するだけ(`container.json` は読まない)。
 * ノート件数・つながり有無・履歴有無は `writeArchive`(`pkc3-archive.ts`)が
 * 書いた `manifest.counts` から取る ── 中身と食い違えば `readArchive` の
 * 照合(「manifest の N 件数が中身と違います」)が警告として出るので、ここで
 * 二重に数え直す必要はない。⚠ **添付だけは目録(zip の中央ディレクトリ)から
 * 実数える** ── `manifest.counts.assets` は「meta の数」で、bytes が
 * 欠けている(GC の途中失敗)場合と食い違いうるため、user に見せる数は
 * **実際に開ける添付の数**にする。
 *
 * ## 旧 `.pkc3.zip` でも同じ表が出る
 *
 * 判定は `manifest.format`(`ARCHIVE_FORMAT = 'pkc3-archive'`)だけを見る ──
 * file 名(`.pkc3-full.zip` / `-notes` / `-part` / 旧 `.pkc3.zip`)は一切見ない
 * (`archive-kind.ts` が既に確立した規律と同じ向き)。
 *
 * ⚠ pure module。browser API は持たない(`Blob` は zip-reader.ts と同じ扱い)。
 */
import { readZipDirectory, readZipText } from './zip-reader';
import { ARCHIVE_FORMAT } from '../export/pkc3-archive';

export interface ArchivePreview {
  readonly noteCount: number;
  readonly assetCount: number;
  readonly hasRelations: boolean;
  readonly hasRevisions: boolean;
}

/**
 * `manifest.json` だけを覗いて中身の概要を返す。
 * @returns PKC3 のアーカイブでない / manifest が壊れている / counts が無い
 *   旧形式 ── いずれも `null`(呼び出し側は確認を出さずに素通しする)
 */
export async function peekArchivePreview(zip: Blob): Promise<ArchivePreview | null> {
  const dir = await readZipDirectory(zip);
  const hits = dir.filter((e) => e.name === 'manifest.json');
  if (hits.length !== 1) return null;
  let manifest: {
    format?: unknown;
    counts?: { entries?: unknown; relations?: unknown; revisions?: unknown };
  };
  try {
    manifest = JSON.parse(await readZipText(zip, hits[0]!)) as typeof manifest;
  } catch {
    return null;
  }
  if (manifest.format !== ARCHIVE_FORMAT) return null;
  const counts = manifest.counts;
  if (typeof counts?.entries !== 'number') return null;
  // ⚠ 目録(zip の中央ディレクトリ)から実数える ── manifest の meta 数ではない
  const assetCount = dir.filter((e) => !e.isDirectory && e.name.startsWith('assets/')).length;
  return {
    noteCount: counts.entries,
    assetCount,
    hasRelations: typeof counts.relations === 'number' && counts.relations > 0,
    hasRevisions: typeof counts.revisions === 'number' && counts.revisions > 0,
  };
}

/** 確認の窓に出す本文(`\n` 区切り ── `dialog-body` は `white-space: pre-wrap`)。 */
export function formatArchivePreviewMessage(preview: ArchivePreview): string {
  return [
    `このバックアップには、次が入っています。`,
    `ノート ${String(preview.noteCount)} 件`,
    `添付 ${String(preview.assetCount)} 件`,
    `つながり ${preview.hasRelations ? '有' : '無'}`,
    `履歴 ${preview.hasRevisions ? '有' : '無'}`,
  ].join('\n');
}
