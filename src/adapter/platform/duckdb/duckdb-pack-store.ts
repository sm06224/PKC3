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
import {
  DUCKDB_EXTENSIONS,
  DUCKDB_REQUIRED_FILES,
  DUCKDB_WASM,
  DUCKDB_WORKER,
  duckDbExtensionPath,
} from '@features/query/duckdb-pack';

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
   *
   * 🔴 **いまの一式に足りない物が在れば `null`**(#682 段④b)。
   * ⚠ 段④b で拡張 3 つが一式に加わったので、**それより前に入れた人の一式**は
   *   wasm と worker しか持っていない。そのまま「入っている」と答えると
   *   **その人だけ parquet / json / sqlite が読めない**という、いちばん
   *   再現しない形になる。
   * 🔑 だから**判断はここ 1 か所**へ置く ── 画面(入っていますか)も
   *   貸し出し(`lendInstalledPack`)も同じ答えを見るので、
   *   「画面は入っていると言うのに、動かすと入っていない扱い」が起きない
   *   (CLAUDE.md §7「同じ問いに答える口を 2 つ作らない」)。
   * ⚠ **bytes は消さない** ── 消すのは user が押したときだけ(`remove`)。
   *   ここは「入れ直してください」と読める状態にするだけである。
   */
  async readMeta(): Promise<DuckDbPackMeta | null> {
    const v = await read(await this.need(), META, (s) => s.get(META_KEY));
    if (!isMeta(v)) return null;
    const have = new Set(v.files.map((f) => f.name));
    if (!DUCKDB_REQUIRED_FILES.every((name) => have.has(name))) return null;
    return v;
  }

  /**
   * 入れてある実体を 1 つ読む。
   *
   * 🔴 **`bytes` を照合する**(#682 段③b。⏸ 段③a からの申し送りに応える)──
   *   `meta` に控えた大きさと、実際に読めた Blob の大きさを突き合わせ、
   *   食い違えば **`null` ではなく `DuckDbPackStoreError` を投げる**。
   *   ⚠ `null` は呼び側(`lendObjectUrl` / DuckDB を起こす側)から見ると
   *   「**入っていない**」と同じ意味になる ── 壊れているのに `null` を返すと、
   *   「取り直せば直る」という理由が消えて**黙って「無い」ことにされる**
   *   (CLAUDE.md §1「控えただけの材料は、誰も読まなければ在るだけ」)。
   * ⚠ **sha256 はまだ見ない**(#682 段③b の指示どおり)── 36MB を読み直す
   *   コストが要るので、いつ見るかは測ってから決める。`meta.files[].sha256` は
   *   控えたまま、まだ照合していない事実ごと次の段へ引き継ぐ。
   * ⚠ **`meta` にその名前の記録が無い**(= 一式の構成外の名前を求められた、
   *   または `meta` 自体が無い)ときは、照合する基準が無いので**素の「無い」
   *   として `null` を返す** ── これは「壊れている」ではなく「管理していない
   *   名前を渡された」なので、例外にしない。
   */
  async readFile(name: string): Promise<Blob | null> {
    const db = await this.need();
    const blob = await read(db, FILES, (s) => s.get(name));
    if (!(blob instanceof Blob)) return null;
    const meta = await this.readMeta();
    const fileMeta = meta?.files.find((f) => f.name === name);
    if (fileMeta === undefined) return null;
    if (blob.size !== fileMeta.bytes) {
      throw new DuckDbPackStoreError(
        `${name} の中身が壊れています(記録: ${fileMeta.bytes} byte / 実際: ${blob.size} byte。入れ直してください)`,
      );
    }
    return blob;
  }

  /**
   * 引き渡し用の ObjectURL の貸出(#682 段③b)。返る `dispose` を**寿命の終わりに
   * 必ず呼ぶ**(revoke は借りた側の責務 ── 不可侵「ObjectURL は表示の寿命終端で
   * revoke」)。`office-pack-store.ts` の `lendObjectUrl` と同じ形。
   *
   * 🔑 **`readFile` の照合を通してから貸す**(迂回しない)── ここで `FILES` を
   *   直に読む別経路を作ると、上の `readFile` に足した検査の意味が消える
   *   (CLAUDE.md §7「同じ問いに答える口を 2 つ作らない」)。壊れていれば
   *   `readFile` が投げる `DuckDbPackStoreError` がそのまま外へ伝わる。
   * 🔑 **blob: URL が DuckDB のワーカー / wasm 起動で使えることは実測済み**
   *   (2026-09-15、実ブラウザ):`new Worker(blobUrl)` も
   *   `db.instantiate(blobWasmUrl, …)` も通り、外への要求は 0 件だった ──
   *   ここで「動くか分からない」とは書かない。
   */
  async lendObjectUrl(name: string): Promise<{ url: string; dispose: () => void } | null> {
    const blob = await this.readFile(name);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    return { url, dispose: () => URL.revokeObjectURL(url) };
  }

  /**
   * 一式(wasm / worker / 拡張)を、`DuckDbRunnerDeps.lendInstalled` が
   * 求める形でまとめて貸す(#682 段③b / 段④b。`main.ts` の配線口)。
   *
   * 🔑 **判断はここへ寄せる** ── `main.ts` はどの test からも実行されない
   *   (CLAUDE.md §2)ので、main.ts には「揃っているか」「貸す/貸さない」を書かない。
   * ⚠ **2 file のうち片方だけ貸せた回は、先に借りた分を revoke してから `null` を
   *   返す** ── 借りっぱなしにしない(不可侵「ObjectURL は寿命終端で revoke」)。
   *   通常は `readMeta()` が meta の有無で「揃っている」を判定しているのでここへは
   *   来ないが、`readFile` は名前ごとに独立して照合するため、念のため両方を見る。
   */
  async lendInstalledPack(): Promise<
    | {
        wasmUrl: string;
        workerUrl: string;
        extensions: readonly { readonly name: string; readonly url: string }[];
        dispose: () => void;
      }
    | null
  > {
    if ((await this.readMeta()) === null) return null;
    /**
     * ⚠ **借りた分は 1 か所で覚える** ── 途中で 1 つでも貸せなければ、
     *   それまでに借りた物を**全部**返してから `null` を返す。
     * 🔑 段④b で借りる数が 2 → 5 に増えたので、`if` を並べる形はやめた
     *   (並べる形は、足した人が返し忘れるとそこだけ漏れる)。
     */
    const lent: Array<{ url: string; dispose: () => void }> = [];
    const borrow = async (name: string): Promise<string | null> => {
      const got = await this.lendObjectUrl(name);
      if (got === null) return null;
      lent.push(got);
      return got.url;
    };
    const giveBack = (): void => {
      for (const l of lent) l.dispose();
    };

    const wasmUrl = await borrow(DUCKDB_WASM);
    const workerUrl = await borrow(DUCKDB_WORKER);
    const extensions: { name: string; url: string }[] = [];
    for (const name of DUCKDB_EXTENSIONS) {
      const url = await borrow(duckDbExtensionPath(name));
      if (url !== null) extensions.push({ name, url });
    }
    if (wasmUrl === null || workerUrl === null || extensions.length !== DUCKDB_EXTENSIONS.length) {
      giveBack();
      return null;
    }
    return { wasmUrl, workerUrl, extensions, dispose: giveBack };
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
