/**
 * 🔴 **可搬単一 HTML の器**(#400 段③)── `:memory:` の DB 画像を IndexedDB に置く。
 *
 * `file://` では OPFS が取れない(opaque origin。設計 doc §1 の実測)ので、
 * 永続は「**DB 画像を丸ごと器へ書く**」しかない。実測(設計 doc §3):
 *
 * | 件数 | DB | 画像を出す | 器へ書く | 合計 | 起動時の復元 |
 * |---|---|---|---|---|---|
 * | 1,000 | 4.1 MB | 19.5 ms | 86.1 ms | **106 ms** | 5.8 ms |
 * | 8,000 | 33.0 MB | 362.8 ms | 620.8 ms | **984 ms** | 50.3 ms |
 *
 * 🔑 **読み側は安い**(33MB で 50ms)── 高いのは書きだけなので、束ねて遅らせる
 * (`portable-persist.ts`)。
 *
 * ## 🔴 `Blob` では置けない(`asset-blob-store.ts` §「Blob 値の bytes が耐久化した
 * 証拠ではない」の実測がそのまま効く)
 *
 * `Blob` は「後で bytes を出す」**借用証書**で、発行した realm が生きている間しか
 * 換金できない ── 32MiB を書いた**直後に窓を閉じる**と `ERR_SOURCE_DIED_IN_TRANSIT`。
 * ⚠ 可搬バンドルの保存は**まさに「閉じる直前」に走る**(`beforeunload` の flush)ので、
 * ここは **`Uint8Array` でなければならない**。⚠ 「1 コピー減らせる」と `Blob` へ
 * 変えると、**閉じたときだけ静かに壊れる**(いちばん気づけない形)。
 */
import { bundleDbName, type StoredImageMeta } from '@features/portable/bundle';

const STORE = 'image';
const KEY = 'db';

/** 器に置く記録。⚠ **bytes と目録を同じ record に置く**(別々に書くと片方だけ残る)。 */
export interface StoredImage extends StoredImageMeta {
  readonly image: Uint8Array;
}

interface RawRecord {
  bundleId?: unknown;
  exportedAt?: unknown;
  savedAt?: unknown;
  image?: unknown;
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
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
    const fail = (e: unknown): void =>
      reject(e instanceof Error ? e : new Error('idb request failed'));
    if (mode === 'readonly') {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => fail(req.error);
      return;
    }
    // ⚠ 書きは **commit を待つ**(`asset-blob-store.ts` と同じ理由 ── quota の
    //   abort は request success の**後**に来るので、そこで resolve すると嘘になる)
    let result: T;
    req.onsuccess = () => {
      result = req.result;
    };
    t.oncomplete = () => resolve(result);
    t.onerror = () => fail(t.error);
    t.onabort = () => fail(t.error ?? new Error('idb transaction aborted'));
  });
}

/**
 * 読んだ record を検める。
 *
 * 🔴 **壊れた record を「無い」と読み替えない** ── ⚠ そうすると
 * 呼び側は「器が空だから配られた画像を開く」へ進み、**user の編集を上書きする**。
 * 🔑 だから**形が違うものは投げる**(呼び側が断って、user に見せる)。
 * ⚠ 例外は「record そのものが無い」場合だけで、それは `undefined` で返す。
 */
function decode(raw: unknown): StoredImage | null {
  if (raw === undefined || raw === null) return null;
  const r = raw as RawRecord;
  const image = r.image;
  if (!(image instanceof Uint8Array))
    throw new Error('器の記録の形が違います(画像が Uint8Array ではない)');
  if (typeof r.bundleId !== 'string' || r.bundleId === '')
    throw new Error('器の記録の形が違います(bundleId が無い)');
  for (const [k, v] of [
    ['exportedAt', r.exportedAt],
    ['savedAt', r.savedAt],
  ] as const)
    if (typeof v !== 'number' || !Number.isFinite(v))
      throw new Error(`器の記録の形が違います(${k} が数ではない)`);
  return {
    bundleId: r.bundleId,
    exportedAt: r.exportedAt as number,
    savedAt: r.savedAt as number,
    bytes: image.byteLength,
    image,
  };
}

/**
 * 1 つのバンドルの器。
 *
 * ⚠ **器の名前は `bundleDbName` からしか作らない** ── `file://` では
 * 器が scheme 全体で 1 個なので、名前を組み立てる場所が 2 つに増えた瞬間、
 * 片方だけ名前空間を切り忘れて**別のバンドルを上書きする**(CLAUDE.md §7)。
 */
export class DbImageStore {
  private db: IDBDatabase | null = null;

  constructor(private readonly bundleId: string) {}

  private async need(): Promise<IDBDatabase> {
    if (!this.db) this.db = await openDb(bundleDbName(this.bundleId));
    return this.db;
  }

  /** @returns 無ければ `null`。⚠ 形が壊れていたら**投げる**(無いことにしない)。 */
  async read(): Promise<StoredImage | null> {
    const raw = await tx<unknown>(await this.need(), 'readonly', (s) => s.get(KEY));
    return decode(raw);
  }

  /** 目録だけ読む。⚠ 判定(`chooseImage`)に bytes は要らない。 */
  async readMeta(): Promise<StoredImageMeta | null> {
    const rec = await this.read();
    if (rec === null) return null;
    const { bundleId, exportedAt, savedAt, bytes } = rec;
    return { bundleId, exportedAt, savedAt, bytes };
  }

  async write(rec: {
    exportedAt: number;
    savedAt: number;
    image: Uint8Array;
  }): Promise<void> {
    /**
     * 🔴 **空を書かない。** 画像を出す側が落ちた回に 0 バイトを put すると、
     * 次の起動は「器に記録がある」と読んで**中身ごと空で開く**。
     * ⚠ `chooseImage` にも同じ門があるが、**書く前に止めるほうが強い**
     * (検出より、起こらなくするほう ── CLAUDE.md §7)。
     */
    if (rec.image.byteLength <= 0) throw new Error('空の画像は器へ書きません');
    await tx(await this.need(), 'readwrite', (s) =>
      s.put({ bundleId: this.bundleId, ...rec }, KEY),
    );
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
