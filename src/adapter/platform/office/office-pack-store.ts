/**
 * Office wasm 一式の置き場 = IndexedDB の Blob record(#88 / 統合設計 O1)。
 *
 * 🔴 user 裁定 2026-08-10「**実行したい人が手動で設定した際に追加ダウンロードと
 * idb とか opfs に配備して、以降の起動はローカルからにしてください**」の実体。
 *
 * ## なぜ IDB Blob か(OPFS ではない)
 *
 * - 同型の前例が 2 つある(`pkc3-assets` / `pkc3-diagram-cache`)── 3 例目として
 *   同じ規約で書ける。新しい storage 面を増やさない
 * - `URL.createObjectURL(blob)` 経由で **heap に載せずに流せる**
 *   (不可侵「ゼロコピー・生成物の即破棄」)
 * - OPFS は **storage worker が sqlite の lease を握っている**。大物を同居させると
 *   quota 逼迫の影響が**ノート本体**に及ぶ ── 分けておくほうが安全
 *
 * ## 保管の形
 *
 * **gz のまま置く**(`soffice.wasm.gz` 50.6MB + `soffice.data.gz` 26.4MB)。
 * 実容量が 93MB → 約 77MB で済み、起動時は `DecompressionStream('gzip')` +
 * `WebAssembly.instantiateStreaming` で**解きながら compile** できる
 * (実測 4,041ms / 288 exports。148MB を JS heap に載せない)。
 *
 * ## 🔴 install は **1 トランザクション**で全部入れる
 *
 * asset 側は「bytes を先に、参照を後に」で順序を買おうとして、**IDB の commit が
 * 遅いせいでその保証が成立しなかった**(`asset-blob-store.ts` の記録)。
 * ここは分割せず、**files も meta も同じ tx**に入れる ── quota で落ちるなら
 * **丸ごと落ちる**。半端に入った pack が「入っている」と名乗る余地を作らない。
 */
import {
  assertPackComplete,
  OfficePackError,
  sha256Hex,
  type OfficePackFileMeta,
  type OfficePackMeta,
  type PackBuild,
} from './office-pack';

const DB_NAME = 'pkc3-office-pack';
const FILES = 'files';
const META = 'meta';
/** meta store の唯一の key。pack は 1 つしか持たない。 */
const META_KEY = 'pack';

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

/**
 * 読みの 1 リクエスト。⚠ 読みは `onsuccess` でよい(値はそこで確定している)。
 */
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
 * `onsuccess` で resolve すると「書けた」と言った直後に tx が abort しうる ──
 * quota で実際に起きる(`asset-blob-store.ts` の P8 段㉔ の記録と同じ罠)。
 */
function write(
  db: IDBDatabase,
  stores: string[],
  run: (t: IDBTransaction) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, 'readwrite');
    const fail = (e: unknown): void =>
      reject(e instanceof Error ? e : new Error('idb transaction failed'));
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

function isMeta(v: unknown): v is OfficePackMeta {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Partial<OfficePackMeta>;
  return typeof m.version === 'string'
    && typeof m.installedAt === 'number'
    && (m.source === 'url' || m.source === 'file')
    && Array.isArray(m.files);
}

export interface InstallOptions {
  readonly version: string;
  /** ⚠ 目録に無ければ `null`(古い配布元 / 手元の zip)。 */
  readonly build?: PackBuild | null;
  readonly source: 'url' | 'file';
  /** 進捗(0..1)。sha256 の計算が支配的なので、file 単位で刻む。 */
  readonly onProgress?: (done: number, total: number, name: string) => void;
}

export class OfficePackStore {
  private db: IDBDatabase | null = null;

  private async need(): Promise<IDBDatabase> {
    if (!this.db) this.db = await openDb();
    return this.db;
  }

  /**
   * 入っている一式の情報。**入っていなければ `null`**。
   *
   * 🔑 判定は **meta の有無**で行う ── meta は install の tx で files と一緒に書かれるので、
   * 「meta が在る」= 「一式が揃って commit された」である。
   * ⚠ files だけ残っている状態(旧版の削除途中など)を「入っている」と読まない。
   */
  async readMeta(): Promise<OfficePackMeta | null> {
    const v = await read(await this.need(), META, (s) => s.get(META_KEY));
    if (!isMeta(v)) return null;
    /**
     * ⚠ **前に入れた一式は `build` を持たない**(#155)── 読んだ形をそのまま返すと
     * `undefined` が画面まで流れる。ここで `null` に正規化する(後方互換)。
     */
    return v.build == null ? { ...v, build: null } : v;
  }

  async isInstalled(): Promise<boolean> {
    return (await this.readMeta()) !== null;
  }

  async getFile(name: string): Promise<Blob | null> {
    const v = await read(await this.need(), FILES, (s) => s.get(name));
    return v instanceof Blob ? v : null;
  }

  /**
   * 表示・読み込み用の ObjectURL の貸出。返る `dispose` を**寿命の終わりに必ず呼ぶ**
   * (revoke は借りた側の責務 ── 不可侵「ObjectURL は表示の寿命終端で revoke」)。
   */
  async lendObjectUrl(name: string): Promise<{ url: string; dispose: () => void } | null> {
    const blob = await this.getFile(name);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    return { url, dispose: () => URL.revokeObjectURL(url) };
  }

  /**
   * 一式を入れる。**揃っていなければ 1 バイトも書かない。**
   *
   * ⚠ 検査は書く前に済ませる ── 「入れてから気づく」と、
   * quota を食っただけの半端な状態が残る。
   */
  async install(files: ReadonlyMap<string, Blob>, opts: InstallOptions): Promise<OfficePackMeta> {
    // ① 揃っているか(取得側でも見るが、**保管側でも数え直す**)
    assertPackComplete(files.keys());

    // ② 照合材料(sha256)を作る。⚠ 落とすと、誤りが自己証明されて固定される
    const names = [...files.keys()].sort();
    const metaFiles: OfficePackFileMeta[] = [];
    let totalBytes = 0;
    for (const [i, name] of names.entries()) {
      const blob = files.get(name);
      if (!blob) throw new OfficePackError(`内部矛盾: ${name} の Blob がありません`);
      opts.onProgress?.(i, names.length, name);
      metaFiles.push({ name, bytes: blob.size, sha256: await sha256Hex(blob) });
      totalBytes += blob.size;
    }
    opts.onProgress?.(names.length, names.length, '');

    const meta: OfficePackMeta = {
      version: opts.version,
      // 🔴 **どのビルドかを保存する**(#155)── 版の文字列は使い回されることがある
      build: opts.build ?? null,
      installedAt: Date.now(),
      source: opts.source,
      totalBytes,
      files: metaFiles,
    };

    // ③ 🔴 files と meta を **同じ tx** で書く。quota で落ちるなら丸ごと落ちる
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
   * 「入っている」と名乗らない側へ倒す。⚠ 逆順にすると、files が消えたのに
   * meta が残って「入っているのに読めない」状態を作る。
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
