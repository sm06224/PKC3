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
 *   `snapshotSeq()` を控える。⚠ **worker は到着順に処理しない**(onmessage は 1 通ごとに独立した Promise で、
 *   書込は容量の確認で待たされうる)── 飛んでいる op が `exportImage` に追い越されると、その op は画像に
 *   入っていない。だから控える値は「**始まって終わっていない op の最小の番号 − 1**」と「次の番号」の小さいほう
 *   (`snapshotSeq`)。⚠ 逆に、画像に入ったかもしれない飛行中の op は再生で 2 回目が流れうる
 *   (upsert など冪等な op は無害)。落とすより重ねるほうを選ぶ。
 *   ⚠ 完了の瞬間に振ると、画像に入った op が画像より新しい番号になり、**二重に流し直す**。
 * - **番号は時計に頼らず単調**(`initialSeq` ── 画像の番号と日誌の最大の番号から始める)。時計が戻っても増える。
 * - **大きい op(`JOURNAL_MAX_BYTES` 超)は日誌に複製しない**(定常のメモリ・IDB の書込を増やさない)。
 *   代わりに「日誌に頼れない」(`broken`)として、画像の保存を即時に流す。失敗(IDB の書込失敗)も同じ。
 * - 日誌に足すのは **成功した op だけ**(失敗した op を流し直すと、画面に出なかった変更が現れる)。
 * - 画像を器へ書けたら、控えた番号以下を捨てる(`trim`)。⚠ 捨てそびれても害は無い
 *   (流し直しは「画像の番号より後」だけを選ぶ)。
 * - 日誌は **別の IndexedDB**(`<器の名前>-journal`)に置く。画像の器の版を上げると、
 *   旧ビルドが開けなくなる(旧ビルドが新データを読めるか ── 互換は双方向)。旧ビルドは日誌を無視して画像だけ開く。
 *   🔴 **限界(記録)**:旧ビルドで開くと、新ビルドの日誌のうち**画像へ畳まれていない分は取り込まれない**
 *   (旧ビルドは日誌を読まない)。そのまま旧ビルドで保存すると、日誌の分は画像に入らず、新ビルドで開き直しても
 *   番号が古いので再生されない。新ビルドで開き直して畳んでから(数秒待つ)旧ビルドへ戻ること。
 * - 再生に失敗した op は日誌の `failed` 置き場へ移して残す(画像の保存で捨てない)。
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
  /**
   * 再生に失敗した op を、画像の保存で捨てられない置き場へ残す(`deleteUpTo` の対象外)。
   * 🔑 失敗を黙って捨てない ── 件数は呼び側が画面(メッセージ)に名指しで出す。
   */
  keepFailed(entries: ReadonlyArray<JournalEntry>): Promise<void>;
}

/** 番号の倍率。⚠ 時刻(ms)から番号を作る ── 画像に番号が無い旧い記録は `savedAt * SEQ_PER_MS` で比べる。 */
export const SEQ_PER_MS = 1024;

/** 画像の記録から「この番号以下は画像に入っている」を決める。⚠ 番号の無い旧い記録は書いた時刻で代える。 */
export function baseSeqOf(args: {
  use: 'stored' | 'embedded' | 'fresh';
  snapshotSeq?: number | undefined;
  savedAt?: number | undefined;
  exportedAt: number;
  /** 器に 1 度も画像が書かれていない(読めなかったのではない)。 */
  neverSaved?: boolean;
}): number | null {
  // 空から始めた回は、日誌の op が前提にする中身が無い ── 流し直さない。
  // ⚠ ただし「1 度も画像が書かれていない」なら、日誌は空の DB を土台に書かれている ── 全部流す
  if (args.use === 'fresh') return args.neverSaved === true ? 0 : null;
  if (args.use === 'embedded') return args.exportedAt * SEQ_PER_MS;
  if (typeof args.snapshotSeq === 'number' && Number.isFinite(args.snapshotSeq)) return args.snapshotSeq;
  return (args.savedAt ?? 0) * SEQ_PER_MS;
}

/** 流し直す分(画像より後)を番号順で返す。 */
export function entriesAfter(entries: ReadonlyArray<JournalEntry>, baseSeq: number): JournalEntry[] {
  return entries.filter((e) => e.seq > baseSeq).sort((a, b) => a.seq - b.seq);
}

/**
 * 流し直す要求の `cid` を、いまの DB の入れ物の id に合わせる。
 * 🔑 器を作った回(まだ 1 度も画像を書いていない)の `cid` は、そのとき採番した id で、DB の画像には入っていない ──
 *   起動の `resolveContainer` が改めて採番する別の id と一致しない。PKC3 の DB の入れ物は 1 つ
 *   (`resolveContainer` は最初の 1 つを返す)なので、日誌の `cid` は常にそれに読み替えてよい。
 */
export function remapCid<T>(req: T, cid: string): T {
  if (req === null || typeof req !== 'object') return req;
  const r = req as { cid?: unknown };
  return typeof r.cid === 'string' && r.cid !== cid ? ({ ...req, cid } as T) : req;
}

export interface ReplayResult {
  readonly applied: number;
  /** 流し直せなかった件数(最初の失敗の理由を `firstError` に)。 */
  readonly failed: number;
  readonly firstError: string | null;
  /** 失敗した op(置き場へ残す)。 */
  readonly failedEntries: ReadonlyArray<JournalEntry>;
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
  const failedEntries: JournalEntry[] = [];
  for (const e of entries) {
    try {
      await run(e.req);
      applied += 1;
    } catch (err) {
      failed += 1;
      failedEntries.push(e);
      firstError ??= errorText(err);
    }
  }
  return { applied, failed, firstError, failedEntries };
}

export interface JournalTicket {
  /** 成功した。日誌へ足す(大きい op は足さず `broken` にする)。 */
  commit(): void;
  /** 失敗した。日誌へ足さず、飛行中から外す。 */
  abort(): void;
}

export interface PortableJournal {
  /** op を worker へ出す直前に呼ぶ。成功したら `commit()`、失敗したら `abort()`(どちらか 1 回)。 */
  begin(req: unknown): JournalTicket;
  /** 画像を書き出す要求を出す直前に呼ぶ。「この番号以下は画像に入る」(飛行中の op の手前まで)。 */
  snapshotSeq(): number;
  /** 画像を器へ書けた後に呼ぶ(`snapshotSeq` で控えた値)。 */
  trim(upTo: number): void;
  /** 始まって終わっていない op の数(worker で飛行中 + 日誌へ足している最中)。 */
  pending(): number;
  /** 日誌に頼れない op が、まだ画像に入っていない(足せなかった / 大きすぎた)。⚠ 真の間は画像の保存が要る。 */
  broken(): boolean;
  /** 始まったものが全部終わるまで。 */
  settled(): Promise<void>;
}

/** 日誌に複製する 1 件の上限(概算バイト)。⚠ 超えたら日誌に書かず、画像の保存を急ぐ。 */
export const JOURNAL_MAX_BYTES = 256 * 1024;

/**
 * 値の大きさの概算(文字列は 2 バイト / 文字、型付き配列は byteLength)。`cap` を超えたら数えるのをやめる
 * (巨大な op を数え切るために全部たどらない)。
 */
export function estimateBytes(value: unknown, cap: number): number {
  let total = 0;
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length > 0 && total <= cap) {
    const v = stack.pop();
    if (typeof v === 'string') total += v.length * 2;
    else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') total += 8;
    else if (v !== null && typeof v === 'object') {
      if (seen.has(v)) continue;
      seen.add(v);
      if (ArrayBuffer.isView(v)) total += v.byteLength;
      else if (v instanceof ArrayBuffer) total += v.byteLength;
      else if (typeof Blob !== 'undefined' && v instanceof Blob) total += v.size;
      else if (Array.isArray(v)) for (const x of v) stack.push(x);
      else
        for (const k of Object.keys(v)) {
          total += k.length * 2;
          stack.push((v as Record<string, unknown>)[k]);
        }
    }
  }
  return total;
}

export function createJournal(deps: {
  backend: JournalBackend;
  now?: () => number;
  /** 番号の下限(画像の `snapshotSeq` と日誌の最大の番号)。⚠ 時計が戻っても番号を増やし続ける。 */
  initialSeq?: number;
  maxBytes?: number;
  /** 日誌が使えなくなったとき(足せない / 大きすぎる)を知らせる ── 呼び側は画像の保存を急ぐ。 */
  onError?: (why: string) => void;
  /** 飛行中の op が 0 になった(未保存の判定を取り直す合図)。 */
  onIdle?: () => void;
}): PortableJournal {
  const now = deps.now ?? ((): number => Date.now());
  const maxBytes = deps.maxBytes ?? JOURNAL_MAX_BYTES;
  let last = deps.initialSeq ?? 0;
  /** 厳密に増える番号。⚠ 同じ ms に出した 2 件を区別し、時計が戻っても減らない。 */
  const next = (): number => {
    last = Math.max(last + 1, now() * SEQ_PER_MS);
    return last;
  };
  /** 始まって終わっていない op の番号。 */
  const open = new Set<number>();
  const waiters: Array<() => void> = [];
  /** 日誌に頼れなかった最大の番号。画像の `snapshotSeq` がそれ以上になれば解消する。 */
  let brokenAt = 0;
  const finish = (seq: number): void => {
    if (!open.delete(seq) || open.size > 0) return;
    for (const w of waiters.splice(0)) w();
    deps.onIdle?.();
  };
  /**
   * ⚠ **飛行中から外してから知らせる** ── 知らせた先が画像の保存を始めると、その番号の控え(`snapshotSeq`)が
   *   この op を「終わっていない」と見て手前に倒れ、画像に入ったのに `broken` が解けない。
   */
  const fail = (seq: number, why: string): void => {
    brokenAt = Math.max(brokenAt, seq);
    finish(seq);
    deps.onError?.(why);
  };

  return {
    begin(req: unknown): JournalTicket {
      const seq = next();
      open.add(seq);
      const tooBig = estimateBytes(req, maxBytes) > maxBytes;
      let settled = false;
      return {
        commit(): void {
          if (settled) return;
          settled = true;
          if (tooBig) {
            fail(seq, '変更が大きいため控えを作りません(画像で保存します)');
            return;
          }
          void deps.backend
            .put({ seq, req })
            .then(() => finish(seq))
            .catch((e: unknown) => fail(seq, errorText(e)));
        },
        abort(): void {
          if (settled) return;
          settled = true;
          finish(seq);
        },
      };
    },
    snapshotSeq(): number {
      const n = next();
      if (open.size === 0) return n;
      return Math.min(n, Math.min(...open) - 1);
    },
    trim(upTo: number): void {
      if (upTo >= brokenAt) brokenAt = 0;
      void deps.backend.deleteUpTo(upTo).catch(() => undefined);
    },
    pending: () => open.size,
    broken: () => brokenAt > 0,
    settled(): Promise<void> {
      return open.size === 0 ? Promise.resolve() : new Promise((r) => waiters.push(r));
    },
  };
}

/* ------------------------------------------------------------------ IndexedDB */

const J_STORE = 'journal';
const F_STORE = 'failed';

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
      if (!req.result.objectStoreNames.contains(F_STORE))
        req.result.createObjectStore(F_STORE, { keyPath: 'seq' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb open failed'));
  });
}

function done_<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
  store: string = J_STORE,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result: T;
    const req = run(t.objectStore(store));
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
    async keepFailed(entries): Promise<void> {
      const db = await need();
      for (const e of entries) await done_(db, 'readwrite', (st) => st.put(e), F_STORE);
    },
    async deleteUpTo(upTo): Promise<void> {
      await done_(await need(), 'readwrite', (s) => s.delete(IDBKeyRange.upperBound(upTo)));
    },
  };
}
