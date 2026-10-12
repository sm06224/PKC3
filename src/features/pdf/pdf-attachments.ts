/**
 * PDF の窓の「PDF を足す → 添付から選ぶ」に出す、この collection の PDF の添付(#275 結合)── 純粋な規則だけ。
 *
 * 🔑 窓は鍵(`attach-get` の `key`)を送ってくるが、**窓の鍵を信用しない**: 貸す前に、ここで作る一覧に
 * 実在するかを本体側が確かめる(`main.ts` の `lendAttachment`)。一覧に載るのは種類が PDF の添付だけ。
 */
import { readAttachmentMeta } from '@features/flavor/attachment-flavor';
import { assetPreviewKind } from '@features/asset/asset-preview-kind';

export interface PdfAttachmentRow {
  readonly key: string;
  readonly name: string;
  readonly size: number | null;
}

/**
 * 添付ノートの本文から、PDF の添付だけを一覧にする。
 * 名前は添付の元の file 名、空ならノートの題名。鍵(`asset_key`)が無い添付は載せない(bytes を借りられない)。
 * 並びは受け取った順(= ノートの並び)。
 */
export function pdfAttachmentsOf(
  rows: ReadonlyArray<{ readonly title: string; readonly body: string }>,
): PdfAttachmentRow[] {
  const out: PdfAttachmentRow[] = [];
  for (const r of rows) {
    const meta = readAttachmentMeta(r.body);
    if (meta.assetKey === null || meta.assetKey === '') continue;
    if (assetPreviewKind(meta.mime) !== 'pdf') continue;
    out.push({
      key: meta.assetKey,
      name: meta.name !== '' ? meta.name : r.title,
      size: meta.size,
    });
  }
  return out;
}
