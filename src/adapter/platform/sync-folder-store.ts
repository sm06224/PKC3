/**
 * 🔴 **フォルダ同期(全データ。#2000 段 3)で選んだフォルダの handle の置き場**。
 *
 * 「PC のフォルダ」の同期(`folder-sync.ts`)は handle を**セッションだけ**で持つ(毎回選び直す裁定 #215)。
 * こちらは端末間の同期なので、開き直すたびに選び直させると同期が続かない → `FileSystemDirectoryHandle` を IndexedDB に保存し
 * (structured clone できる)、次の起動で `queryPermission` → 切れていれば `requestPermission`(押した操作の中で)で再開する。
 *
 * - 鍵はワークスペースの cid(ワークスペースごとに 1 つのフォルダ)。
 * - 保存した handle は「フォルダを解除する」で消せる(片道にしない)。
 * - ⚠ IndexedDB が使えない環境では、このセッションの控え(メモリ)だけ。
 */
import type { SyncDirLike } from './folder-sync';
import type { DiffAssetMeta } from '@features/sync/diff-file';

export interface SyncFolderRecord {
  handle: SyncDirLike;
  /** 画面に出す名前(handle の name)。 */
  name: string;
  /** 保存した時刻(ISO)。 */
  savedAt: string;
  /** 取り込んだが実体を置けていない添付(開き直しても引き直しを続ける)。 */
  missing?: DiffAssetMeta[];
}

export interface SyncFolderStore {
  get(cid: string): Promise<SyncFolderRecord | null>;
  put(cid: string, rec: SyncFolderRecord): Promise<void>;
  delete(cid: string): Promise<void>;
}

/** メモリだけの置き場(test / IndexedDB が使えない環境)。 */
export class MemorySyncFolderStore implements SyncFolderStore {
  readonly map = new Map<string, SyncFolderRecord>();
  async get(cid: string): Promise<SyncFolderRecord | null> {
    return this.map.get(cid) ?? null;
  }
  async put(cid: string, rec: SyncFolderRecord): Promise<void> {
    this.map.set(cid, rec);
  }
  async delete(cid: string): Promise<void> {
    this.map.delete(cid);
  }
}

const DB_NAME = 'pkc3-sync-folder';
const STORE = 'handles';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb open failed'));
  });
}

function run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const r = f(t.objectStore(STORE));
        let out: T;
        r.onsuccess = () => {
          out = r.result;
        };
        // request の success は commit の前 ── 完了まで待つ
        t.oncomplete = () => {
          db.close();
          resolve(out);
        };
        t.onerror = () => {
          db.close();
          reject(t.error ?? new Error('idb tx failed'));
        };
        t.onabort = () => {
          db.close();
          reject(t.error ?? new Error('idb tx aborted'));
        };
      }),
  );
}

/** IndexedDB の置き場。 */
export class IdbSyncFolderStore implements SyncFolderStore {
  async get(cid: string): Promise<SyncFolderRecord | null> {
    const v = await run<unknown>('readonly', (s) => s.get(cid));
    if (typeof v !== 'object' || v === null) return null;
    const r = v as Partial<SyncFolderRecord>;
    if (r.handle === undefined || typeof r.name !== 'string') return null;
    const missing = Array.isArray(r.missing)
      ? r.missing.filter((m): m is DiffAssetMeta => typeof m === 'object' && m !== null && typeof m.key === 'string' && typeof m.mime === 'string' && typeof m.size === 'number' && (m.hash === null || typeof m.hash === 'string'))
      : [];
    return { handle: r.handle, name: r.name, savedAt: typeof r.savedAt === 'string' ? r.savedAt : '', ...(missing.length > 0 ? { missing } : {}) };
  }
  async put(cid: string, rec: SyncFolderRecord): Promise<void> {
    await run('readwrite', (s) => s.put(rec, cid));
  }
  async delete(cid: string): Promise<void> {
    await run('readwrite', (s) => s.delete(cid));
  }
}

/** 使える置き場を返す(IndexedDB が無ければメモリ)。 */
export function createSyncFolderStore(): SyncFolderStore {
  return typeof indexedDB === 'undefined' ? new MemorySyncFolderStore() : new IdbSyncFolderStore();
}
