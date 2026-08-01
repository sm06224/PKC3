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
  | {
      op: 'upsertEntry';
      cid: string;
      entry: EntryUpsert;
      /** true = 変更前の body を履歴に 1 件積む(既定は amend ── 鎖の頭を張り替えるだけ)。 */
      checkpoint?: boolean;
      /** 生存 entry の保持上限(未指定は worker 既定)。 */
      keepLatest?: number;
    }
  | { op: 'bulkUpsertEntries'; cid: string; entries: EntryUpsert[] }
  | { op: 'deleteEntry'; cid: string; lid: string }
  | { op: 'listRelations'; cid: string }
  | { op: 'bulkUpsertRelations'; cid: string; relations: RelationUpsert[] }
  | {
      /**
       * 取込の履歴を**鎖として**積む(P5c の符号化 = tip は entries.body、
       * 履歴は逆向きパッチ)。全文で積む経路は持たない ── 持つと取込だけが
       * 設計から外れ、PKC2 と同じ「履歴が本文の N 倍」に戻る。
       */
      op: 'importRevisionChains';
      cid: string;
      chains: RevisionChainInput[];
      keepLatest?: number;
    }
  | { op: 'revisionCounts'; cid: string }
  | { op: 'getRevision'; cid: string; id: string }
  | { op: 'listRevisionMetas'; cid: string; entryLid: string }
  /** revisions が存在する entry_lid の集合(= 生存 + ゴミ箱)。取込の lid 衝突判定用。 */
  | { op: 'listRevisionLids'; cid: string }
  | { op: 'listTrash'; cid: string }
  | { op: 'purgeTrash'; cid: string }
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

/**
 * 取込む履歴 1 本(entry 1 件ぶん)。snapshots は**古い → 新しい**の順の全文で、
 * worker が tip(entries.body)から遡る逆向きパッチへ符号化する。
 *
 * ⚠ **既に履歴を持つ entry には積まない**(worker が skip する)── 既存の鎖に
 * 割り込ませると符号化の前提(隣接する版の差分)が崩れる。
 */
export interface RevisionChainInput {
  entryLid: string;
  snapshots: Array<{ body: string; createdAt: string }>;
}

/** importRevisionChains の結果(何が入って何が落ちたかを可視化する)。 */
export interface ImportRevisionsResult {
  /** 実際に積んだ行数。 */
  added: number;
  /** 変更が無くて畳んだ版の数(PKC2 は無変更でも snapshot を作りうる)。 */
  skippedNoChange: number;
  /** 保持上限を超えて捨てた古い版の数。 */
  droppedOverLimit: number;
  /** entry が居ない / 既に履歴を持つ等で丸ごと見送った鎖の entry_lid。 */
  skippedEntries: string[];
}

/** revision 一覧の行(snapshot は返さない ── 本文は getRevision で 1 行ずつ)。 */
export interface RevisionMetaRow {
  id: string;
  entry_lid: string;
  rev_order: number;
  created_at: string | null;
  title: string | null;
  archetype: string | null;
  /**
   * 保存形('patch' = 逆向き差分 / 'full' = 全文)。
   * P5c の設計そのもの ── 一覧に出しておくと「差分で持っている」が**観測可能**に
   * なる(出さないと、全文で積む実装に退化しても test が気づけない)。
   */
  kind: string | null;
}

/** getRevision の本文(P5 で JSON 包みを廃止 ── body 原文 + 列)。 */
export interface RevisionBody {
  body: string;
  title: string | null;
  archetype: string | null;
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
  importRevisionChains: ImportRevisionsResult;
  revisionCounts: RevisionCountRow[];
  getRevision: RevisionBody | null;
  listRevisionMetas: RevisionMetaRow[];
  listRevisionLids: string[];
  listTrash: RevisionMetaRow[];
  purgeTrash: { purged: number };
  putAssetMeta: null;
  listAssetMetas: AssetMetaRow[];
  deleteAssetMeta: null;
  scanAssetRefs: { referenced: string[] };
  counts: CountsResult;
  close: null;
}
