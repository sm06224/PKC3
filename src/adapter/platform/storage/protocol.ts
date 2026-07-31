/**
 * storage worker ⇄ main thread の message 契約(設計 doc §4.4)。
 * メインスレッドは query/command を投げるだけで、sqlite は worker 内に閉じる。
 */
import type { EntryMetaRow, EntryUpsert } from './schema';

export type StorageRequest =
  | { op: 'init'; dbName: string; journalMode?: JournalMode }
  | { op: 'openContainer'; cid: string; title?: string }
  | { op: 'listEntryMetas'; cid: string }
  | { op: 'getBody'; cid: string; lid: string }
  | { op: 'upsertEntry'; cid: string; entry: EntryUpsert }
  | { op: 'bulkUpsertEntries'; cid: string; entries: EntryUpsert[] }
  | { op: 'deleteEntry'; cid: string; lid: string }
  | { op: 'listRelations'; cid: string }
  | { op: 'bulkUpsertRelations'; cid: string; relations: RelationUpsert[] }
  | { op: 'bulkAddRevisions'; cid: string; revisions: RevisionAdd[] }
  | { op: 'revisionCounts'; cid: string }
  | { op: 'getRevision'; cid: string; id: string }
  | { op: 'putAssetMeta'; cid: string; meta: AssetMetaPut }
  | { op: 'listAssetMetas'; cid: string }
  | { op: 'deleteAssetMeta'; cid: string; key: string }
  | { op: 'scanAssetRefs'; cid: string; candidates: string[] }
  | { op: 'counts'; cid: string }
  | { op: 'close' };

/** assets 表は meta のみ(bytes は AssetBlobStore ── §4.2)。hash は遅延計算可。 */
export interface AssetMetaPut {
  key: string;
  mime: string;
  size: number;
  hash?: string | null;
}

export interface AssetMetaRow {
  key: string;
  mime: string | null;
  size: number | null;
  hash: string | null;
}

/** relations の行(P3-6b: boot 配線)。 */
export interface RelationRow {
  id: string;
  from_lid: string;
  to_lid: string;
  kind: string;
  created_at: string | null;
  updated_at: string | null;
}

/** relations の一括書込(P6 import / 将来の relation 編集が使う)。 */
export interface RelationUpsert {
  id: string;
  fromLid: string;
  toLid: string;
  kind: string;
}

/** revision の追加(P2 最小形: snapshot は平文。zstd segment 化は P5)。 */
export interface RevisionAdd {
  id: string;
  entryLid: string;
  revOrder: number;
  snapshot: string;
}

/** entry ごとの revision 件数(snapshot は読まない ── 常駐ゼロの根拠)。 */
export interface RevisionCountRow {
  entry_lid: string;
  n: number;
}

/** message 経由の値を PRAGMA に流すため allowlist で固定(injection 防止)。 */
export const JOURNAL_MODES = [
  'delete',
  'truncate',
  'persist',
  'memory',
  'wal',
] as const;
export type JournalMode = (typeof JOURNAL_MODES)[number];

export interface StorageOk<T = unknown> {
  id: number;
  ok: true;
  result: T;
}
export interface StorageErr {
  id: number;
  ok: false;
  error: string;
}
export type StorageResponse<T = unknown> = StorageOk<T> | StorageErr;

export interface InitResult {
  vfs: 'opfs-sahpool' | 'memory';
  libVersion: string;
  crossOriginIsolated: boolean;
  /** PRAGMA journal_mode の読み戻し値(要求と違う値になりうる ── 非対応時)。 */
  journalMode: string;
  /** memory fallback したときだけ入る、落ちた理由(観測可能性 ── review #1)。 */
  fallbackReason?: string;
}

export interface CountsResult {
  entries: number;
  relations: number;
  revisions: number;
  assets: number;
}

export type RequestFor<Op extends StorageRequest['op']> = Extract<
  StorageRequest,
  { op: Op }
>;

export interface ResultMap {
  init: InitResult;
  openContainer: null;
  listEntryMetas: EntryMetaRow[];
  getBody: string | null;
  upsertEntry: null;
  bulkUpsertEntries: null;
  deleteEntry: null;
  listRelations: RelationRow[];
  bulkUpsertRelations: null;
  bulkAddRevisions: null;
  revisionCounts: RevisionCountRow[];
  getRevision: string | null;
  putAssetMeta: null;
  listAssetMetas: AssetMetaRow[];
  deleteAssetMeta: null;
  scanAssetRefs: { referenced: string[] };
  counts: CountsResult;
  close: null;
}
