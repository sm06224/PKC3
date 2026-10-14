/**
 * 保存していない編集の置き場 = IndexedDB(#1376)。**端末ごと**。
 *
 * 🔴 **アプリのデータに混ぜない。** container に入れると書き出し・バックアップ・履歴に
 * 同乗する(確定していない字を端末の外へ出さない)。`copy-history-store.ts` と同じ判断で、
 * 置き場だけ違う ── 本文は最大 2 MB あり、localStorage(合計 5 MB 前後)では足りない。
 * 判断・上限・複数タブの扱いは `@features/draft/draft-recovery.ts`。
 *
 * ⚠ 書けなかった(quota・私用ウィンドウ)ときは**黙って諦める** ── 控えは保険であって、
 *   書けないことで編集そのものを止めない。
 */
import { DRAFT_COUNT_MAX, draftKey, isDraftPart, type DraftRecord } from '@features/draft/draft-recovery';

/** 置き場の口。test は {@link MemoryDraftStore} を渡す。 */
export interface DraftStore {
  put(rec: DraftRecord): Promise<void>;
  /** 控えを消す。`tab` を渡したら、その tab が書いた控えのときだけ消す。 */
  remove(cid: string, lid: string, tab?: string): Promise<void>;
  list(cid: string): Promise<DraftRecord[]>;
  /**
   * 全部消す(中身を消してまっさらにする / 建て直し)。⚠ 消した入れ物の控えは、新しい入れ物から
   * 一覧に出ない(別の cid)ので、残すと端末に本文が残り続ける。
   */
  clearAll(): Promise<void>;
}

const DB_NAME = 'pkc3-drafts';
const STORE = 'drafts';

function isRecord(v: unknown): v is DraftRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<DraftRecord>;
  return (
    typeof r.cid === 'string' &&
    typeof r.lid === 'string' &&
    typeof r.body === 'string' &&
    typeof r.title === 'string' &&
    typeof r.base === 'string' &&
    typeof r.at === 'number' &&
    typeof r.tab === 'string' &&
    // 欄の控え(#1728)── 形が壊れた part は控えごと読まない(戻すとき別の欄を開かない)
    (r.part === undefined || isDraftPart(r.part))
  );
}

/** 上限を超えたら古い順に消す(全コレクション通しで {@link DRAFT_COUNT_MAX})。 */
export function overflowKeys(all: readonly DraftRecord[]): string[] {
  return [...all]
    .sort((a, b) => b.at - a.at)
    .slice(DRAFT_COUNT_MAX)
    .map((r) => draftKey(r.cid, r.lid));
}

/**
 * 消してよい控えか。`tab` を渡されたら、その tab が書いた控えだけ(別タブの編集中の控えを消さない)。
 * ⚠ 置き場 2 つ(メモリ / IndexedDB)が**この 1 関数**を通る ── 片方だけ緩むと、test に見えない側が静かに壊れる。
 */
export function mayRemove(cur: DraftRecord | undefined, tab: string | undefined): boolean {
  if (cur === undefined) return false;
  return tab === undefined || cur.tab === tab;
}

export class MemoryDraftStore implements DraftStore {
  readonly map = new Map<string, DraftRecord>();
  async put(rec: DraftRecord): Promise<void> {
    this.map.set(draftKey(rec.cid, rec.lid), rec);
    for (const k of overflowKeys([...this.map.values()])) this.map.delete(k);
  }
  async remove(cid: string, lid: string, tab?: string): Promise<void> {
    const k = draftKey(cid, lid);
    if (mayRemove(this.map.get(k), tab)) this.map.delete(k);
  }
  async list(cid: string): Promise<DraftRecord[]> {
    return [...this.map.values()].filter((r) => r.cid === cid);
  }
  async clearAll(): Promise<void> {
    this.map.clear();
  }
}

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

/** `oncomplete` まで待つ(request の success は commit の前に起きる)。 */
function tx(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore, done: (v?: unknown) => void) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    let out: unknown;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error ?? new Error('idb tx failed'));
    t.onabort = () => reject(t.error ?? new Error('idb tx aborted'));
    try {
      run(t.objectStore(STORE), (v) => {
        out = v;
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error('idb failed'));
    }
  });
}

export class IdbDraftStore implements DraftStore {
  private db: Promise<IDBDatabase> | null = null;
  private need(): Promise<IDBDatabase> {
    this.db ??= openDb();
    return this.db;
  }

  async put(rec: DraftRecord): Promise<void> {
    const db = await this.need();
    await tx(db, 'readwrite', (s) => {
      s.put(rec, draftKey(rec.cid, rec.lid));
      // 上限は同じ tx の中で見る(別タブの書込と競っても件数が増え続けない)
      const all = s.getAll();
      all.onsuccess = () => {
        const rows = (all.result as unknown[]).filter(isRecord);
        for (const k of overflowKeys(rows)) s.delete(k);
      };
    });
  }

  async remove(cid: string, lid: string, tab?: string): Promise<void> {
    const db = await this.need();
    await tx(db, 'readwrite', (s) => {
      const key = draftKey(cid, lid);
      if (tab === undefined) {
        s.delete(key);
        return;
      }
      // 自分が書いた控えだけ消す(別タブの編集中の控えは残す)
      const cur = s.get(key);
      cur.onsuccess = () => {
        if (mayRemove(isRecord(cur.result) ? cur.result : undefined, tab)) s.delete(key);
      };
    });
  }

  async clearAll(): Promise<void> {
    const db = await this.need();
    await tx(db, 'readwrite', (s) => {
      s.clear();
    });
  }

  async list(cid: string): Promise<DraftRecord[]> {
    const db = await this.need();
    const rows = (await new Promise<unknown[]>((resolve, reject) => {
      const t = db.transaction(STORE, 'readonly');
      const req = t.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as unknown[]);
      req.onerror = () => reject(req.error ?? new Error('idb read failed'));
    })) as unknown[];
    return rows.filter(isRecord).filter((r) => r.cid === cid);
  }
}

/** 生きているタブの印。Web Locks で「このタブが居る間だけ握る」。取れない端末は `null`。 */
export function holdTabLock(tab: string): void {
  try {
    const locks = navigator.locks;
    if (!locks) return;
    void locks.request(`pkc3-draft-tab:${tab}`, { mode: 'shared' }, () => new Promise<void>(() => {}));
  } catch {
    /* 取れない端末は、年齢で見る(`isLiveDraft` の fallback) */
  }
}

export async function liveTabs(): Promise<Set<string> | null> {
  try {
    const locks = navigator.locks;
    if (!locks?.query) return null;
    const q = await locks.query();
    const out = new Set<string>();
    const prefix = 'pkc3-draft-tab:';
    for (const l of [...(q.held ?? []), ...(q.pending ?? [])]) {
      if (typeof l.name === 'string' && l.name.startsWith(prefix)) out.add(l.name.slice(prefix.length));
    }
    return out;
  } catch {
    return null;
  }
}
