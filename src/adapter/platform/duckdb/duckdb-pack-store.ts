/**
 * DuckDB wasm 一式の置き場 = IndexedDB の Blob record(#682 段③a)。
 *
 * 🔑 **Office 一式(`office-pack-store.ts`)と同じ設計の先例を写す**
 * ── 取得 / 保管 / 設置の 3 分離、IDB の tx の作法、sha256、quota の断り文。
 * ⚠ ただし **DB 名は新しく切る**(`pkc3-duckdb-pack`)── `'pkc3-office-pack'` という
 * 字は 1 バイトも触らない。IDB は名前が違えば別の DB なので、混ぜると既存 user の
 * Office 一式を巻き添えにする。
 *
 * ## Office と違う所(実地調査 2026-09-15。理由は各所)
 *
 * | Office 固有 | DuckDB では |
 * |---|---|
 * | CJK フォントの必須化 | **概念が無い**(DuckDB はフォントを持たない) |
 * | gzip で再圧縮してから保管 | **要らない**(`build/duckdb-assets-plugin.ts` が無圧縮のまま配る) |
 * | ビルドの素性(`PackBuild`) | 目録は `{version, files}` だけ |
 * | 手元 zip からの取り込み | **この回では作らない**(user の裁定待ち) |
 * | user のマクロ退避 | 概念が無い |
 *
 * ## 🔴 書き込みは **1 トランザクション**で全部入れる(Office と同じ理由)
 *
 * `files` と `meta` を分けて書くと、間で quota に当たったときに
 * 「files は入ったのに meta が無い(= 入っていないと読める)」または
 * 「meta は書けたが files が半端(= 入っていると嘘をつく)」のどちらかになる。
 * ⚠ ここは分割せず同じ tx に入れる ── quota で落ちるなら丸ごと落ちる。
 */

const DB_NAME = 'pkc3-duckdb-pack';
const FILES = 'files';
const META = 'meta';
/** meta store の key。pack は 1 つしか持たない。 */
const META_KEY = 'pack';

export class DuckDbPackStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuckDbPackStoreError';
  }
}

export interface DuckDbPackFileMeta {
  /** pack 内の相対 path(`duckdb-eh.wasm` / `duckdb-browser-eh.worker.js`)。 */
  readonly name: string;
  readonly bytes: number;
  /** 小文字 hex の SHA-256。**壊れを検出する材料なので落とさない**。 */
  readonly sha256: string;
}

export interface DuckDbPackMeta {
  /** 配布元の版(`pack.json` の `version`)。 */
  readonly version: string;
  readonly installedAt: number;
  readonly totalBytes: number;
  readonly files: readonly DuckDbPackFileMeta[];
}

export interface WriteAllOptions {
  readonly version: string;
  /** 進捗(0..1)。sha256 の計算が支配的なので、file 単位で刻む。 */
  readonly onProgress?: (done: number, total: number, name: string) => void;
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

/** 読みの 1 リクエスト。⚠ 読みは `onsuccess` でよい(値はそこで確定している)。 */
function read<T>(db: IDBDatabase, store: string, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const req = run(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb read failed'));
  });
}

/**
 * 書きの 1 トランザクション。
 *
 * 🔴 **`oncomplete` まで待つ。** IDB の request success は **commit の前**に起きるので、
 * `onsuccess` で resolve すると「書けた」と言った直後に tx が abort しうる(quota で実際に起きる)。
 */
function write(db: IDBDatabase, stores: string[], run: (t: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, 'readwrite');
    const fail = (e: unknown): void =>
      reject(e instanceof Error ? e : new Error('この端末の保存領域(IndexedDB)に書き込めませんでした'));
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

function isFileMeta(v: unknown): v is DuckDbPackFileMeta {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Record<string, unknown>;
  return typeof f['name'] === 'string' && typeof f['bytes'] === 'number' && typeof f['sha256'] === 'string';
}

function isMeta(v: unknown): v is DuckDbPackMeta {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Partial<DuckDbPackMeta>;
  return (
    typeof m.version === 'string'
    && typeof m.installedAt === 'number'
    && typeof m.totalBytes === 'number'
    && Array.isArray(m.files)
    && m.files.every(isFileMeta)
  );
}

/** 小文字 hex の SHA-256。 */
async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class DuckDbPackStore {
  private db: IDBDatabase | null = null;

  private async need(): Promise<IDBDatabase> {
    if (!this.db) this.db = await openDb();
    return this.db;
  }

  /**
   * 入っている一式の情報。**入っていなければ `null`**。
   *
   * 🔑 判定は **meta の有無**で行う ── meta は `writeAll` の tx で files と一緒に
   * 書かれるので、「meta が在る」= 「一式が揃って commit された」である。
   * ⚠ files だけ残っている状態(旧版の削除途中など)を「入っている」と読まない。
   */
  async readMeta(): Promise<DuckDbPackMeta | null> {
    const v = await read(await this.need(), META, (s) => s.get(META_KEY));
    return isMeta(v) ? v : null;
  }

  /**
   * 入れてある実体を 1 つ読む。
   *
   * ⏸ **段③b への申し送り**:ここは**まだ照合していない** ── `meta` に `sha256` と
   *   `bytes` を控えてあるのに、読み出すときに突き合わせていない。
   * 🔴 **控えただけの材料は、誰も読まなければ「在るだけ」である**(CLAUDE.md §1)──
   *   段③b で DuckDB へ渡す手前に、**少なくとも `bytes` の一致**を見ること
   *   (sha256 は 36MB を読み直すので、いつ見るかは測ってから決める)。
   * ⚠ ここで見ないのは「まだ渡す先が無い」からであって、**要らないからではない**。
   */
  async readFile(name: string): Promise<Blob | null> {
    const v = await read(await this.need(), FILES, (s) => s.get(name));
    return v instanceof Blob ? v : null;
  }

  /**
   * 一式を入れる。**揃っていなければ 1 バイトも書かない。**
   *
   * ⚠ 検査は書く前に済ませる ── 「入れてから気づく」と、quota を食っただけの
   * 半端な状態が残る。
   */
  async writeAll(files: ReadonlyMap<string, Blob>, opts: WriteAllOptions): Promise<DuckDbPackMeta> {
    if (files.size === 0) {
      throw new DuckDbPackStoreError('DuckDB の一式が空です(書き込みを取り消しました)');
    }

    // 照合材料(sha256)を作る。⚠ 落とすと、誤りが自己証明されて固定される
    const names = [...files.keys()].sort();
    const metaFiles: DuckDbPackFileMeta[] = [];
    let totalBytes = 0;
    for (const [i, name] of names.entries()) {
      const blob = files.get(name);
      if (!blob) throw new DuckDbPackStoreError(`ファイルの中身を取り出せませんでした(${name})`);
      opts.onProgress?.(i, names.length, name);
      metaFiles.push({ name, bytes: blob.size, sha256: await sha256Hex(blob) });
      totalBytes += blob.size;
    }
    opts.onProgress?.(names.length, names.length, '');

    const meta: DuckDbPackMeta = {
      version: opts.version,
      installedAt: Date.now(),
      totalBytes,
      files: metaFiles,
    };

    // 🔴 files と meta を **同じ tx** で書く。quota で落ちるなら丸ごと落ちる
    const db = await this.need();
    await write(db, [FILES, META], (t) => {
      const fs = t.objectStore(FILES);
      // 旧版の残骸を消してから入れる(file 構成が変わったときに混ざらないように)
      fs.clear();
      for (const [name, blob] of files) fs.put(blob, name);
      t.objectStore(META).put(meta, META_KEY);
    });
    return meta;
  }

  /**
   * 一式を消す。
   *
   * 🔑 **meta を先に消す**(同じ tx の中でも順序を明示しておく)── 途中で落ちても
   * 「入っている」と名乗らない側へ倒す。
   */
  async remove(): Promise<void> {
    const db = await this.need();
    await write(db, [FILES, META], (t) => {
      t.objectStore(META).delete(META_KEY);
      t.objectStore(FILES).clear();
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
