/**
 * 録音・録画の途中保存の置き場 = **収録専用の IndexedDB**(#1985 項目 2)。**端末ごと**。
 *
 * 🔴 **新しい専用 DB** ── 既存の DB(`pkc3-drafts` / 添付の Blob など)の version を上げない
 *   (oplog 設計 doc の DB 規則)。アプリのデータ(container)に混ぜない(書き出し・バックアップに同乗させない)。
 * 🔴 **断片は `Blob` のまま入れる**(`ArrayBuffer` へ写さない = ゼロコピー。IndexedDB が Blob を参照のまま持つ)。
 * 判断(上限・順序・失敗の扱い)は `@features/capture/capture-journal*.ts`。ここは**置くだけ**。
 */
import type { JournalChunkInfo, JournalMeta } from '@features/capture/capture-journal';
import type { JournalWritePort } from '@features/capture/capture-journal-writer';

export interface JournalChunk {
  readonly idx: number;
  readonly elapsedMs: number;
  readonly blob: Blob;
}

export interface JournalStore extends JournalWritePort {
  listMetas(): Promise<JournalMeta[]>;
  /** 断片の一覧(Blob の中身は読まない)。 */
  listChunkInfos(): Promise<JournalChunkInfo[]>;
  /** 区間の断片を 0 番から順に(穴は飛ばさずそのまま返す。使う範囲は呼び側が決める)。 */
  readSegment(rec: string, seg: number): Promise<JournalChunk[]>;
}

/** test と、IndexedDB の無い環境の置き場。 */
export class MemoryJournalStore implements JournalStore {
  readonly metas = new Map<string, JournalMeta>();
  readonly chunks = new Map<string, { rec: string; seg: number; idx: number; elapsedMs: number; blob: Blob }>();
  /** test から書き込みを失敗させる。 */
  failPut: Error | null = null;
  /** test から書き込みを保留する(最初の断片の待ち合わせを見る)。 */
  gate: Promise<void> | null = null;
  /** 書き込みを始めた順。 */
  readonly log: string[] = [];

  private key(rec: string, seg: number, idx: number): string {
    return `${rec}/${seg}/${idx}`;
  }
  async putMeta(meta: JournalMeta): Promise<void> {
    this.log.push(`meta:${meta.id}`);
    if (this.gate !== null) await this.gate;
    if (this.failPut !== null) throw this.failPut;
    this.metas.set(meta.id, meta);
  }
  async putChunk(c: { rec: string; seg: number; idx: number; elapsedMs: number; blob: Blob }): Promise<void> {
    this.log.push(`put:${c.seg}/${c.idx}`);
    if (this.gate !== null) await this.gate;
    if (this.failPut !== null) throw this.failPut;
    this.chunks.set(this.key(c.rec, c.seg, c.idx), c);
  }
  async dropSegment(rec: string, seg: number): Promise<void> {
    this.log.push(`dropSeg:${seg}`);
    for (const [k, v] of this.chunks) if (v.rec === rec && v.seg === seg) this.chunks.delete(k);
  }
  async dropRec(rec: string): Promise<void> {
    this.log.push(`dropRec:${rec}`);
    this.metas.delete(rec);
    for (const [k, v] of this.chunks) if (v.rec === rec) this.chunks.delete(k);
  }
  async listMetas(): Promise<JournalMeta[]> {
    return [...this.metas.values()];
  }
  async listChunkInfos(): Promise<JournalChunkInfo[]> {
    return [...this.chunks.values()].map((c) => ({
      rec: c.rec,
      seg: c.seg,
      idx: c.idx,
      elapsedMs: c.elapsedMs,
      size: c.blob.size,
    }));
  }
  async readSegment(rec: string, seg: number): Promise<JournalChunk[]> {
    return [...this.chunks.values()]
      .filter((c) => c.rec === rec && c.seg === seg)
      .sort((a, b) => a.idx - b.idx)
      .map((c) => ({ idx: c.idx, elapsedMs: c.elapsedMs, blob: c.blob }));
  }
}

const DB_NAME = 'pkc3-capture-journal';
const META = 'meta';
const CHUNKS = 'chunks';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      // 鍵 = [収録, 区間, 断片の番号]。⚠ 範囲で消す / 順に読むために配列の鍵にしてある
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: ['rec', 'seg', 'idx'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb open failed'));
  });
}

/** `oncomplete` まで待つ(request の success は commit の前に起きる)。 */
function tx<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  run: (t: IDBTransaction, done: (v: T) => void) => void,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out: T | undefined;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error ?? new Error('idb tx failed'));
    t.onabort = () => reject(t.error ?? new Error('idb tx aborted'));
    try {
      run(t, (v) => {
        out = v;
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error('idb failed'));
    }
  });
}

/** 収録 `rec` の区間 `seg` の断片すべて(番号は 0 以上の数 → Infinity まで)。 */
function segRange(rec: string, seg: number): IDBKeyRange {
  return IDBKeyRange.bound([rec, seg, 0], [rec, seg, Infinity]);
}
function recRange(rec: string): IDBKeyRange {
  return IDBKeyRange.bound([rec, 0, 0], [rec, Infinity, Infinity]);
}

export class IdbJournalStore implements JournalStore {
  private db: Promise<IDBDatabase> | null = null;
  private need(): Promise<IDBDatabase> {
    if (this.db === null) {
      this.db = openDb().catch((e: unknown) => {
        this.db = null; // 次に呼ばれたらまた開く
        throw e;
      });
    }
    return this.db;
  }

  async putMeta(meta: JournalMeta): Promise<void> {
    const db = await this.need();
    await tx(db, [META], 'readwrite', (t) => {
      t.objectStore(META).put(meta);
    });
  }
  async putChunk(c: { rec: string; seg: number; idx: number; elapsedMs: number; blob: Blob }): Promise<void> {
    const db = await this.need();
    // ⚠ Blob をそのまま渡す(`arrayBuffer()` を経由しない)
    await tx(db, [CHUNKS], 'readwrite', (t) => {
      t.objectStore(CHUNKS).put({ rec: c.rec, seg: c.seg, idx: c.idx, elapsedMs: c.elapsedMs, blob: c.blob });
    });
  }
  async dropSegment(rec: string, seg: number): Promise<void> {
    const db = await this.need();
    await tx(db, [CHUNKS], 'readwrite', (t) => {
      t.objectStore(CHUNKS).delete(segRange(rec, seg));
    });
  }
  async dropRec(rec: string): Promise<void> {
    const db = await this.need();
    await tx(db, [META, CHUNKS], 'readwrite', (t) => {
      t.objectStore(CHUNKS).delete(recRange(rec));
      t.objectStore(META).delete(rec);
    });
  }
  async listMetas(): Promise<JournalMeta[]> {
    const db = await this.need();
    const out = await tx<JournalMeta[]>(db, [META], 'readonly', (t, done) => {
      const r = t.objectStore(META).getAll();
      r.onsuccess = () => done(r.result as JournalMeta[]);
    });
    return out ?? [];
  }
  async listChunkInfos(): Promise<JournalChunkInfo[]> {
    const db = await this.need();
    const out = await tx<JournalChunkInfo[]>(db, [CHUNKS], 'readonly', (t, done) => {
      const infos: JournalChunkInfo[] = [];
      const r = t.objectStore(CHUNKS).openCursor();
      r.onsuccess = () => {
        const cur = r.result;
        if (cur === null) {
          done(infos);
          return;
        }
        const v = cur.value as { rec: string; seg: number; idx: number; elapsedMs: number; blob: Blob };
        infos.push({ rec: v.rec, seg: v.seg, idx: v.idx, elapsedMs: v.elapsedMs, size: v.blob.size });
        cur.continue();
      };
    });
    return out ?? [];
  }
  async readSegment(rec: string, seg: number): Promise<JournalChunk[]> {
    const db = await this.need();
    const out = await tx<JournalChunk[]>(db, [CHUNKS], 'readonly', (t, done) => {
      const r = t.objectStore(CHUNKS).getAll(segRange(rec, seg));
      r.onsuccess = () =>
        done(
          (r.result as Array<{ idx: number; elapsedMs: number; blob: Blob }>).map((v) => ({
            idx: v.idx,
            elapsedMs: v.elapsedMs,
            blob: v.blob,
          })),
        );
    });
    return out ?? [];
  }
}

/**
 * 🔴 **この収録を「いま録っている」と他のタブへ知らせる**(Web Locks)。⚠ タブが落ちれば自動で外れる。
 * 別のタブの起動時の復元が、**録っている最中の収録を「途中で終わった」と取り違えない**ための印。
 * 戻り値は外す関数。Web Locks が無い環境では何もしない。
 */
export function holdRecordingLock(id: string): () => void {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (locks === undefined) return () => undefined;
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  void locks.request(`pkc3-capture-${id}`, () => held).catch(() => undefined);
  return () => release?.();
}

/** いま別のタブが録っている収録の id の集まり(Web Locks が無い環境では空)。 */
export async function liveRecordingIds(): Promise<Set<string>> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  const out = new Set<string>();
  if (locks === undefined || typeof locks.query !== 'function') return out;
  try {
    const snap = await locks.query();
    for (const l of [...(snap.held ?? []), ...(snap.pending ?? [])]) {
      if (l.name?.startsWith('pkc3-capture-')) out.add(l.name.slice('pkc3-capture-'.length));
    }
  } catch {
    // 聞けなければ空(= 全部「途中で終わった」と見る)
  }
  return out;
}

/** 空き(bytes)。聞けなければ `null`。 */
export async function storageFreeBytes(): Promise<number | null> {
  try {
    const est = await (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage?.estimate?.();
    if (est?.quota === undefined || est.usage === undefined) return null;
    return est.quota - est.usage;
  } catch {
    return null;
  }
}
