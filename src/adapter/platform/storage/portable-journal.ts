/**
 * 🔴 **可搬単一 HTML の「変更分だけ先に書く」日誌**(#1589 の根治)。
 *
 * 画像(DB 丸ごと)の保存は「溜めて 1.2 秒待つ → 書き出す → 器へ書く」で、DB が大きいほど長い。
 * その間に閉じる・読み直すと、直前の変更が消える。画像を速くするのではなく、
 * **書込 op(小さい)を完了した直後に別の器へ 1 件ずつ足す** ── 起動時、画像のあとに
 * 画像へ入っていない分だけ同じ op を流し直す。
 *
 * ## 🔑 重ならない・落とさないための約束
 *
 * - **番号(seq)は op を worker へ出す瞬間に振る**。画像を書き出す要求(`exportImage`)も出す瞬間に
 *   `snapshotSeq()` を控える。worker は到着順に処理するので「番号 ≤ 控えた値」の op は画像に入っている。
 *   ⚠ 完了の瞬間に振ると、画像に入った op が画像より新しい番号になり、**二重に流し直す**。
 * - 日誌に足すのは **成功した op だけ**(失敗した op を流し直すと、画面に出なかった変更が現れる)。
 * - 画像を器へ書けたら、控えた番号以下を捨てる(`trim`)。⚠ 捨てそびれても害は無い
 *   (流し直しは「画像の番号より後」だけを選ぶ)。
 * - 日誌は **別の IndexedDB**(`<器の名前>-journal`)に置く。画像の器の版を上げると、
 *   旧ビルドが開けなくなる(旧ビルドが新データを読めるか ── 互換は双方向)。旧ビルドは日誌を無視して画像だけ開く。
 */
import { errorText } from '@features/error-text';

/** 日誌の 1 件。⚠ `req` は worker に渡した要求そのもの(構造化複製できる形)。 */
export interface JournalEntry {
  readonly seq: number;
  readonly req: unknown;
}

/** 日誌の器(IndexedDB の薄い包み。test は同じ形のメモリ版を渡す)。 */
export interface JournalBackend {
  put(entry: JournalEntry): Promise<void>;
  readAll(): Promise<JournalEntry[]>;
  /** `seq <= upTo` を捨てる。 */
  deleteUpTo(upTo: number): Promise<void>;
}

/** 番号の倍率。⚠ 時刻(ms)から番号を作る ── 画像に番号が無い旧い記録は `savedAt * SEQ_PER_MS` で比べる。 */
export const SEQ_PER_MS = 1024;

/** 画像の記録から「この番号以下は画像に入っている」を決める。⚠ 番号の無い旧い記録は書いた時刻で代える。 */
export function baseSeqOf(args: {
  use: 'stored' | 'embedded' | 'fresh';
  snapshotSeq?: number | undefined;
  savedAt?: number | undefined;
  exportedAt: number;
}): number | null {
  // 空から始めた回は、日誌の op が前提にする中身が無い ── 流し直さない
  if (args.use === 'fresh') return null;
  if (args.use === 'embedded') return args.exportedAt * SEQ_PER_MS;
  if (typeof args.snapshotSeq === 'number' && Number.isFinite(args.snapshotSeq)) return args.snapshotSeq;
  return (args.savedAt ?? 0) * SEQ_PER_MS;
}

/** 流し直す分(画像より後)を番号順で返す。 */
export function entriesAfter(entries: ReadonlyArray<JournalEntry>, baseSeq: number): JournalEntry[] {
  return entries.filter((e) => e.seq > baseSeq).sort((a, b) => a.seq - b.seq);
}

export interface ReplayResult {
  readonly applied: number;
  /** 流し直せなかった件数(最初の失敗の理由を `firstError` に)。 */
  readonly failed: number;
  readonly firstError: string | null;
}

/**
 * 日誌を流し直す。⚠ 1 件の失敗で止めない(後ろの op は別のノートかもしれない)。失敗は数えて返す。
 */
export async function replayEntries(
  entries: ReadonlyArray<JournalEntry>,
  run: (req: unknown) => Promise<unknown>,
): Promise<ReplayResult> {
  let applied = 0;
  let failed = 0;
  let firstError: string | null = null;
  for (const e of entries) {
    try {
      await run(e.req);
      applied += 1;
    } catch (err) {
      failed += 1;
      firstError ??= errorText(err);
    }
  }
  return { applied, failed, firstError };
}

export interface PortableJournal {
  /** op を worker へ出す直前に呼ぶ。返した関数を **成功したときだけ** 呼ぶ(= 日誌へ足す)。 */
  begin(req: unknown): () => void;
  /** 画像を書き出す要求を出す直前に呼ぶ。「この番号以下は画像に入る」。 */
  snapshotSeq(): number;
  /** 画像を器へ書けた後に呼ぶ(`snapshotSeq` で控えた値)。 */
  trim(upTo: number): void;
  /** 日誌を足している最中の件数(閉じる前に待つ・確認に数える)。 */
  pending(): number;
  /** 日誌へ足せなかった op が、まだ画像に入っていない。⚠ 真の間は日誌に頼れない。 */
  broken(): boolean;
  /** 足している最中のものが全部終わるまで。 */
  settled(): Promise<void>;
}

export function createJournal(deps: {
  backend: JournalBackend;
  now?: () => number;
  /** 日誌が使えなくなったとき(足せない)を知らせる。 */
  onError?: (why: string) => void;
}): PortableJournal {
  const now = deps.now ?? ((): number => Date.now());
  let last = 0;
  /** 厳密に増える番号。⚠ 同じ ms に出した 2 件を区別する。 */
  const next = (): number => {
    last = Math.max(last + 1, now() * SEQ_PER_MS);
    return last;
  };
  let inflight = 0;
  const waiters: Array<() => void> = [];
  /** 足せなかった最大の番号。画像の `snapshotSeq` がそれ以上になれば解消する。 */
  let brokenAt = 0;
  const done = (): void => {
    inflight -= 1;
    if (inflight === 0) for (const w of waiters.splice(0)) w();
  };

  return {
    begin(req: unknown): () => void {
      const seq = next();
      return (): void => {
        inflight += 1;
        void deps.backend
          .put({ seq, req })
          .catch((e: unknown) => {
            brokenAt = Math.max(brokenAt, seq);
            deps.onError?.(errorText(e));
          })
          .finally(done);
      };
    },
    snapshotSeq(): number {
      return next();
    },
    trim(upTo: number): void {
      if (upTo >= brokenAt) brokenAt = 0;
      void deps.backend.deleteUpTo(upTo).catch(() => undefined);
    },
    pending: () => inflight,
    broken: () => brokenAt > 0,
    settled(): Promise<void> {
      return inflight === 0 ? Promise.resolve() : new Promise((r) => waiters.push(r));
    },
  };
}

/* ------------------------------------------------------------------ IndexedDB */

const J_STORE = 'journal';

/** 日誌の器の名前。⚠ 画像の器(`bundleDbName`)と別の database にする(版を上げない)。 */
export function journalDbName(imageDbName: string): string {
  return `${imageDbName}-journal`;
}

function openJournalDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(J_STORE))
        req.result.createObjectStore(J_STORE, { keyPath: 'seq' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb open failed'));
  });
}

function done_<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(J_STORE, mode);
    let result: T;
    const req = run(t.objectStore(J_STORE));
    req.onsuccess = () => {
      result = req.result;
    };
    // ⚠ commit を待つ(quota の abort は request success の後に来る)
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error ?? new Error('idb request failed'));
    t.onabort = () => reject(t.error ?? new Error('idb transaction aborted'));
  });
}

export function idbJournalBackend(imageDbName: string): JournalBackend {
  let dbP: Promise<IDBDatabase> | null = null;
  const need = (): Promise<IDBDatabase> => (dbP ??= openJournalDb(journalDbName(imageDbName)));
  return {
    async put(entry): Promise<void> {
      await done_(await need(), 'readwrite', (s) => s.put(entry));
    },
    async readAll(): Promise<JournalEntry[]> {
      // 器が無い環境(IndexedDB 自体が無い)── 控えも無い。⚠ 画像の器が読めない回は画像側が先に断る
      if (typeof indexedDB === 'undefined') return [];
      const rows = await done_<unknown[]>(await need(), 'readonly', (s) => s.getAll());
      return rows.filter(
        (r): r is JournalEntry =>
          typeof r === 'object' && r !== null && typeof (r as { seq?: unknown }).seq === 'number',
      );
    },
    async deleteUpTo(upTo): Promise<void> {
      await done_(await need(), 'readwrite', (s) => s.delete(IDBKeyRange.upperBound(upTo)));
    },
  };
}
