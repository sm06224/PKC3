/**
 * 🔴 **PKC3 入り HTML を取り込む前に、バックアップ(`.pkc3-full.zip`)の形へ直す**(#1416)。
 *
 * ## 🔑 新しい取り込みの道は作らない
 *
 * 取り込みの本体(`import-pkc2.ts`)は、バックアップ zip を読んで
 * 「確認 → 衝突する ID の付け替え → 添付 → ノート → つながり → 履歴 → タグの色」へ進む 1 本の道を持つ。
 * PKC3 入り HTML の中身(DB の画像 + 添付)は、**その道の入口に合う zip に直して渡す**だけにする:
 *
 * 1. HTML の全文から DB の画像と添付を取り出す(`features/import/portable-html.ts`)
 * 2. DB の画像を、**一時の DB で**読む(worker の `readImageArchive`。いま開いているコレクションには触れない)
 * 3. 書き出しと同じ `writeArchive` で `.pkc3-full.zip` を作る(書き出し側の規則をそのまま使う)
 *
 * ⚠ 履歴は鎖のまま、タグの色は材料ごと運ぶ ── バックアップの取り込みと**同じ範囲**が戻る。
 */
import { writeArchive, type ArchiveSource } from '@features/export/pkc3-archive';
import { archiveFileName } from '@features/export/archive-kind';
import { readPortableHtml } from '@features/import/portable-html';
import type { ImageArchiveData } from '@adapter/platform/storage/protocol';

/** DB の画像 → バックアップの材料(worker に頼む口)。 */
export type ReadImageArchive = (image: Uint8Array) => Promise<ImageArchiveData>;

/** worker が返した材料を、`writeArchive` が読む口に嵌める。 */
export function portableArchiveSource(
  data: ImageArchiveData,
  assets: ReadonlyMap<string, Blob>,
): ArchiveSource {
  const chainOf = new Map(data.chains.map((c) => [c.lid, c.rows]));
  return {
    cid: data.cid,
    title: data.title,
    listEntryMetas: async () => data.metas,
    // 本文は既に全部あるので、1 回で渡して終える(`done: true`)
    listBodies: async () => ({ rows: data.bodies, done: true }),
    listRelations: async () => data.relations,
    listAssetMetas: async () => data.assets,
    getAssetBlob: async (key) => assets.get(key) ?? null,
    listTagColors: async () => data.tagColors,
    listRevisionLids: async () => data.chains.map((c) => c.lid),
    getRevisionChain: async (lid) => chainOf.get(lid) ?? [],
  };
}

/**
 * PKC3 入り HTML の全文 → `.pkc3-full.zip` の Blob。
 * @throws 印が無い / 最後まで書き込まれていない / 中身が読めない / ノートが 1 件も無い
 */
export async function portableHtmlToArchive(
  html: string,
  read: ReadImageArchive,
  now: Date,
): Promise<Blob> {
  const parts = readPortableHtml(html);
  const data = await read(parts.image);
  if (data.metas.length === 0) {
    throw new Error('この PKC3 入り HTML には、取り込めるノートが 1 件も入っていません');
  }
  const out = await writeArchive(portableArchiveSource(data, parts.assets), now.toISOString());
  return out.blob;
}

/** 取り込みの道に渡す file の名前(元の名前から `.html` を外して、バックアップの末尾を付ける)。 */
export function portableArchiveName(htmlName: string): string {
  const base = htmlName.replace(/\.pkc3\.html?$/i, '').replace(/\.html?$/i, '');
  return archiveFileName(base === '' ? 'pkc3' : base, 'full');
}
