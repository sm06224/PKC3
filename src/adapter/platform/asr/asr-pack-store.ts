/**
 * 音声認識の部品の置き場 = IndexedDB の Blob record(#772 段②)。
 *
 * 🔑 `duckdb-pack-store.ts` / `office-pack-store.ts` と同じ設計の先例を写す ──
 * 取得 / 保管 / 設置の 3 分離、tx の作法、quota の断り文。
 * ⚠ **DB 名は新しく切る**(`pkc3-asr-pack`)── 既存の DB(`pkc3-office-pack` /
 * `pkc3-duckdb-pack`)の字は 1 バイトも触らない(IDB は名前が違えば別の DB)。
 *
 * ## 何を、どう置くか
 *
 * - `files` ── key は pack 内の相対 path(`runtime/…` / `models/<model>/…`)。値は **Blob**
 *   (heap に載せない。読み出しも Blob のまま ── worker へは参照で渡る)。
 * - `meta` ── `runtime`(実行の部品)と `part:<id>`(2 択の 1 つ)。
 *
 * ## 🔴 「入っている」の判定は 1 か所
 *
 * 2 択の 1 つが入っている = **その `part:<id>` の meta が在り、かつ `runtime` の meta が在る**。
 * ⚠ 実行の部品だけ在る・重みだけ在る、は「入っていない」と読む(動かせない物を
 *   「取り込み済み」と言わない)。画面も、文字にする側も、**この関数の答えだけ**を見る(§7)。
 *
 * ## 🔴 書き込みは **1 トランザクション**(部品ごと)
 *
 * files と meta を分けて書くと、quota で落ちたとき「meta は在るのに files が半端」/
 * 「files は在るのに meta が無い」のどちらかになる。同じ tx に入れて、落ちるなら丸ごと落とす。
 * ⚠ **取り込みの途中で落ちた・止めた物は、ここへ来る前に捨てられている**
 *   (`asr-pack-acquire.ts` は全部揃うまで書かせない)。
 */
import { ASR_PARTS, type AsrPartId } from '@features/asr/asr-parts';
import { AsrPackError } from './asr-pack-acquire';

const DB_NAME = 'pkc3-asr-pack';
const FILES = 'files';
const META = 'meta';
const RUNTIME_KEY = 'runtime';
const partKey = (id: AsrPartId): string => `part:${id}`;

export interface AsrFileMeta {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** 実行の部品 / 2 択の 1 つ、1 件の控え。 */
export interface AsrGroupMeta {
  readonly version: string;
  readonly installedAt: number;
  readonly totalBytes: number;
  readonly files: readonly AsrFileMeta[];
}

/** いま端末に入っているもの。 */
export interface AsrInstalled {
  readonly runtime: AsrGroupMeta | null;
  /** ⚠ `runtime` が在るときだけ入る(上の判定)。 */
  readonly parts: Readonly<Partial<Record<AsrPartId, AsrGroupMeta>>>;
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

/**
 * 🔴 **`oncomplete` まで待つ。** request success は commit の**前**に起きるので、
 * そこで resolve すると「書けた」と言った直後に tx が abort しうる(quota で実際に起きる)。
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

function isGroupMeta(v: unknown): v is AsrGroupMeta {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Partial<AsrGroupMeta>;
  return (
    typeof m.version === 'string'
    && typeof m.installedAt === 'number'
    && typeof m.totalBytes === 'number'
    && Array.isArray(m.files)
    && m.files.every(
      (f) =>
        typeof f === 'object' && f !== null
        && typeof (f as AsrFileMeta).path === 'string'
        && typeof (f as AsrFileMeta).bytes === 'number'
        && typeof (f as AsrFileMeta).sha256 === 'string',
    )
  );
}

export class AsrPackStore {
  private db: IDBDatabase | null = null;

  private async need(): Promise<IDBDatabase> {
    if (!this.db) this.db = await openDb();
    return this.db;
  }

  private async readGroup(key: string): Promise<AsrGroupMeta | null> {
    const raw = await read(await this.need(), META, (s) => s.get(key));
    return isGroupMeta(raw) ? raw : null;
  }

  /** 入っているもの。⚠ **判定はここ 1 か所**(上の docstring)。 */
  async readInstalled(): Promise<AsrInstalled> {
    const runtime = await this.readGroup(RUNTIME_KEY);
    if (runtime === null) return { runtime: null, parts: {} };
    const parts: Partial<Record<AsrPartId, AsrGroupMeta>> = {};
    for (const p of ASR_PARTS) {
      const m = await this.readGroup(partKey(p.id));
      if (m !== null) parts[p.id] = m;
    }
    return { runtime, parts };
  }

  /** 1 件ぶんを書く(files + meta を同じ tx で)。⚠ 空なら 1 バイトも書かない。 */
  private async writeGroup(
    key: string,
    files: ReadonlyMap<string, Blob>,
    expect: ReadonlyMap<string, { bytes: number; sha256: string }>,
    version: string,
  ): Promise<AsrGroupMeta> {
    if (files.size === 0) throw new AsrPackError('音声認識の部品が空です(書き込みを取り消しました)');
    const metaFiles: AsrFileMeta[] = [];
    let totalBytes = 0;
    for (const [path, blob] of files) {
      const want = expect.get(path);
      if (want === undefined) throw new AsrPackError(`ファイル一覧に無いファイルが混ざっています(${path})`);
      // 🔴 書く前に大きさを突き合わせる(入れてから気づくと、quota を食っただけの半端が残る)
      if (blob.size !== want.bytes) {
        throw new AsrPackError(`${path} の大きさがファイル一覧と違います(書き込みを取り消しました)`);
      }
      metaFiles.push({ path, bytes: blob.size, sha256: want.sha256 });
      totalBytes += blob.size;
    }
    const meta: AsrGroupMeta = { version, installedAt: Date.now(), totalBytes, files: metaFiles };
    const db = await this.need();
    await write(db, [FILES, META], (t) => {
      const fs = t.objectStore(FILES);
      for (const [path, blob] of files) fs.put(blob, path);
      t.objectStore(META).put(meta, key);
    });
    return meta;
  }

  /** 実行の部品を入れる。⚠ 古い実行の部品の file は先に消す(構成が変わっても混ざらない)。 */
  async writeRuntime(
    files: ReadonlyMap<string, Blob>,
    expect: ReadonlyMap<string, { bytes: number; sha256: string }>,
    version: string,
  ): Promise<AsrGroupMeta> {
    const before = await this.readInstalled();
    const stale = (before.runtime?.files ?? []).map((f) => f.path).filter((p) => !files.has(p));
    const meta = await this.writeGroup(RUNTIME_KEY, files, expect, version);
    if (stale.length > 0) {
      const db = await this.need();
      await write(db, [FILES], (t) => {
        for (const p of stale) t.objectStore(FILES).delete(p);
      });
    }
    return meta;
  }

  /** 2 択の 1 つを入れる。 */
  writePart(
    id: AsrPartId,
    files: ReadonlyMap<string, Blob>,
    expect: ReadonlyMap<string, { bytes: number; sha256: string }>,
    version: string,
  ): Promise<AsrGroupMeta> {
    return this.writeGroup(partKey(id), files, expect, version);
  }

  /**
   * 実行の部品と、`id` の重みを **Blob のまま**読む(worker へ参照で渡すため)。
   *
   * 🔴 **大きさを照合する** ── 壊れていれば `null` ではなく**理由つきで投げる**
   *   (`null` は「入っていない」と同じ意味になり、「取り直せば直る」が消える)。
   * ⚠ 入っていなければ `null`(= 取り込みを案内する側へ)。
   */
  async readFilesFor(id: AsrPartId): Promise<Map<string, Blob> | null> {
    const installed = await this.readInstalled();
    const part = installed.parts[id];
    if (installed.runtime === null || part === undefined) return null;
    const db = await this.need();
    const out = new Map<string, Blob>();
    for (const f of [...installed.runtime.files, ...part.files]) {
      const blob = await read(db, FILES, (s) => s.get(f.path));
      if (!(blob instanceof Blob)) {
        throw new AsrPackError(`${f.path} が見つかりません(入れ直してください)`);
      }
      if (blob.size !== f.bytes) {
        throw new AsrPackError(
          `${f.path} の中身が記録と合いません(記録: ${f.bytes} byte / 実際: ${blob.size} byte。入れ直してください)`,
        );
      }
      out.set(f.path, blob);
    }
    return out;
  }

  /**
   * 2 択の 1 つを消す。**meta を先に**消す(途中で落ちても「入っている」と名乗らない側へ倒す)。
   * ⚠ 最後の 1 つなら実行の部品も消す(使い道の無い 16MB を残さない)。
   * @returns 実行の部品も消したか。
   */
  async removePart(id: AsrPartId): Promise<boolean> {
    // ⚠ 実行の部品が無くても、重みの控えは直に読む(読めない形で残った重みを取りこぼさない)
    const part = await this.readGroup(partKey(id));
    const installed = await this.readInstalled();
    const others = Object.keys(installed.parts).filter((k) => k !== id);
    const dropRuntime = others.length === 0 && installed.runtime !== null;
    const db = await this.need();
    await write(db, [FILES, META], (t) => {
      t.objectStore(META).delete(partKey(id));
      if (dropRuntime) t.objectStore(META).delete(RUNTIME_KEY);
      for (const f of part?.files ?? []) t.objectStore(FILES).delete(f.path);
      if (dropRuntime) for (const f of installed.runtime?.files ?? []) t.objectStore(FILES).delete(f.path);
    });
    return dropRuntime;
  }

  /** 実行の部品だけを消す(2 択が 1 つも無いときの掃除。取り込みの巻き戻しに使う)。 */
  async removeRuntimeIfAlone(): Promise<void> {
    const installed = await this.readInstalled();
    if (installed.runtime === null || Object.keys(installed.parts).length > 0) return;
    const db = await this.need();
    await write(db, [FILES, META], (t) => {
      t.objectStore(META).delete(RUNTIME_KEY);
      for (const f of installed.runtime?.files ?? []) t.objectStore(FILES).delete(f.path);
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
