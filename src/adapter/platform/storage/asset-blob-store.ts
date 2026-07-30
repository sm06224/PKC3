/**
 * asset bytes の置き場 = IndexedDB の Blob record(設計 doc §4.2)。
 *
 * bytes を sqlite(WASM リニアメモリ)に通さないための独立層:
 * - IDB の Blob 値は structured clone で JS heap の外に置かれ、ブラウザがディスクへ
 *   退避できる(PKC2 実測: base64 200MB 読出 +293MB 常駐 vs Blob ±0)
 * - sqlite 側には assets 表の meta 行(mime / size / hash)だけを書く(storage worker)
 * - 表示は ObjectURL 経由。**URL の revoke は貸した側の責務**(メモリ 2 原則)
 *
 * main thread で動く(IDB は worker 不要)。sqlite worker とは独立。
 */
const DB_NAME = 'pkc3-assets';
const STORE = 'blobs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb open failed'));
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb request failed'));
  });
}

const key = (cid: string, assetKey: string): string => `${cid}:${assetKey}`;

export class AssetBlobStore {
  private db: IDBDatabase | null = null;

  private async need(): Promise<IDBDatabase> {
    if (!this.db) this.db = await openDb();
    return this.db;
  }

  /** Blob をそのまま格納(base64 経由禁止 ── bytes を heap に通さない)。 */
  async put(cid: string, assetKey: string, blob: Blob): Promise<void> {
    await tx(await this.need(), 'readwrite', (s) => s.put(blob, key(cid, assetKey)));
  }

  async get(cid: string, assetKey: string): Promise<Blob | null> {
    const v = await tx(await this.need(), 'readonly', (s) => s.get(key(cid, assetKey)));
    return v instanceof Blob ? v : null;
  }

  async delete(cid: string, assetKey: string): Promise<void> {
    await tx(await this.need(), 'readwrite', (s) => s.delete(key(cid, assetKey)));
  }

  /**
   * 表示用 ObjectURL の貸出。返る dispose を **表示の寿命の終わりに必ず呼ぶ**
   * (revoke は所有者の責務 ── メモリ 2 原則)。
   */
  async lendObjectUrl(
    cid: string,
    assetKey: string,
  ): Promise<{ url: string; dispose: () => void } | null> {
    const blob = await this.get(cid, assetKey);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    return { url, dispose: () => URL.revokeObjectURL(url) };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
