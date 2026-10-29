/**
 * 音源分離モデルの置き場 = IndexedDB の Blob record(#674 / #949。レビュー裁定: ASR の一式と同じく端末へ取り込んで残す)。
 *
 * 🔑 `asr-pack-store.ts` と同じ設計の先例を写す。⚠ **DB 名は新しく切る**(`pkc3-stem-model`)── 既存の DB の字は 1 バイトも触らない。
 *  - `files` ── key = モデルの id、値 = **Blob**(heap に載せない。読み出しも Blob のまま ── worker へは参照で渡る)
 *  - `meta`  ── key = モデルの id、値 = `{ bytes, url, installedAt }`(Blob を読まずに「入っている」を言うため)
 * 🔴 書き込みは **1 トランザクション**(Blob と meta を分けると、quota で落ちたとき半端が残る)。`oncomplete` まで待つ。
 * 🔴 「入っている」の判定は **meta が在り、かつ Blob が在る**こと(`has`)── 片方だけは「入っていない」と読む。
 */

const DB_NAME = 'pkc3-stem-model';
const FILES = 'files';
const META = 'meta';

export interface StemModelMeta {
  readonly bytes: number;
  /** 取れた取得元の URL(どこから取ったかを画面で言える)。 */
  readonly url: string;
  readonly installedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(FILES)) req.result.createObjectStore(FILES);
      if (!req.result.objectStoreNames.contains(META)) req.result.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb open failed'));
  });
}

function read<T>(db: IDBDatabase, store: string, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const req = run(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb read failed'));
  });
}

function write(db: IDBDatabase, run: (t: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction([FILES, META], 'readwrite');
    const fail = (e: unknown): void =>
      reject(e instanceof Error ? e : new Error('この端末にモデルを保存できませんでした(IndexedDB)'));
    t.oncomplete = () => resolve();
    t.onerror = () => fail(t.error);
    t.onabort = () => fail(t.error ?? new Error('idb transaction aborted'));
    try {
      run(t);
    } catch (e) {
      fail(e);
    }
  });
}

function isMeta(v: unknown): v is StemModelMeta {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Partial<StemModelMeta>;
  return typeof m.bytes === 'number' && typeof m.url === 'string' && typeof m.installedAt === 'number';
}

/** 置き場の口(installer が使う部分。test が差し替える)。 */
export interface StemModelStorePort {
  readMeta(id: string): Promise<StemModelMeta | null>;
  readBlob(id: string): Promise<Blob | null>;
  put(id: string, blob: Blob, meta: StemModelMeta): Promise<void>;
  remove(id: string): Promise<void>;
}

export class StemModelStore implements StemModelStorePort {
  private db: IDBDatabase | null = null;

  private async need(): Promise<IDBDatabase> {
    if (!this.db) this.db = await openDb();
    return this.db;
  }

  /** 入っているモデルの控え。⚠ Blob が無ければ「入っていない」(片方だけは入っていると言わない)。 */
  async readMeta(id: string): Promise<StemModelMeta | null> {
    const db = await this.need();
    const raw = await read(db, META, (s) => s.get(id));
    if (!isMeta(raw)) return null;
    const key = await read(db, FILES, (s) => s.getKey(id));
    return key === undefined ? null : raw;
  }

  /** 重み(Blob のまま。heap に載せない)。 */
  async readBlob(id: string): Promise<Blob | null> {
    const v = await read(await this.need(), FILES, (s) => s.get(id));
    return v instanceof Blob ? v : null;
  }

  async put(id: string, blob: Blob, meta: StemModelMeta): Promise<void> {
    const db = await this.need();
    await write(db, (t) => {
      t.objectStore(FILES).put(blob, id);
      t.objectStore(META).put(meta, id);
    });
  }

  async remove(id: string): Promise<void> {
    const db = await this.need();
    await write(db, (t) => {
      t.objectStore(FILES).delete(id);
      t.objectStore(META).delete(id);
    });
  }
}
