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

/**
 * joiner が ':' のため、cid に ':' が入ると `a:b` の key 空間が cid `a` の
 * prefix 範囲と交差し、**GC(listKeys → delete)が他コンテナの bytes を消す**
 * (review F3)。cid を作る側の規約に頼らず、ここで構造的に拒否する。
 */
function assertCid(cid: string): void {
  if (cid.includes(':')) throw new Error(`invalid cid (":" は使えない): ${cid}`);
}

const key = (cid: string, assetKey: string): string => {
  assertCid(cid);
  return `${cid}:${assetKey}`;
};

export class AssetBlobStore {
  private db: IDBDatabase | null = null;

  private async need(): Promise<IDBDatabase> {
    if (!this.db) this.db = await openDb();
    return this.db;
  }

  /** Blob をそのまま格納(base64 経由禁止 ── bytes を heap に通さない)。 */
  async put(cid: string, assetKey: string, blob: Blob): Promise<void> {
    const k = key(cid, assetKey); // assert は IDB を触る前に
    await tx(await this.need(), 'readwrite', (s) => s.put(blob, k));
  }

  async get(cid: string, assetKey: string): Promise<Blob | null> {
    const k = key(cid, assetKey);
    const v = await tx(await this.need(), 'readonly', (s) => s.get(k));
    return v instanceof Blob ? v : null;
  }

  async delete(cid: string, assetKey: string): Promise<void> {
    const k = key(cid, assetKey);
    await tx(await this.need(), 'readwrite', (s) => s.delete(k));
  }

  /** cid 配下の asset key 一覧(GC の候補集めに使う。Blob 値は読まない)。 */
  async listKeys(cid: string): Promise<string[]> {
    assertCid(cid);
    const prefix = `${cid}:`;
    // 上界は「':' の次の code unit ';'」の exclusive bound ── `cid:` で始まる
    // key を全部含む(U+FFFF 始まりの asset key も漏らさない。review F3)
    const keys = await tx<IDBValidKey[]>(await this.need(), 'readonly', (s) =>
      s.getAllKeys(IDBKeyRange.bound(prefix, `${cid};`, false, true)),
    );
    return keys
      .filter((k): k is string => typeof k === 'string')
      .map((k) => k.slice(prefix.length));
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
