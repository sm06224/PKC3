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
 * 照合(「記録された数と実際の数が合いません」)が警告として出るので、ここで
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
import { readZipDirectory, readZipText, unwrapSingleTopDir, ZipReadError } from './zip-reader';
import { isTooLargeToRead } from './too-large';
import { ARCHIVE_FORMAT, type Pkc3Archive } from '../export/pkc3-archive';

export interface ArchivePreview {
  readonly noteCount: number;
  readonly assetCount: number;
  readonly hasRelations: boolean;
  readonly hasRevisions: boolean;
  /** 🔴 バックアップを取った日時(manifest の `exported_at`。ISO 文字列)。無い・読めないときは `null`(#1643)。 */
  readonly exportedAt: string | null;
}

/**
 * `manifest.json` だけを覗いて中身の概要を返す。
 * @returns PKC3 のアーカイブでない / manifest が壊れている / counts が無い
 *   旧形式 ── いずれも `null`(呼び出し側は確認を出さずに素通しする)
 */
export async function peekArchivePreview(zip: Blob): Promise<ArchivePreview | null> {
  const dir = unwrapSingleTopDir(await readZipDirectory(zip)).entries;
  const hits = dir.filter((e) => e.name === 'manifest.json');
  if (hits.length !== 1) return null;
  let manifest: {
    format?: unknown;
    exported_at?: unknown;
    counts?: { entries?: unknown; relations?: unknown; revisions?: unknown };
  };
  try {
    manifest = JSON.parse(await readZipText(zip, hits[0]!)) as typeof manifest;
  } catch (e) {
    // 🔴 壊れた zip・大きすぎる物は「中身が分からない」ではなく、そのまま上へ(確認なしで素通しすると、後で失敗する)
    if (e instanceof ZipReadError || isTooLargeToRead(e)) throw e;
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
    exportedAt: typeof manifest.exported_at === 'string' ? manifest.exported_at : null,
  };
}

/**
 * zip を介さずに組んだ `Pkc3Archive`(PKC3 入り HTML)の概要。⚠ `peekArchivePreview` と**同じ数え方**:
 * ノートの件数は書き出しが刻む `manifest.counts.entries`(= 取り込むノートの数)、
 * 添付は**実際に開ける**数(`assetSources`)。
 */
export function archivePreviewOf(archive: Pkc3Archive): ArchivePreview {
  return {
    noteCount: archive.entries.length,
    assetCount: archive.assetSources.size,
    hasRelations: archive.relations.length > 0,
    hasRevisions: archive.revisions.length > 0,
    exportedAt: typeof archive.manifest.exported_at === 'string' ? archive.manifest.exported_at : null,
  };
}

/**
 * 🔴 **窓の頭に出す「どのファイルか・いつ取ったか」**(依頼 38-3 の裁定 A。#1643)── 週ごとにバックアップを
 * 溜めていると、どれが今週の物か分からなかった。例:「メモ-20261010.pkc3-full.zip(10月10日 18:20 に取りました)」。
 * ⚠ 時刻は**この端末の時刻**で出す(書き出しは UTC の ISO で書いている)。読めない日時は黙って省く(壊すより通す)。
 * @returns 名前も日時も無ければ `null`(行を作らない)
 */
export function archiveSourceLine(fileName: string | undefined, exportedAt: string | null): string | null {
  const t = exportedAt === null ? Number.NaN : Date.parse(exportedAt);
  const when = Number.isNaN(t)
    ? null
    : (() => {
        const d = new Date(t);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${String(d.getMonth() + 1)}月${String(d.getDate())}日 ${hh}:${mm} に取りました`;
      })();
  const name = fileName !== undefined && fileName !== '' ? fileName : null;
  if (name !== null && when !== null) return `${name}(${when})`;
  if (name !== null) return name;
  return when;
}

/** 確認の窓に出す本文(`\n` 区切り ── `dialog-body` は `white-space: pre-wrap`)。 */
export function formatArchivePreviewMessage(preview: ArchivePreview, fileName?: string): string {
  const source = archiveSourceLine(fileName, preview.exportedAt);
  return [
    ...(source !== null ? [source] : []),
    `このバックアップには、次が入っています。`,
    `ノート ${String(preview.noteCount)} 件`,
    `添付 ${String(preview.assetCount)} 件`,
    `つながり ${preview.hasRelations ? '有' : '無'}`,
    `履歴 ${preview.hasRevisions ? '有' : '無'}`,
    // 🔑 「バックアップ」は「元に戻る(置き換わる)」と読まれやすい ── 足すだけであることを押す前に言う(#1087)。
    //   依頼 38-2 の裁定 A(#1643):取り込んだ後でも取り消せることまで言う(「取り込みを取り消す」は取り込み直後に出る)
    'いまのノートはそのまま残り、これが追加されます。取り込んだ後でも取り消せます。',
  ].join('\n');
}
