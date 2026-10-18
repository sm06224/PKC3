/**
 * 🔴 **PKC3 入り HTML を取り込む前に、バックアップ(`Pkc3Archive`)の形へ直す**(#1416)。
 *
 * ## 🔑 新しい取り込みの道は作らない ── zip も作らない
 *
 * 取り込みの本体(`import-pkc2.ts`)は、バックアップを読んで
 * 「確認 → 衝突する ID の付け替え → 添付 → ノート → つながり → 履歴 → タグの色」へ進む 1 本の道を持つ。
 * その道の入口は `Pkc3Archive`(zip を読んだ後の形)である。PKC3 入り HTML の中身(DB の画像 + 添付)は、
 * **その形に直して渡す**だけにする:
 *
 * 1. HTML から DB の画像と添付を取り出す(`features/import/portable-html.ts`)
 * 2. DB の画像を、**一時の DB で**読む(worker の `readImageArchive`。いま開いているコレクションには触れない)
 * 3. 書き出しと同じ写し(`toArchive*`)と、zip の読み取りと同じ検め(`assembleArchive`)で `Pkc3Archive` を組む
 *
 * ⚠ 以前は 3 で `writeArchive` に zip を作らせ、それを読み戻していた ── **添付が 1 部ずつ余計に増え**
 *   (432 MB の HTML で、取り込みの後半にブラウザ側が約 400 MB を抱えた)、読み戻しのために全添付を
 *   もう一度なぞっていた。いまは添付の Blob をそのまま取り込みの本体へ渡す(`BlobAssetSource`)。
 * ⚠ 履歴は鎖のまま、タグの色は材料ごと運ぶ ── バックアップの取り込みと**同じ範囲**が戻る。
 */
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  assembleArchive,
  checkArchiveManifest,
  toArchiveAsset,
  toArchiveEntry,
  toArchiveRelation,
  toArchiveRevision,
  toArchiveTrash,
  type ArchiveContainerJson,
  type ArchiveEntry,
  type ArchiveRevision,
  type ArchiveTrashNote,
  type Pkc3Archive,
} from '@features/export/pkc3-archive';
import { openPortableHtmlBlob, type LazyPortableAsset } from '@features/import/portable-html';
import type { ReadableAssetSource } from '@features/import/zip-reader';
import type { ImageArchiveData } from '@adapter/platform/storage/protocol';

/** DB の画像 → バックアップの材料(worker に頼む口)。 */
export type ReadImageArchive = (image: Uint8Array) => Promise<ImageArchiveData>;

/**
 * worker が返した材料と添付 → `Pkc3Archive`(zip を介さない)。
 * ⚠ 検め・警告・版の読み替えは zip の読み取りと**同じ `assembleArchive`** を通る。
 * @throws ノートが 1 件も無い
 */
export function portableArchive(
  data: ImageArchiveData,
  assets: ReadonlyMap<string, Blob | LazyPortableAsset>,
  now: Date,
): Pkc3Archive {
  if (data.metas.length === 0) {
    throw new Error('この PKC3 入り HTML には、取り込めるノートが 1 件も入っていません');
  }
  const metaOf = new Map(data.metas.map((m) => [m.lid, m]));
  // 本文があって一覧にも在るものだけ(書き出しと同じ ── 一覧に無い本文は取り込まない)
  const entries: ArchiveEntry[] = [];
  for (const r of data.bodies) {
    const m = metaOf.get(r.lid);
    if (m) entries.push(toArchiveEntry(m, r.body));
  }
  // 🔴 ゴミ箱のノートは書き出しと同じ写し(`toArchiveTrash`)で別の鍵へ(台帳 #1852 束 F2 / 依頼 105-2・297 A)。
  //   鎖はゴミ箱の lid のぶんも入っている ── 生きたノートの履歴(`revisions`)と混ぜない
  const trash: ArchiveTrashNote[] = [];
  const trashRevisions: ArchiveRevision[] = [];
  const trashLids = new Set<string>();
  const chainOf = new Map(data.chains.map((c) => [c.lid, c.rows] as const));
  for (const h of data.trash) {
    if (metaOf.has(h.lid) || trashLids.has(h.lid)) continue;
    const got = toArchiveTrash(h, chainOf.get(h.lid) ?? []);
    if (got === null) continue;
    trash.push(got.note);
    trashRevisions.push(...got.rows);
    trashLids.add(h.lid);
  }
  const revisions = data.chains
    .filter((c) => !trashLids.has(c.lid))
    .flatMap((c) => c.rows.map((rv) => toArchiveRevision(c.lid, rv)));
  // ゴミ箱のノートに触るつながりは別の鍵へ(書き出しと同じ分け方。両端がバックアップの中に居る物だけ)
  const knows = (lid: string): boolean => metaOf.has(lid) || trashLids.has(lid);
  const trashRelations = data.relations.filter(
    (r) => (trashLids.has(r.from_lid) || trashLids.has(r.to_lid)) && knows(r.from_lid) && knows(r.to_lid),
  );
  const trashRelationIds = new Set(trashRelations.map((r) => r.id));
  const container: ArchiveContainerJson = {
    entries,
    relations: data.relations.filter((r) => !trashRelationIds.has(r.id)).map(toArchiveRelation),
    revisions,
    ...(trash.length > 0
      ? { trash, trashRelations: trashRelations.map(toArchiveRelation), trashRevisions }
      : {}),
    assets: data.assets.map(toArchiveAsset),
    // 1 つも無ければ付けない(書き出しと同じ)
    ...(data.tagColors.length > 0 ? { tagColors: data.tagColors } : {}),
  };
  // 実体のある添付だけが「開ける添付」になる(目録に在って実体が無いものは assembleArchive が警告する)
  const sources = new Map<string, ReadableAssetSource>();
  for (const a of data.assets) {
    const got = assets.get(a.key);
    if (got === undefined) continue;
    // 🔑 開くまで復号しない添付は、そのまま遅延の在り処にする(確認の窓の前に Blob を作らない)
    sources.set(a.key, got instanceof Blob ? { blob: got } : { size: got.size, open: () => got.open() });
  }
  const manifest: Pkc3Archive['manifest'] & { counts: Record<string, number> } = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exported_at: now.toISOString(),
    cid: data.cid,
    title: data.title,
    counts: {
      entries: entries.length,
      relations: data.relations.length - trashRelations.length,
      revisions: revisions.length,
      assets: data.assets.length,
      ...(trash.length > 0 ? { trash: trash.length } : {}),
    },
  };
  checkArchiveManifest(manifest);
  return assembleArchive(manifest, container, sources, []);
}

/**
 * PKC3 入り HTML(file) → `Pkc3Archive`。⚠ 全文を字にしない(窓で読む ── `openPortableHtmlBlob`)。
 * 🔑 添付は**確認の窓の後まで復号しない**(目録と大きさだけで窓が出る。やめれば何も重くならない)。
 * @throws 印が無い / 最後まで書き込まれていない / 中身が読めない / ノートが 1 件も無い
 */
export async function portableHtmlToArchive(
  html: Blob,
  read: ReadImageArchive,
  now: Date,
): Promise<Pkc3Archive> {
  const parts = await openPortableHtmlBlob(html);
  const data = await read(parts.image);
  return portableArchive(data, parts.assets, now);
}
