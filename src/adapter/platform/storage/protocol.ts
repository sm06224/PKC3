/**
 * storage worker ⇄ main thread の message 契約(設計 doc §4.4)。
 * メインスレッドは query/command を投げるだけで、sqlite は worker 内に閉じる。
 */
import type { EntryMetaRow, EntryUpsert } from './schema';

export type StorageRequest =
  | { op: 'init'; dbName: string }
  | { op: 'openContainer'; cid: string; title?: string }
  | { op: 'listEntryMetas'; cid: string }
  | { op: 'getBody'; cid: string; lid: string }
  | { op: 'upsertEntry'; cid: string; entry: EntryUpsert }
  | { op: 'deleteEntry'; cid: string; lid: string }
  | { op: 'counts'; cid: string }
  | { op: 'close' };

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
  deleteEntry: null;
  counts: CountsResult;
  close: null;
}
