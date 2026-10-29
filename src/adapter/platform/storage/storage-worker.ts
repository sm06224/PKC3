/**
 * PKC3 storage worker(設計 doc §4.4)。
 * sqlite(OPFS SAHPool)はこの worker に閉じる。OPFS 不可環境(旧ブラウザ /
 * SAH を他タブが保持)は :memory: に fallback し、**理由を InitResult に載せる**
 * (silent fallback にしない ── review #1)。多重タブの writer リースは P2 残作業。
 *
 * メモリ 2 原則(§4.2): stmt は毎回 finalize(exec/selectObjects/selectValue の
 * 内部完結 API のみを使う)/ 大きな値は保持しない。
 */
import { WORKSPACES_REMAIN_MESSAGE } from '@features/storage/workspace-guard';
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { exportDbImage } from './db-image-export';
import {
  DB_SCHEMA_VERSION,
  SCHEMA_DDL,
  REVISION_ADDED_COLUMNS,
  ENTRY_ADDED_COLUMNS,
  FTS_DDL,
  LEGACY_FTS_DDL,
  FTS_FORM_KEY,
  FTS_FORM_VERSION,
  FTS_PROGRESS_KEY,
  FTS_PROGRESS_SCOPE,
  FTS_SOURCE_VIEW,
  USER_REALM_SQL,
  CID_SCOPED_TABLES,
} from './schema';
/**
 * 全文検索が 1 度に返す上限(#181)。⚠ **切ったことは呼び側へ言う** ── 黙って
 * 切ると user は「無い」と読む。上限そのものは「一覧に出して意味がある量」で決めた。
 */
const SEARCH_LIMIT = 200;
import type { EntryStamps, EntryUpsert } from './schema';
import { contentHash64Hex } from './content-hash';
import { fixReservedLock, type ReservedLockOutcome, type ReservedLockSqlite } from './reserved-lock';
// 🔑 メッセージの本文の形は features 層が持つ(判断を 1 か所に。設計 doc §7、段②a)
import { errorText } from '@features/error-text';
import { wouldMakeCycle } from '@features/relation/tree';
import {
  SYSTEM_JOB_LID,
  SYSTEM_MESSAGE_LID,
  capForMessageLid,
  formatMessageSection,
  trimSlackForLid,
  trimToCap,
  titleForMessageLid,
  MESSAGE_CAP_DEFAULT,
} from '@features/message/message-log';
// 🔑 数だけをここから取る ── 読み解き(日本語)は features 層に置く(#971 段③)
import { QUICK_CHECK_MAX_ERRORS, RESCUE_CHUNK } from '@features/storage/db-rescue';
import { INTEGRITY_STAMP_KEY, INTEGRITY_STAMP_SCOPE } from '@features/storage/integrity-schedule';
import { MAX_TAG_COLORS, normalizeTagColor } from '@features/tag-color';
import { MAX_NOTE_PINS_STORED } from '@features/relation/note-pins';
import {
  CORRUPT_BLOCKED_OPS,
  CORRUPT_REFUSAL,
  corruptReport,
  looksCorrupt,
  shouldFlagCorrupt,
} from '@features/storage/db-corruption';
import {
  QUOTA_BLOCKED_OPS,
  QUOTA_ESTIMATE_TIMEOUT_MS,
  WRITE_QUOTA_REFUSAL,
  refuseWrite,
  shouldRecheck,
  type QuotaSample,
} from '@features/storage/write-quota';
import {
  imageTooBigMessage,
  looksOutOfMemory,
} from '@features/storage/image-export-limit';
import { assetRefsIn, scanAssetRefsInto } from '@features/asset/asset-ref-scan';
import { readAttachmentMeta } from '@features/flavor/attachment-flavor';
import { rewriteAssetRefs } from '@features/asset/asset-ref-rewrite';
import { extractMeta } from '@features/flavor';
import { remapImportedBody } from '@features/import/body-remap';
import { readVersions, totalHistoryBytes } from '@features/flavor/attachment-versions';
import { planSaveBack } from '@features/asset/asset-replace-plan';
import { spliceFrontmatterKeys } from '@features/markdown/frontmatter';
import { bodyLinkNeedles, bodyLinksTo } from '@features/entry-ref/body-links';
import { isWritableLinkTitle, renameLinkTexts, renameTitleLinks } from '@features/entry-ref/link-text-rename';
import { scanTitleLinks } from '@features/markdown/title-link';
import {
  SNIPPET_ARCHETYPE,
  SNIPPET_LIMITS,
  SNIPPET_SKIPPED_NAMES,
  snippetItemOf,
  snippetSkipReason,
  type SnippetItem,
  type SnippetScan,
  type SnippetSkipped,
} from '@features/snippet/snippet-table';
import {
  plannedTerms,
  planSearch,
  toLikePattern,
  type QuerySearchPlan,
} from '@features/filter/search-query';
import { foldWidth } from '@features/filter/fold-text';
import { excerptAroundFolded, foldedColumns, searchableBody } from '@features/filter/search-text';
import { countTaskCandidates } from '@features/markdown/task-count';
import { bodyTags } from '@features/flavor/entry-tags';
import { decodeTags, encodeTags } from '@features/flavor/tags';
import {
  TASK_LIMITS,
  NOTE_TIME_LIMIT,
  type TaskCard,
  noteTimeOf,
  taskCardsOf,
  type NoteTime,
  type TaskScan,
} from '@features/schedule/task-cards';
import {
  CONTACT_LIMITS,
  contactOf,
  type ContactCard,
  type ContactScan,
} from '@features/contact/contact-card';
import { WORK_LOG_LIMITS, workRunsOf, type WorkLogScan, type WorkRun } from '@features/timer/work-log';
import { createQueryScan, FRONTMATTER_SCAN_CHARS } from '@features/query/group-by';
import { capCellText } from '@features/query/sql-cell';
import { decodeImportTextInfo } from '@features/import/text-decode';
import {
  FTS_VIRTUAL_NAMES_SQL,
  NOT_FTS_BACKSTAGE,
  NOT_FTS_SHADOW,
  NOT_SQLITE_INTERNAL_SQL,
} from '@features/query/schema-digest';
import {
  collectCsvTables,
  CSV_DEFAULT_TABLE,
  csvCellsOverBudget,
  mergeCsvTables,
  csvTablesMentioned,
  CSV_TABLE_CELLS_MAX,
  type CsvTable,
  type CsvTableReject,
} from '@features/query/csv-tables';
// 🔴 添付の .csv / .tsv を「客の DB」として開けるようにする(#854 段①)
import { buildCsvAttachmentTable } from '@features/query/csv-attachment';
import { readXlsxBook } from '@features/query/xlsx-book';
// 🔴 `.sqlite` を DuckDB 用の NDJSON の写しにする(#682 段④d)── 判断は features 側の 1 か所
import {
  LossyWatch,
  NdjsonCollector,
  ndjsonKeysOf,
  ndjsonLineOf,
  quoteIdent,
  tooBigReason,
  type SqliteColumnShape,
  type SqliteExportFk,
  type SqliteExportedTable,
} from '@features/query/sqlite-ndjson';
import { createSmartScan } from '@features/smart/smart-spec';
import {
  applyLinePatch,
  diffLines,
  parseLinePatch,
  serializeLinePatch,
} from '@features/revision/line-patch';
import {
  JOURNAL_MODES,
  type JournalMode,
  type StorageRequest,
  type StorageResponse,
  type InitResult,
  type RequestFor,
  type ResultMap,
  type ImportRevisionsResult,
  type EncodedChainInput,
  type TrashNoteInput,
  type StorageGauge,
} from './protocol';

let db: Database | null = null;
let initResult: InitResult | null = null;
/**
 * 🔑 **init が建てた sqlite の口を持っておく**(#400 段③)── 画像の出し入れが要る。
 * ⚠ **`init` の中の局所変数のままにしない** ── `exportImage` から届かないので、
 *   もう 1 度 `sqlite3InitModule()` を呼ぶ形になり、**WASM が二重に建つ**。
 */
let sqliteApi: { capi: Record<string, unknown>; wasm: Record<string, unknown> } | null = null;

/**
 * 🔴 **SAHPool の口を持っておく**(#986 段③)── **入れ物ごと捨てる**ために要る。
 *
 * ## ⚠ なぜ `DELETE` ではないのか
 *
 * このボタンが要る当の場面は「**DB が壊れている**」である。
 * 🔴 壊れた DB へ SQL を打つと `rc 11` で落ちるので(`db-rescue.ts` の実測表:
 * `REINDEX` / `DROP+CREATE INDEX` / `VACUUM INTO` が **12 回とも rc 11**)、
 * **`DELETE FROM …` は「使いたいときだけ使えない」道具**になる。
 * 🔑 だから **file の層**で捨てる ── `wipeFiles()` は SQL を 1 文も打たない。
 *
 * ⚠ `init` の中の局所変数のままにしない(`sqliteApi` と同じ理由)── 後から届かない。
 * ⚠ `memory` VFS のときは `null` のまま ── その場合は**捨てる物がディスクに無い**
 *   (読み込み直せば消える)ので、呼び側へそう返す。
 */
let sahPool: { wipeFiles(): Promise<void> } | null = null;

/**
 * 🔴 **画像を `:memory:` の DB へ流し込む**(#400 段③)。
 *
 * ⚠ **schema を当てる前に呼ぶこと。** `sqlite3_deserialize` は DB を**丸ごと**
 * 差し替えるので、先に表を作っても消える。あとから `applySchema` を通すことで、
 * **古い版の画像でも移行が走る**(OPFS の DB と同じ経路に合流する)。
 *
 * ## 🔴 領域の持ち主を取り違えない
 *
 * `FREEONCLOSE`(1)を渡すと、**sqlite が閉じるときに `sqlite3_free` する** ──
 * だから領域は `sqlite3_malloc` 由来でなければならない(`allocFromTypedArray` が
 * それ)。⚠ そして **rc が 0 でない回は所有権が移らない**ので、
 * こちらで解放する。⚠ 逆に成功した回に解放すると **二重解放**になる。
 *
 * `RESIZEABLE`(2)が無いと、**画像より 1 バイトも大きくできない DB** になる
 * (= 復元した瞬間から書けない)。⚠ これは「開ける」ので、**書くまで気づけない**。
 */
function deserializeInto(
  sqlite3: { capi: Record<string, (...a: never[]) => unknown>; wasm: Record<string, (...a: never[]) => unknown> },
  database: Database,
  image: Uint8Array,
): number {
  const { capi, wasm } = sqlite3;
  const alloc = wasm.allocFromTypedArray as unknown as (a: Uint8Array) => number;
  const free = wasm.dealloc as unknown as ((p: number) => void) | undefined;
  const deserialize = capi.sqlite3_deserialize as unknown as (
    db: unknown,
    schema: string,
    p: number,
    szDb: bigint,
    szBuf: bigint,
    flags: number,
  ) => number;
  const p = alloc(image);
  const n = BigInt(image.byteLength);
  const FREEONCLOSE = 1;
  const RESIZEABLE = 2;
  const rc = deserialize(
    (database as unknown as { pointer: unknown }).pointer,
    'main',
    p,
    n,
    n,
    FREEONCLOSE | RESIZEABLE,
  );
  if (rc !== 0) {
    free?.(p); // ⚠ 失敗した回は所有権が移っていない
    throw new Error(`DB 画像を読み込めませんでした(sqlite3_deserialize rc=${rc})`);
  }
  return image.byteLength;
}

/**
 * 🔴 **保存先を開こうとしている間だけ、sqlite のエラーログを控える**(#1073)。
 *
 * ## なぜ要るか
 *
 * 起動の直後に読み込み直すと、前のページの storage worker がまだ OPFS の
 * SAHPool を掴んでいる間に、新しいページの worker が開こうとする。sqlite は
 * `NoModificationAllowedError` を `sqlite3.config.error` へ複数行書くが、
 * `openStorageWithRetry`(open-with-retry.ts)が worker を作り直して待ち、
 * **2 回目には開ける**(画面には何も出ない)。⚠ それでも console には
 * 「回復した一時の失敗」がエラーとして残り、開発者には壊れて見える
 * (`tests/smoke/launcher.smoke.spec.ts` が `collectPageErrors` でおよそ 1 割落ちていた)。
 *
 * 🔑 だから **「保存先を開こうとしている間」だけ**、`sqlite3.config.error` の
 * 呼び出しを console ではなく控えへ溜める。⚠ **`warn` / `log` は触らない**
 * (範囲を広げない ── ほかの sqlite のエラーを隠さない)。
 */
let capturingOpenErrors = false;
let openErrorLog: string[] = [];
/**
 * 🔴 **窓を閉じた後に着く、失敗した試行の残り**(#1311)。
 *
 * 上流 SAHPool の `acquireAccessHandles`(`@sqlite.org/sqlite-wasm/dist/index.mjs` 14938-14959)は
 * pool の file(`initialCapacity` = 6 本)それぞれに `Promise.all(files.map(async …))` で
 * `createSyncAccessHandle` を投げ、**枝ごとの `catch` が `storeErr`(= このエラー口)を呼んでから
 * 投げ直す**。`Promise.all` は**最初の 1 本が落ちた時点で reject** するので、
 * `installOpfsSAHPoolVfs` が `removeVfs()` を待って reject → 呼び側の `catch` が区間を閉じる。
 * ⚠ **残りの枝の失敗は、その後に返る** ── 区間の外でこの口に届く(1 回に 1〜6 行)。
 *
 * 🔑 開けなかった worker は捨てられ(再試行は新しい worker)、その pool は `removeVfs` で消えている。
 * だから **失敗した pool の接頭(pool 名 + `:`)と一致する行は、全部失敗した試行の残り**である。
 * 接頭が違う行(`:memory:` へ退避した後の別の sqlite のエラー)は今までどおり流す。
 * ⚠ エラーの名前では絞らない(上の理由で、その接頭で届く物は残りと決まっているため)。
 */
let failedPoolPrefix: string | null = null;
let lateOpenErrorLog: string[] = [];

/**
 * `sqlite3ApiConfig.error` へ渡す口。⚠ 上流の既定(`error: console.error.bind(console)`、
 * `dist/index.mjs` 3263 付近)と同じ呼び方(可変長引数)。
 *
 * ⚠ 「開いている間だけ」の切り替えは `beginOpeningStorage` / `endOpeningStorage` が
 * 持つ ── この関数自体はフラグを読むだけで、いつ捕まえるかは決めない。
 * 🔑 test から直に呼べるよう export する(CLAUDE.md §2「取り出せば test できる」──
 * node で SAHPool の失敗そのものは作れない。詳しくは呼び出し口の注記)。
 */
export function sqliteOpenErrorSink(...args: unknown[]): void {
  if (capturingOpenErrors) {
    openErrorLog.push(args.map((a) => String(a)).join(' '));
    return;
  }
  if (failedPoolPrefix !== null && args.length > 0 && args[0] === failedPoolPrefix) {
    lateOpenErrorLog.push(args.map((x) => String(x)).join(' '));
    return;
  }
  console.error(...args);
}

/**
 * 開けなかった pool を覚える(#1311)。以後、その接頭で届く行は
 * 失敗した試行の残りとして `lateOpenErrors()` へ控える(理由は `failedPoolPrefix` の注記)。
 */
export function markPoolOpenFailed(poolName: string): void {
  failedPoolPrefix = `${poolName}:`;
  lateOpenErrorLog = [];
}

/** 窓を閉じた後に控えた行(test と診断用)。 */
export function lateOpenErrors(): readonly string[] {
  return lateOpenErrorLog;
}

/** test の後始末用 ── ⚠ 製品コードは呼ばない(`tests/adapter/storage-open-error-sink.test.ts` が pin)。 */
export function resetOpenErrorSinkForTest(): void {
  capturingOpenErrors = false;
  openErrorLog = [];
  failedPoolPrefix = null;
  lateOpenErrorLog = [];
}

/**
 * 保存先を開こうとしている区間へ入る(控えを新しく始める)。
 * 🔑 node では SAHPool の失敗そのものを再現できない(`installOpfsSAHPoolVfs` が
 *   `sqlite3.config.error` を呼ぶ前に `Missing required OPFS APIs.` で reject する)
 *   ので、export して**直に**区間の開始・終了を test する(CLAUDE.md §2)。
 */
export function beginOpeningStorage(): void {
  /**
   * ⚠ **区間は 1 度に 1 つだけ**(#1073 着地前レビュー ⚠2)── 控えは worker 全体で
   *   1 つなので、重ねて入ると片方の区間を抜けた瞬間にもう片方の sqlite のエラーが
   *   漏れる / 混ざる。いまは重なる経路が無い(再試行は毎回新しい worker)が、
   *   黙って上書きせず**投げて見えるようにする**。
   */
  if (capturingOpenErrors) throw new Error('保存先を開く区間が重なりました(#1073)');
  capturingOpenErrors = true;
  openErrorLog = [];
}

/**
 * 区間を抜ける。⚠ **開けたら `discard: true`**(控えは捨てる)。
 * 開けずに `:memory:` へ退避した回は `discard: false` ── 戻り値を
 * `InitResult.fallbackDetail` として診断に載せる(console には出さない)。
 */
export function endOpeningStorage(discard: boolean): string[] {
  capturingOpenErrors = false;
  const captured = openErrorLog;
  openErrorLog = [];
  return discard ? [] : captured;
}

async function init(
  dbName: string,
  journalMode?: JournalMode,
  opts?: { memory?: boolean; image?: Uint8Array },
): Promise<InitResult> {
  /**
   * 🔴 **画像は `memory: true` と一緒でなければ受けない**(#400 段③)。
   *
   * ⚠ 判定を「開いた後の `vfs`」に置くと、**OPFS が取れない環境では素通りする**
   * (node がまさにそれ ── 門が 1 度も通らないまま緑になる。CLAUDE.md §2)。
   * 🔑 だから**頼まれた形そのもの**で断る ── これはどの環境でも同じように鳴る。
   */
  if (opts?.image !== undefined && opts.memory !== true)
    throw new Error('DB 画像は memory: true と一緒に渡してください');

  // 冪等(review #4): 二重 init で WASM を二重化しない・旧 db を leak しない
  if (initResult) return initResult;

  /**
   * 🔴 **使わない OPFS VFS を用意させない**(#114)。
   *
   * `crossOriginIsolated` が成立した(#112 / #113)結果、上流は `opfs` と `opfs-wl`
   * という **PKC3 が 1 度も使わない VFS** を init 時に建て、そのたびに
   * **async proxy の worker を 1 本ずつ**起こすようになった。DB 本体は
   * 下の `installOpfsSAHPoolVfs`(SAHPool)であって、この 2 つではない。
   *
   * ⚠ **止め方は推測せず上流の実物で確かめた**(`@sqlite.org/sqlite-wasm` の
   * `dist/index.mjs`)── 3 つの初期化子がそれぞれ別の鍵を見ている:
   *
   * | 初期化子 | 門 |
   * |---|---|
   * | `opfs` VFS | `config.disable?.vfs?.opfs` |
   * | `opfs-wl` VFS | ``config.disable?.vfs?.['opfs-wl']`` |
   * | **`opfs-sahpool`(PKC3 が使う)** | ``config.disable?.vfs?.['opfs-sahpool']`` ← **別の鍵。閉じない** |
   *
   * worker を作る `new Worker(...)` は `createVfsState()` の中の**1 か所だけ**で、
   * そこへ入るのは上の 2 つの install 経路しかない ── 門を閉じれば 1 本も起きない。
   *
   * ## 実測(2026-08-17、同じビルドで 2 鍵だけ違う 2 つの dist を交互に 6 組)
   *
   * | | renderer の Pss(中央値) | 範囲 |
   * |---|---|---|
   * | いまのまま | 143.5 MB | 143.2–144.0 |
   * | **この設定** | **139.6 MB** | 138.3–140.1 |
   *
   * **6 組とも同じ向きで、範囲が重ならない(−3.9 MB)。**
   * ⚠ 起動は **462 → 454ms** で**範囲が重なる** ── 起動が速くなったとは言えない。
   * ⚠ 編集セッションの計器(`run-app-session.mjs`)では ±8MB 揺れて**分解できない**
   * (添付のラスタが揺れの主因)── だから観測点を renderer の静止時に寄せてある。
   *
   * ⚠ **`globalThis` に置くのが上流の作法**(`sqlite3ApiBootstrap` が
   * `globalThis.sqlite3ApiConfig` を読んで merge し、**読んだ後に自分で消す**)。
   * したがって init 後にこの値は残らない ── 検査は `tests/adapter/storage-vfs-config.test.ts`
   * が**代入そのもの**を捕まえる形で置いてある。
   */
  (globalThis as unknown as Record<string, unknown>).sqlite3ApiConfig = {
    disable: { vfs: { opfs: true, 'opfs-wl': true } },
    // 🔴 「保存先を開こうとしている間」だけ控えるための口(#1073。上の注記)。
    error: sqliteOpenErrorSink,
  };
  const sqlite3 = await sqlite3InitModule();
  sqliteApi = sqlite3 as unknown as { capi: Record<string, unknown>; wasm: Record<string, unknown> };
  const meta = {
    libVersion: sqlite3.version.libVersion,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
  };

  // catch の範囲は「OPFS の確保」だけに絞る(review #1)
  let opened: Database;
  let vfs: InitResult['vfs'] = 'opfs-sahpool';
  let fallbackReason: string | undefined;
  let fallbackDetail: string[] | undefined;
  // :memory: には journal の巻き戻しの話が無い ── 差し替えない(2 つとも false)
  let reservedLock: ReservedLockOutcome = {
    reservedLockPatched: false,
    reservedLockUpstreamFixed: false,
  };
  if (opts?.memory === true) {
    /**
     * 🔴 **頼まれて `:memory:` にした回は「落ちた」と言わない**(#400 段③)。
     *
     * 可搬単一 HTML は **OPFS を試さない** ── `file://` では原理的に取れず
     * (opaque origin)、`https://` に置いたときも**その origin の本体の DB を
     * 開いてしまう**ので、どちらでも試す理由が無い。
     * ⚠ ここで `fallbackReason` を載せると、状態行に `⚠ SecurityError …` と
     * 出る ── **選んだ形を事故として告げる**ことになる。
     */
    vfs = 'memory';
    opened = new sqlite3.oo1.DB(':memory:');
  } else {
    // 🔴 開こうとしている区間だけ、error を控えへ溜める(#1073。上の注記)
    beginOpeningStorage();
    try {
      const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: dbName });
      // 🔑 **捨てる口を持っておく**(上の `sahPool` の注記)── ここでしか手に入らない。
      sahPool = poolUtil as unknown as { wipeFiles(): Promise<void> };
      opened = new poolUtil.OpfsSAHPoolDb(`/${dbName}.db`);
      /**
       * 🔴 **開いた直後、`applySchema` より前に差し替える**(#1218 F1。`reserved-lock.ts` に理由)。
       * ⚠ 結果は**黙って捨てない** ── 当たらなかったら `reservedLockPatched: false` が
       *   `InitResult` に載り、main が user に言う。
       */
      reservedLock = fixReservedLock(
        sqlite3 as unknown as ReservedLockSqlite,
        opened as unknown as { pointer: number },
      );
      endOpeningStorage(true); // 開けた ── 控えは捨てる
    } catch (e) {
      fallbackDetail = endOpeningStorage(false); // 開けなかった ── 診断として残す
      markPoolOpenFailed(dbName); // 窓の後に着く残りも console へ出さない(#1311)
      vfs = 'memory';
      fallbackReason = String(e);
      opened = new sqlite3.oo1.DB(':memory:');
    } finally {
      /**
       * ⚠ **どの経路で抜けても区間を閉じる**(#1073 着地前レビュー ⚠2)── 上の 2 か所で
       *   既に閉じていれば何もしない。閉じ忘れると、以後この worker の**無関係な**
       *   sqlite のエラーまで console に出なくなる(上の try に後から早期 return を
       *   足した日に、黙ってそうなる)。
       */
      if (capturingOpenErrors) endOpeningStorage(true);
    }
  }

  /**
   * 🔴 **画像は `:memory:` にしか当てない。**
   *
   * ⚠ OPFS の接続に `deserialize` すると、その接続は**メモリ上の DB に化ける** ──
   * 開けるし読めるが、**書いたものが OPFS へ 1 バイトも届かない**。
   * 症状は「保存したのに次の起動で消えている」で、**当日は絶対に気づけない**。
   */
  let restoredBytes: number | undefined;
  if (opts?.image !== undefined && opts.image.byteLength > 0) {
    if (vfs !== 'memory') {
      opened.close();
      throw new Error('DB 画像は :memory: にしか流し込めません(memory: true と一緒に渡すこと)');
    }
    try {
      restoredBytes = deserializeInto(
        sqlite3 as unknown as Parameters<typeof deserializeInto>[0],
        opened,
        opts.image,
      );
      /**
       * 🔴 **`sqlite3_deserialize` は中身を見ない** ── でたらめな bytes でも
       * `rc = 0` を返す。壊れていることが分かるのは**最初に読んだとき**で、
       * そのままだと `applySchema` の中から `SQLITE_NOTADB` が飛ぶ ──
       * ⚠ user には「file is not a database」としか出ず、**どの画像の話か分からない**。
       * 🔑 ここで 1 回読んで、**画像の話として**言い直す。
       */
      opened.selectValue('SELECT count(*) FROM sqlite_schema');
    } catch (e) {
      opened.close();
      throw new Error(`DB 画像を読み込めませんでした(${String(e)})`, { cause: e });
    }
  }

  // schema 適用の失敗は fallback ではなく error(review #1b ── open 済み接続は閉じる)
  let actualJournalMode: string;
  try {
    applySchema(opened);
    // journal_mode は allowlist 経由のみ(injection 防止)。読み戻し値を正とする
    // (VFS 非対応なら要求と違う値が返る ── WAL は SAHPool 非対応を実測で確認済み)。
    // 既定 = truncate: 2026-07-30 掃引で delete よりわずかに速く安全性同等。
    // memory は最速だがクラッシュ時の DB 破損リスクがあり既定にしない(p2 log)
    const requested: JournalMode =
      journalMode && JOURNAL_MODES.includes(journalMode) ? journalMode : 'truncate';
    actualJournalMode = String(opened.selectValue(`PRAGMA journal_mode=${requested}`));
    /**
     * 🔴 **`synchronous` は FULL と決めた**(#1007 段③)。sqlite の既定も FULL(2)だが、
     * 既定に頼ると ① 上流が既定を変えた日 ② `journal_mode` を WAL へ変えた日(WAL なら
     * NORMAL でよい、と読む人が居る)に、**誰にも告げず耐久性が落ちる**。壊れに強くする側
     * (#1007)の決定なので字で置く。⚠ NORMAL にしない ── truncate / delete の journal で
     * NORMAL は電源断の瞬間に DB が壊れうる(sqlite の docs)。
     * 読み戻し値は `storageGauge` の `synchronous` で見える(test が 2 = FULL を pin)。
     * ⚠ 既定と同じ値なので、この行を消しても読み戻しは 2 のまま ── 消したことは
     *   `tests/adapter/storage-worker-gauge.test.ts` の原文の pin だけが止める。
     */
    opened.exec('PRAGMA synchronous = FULL');
  } catch (e) {
    opened.close();
    throw e;
  }

  db = opened;
  registerFoldFunctions(opened);
  // 🔴 索引の作り直しが要るなら、起動の返事の後に塊で流す(台帳 #1852 の束 B2 ── 本文の表示を止めない)
  try {
    startFoldBuild(opened);
  } catch {
    // ⚠ 壊れた DB(索引の頁が潰れている等)── 起動は止めない。読み出しと救出は通す(`applySchema` の「整える」段と同じ作法)
  }
  const base = { ...meta, vfs, journalMode: actualJournalMode, ...reservedLock };
  const withReason = fallbackReason ? { ...base, fallbackReason } : base;
  // 🔴 診断として載せるのは開けなかった回だけ(#1073)。console には出さない。
  const withDetail =
    fallbackDetail && fallbackDetail.length > 0 ? { ...withReason, fallbackDetail } : withReason;
  initResult = restoredBytes === undefined ? withDetail : { ...withDetail, restoredBytes };
  return initResult;
}

/**
 * 🔴 **既存行の派生列(`task_total` / `body_chars`)を数え直す**(#277 段② /
 * 2026-08-19 の 2 ペイン作り直し)。
 *
 * ⚠ **列ごとに走査を分けない** ── どちらも「本文を読んで数える」なので、
 *   分けると同じ本文を 2 度読む(埋め戻しはいちばん本文を読む場所である)。
 *
 * ⚠ **1 件ずつ UPDATE しない** ── 行数ぶん往復すると、取り込み直後の大きな
 *   コンテナで open が固まる。読みは 1 回、書きは変わる行だけ。
 * ⚠ **`updated_at` を触らない** ── 埋め戻しは user の編集ではない。
 *   触ると「今日ぜんぶ更新された」ように見える(情報列の嘘)。
 * ⚠ FTS の trigger は `AFTER UPDATE` で発火するが、`title` / `body` は
 *   変えていないので索引の中身は同じ値に書き直されるだけ(害は無い)。
 */
/**
 * 索引に入っている doc の数。
 *
 * 🔴 **`SELECT count(*) FROM entries_fts` で数えてはいけない**(2026-08-20 に実測)。
 *   外部内容(`content='entries'`)の全走査は**内容表のほう**を読むので、
 *   **索引が空でも `entries` の行数がそのまま返る**。実測値 ──
 *   索引 0 件 / entries 3 件のとき `count(*) FROM entries_fts` = **3**、
 *   `count(*) FROM entries_fts_docsize` = **0**(組み直した後は 3)。
 * ⚠ これは #181 の「**索引が空なら組み直す**」判定が**一度も真にならなかった**
 *   理由でもある(空振り §1 ── 検査が別の理由で成立していた)。
 *   つまり **#181 より前に作られた DB の索引は、今日まで空のまま**だった。
 * 🔑 数えるのは **`%_docsize` 影表**(1 doc = 1 行)。
 * ⚠ 読めないとき(壊れている / 影表がまだ無い)は `null` ── 呼び側が
 *   「合っていない」として組み直す。
 */
function ftsDocCount(database: Database): number | null {
  try {
    return Number(database.selectValue('SELECT count(*) FROM entries_fts_docsize') ?? 0);
  } catch {
    return null;
  }
}


/**
 * 🔴 **索引の作り直しの進み(台帳 #1852 の束 B2)**。`built_upto` の印は `settings` の 1 行
 * (`schema.ts` の `FTS_PROGRESS_SCOPE` の注記)。**行が無ければ済んでいる** = `FTS_ALL`。
 */
type SearchDetailResult = ResultMap['searchDetail'];

const FTS_ALL = Number.MAX_SAFE_INTEGER;

function readFoldCursor(database: Database): number {
  const v = database.selectValue('SELECT v FROM settings WHERE scope = ? AND k = ?', [
    FTS_PROGRESS_SCOPE,
    FTS_PROGRESS_KEY,
  ]);
  return v === undefined || v === null ? FTS_ALL : Number(v);
}

function setFoldCursor(database: Database, v: number): void {
  database.exec({
    sql: `INSERT INTO settings(scope, k, v) VALUES (?, ?, ?)
            ON CONFLICT(scope, k) DO UPDATE SET v = excluded.v`,
    bind: [FTS_PROGRESS_SCOPE, FTS_PROGRESS_KEY, String(v)],
  });
}

/**
 * 🔴 **索引を捨てて、最初から作り直す(印を -1 に戻す)**。
 *
 * 作り直しの途中(`built_upto` が途中)で、**前の版が `'rebuild'` を撃つ**と、印より後の行まで索引に入る。すると
 * 印より後の行の書き換え・削除は引き金が黙るので、索引が古い本文のまま残り、続きを流すと二重に入れて壊れる。
 * 印より後の行が索引に居る(`entries_fts_docsize` の id が印より大きい)のは、**誰かが索引を組み直した**証拠 ── そのときはここへ来る。
 */
function resetFtsIndex(database: Database): void {
  database.exec('DROP TABLE IF EXISTS entries_fts');
  for (const ddl of FTS_DDL) database.exec(ddl);
  setFoldCursor(database, -1);
}

/** 印より後の行が索引に居るか。⚠ 読めない(影の表が壊れている)ときも「居る」と読む(= 作り直す)。 */
function indexedBeyondCursor(database: Database, cursor: number): boolean {
  try {
    return (
      database.selectValue('SELECT 1 FROM entries_fts_docsize WHERE id > ? LIMIT 1', [cursor]) !== undefined
    );
  } catch {
    return true;
  }
}

function clearFoldCursor(database: Database): void {
  database.exec({
    sql: 'DELETE FROM settings WHERE scope = ? AND k = ?',
    bind: [FTS_PROGRESS_SCOPE, FTS_PROGRESS_KEY],
  });
}

/**
 * メモリ側の写し。⚠ **検索が「索引で引くか、全走査で引くか」を決めるのはこの値 1 つ**(`searchPlanOf`)。
 * `init` が読み、`foldStep` が進める。作り直しが済むまでは `FTS_ALL` より小さい。
 */
let foldCursor = FTS_ALL;

/**
 * 1 行の「索引の元の字」を作り直して書く。⚠ 引き金が索引を書き換える(`rowid <= built_upto` の行だけ)。
 * 🔑 **値が変わらない行は書かない**(本文の入った行を無駄に書き直さない)── 索引の形の版を上げた作り直しでも、
 *   作り方が変わらなかった行は 1 バイトも触れない。
 */
function refoldRow(database: Database, rid: number): void {
  const r = database.selectObjects(
    'SELECT title, body, title_f, body_f, fold_rev FROM entries WHERE rowid = ?',
    [rid],
  )[0] as
    | { title: string; body: string; title_f: string | null; body_f: string | null; fold_rev: number | null }
    | undefined;
  if (r === undefined) return;
  const f = foldedColumns(r.title, r.body);
  if (r.title_f === f.titleF && r.body_f === f.bodyF && r.fold_rev !== null) return;
  database.exec({
    sql: 'UPDATE entries SET title_f = ?, body_f = ?, fold_rev = coalesce(fold_rev, 0) + 1 WHERE rowid = ?',
    bind: [f.titleF, f.bodyF, rid],
  });
}

/** 1 塊に入れる行数と、本文の字数の合計の上限。⚠ 本文は 1 行ずつ読んで捨てる(ゼロコピーの規律)── 大きなノートが続く塊を長くしない。 */
const FOLD_CHUNK = 100;
const FOLD_CHUNK_CHARS = 4_000_000;

/**
 * 🔴 **索引の作り直しを 1 塊だけ進める**(台帳 #1852 の束 B2)。戻り値 = まだ続きがあるか。
 *
 * - 作り直しの途中(`built_upto < 最大`): `rowid` の順に次の塊(`chunk` 行 または 本文 `FOLD_CHUNK_CHARS` 字まで)を取り、
 *   元の字を作り(`refoldRow` ── 引き金は黙る)、視点から索引へ入れ、印を進める。**1 塊 = 1 tx**なので、途中で止まっても索引と印は合っている。
 * - 済んだ後: 旧ビルドが書いた行(`fold_rev IS NULL`)だけを引き直す(引き金が索引を書き換える)。
 * ⚠ **行ごとに本文を読んで捨てる**(塊の本文を一度に heap へ載せない)。
 * ⚠ 呼ぶのは `foldTick`(起動の後の係)と test だけ。塊と塊の間で worker は他の依頼を捌く。
 */
export function foldStep(database: Database, chunk = FOLD_CHUNK): boolean {
  const cursor = readFoldCursor(database);
  /** 行数と字数の両方で切る(最低 1 行は進む)。 */
  const cut = (rows: Array<{ rid: number; n: number | null }>): Array<{ rid: number }> => {
    let sum = 0;
    const out: Array<{ rid: number }> = [];
    for (const r of rows) {
      const n = Number(r.n ?? 0);
      if (out.length > 0 && sum + n > FOLD_CHUNK_CHARS) break;
      sum += n;
      out.push({ rid: r.rid });
    }
    return out;
  };
  database.exec('BEGIN IMMEDIATE');
  let more = false;
  let next = cursor;
  try {
    if (cursor >= FTS_ALL) {
      const fetched = database.selectObjects(
        'SELECT rowid AS rid, coalesce(body_chars, length(body)) AS n FROM entries WHERE fold_rev IS NULL LIMIT ?',
        [chunk],
      ) as Array<{ rid: number; n: number | null }>;
      const rids = cut(fetched);
      for (const r of rids) refoldRow(database, r.rid);
      more = rids.length < fetched.length || fetched.length === chunk;
    } else {
      const fetched = database.selectObjects(
        'SELECT rowid AS rid, coalesce(body_chars, length(body)) AS n FROM entries WHERE rowid > ? ORDER BY rowid LIMIT ?',
        [cursor, chunk],
      ) as Array<{ rid: number; n: number | null }>;
      const rids = cut(fetched);
      if (rids.length === 0) {
        clearFoldCursor(database);
        next = FTS_ALL;
      } else {
        // ⚠ 作り直す前に、元の字を今の作り方で揃える(`refoldRow` は変わらない行を書かない)
        for (const r of rids) refoldRow(database, r.rid);
        const hi = rids[rids.length - 1]!.rid;
        database.exec({
          sql: `INSERT INTO entries_fts(rowid, title, body)
                  SELECT rid, title, body FROM ${FTS_SOURCE_VIEW} WHERE rid > ? AND rid <= ?`,
          bind: [cursor, hi],
        });
        // 取り切った(取った行が chunk 未満で、切られてもいない)なら済み
        if (rids.length === fetched.length && fetched.length < chunk) {
          clearFoldCursor(database);
          next = FTS_ALL;
        } else {
          setFoldCursor(database, hi);
          next = hi;
          more = true;
        }
      }
    }
    database.exec('COMMIT');
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* rollback 失敗は元エラーを優先 */
    }
    throw err;
  }
  if (database === db) foldCursor = next;
  return more;
}

let foldTimer: ReturnType<typeof setTimeout> | null = null;
let foldFailures = 0;

/** 作り直しの係。塊と塊の間で `setTimeout` に戻る ── その間に本文の読込・保存・検索が割り込める。 */
function foldTick(): void {
  foldTimer = null;
  const database = db;
  if (database === null || dbCorrupt) return;
  try {
    if (foldStep(database)) {
      foldFailures = 0;
      foldTimer = setTimeout(foldTick, 0);
    }
  } catch {
    // ⚠ 他の処理の tx と重なった等 ── 少し待ってやり直す。続けて落ちるなら諦める(検索は全走査に落ちたまま動く)
    foldFailures += 1;
    if (foldFailures < 20) foldTimer = setTimeout(foldTick, 50);
    else postFoldGiveUp(database);
  }
}

/** 20 回続けて落ちて諦めたとき、システムのメッセージに 1 件残す(検索は全走査のまま動くが、遅い)。 */
function postFoldGiveUp(database: Database): void {
  try {
    const cid = activeContainerCid(database);
    if (cid === undefined) return;
    handlers.appendMessage({
      op: 'appendMessage',
      cid,
      lid: SYSTEM_MESSAGE_LID,
      title: titleForMessageLid(SYSTEM_MESSAGE_LID),
      section: formatMessageSection({
        at: new Date().toISOString(),
        kind: 'problem',
        source: 'app',
        text: '検索の索引を作り直せませんでした。検索は動きますが、遅くなります。保存領域の空きを増やして、PKC3 を開き直してください',
      }),
      cap: capForMessageLid(SYSTEM_MESSAGE_LID, MESSAGE_CAP_DEFAULT),
    });
  } catch {
    /* メッセージを残せなくても、検索は動く */
  }
}

/** 起動の後に作り直しの係を起こす。⚠ 要るときだけ(印が在る / 旧ビルドが書いた行が在る)。 */
function startFoldBuild(database: Database): void {
  foldCursor = readFoldCursor(database);
  foldFailures = 0;
  if (foldTimer !== null) clearTimeout(foldTimer);
  foldTimer = null;
  const pending =
    foldCursor < FTS_ALL ||
    database.selectValue('SELECT 1 FROM entries WHERE fold_rev IS NULL LIMIT 1') !== undefined;
  if (pending) foldTimer = setTimeout(foldTick, 0);
}

/**
 * 🔴 **検索の引き方を決める唯一の口**(台帳 #1852 の束 B2)。`planSearch` の答えを、索引の状態で直す。
 *
 * ⚠ **作り直しの途中は索引を使わない**(索引にまだ入っていない行が「無い」と読まれるため)── 全語を LIKE で全走査する。
 *   全走査が見る字は `foldedExprs` が決める ── **まだ作り直していない行(`rowid > 印`)も、その場で同じ作り方
 *   (`foldedColumns` と同じ `searchableBody` + `foldWidth`)を通した字**を見る。だから作り直しの間も、答えは作り直した後と同じ集合になる
 *   (隠したメモ・リンクの宛先で一致せず、全角は半角の語で一致する)。遅いだけである。作り直しが済めば索引で引く。
 */
function searchPlanOf(query: string, syntax: 'plain' | 'query'): QuerySearchPlan {
  const plan = syntax === 'plain' ? planSearch(query) : planSearch(query, { syntax: 'query' });
  if (plan.kind === 'fts' && foldCursor < FTS_ALL) {
    const t = plannedTerms(query, syntax);
    return { kind: 'like-terms', include: t.include, exclude: t.exclude };
  }
  return plan;
}

/**
 * 全走査(LIKE)が見る題名・本文の式。索引と同じ元の字 ── 作り直し済みの行は `coalesce(title_f, title)` /
 * `coalesce(body_f, body)`、作り直しの途中なら、まだの行(`rowid > 印`)は登録した関数(`registerFoldFunctions`)でその場で作る。
 */
function foldedExprs(): { title: string; body: string } {
  if (foldCursor >= FTS_ALL) return { title: 'coalesce(title_f, title)', body: 'coalesce(body_f, body)' };
  const c = Math.trunc(foldCursor); // 数だけを式に埋める(利用者の字は入らない)
  return {
    title: `CASE WHEN rowid > ${c} THEN pkc_fold_t(title) ELSE coalesce(title_f, title) END`,
    body: `CASE WHEN rowid > ${c} THEN pkc_fold_b(body) ELSE coalesce(body_f, body) END`,
  };
}

/**
 * 🔴 **作り直し前の行を、その場で揃えるための SQL 関数**(接続ごとに登録)。⚠ **検索の問い合わせでだけ使う** ──
 * 引き金からは呼ばない(旧ビルドが同じ DB に書いても `no such function` で落ちない)。
 */
function registerFoldFunctions(database: Database): void {
  const d = database as unknown as {
    createFunction: (
      name: string,
      fn: (cx: unknown, v: unknown) => unknown,
      opts: { arity: number; deterministic: boolean },
    ) => void;
  };
  d.createFunction('pkc_fold_t', (_cx, v) => (typeof v === 'string' ? foldWidth(v) : v), {
    arity: 1,
    deterministic: true,
  });
  d.createFunction('pkc_fold_b', (_cx, v) => (typeof v === 'string' ? foldWidth(searchableBody(v)) : v), {
    arity: 1,
    deterministic: true,
  });
}

/**
 * 題名か本文に語が入っている(LIKE)の条件を組む。⚠ 索引と同じ元の字(`foldedExprs`)を見る。
 * `numbered` = 番号つき引数(`?3`)/ そうでなければ位置引数(`?` を 2 つ → 2 回積む)。
 * 除く語は `NOT (…)`。戻り値は AND でつなぐ条件の並び。
 */
function likeWhere(
  plan: Extract<QuerySearchPlan, { kind: 'like' | 'like-terms' }>,
  bind: (string | number)[],
  numbered: boolean,
): string[] {
  const include = plan.kind === 'like' ? [plan.pattern] : plan.include.map(toLikePattern);
  const exclude = plan.kind === 'like' ? [] : plan.exclude.map(toLikePattern);
  const x = foldedExprs();
  const cond = (pattern: string): string => {
    if (numbered) {
      bind.push(pattern);
      const i = bind.length;
      return `(${x.title} LIKE ?${i} ESCAPE '\\' OR ${x.body} LIKE ?${i} ESCAPE '\\')`;
    }
    bind.push(pattern, pattern);
    return `(${x.title} LIKE ? ESCAPE '\\' OR ${x.body} LIKE ? ESCAPE '\\')`;
  };
  return [...include.map((p) => cond(p)), ...exclude.map((p) => `NOT ${cond(p)}`)];
}

/**
 * 🔴 **全文検索の索引を `entries` に合わせる**(#181 / 2026-08-20 の起動不能)。
 *
 * ⚠ 呼ぶ場所が主張の半分である ── **`entries` を書き換えるどの処理よりも前**。
 *   後ろに置くと、空の索引に trigger が `'delete'` を撃って索引を壊す
 *   (呼び出し側の注記を読むこと)。
 * ⚠ 判定は user_version ではなく**あるべき状態の実在**(schema.ts の原則)。
 *   冪等なので、半端な DB も次の open で自己修復する。
 */
function syncFtsIndex(database: Database): void {
  const entryCount = Number(database.selectValue('SELECT count(*) FROM entries') ?? 0);
  /**
   * 🔴 **索引の作り直しの途中なら、ここでは組み直さない**(台帳 #1852 の束 B2)。
   *
   * ⚠ 途中の索引は「数が合わない」のが正しい。ここで `'rebuild'` を撃つと、起動の tx の中で全件を一度に入れ直して
   *   起動が止まる(= 塊で流す設計の意味が消える)。続きは `foldStep` が流す。
   * ⚠ ただし**印より後の行が索引に居るなら**(前の版が `'rebuild'` を撃った)、索引を捨てて最初からやり直す
   *   (`resetFtsIndex`)。「数が合っているから済んだ」とは読まない ── 古い本文のまま居る行が残る。
   */
  const cursorNow = readFoldCursor(database);
  if (cursorNow < FTS_ALL) {
    if (indexedBeyondCursor(database, cursorNow)) resetFtsIndex(database);
    return;
  }
  if (ftsDocCount(database) === entryCount) return;
  try {
    database.exec(`INSERT INTO entries_fts(entries_fts) VALUES ('rebuild')`);
    if (ftsDocCount(database) === entryCount) return;
  } catch {
    /* 組み直しでも直らない索引 ── 下で作り直す */
  }
  /**
   * 🔴 **最後の手段:索引ごと作り直す**(2026-08-20 に実測して決めた)。
   *
   * ⚠ `'rebuild'` は**影表が壊れていると直せない** ── 実測:`%_docsize` を
   *   落とした索引に `'rebuild'` を撃つと `SQLITE_ERROR` で落ちる。
   *   ⚠ ここで throw させてはいけない。**起動そのものが失敗する**からである
   *   (それがこの節の直している症状である)。
   * 🔑 仮想表を落とすと**影表もろとも消える**ので、壊れ方に依らず作り直せる。
   *   ⚠ trigger は `entries` に付いているので**消えない**(実測: drop 後も 3 本)。
   */
  database.exec('DROP TABLE IF EXISTS entries_fts');
  for (const ddl of FTS_DDL) database.exec(ddl);
  database.exec(`INSERT INTO entries_fts(entries_fts) VALUES ('rebuild')`);
}

/**
 * 🔴 **タグの拾い方を直したら、既に索引に入っている行も引き直す**(#550、2026-08-29)。
 *
 * ⚠ 埋め戻し(`backfillDerivedColumns`)が拾うのは **NULL の行だけ**なので、
 *   規則を直しても**既存のノートは古い値のまま**である ── 実害は
 *   「`---` の中に書いた `#下書き` が**消えない幽霊タグ**として残る」形で出る
 *   (画面にも情報ペインにも出ないので、user は消し方を見つけられない)。
 * 🔑 だから**規則に版**を持たせ、版が変わったときだけ 1 度引き直す。
 *
 * ⚠ **全行を NULL にしてから埋め戻す形は採らない** ── `entries` の UPDATE は
 *   FTS の trigger(delete + insert)を全行に撃つので、**索引の churn が 2 周**する。
 *   ここでは **値が変わる行だけ**書くので、たいていのノート(タグを書いていない)は
 *   1 バイトも触らない。
 * ⚠ 走るのは `syncFtsIndex` の**後**(2026-08-20 の起動不能と同じ順序の約束)。
 * ⚠ 旧ビルドはこの印を知らないので、行き来すると古い規則で書き直されうる ──
 *   そのときは次に新ビルドで開いても版が一致してしまう(既知の限界。
 *   本文を保存し直せば正しくなる)。
 */
const BODY_TAGS_RULE = '2';
const DERIVE_SCOPE = '__derive__';

/** タグの色を持つ `settings` の scope(器ごと)。 */
function tagColorScope(cid: string): string {
  return `tag-color:${cid}`;
}

/** ノートのピン留めを持つ `settings` の scope(器ごと。#1377)。1 ノート 1 行(`k` = lid、`v` = 留めた順の通し番号)。 */
function notePinScope(cid: string): string {
  return `note-pin:${cid}`;
}

/**
 * 🔴 **旧ビルドが書いた行は、索引が据え置かれる**(2026-08-29 の着地後レビュー)。
 *
 * ⚠ `/`(本番)と `/dev/` は**同じ origin・同じ DB 名**なので、同じ DB を触る。
 *   旧ビルドの UPSERT は `body_tags` を更新しないので、**既存行を書き換えると
 *   索引だけ古いまま**になる ── 新規行は NULL なので埋め戻しが直すが、
 *   据え置かれた行は `NEEDS_BACKFILL` に当たらず**二度と拾われない**。
 * ⚠ 症状: 旧ビルドで `#請求` を消しても、新ビルドの集計とスマートフォルダには
 *   **残り続ける**(逆に旧ビルドで足したタグは永久に集まらない)。
 * 🔑 だから**最後に索引を揃えた時刻**を憶え、次に開いたとき
 *   **それ以降に編集された行だけ**引き直す ── どの writer も `updated_at` は
 *   必ず動かすので、旧ビルドの書込にも効く。実費は「前回の open 以降に
 *   編集された行」だけである。
 */
function redriveBodyTags(database: Database): void {
  const cur = database.selectValue(
    `SELECT v FROM settings WHERE scope = ? AND k = 'body_tags'`,
    [DERIVE_SCOPE],
  );
  const since =
    cur === BODY_TAGS_RULE
      ? ((database.selectValue(`SELECT v FROM settings WHERE scope = ? AND k = 'body_tags_at'`, [
          DERIVE_SCOPE,
        ]) as string | undefined) ?? '')
      : null;
  // ⚠ `since === null` = 規則が変わった(全件)/ 文字列 = その時刻より後だけ
  const stamp = new Date().toISOString();
  let after: { cid: string; lid: string } | undefined;
  for (;;) {
    // ⚠ 時刻で絞るときも `updated_at` が NULL の行は見る(一度も保存していない行)
    const fresh = since === null ? '' : ` AND (updated_at IS NULL OR updated_at > '${since}')`;
    const rows = database.selectObjects(
      after === undefined
        ? `SELECT cid, lid, body, body_tags FROM entries WHERE 1${fresh}
             ORDER BY cid, lid LIMIT ${BACKFILL_CHUNK}`
        : `SELECT cid, lid, body, body_tags FROM entries
             WHERE (cid > ? OR (cid = ? AND lid > ?))${fresh} ORDER BY cid, lid LIMIT ${BACKFILL_CHUNK}`,
      after === undefined ? [] : [after.cid, after.cid, after.lid],
    ) as Array<{ cid: string; lid: string; body: string | null; body_tags: string | null }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      const want = encodeTags(bodyTags(r.body ?? ''));
      // ⚠ **変わる行だけ**書く(FTS の trigger を無駄に撃たない)
      if (r.body_tags === want) continue;
      database.exec({
        sql: `UPDATE entries SET body_tags = ? WHERE cid = ? AND lid = ?`,
        bind: [want, r.cid, r.lid],
      });
    }
    const last = rows[rows.length - 1]!;
    after = { cid: last.cid, lid: last.lid };
    if (rows.length < BACKFILL_CHUNK) break;
  }
  database.exec({
    sql: `INSERT INTO settings(scope, k, v) VALUES (?, 'body_tags', ?)
            ON CONFLICT(scope, k) DO UPDATE SET v = excluded.v`,
    bind: [DERIVE_SCOPE, BODY_TAGS_RULE],
  });
  // 🔑 **揃えた時刻を残す** ── 次の open は「これより後に編集された行」だけを見る
  database.exec({
    sql: `INSERT INTO settings(scope, k, v) VALUES (?, 'body_tags_at', ?)
            ON CONFLICT(scope, k) DO UPDATE SET v = excluded.v`,
    bind: [DERIVE_SCOPE, stamp],
  });
}

function backfillDerivedColumns(database: Database): void {
  /**
   * 🔴 **回数の上限を、書込の成功と無関係に置く**(2026-08-20 の変異試験で判明)。
   *
   * ⚠ この `for(;;)` は「**UPDATE が条件を外す**から必ず尽きる」に賭けていた ──
   *   変異試験で `body_chars` の代入を落としたら、同じ 200 行が永久に返り続けて
   *   **worker が open で固まった**(test が 15 分止まり、外から殺すまで戻らない)。
   * ⚠ これは「変異だから起きた」で済ませてよい話ではない ── 尽きる理由が
   *   **別の行(UPDATE の列名)に握られている**形そのものが脆い。列を 1 つ足す
   *   たびに、この不変条件を人間が思い出さなければならない。
   * 🔑 だから**行数**で天井を張る:全件を 1 度ずつ読んだら必ず抜ける。
   *   正しく書けている限り天井には届かない(実費 0)。
   */
  const ceiling =
    Number(database.selectValue('SELECT count(*) FROM entries') ?? 0) + BACKFILL_CHUNK;
  let seen = 0;
  for (;;) {
    /**
     * ⚠ **本文を全件いっぺんに heap へ載せない**(不可侵指示 2026-07-27
     * 「ゼロコピー、生成とライフサイクル後の速やかな破棄」)── 20MB の容れ物で
     * boot の worker が 20MB 抱える形になる。**塊で回して都度捨てる**。
     * 🔑 対象は **NULL の行だけ**なので、進めば必ず尽きる(無限には回らない)。
     */
    const rows = database.selectObjects(
      `SELECT cid, lid, body FROM entries WHERE ${NEEDS_BACKFILL} LIMIT ${BACKFILL_CHUNK}`,
    ) as Array<{ cid: string; lid: string; body: string }>;
    if (rows.length === 0) return;
    for (const r of rows) {
      const body = r.body ?? '';
      database.exec({
        sql: `UPDATE entries SET task_total = ?, body_chars = ?, body_tags = ?
                WHERE cid = ? AND lid = ?`,
        bind: [
          countTaskCandidates(body).total,
          body.length,
          encodeTags(bodyTags(body)),
          r.cid,
          r.lid,
        ],
      });
    }
    seen += rows.length;
    // ⚠ **進んでいないなら抜ける** ── 「尽きる」を書込の成否に依存させない
    if (seen > ceiling) return;
    if (rows.length < BACKFILL_CHUNK) return;
  }
}

/**
 * 🔴 **export しているのは、migration を test から回すため**(#277 段②)。
 *
 * ⚠ ここは「**既に DB を持っている user**」だけが通る道なので、手元の
 *   新規 DB では**一度も走らない** ── つまり普通の test では
 *   「弱い」のではなく**そもそも実行されない**(CLAUDE.md §2)。
 * 🔑 だから `tests/adapter/schema-migration.test.ts` が、**旧い形の DB を自分で作って**
 *   ここへ通す。⚠ 呼ぶのは worker の init と、その test だけ。
 */
export function applySchema(database: Database): void {
  // schema 進化の seam(review #7): user_version を v1 から刻む。
  // 新しい DB(未来の user_version)は読み書きせず明示 reject ── 単調・明示 reject の
  // 規約(schema-migration-policy)を storage 層でも守る
  const userVersion = Number(database.selectValue('PRAGMA user_version') ?? 0);
  if (userVersion > DB_SCHEMA_VERSION) {
    throw new Error(
      `db user_version ${userVersion} is newer than supported ${DB_SCHEMA_VERSION}`,
    );
  }
  database.exec('PRAGMA foreign_keys = ON'); // tx 内では効かないので外に置く
  // 🔒 DDL → migration → 刻印を **1 tx に原子化**(review P5a F1)。非原子だと
  // クラッシュ窓で 2 型の恒久破損を作る(実験で実証済み):
  //   (d1) 表はあるが刻印なし(=0)→ 次回 open が migration を飛ばして
  //        最新版と刻印 → 列欠損のまま無音で恒久失敗
  //   (d2) ALTER 半端 + 旧版刻印 → 次回 open が duplicate column で毎回 throw
  database.exec('BEGIN IMMEDIATE');
  try {
    /**
     * 🔴 **後付け列は DDL より先に足す**(#277 段②。migration の test が実際に捕まえた)。
     *
     * ⚠ 順序を逆にすると、**既存 DB が開かなくなる**:
     *   `SCHEMA_DDL` には新しい列を使う索引
     *   (`CREATE INDEX … ON entries (cid, task_total)`)が入っているので、
     *   列を足す前に走ると `no such column` で **tx ごと落ちる** ── つまり
     *   **いま使っている user 全員のアプリが起動しなくなる**。
     * ⚠ 新規 DB には entries がまだ無いので、**表の実在を見てから** ALTER する
     *   (判定は user_version ではなく「あるべき状態の実在」── schema.ts の原則)。
     */
    const hasEntries =
      database.selectValue(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries'`,
      ) !== undefined;
    const addedEntryCols: string[] = [];
    if (hasEntries) {
      const entryCols = new Set(
        (
          database.selectObjects(
            `SELECT name FROM pragma_table_info('entries')`,
          ) as Array<{ name: string }>
        ).map((r) => r.name),
      );
      for (const col of ENTRY_ADDED_COLUMNS) {
        if (entryCols.has(col.name)) continue;
        database.exec(`ALTER TABLE entries ADD COLUMN ${col.name} ${col.ddl}`);
        addedEntryCols.push(col.name);
      }
    }
    /**
     * 🔴 **並べ替えただけで本文が索引に書き直される引き金を、作り直す**(#984)。
     *
     * ⚠ 直す前の `entries_fts_au` は `AFTER UPDATE ON entries` で**列の指定が無い**ので、
     *   `UPDATE entries SET entry_order = ?` でも発火し、**本文まるごと**を
     *   索引から消して入れ直していた(実測:本文 1,000KB で並べ替え 1 回 95.37ms)。
     *
     * 🔴 **`CREATE TRIGGER IF NOT EXISTS` は既存の引き金を書き換えない**ので、
     *   `schema.ts` の文面を直しただけでは**既に在る DB は古いまま**である
     *   ── だから**ここで落とす**(下の `SCHEMA_DDL` が新しい文面で作り直す)。
     *
     * 🔑 判定は user_version ではなく**いま在る引き金の字**(この file の原則)。
     *   ⚠ `sqlite_master` の `sql` は**作ったときの原文**がそのまま入っているので、
     *   `UPDATE OF` が入っているかで新旧が分かる。
     * ⚠ 引き金が無い DB(新規)では 1 行も返らない ── その回は何もしない。
     */
    const ftsAu = database.selectValue(
      `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'entries_fts_au'`,
    ) as string | undefined;
    if (typeof ftsAu === 'string' && !/UPDATE\s+OF/i.test(ftsAu)) {
      database.exec('DROP TRIGGER IF EXISTS entries_fts_au');
    }
    /**
     * 🔴 **全文検索の索引を、揃えた字を引く形へ移す**(台帳 #1852 の束 B2)。
     *
     * 旧い索引は `content='entries'`(書いた字をそのまま引く)。新しい索引は視点 `entries_fts_src`
     * (`coalesce(body_f, body)`)を内容表にする。**既存の索引は作り直すしかない**ので、旧い引き金と索引を落とし、
     * 「まだ 1 件も入れていない」(`built_upto = -1`)の印を置く。中身は起動の後に `foldStep` が塊で流す。
     * ⚠ 判定は user_version ではなく**いま在る索引の字**(この file の原則)。旧ビルドが索引を作り直した
     *   (旧い形に戻した)DB も、次の新ビルドの起動でここへ来る。
     * ⚠ 引き金は `entries` に付いているので、表を落としても残る ── 旧い文面のまま新しい索引に撃たないよう先に落とす
     *   (下の `SCHEMA_DDL` が新しい文面で作り直す)。
     */
    const ftsTable = database.selectValue(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entries_fts'`,
    ) as string | undefined;
    // 保存されている索引の形の版(行が無い = 1 = 書いた字をそのまま引く形)。⚠ settings の表が無い古い DB でも落とさない
    const storedForm =
      typeof ftsTable === 'string'
        ? (database.selectValue(`SELECT v FROM settings WHERE scope = ? AND k = ?`, [
            FTS_PROGRESS_SCOPE,
            FTS_FORM_KEY,
          ]) as string | undefined)
        : undefined;
    let migrationFailed = false;
    if (
      typeof ftsTable === 'string' &&
      (!ftsTable.includes(FTS_SOURCE_VIEW) || storedForm !== FTS_FORM_VERSION)
    ) {
      try {
        database.exec('DROP TABLE IF EXISTS entries_fts');
        database.exec({
          sql: `INSERT INTO settings(scope, k, v) VALUES (?, ?, '-1')
                  ON CONFLICT(scope, k) DO UPDATE SET v = excluded.v`,
          bind: [FTS_PROGRESS_SCOPE, FTS_PROGRESS_KEY],
        });
      } catch {
        migrationFailed = true; // 版を刻まない ── 刻むと二度と移行されない
        // ⚠ 影の表が壊れていて落とせない索引 ── ここで throw すると起動できない(2026-08-20 と同じ型)。
        //   索引は残し、下の `syncFtsIndex` の最後の手段(落として作り直す)に任せる。引き金は新しい文面に替える。
      }
      for (const t of ['entries_fts_ai', 'entries_fts_ad', 'entries_fts_au'])
        database.exec(`DROP TRIGGER IF EXISTS ${t}`);
    }
    // 新規 DB は最新 DDL がそのまま最新形を作る(既存 DB では no-op)。
    // ⚠ 索引はここで作られる ── 上で列を足した**後**であることが要。
    for (const ddl of SCHEMA_DDL) database.exec(ddl);
    // 索引の形の版を刻む(新しい DB も作り直した DB も、いまの形)。⚠ 移行に失敗した回は刻まない(次の起動でやり直す)
    if (!migrationFailed)
      database.exec({
      // ⚠ 同じ値なら書かない(開くたびに 1 行書き直さない)
      sql: `INSERT INTO settings(scope, k, v) VALUES (?, ?, ?)
              ON CONFLICT(scope, k) DO UPDATE SET v = excluded.v WHERE v IS NOT excluded.v`,
      bind: [FTS_PROGRESS_SCOPE, FTS_FORM_KEY, FTS_FORM_VERSION],
    });
    // v2(P5)migration: 判定は user_version ではなく**列の実在**(冪等)──
    // 上記 (d1)(d2) の半端状態も次回 open で自己修復する(schema.ts の原則)
    const revCols = new Set(
      (
        database.selectObjects(
          `SELECT name FROM pragma_table_info('revisions')`,
        ) as Array<{ name: string }>
      ).map((r) => r.name),
    );
    for (const col of REVISION_ADDED_COLUMNS) {
      if (!revCols.has(col))
        database.exec(`ALTER TABLE revisions ADD COLUMN ${col} TEXT`);
    }
    /**
     * 🔴 **足した列は、既存行を埋める**(#277 段②)。
     *
     * ⚠ ALTER は既存行を **NULL のまま**にするので、埋めないと
     *   **いま在るノートが 1 件もカンバンに出ない**まま緑になる ── 全文検索(#181)で
     *   索引を足したときに踏んだのと同じ型(§1「材料が届いていない」)。
     * ⚠ 判定は「**列をいま足したか**」で足りる ── ALTER も埋め戻しも刻印も
     *   **1 つの tx** に入っているので、「列は在るが埋まっていない」半端な状態は
     *   作れない(落ちれば ALTER ごと巻き戻る)。
     * ⚠ 「本文を LIKE で走査して埋め忘れを探す」形は**採らない** ── 毎回の open で
     *   全本文を読むことになり、絞るために列を足した意味が消える(#212 の穴)。
     * 🔑 本文は既に DB に在るので、**ここで数え直せる**(取り込み直しは要らない)。
     */
    /**
     * ⚠ 判定は「列をいま足したか」**ではなく**「**NULL の行が在るか**」──
     *   旧ビルドが書いた行(この列を知らない UPSERT)も NULL で残るので、
     *   次の open で拾える(schema.ts の原則「あるべき状態の実在」)。
     * 🔑 判定そのものは索引が効く(`idx_entries_task`)ので、本文は読まない。
     */
    /**
     * 🔴 **索引を整合させるのは、`entries` を書き換える「前」**(2026-08-20、起動不能)。
     *
     * ⚠ 直す前はこの下の埋め戻し(`backfillDerivedColumns`)より**後**に在った ──
     *   それが **user のアプリを起動不能にしていた**:
     *   ① #181 より前に作られた DB には `entries_fts` も trigger も**無い**
     *   ② この open で DDL が**空の索引**と trigger を作る
     *   ③ 直後の埋め戻しが全行を UPDATE → `entries_fts_au` が
     *      **空の索引に `'delete'`** を撃つ → FTS5 が
     *      `SQLITE_CORRUPT_VTAB(267) database disk image is malformed` を返す
     *   ④ tx ごと巻き戻るので DB は無傷のまま ── **毎回の起動で同じ所で落ちる**
     *   ⑤ しかも壊した結果、④ の前に居た `ftsCount === 0` の判定は
     *      **もう 0 ではない**ので、rebuild は永久に走らない(自分で自分の
     *      救済経路を塞いでいた)
     * 🔑 順序を入れ替えるだけで③が正当な delete/insert になる。
     *
     * ⚠ **判定を「空か」から「数が合うか」へ広げた** ── `=== 0` は
     *   「一部だけずれている索引」を**素通りさせる**(空振り §1)。
     *   外部内容(`content='entries'`)の索引は **1 entry = 1 doc** なので、
     *   数が合わないこと自体がずれの証拠である。
     * ⚠ 壊れた索引は `count(*)` **すら通らない**ので、読めないときも
     *   「合っていない」として扱う(= 組み直す)。
     */
    database.exec(`PRAGMA user_version = ${DB_SCHEMA_VERSION}`);
    database.exec('COMMIT');
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* rollback 失敗は元エラーを優先 */
    }
    throw err;
  }

  /**
   * 🔴 **「整える」段は、壊れていても起動を止めない**(#971 段③。2026-09-16)。
   *
   * ⚠ **直す前はここが上の tx の中に在り、壊れた DB では `init` ごと落ちていた** ──
   *   帰結は「**アプリが起動しない**」で、🔴 **その日に足した救出の口
   *   (調べる / 拾えるだけ取り出す)へ、いちばん必要な人が辿り着けない**。
   *   実測: PK の自動索引を潰した DB を食わせると、埋め戻しの `UPDATE` が rc 11 で
   *   落ち、`init` が断り文ごと reject していた(`storage-worker-corrupt.test.ts`)。
   *
   * 🔑 **段を分けるだけで解ける** ── 器を作る段(上)は落ちたら起動できないが、
   *   ここは**既にある行を整え直すだけ**なので、できなくても読み書き以外は動く。
   * ⚠ **握り潰すのは壊れの字だけ**(`looksCorrupt`)── それ以外を隠すと、
   *   普通の不具合が「静かに整わない」形で残る(いちばん気づけない)。
   * 🔑 握り潰したら**壊れの旗を立てる** ── 書き込みは止まり、読み出しと救出は通る。
   *   ⚠ 旗を立てずに素通りさせると、**壊れた DB へ書き続ける**ことになる。
   * ⚠ `user_version` は上で既に上げているが、埋め戻しの要否は
   *   **版ではなく「NULL の行が在るか」**で判定するので、次の起動でやり直せる。
   */
  try {
    database.exec('BEGIN IMMEDIATE');
    syncFtsIndex(database);
    if (
      database.selectValue(`SELECT 1 FROM entries WHERE ${NEEDS_BACKFILL} LIMIT 1`) !== undefined
    )
      backfillDerivedColumns(database);
    // 🔴 **タグの規則を直したら既存行も引き直す**(#550。上の注記)
    redriveBodyTags(database);
    database.exec('COMMIT');
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* rollback 失敗は元エラーを優先 */
    }
    if (!looksCorrupt(String(err))) throw err;
    dbCorrupt = true;
  }
}

/** 空白の違いを無視して比べるための正規形。 */
const normSql = (sql: unknown): string => String(sql ?? '').replace(/\s+/g, ' ').trim();

let ownTriggers: Map<string, string[]> | null = null;
let ownViews: Map<string, string> | null = null;

/**
 * 🔴 **客の画像に、PKC3 が作る引き金・ビュー以外が入っていないか**(#1416)。
 *
 * 基準は、新しい DB に `applySchema` が作る引き金・ビューの原文(空白を無視して等値)。それ以外は 1 つでもあれば断る。
 * ⚠ 旧い `entries_fts_au`(`UPDATE OF` が無い版)だけは、`applySchema` が最初に落とすので通す。
 * 🔴 台帳 #1852 の束 B2:**束 B2 より前のビルドが書き出した画像**は、全文検索の引き金が旧い文面(`LEGACY_FTS_DDL`)で入っている
 *   ── これも通す(`applySchema` が新しい形へ移す)。ビューは `entries_fts_src` だけ(原文が等しいとき)。
 */
function hasOnlyOwnTriggers(
  oo1: { DB: new (name: string) => Database },
  image: Database,
): boolean {
  if (ownTriggers === null || ownViews === null) {
    const fresh = new oo1.DB(':memory:');
    const legacy = new oo1.DB(':memory:');
    try {
      applySchema(fresh);
      const triggers = new Map<string, string[]>();
      for (const r of fresh.selectObjects(
        `SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'`,
      ) as unknown as Array<{ name: string; sql: string }>)
        triggers.set(r.name, [normSql(r.sql)]);
      // 旧い文面は、索引の引き金 3 本だけを最小の表に付けて採る(列の揃った表は要らない)
      legacy.exec('CREATE TABLE entries (title TEXT, body TEXT)');
      for (const ddl of LEGACY_FTS_DDL) legacy.exec(ddl);
      for (const r of legacy.selectObjects(
        `SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'`,
      ) as unknown as Array<{ name: string; sql: string }>)
        triggers.get(r.name)?.push(normSql(r.sql));
      ownViews = new Map(
        (
          fresh.selectObjects(
            `SELECT name, sql FROM sqlite_schema WHERE type = 'view'`,
          ) as unknown as Array<{ name: string; sql: string }>
        ).map((r) => [r.name, normSql(r.sql)]),
      );
      ownTriggers = triggers;
    } finally {
      fresh.close();
      legacy.close();
    }
  }
  const rows = image.selectObjects(
    `SELECT type, name, sql FROM sqlite_schema WHERE type IN ('trigger', 'view')`,
  ) as unknown as Array<{ type: string; name: string; sql: string }>;
  for (const r of rows) {
    if (r.type === 'view') {
      if (ownViews.get(r.name) === normSql(r.sql)) continue;
      return false;
    }
    const expected = ownTriggers.get(r.name);
    if (expected === undefined) return false;
    if (expected.includes(normSql(r.sql))) continue;
    if (r.name === 'entries_fts_au' && !/UPDATE\s+OF/i.test(r.sql)) continue;
    return false;
  }
  return true;
}

function need(): Database {
  if (!db) throw new Error('storage worker not initialized');
  return db;
}

/**
 * 🔴 **保存領域の太り具合を測る**(#999 段①)── `storageGauge` と `optimizeIndexes`
 * (前後の計器)が**同じ 1 本**を通る(判断を 2 か所に書かない)。読むだけ。
 *
 * ⚠ `PRAGMA` は `exportImage` が `page_count` を読む形に倣う(`selectValue`)。
 * ⚠ **索引の段数だけは「読めないかもしれない」** ── 索引の表が無い / 壊れていると
 *   `null` で返す(0 と嘘を言わない。⚠ 壊れた DB でも他の数は返す ── 壊れていても
 *   通す門に置いたので、ここで落とすと「測れない」しか返せなくなる)。
 * ⚠ `count(*) FROM entries_fts` は使わない(外部内容の表は内容表を数える。
 *   `entriesFtsRowCount` の註記)── 数えるのは影の表 `entries_fts_idx` の `segid`。
 */
function measureGauge(database: Database): StorageGauge {
  const started = Date.now();
  const num = (sql: string): number => {
    const v = database.selectValue(sql);
    return typeof v === 'number' ? v : Number(v ?? 0);
  };
  const pageCount = num('PRAGMA page_count');
  const pageSize = num('PRAGMA page_size');
  const freelistCount = num('PRAGMA freelist_count');
  let ftsSegments: number | null = null;
  try {
    ftsSegments = num('SELECT count(DISTINCT segid) FROM entries_fts_idx');
  } catch {
    /* 索引の表が無い / 読めない = null(下限を 0 と読ませない) */
  }
  return {
    pageCount,
    pageSize,
    freelistCount,
    fileBytes: pageCount * pageSize,
    freeBytes: freelistCount * pageSize,
    ftsSegments,
    journalMode: String(database.selectValue('PRAGMA journal_mode')),
    tempStore: num('PRAGMA temp_store'),
    synchronous: num('PRAGMA synchronous'),
    elapsedMs: Date.now() - started,
  };
}

/**
 * 集計(#184)が 1 度に手元へ載せる行数。
 *
 * 🔴 **全行を一度に materialize しない**(レビュー B-3)。`selectObjects` は結果を
 * まるごと配列にするので、本文の長い container では一時ピークが跳ねる ──
 * この file 冒頭のメモリ 2 原則(**大きな値は保持しない**)と、2026-07-27 の
 * 不可侵指示(ゼロコピー / 生成物の即破棄)から外れる。
 * ⚠ カーソルは `listBodies` と**同じ複合キー**(`entry_order` + `lid`)── `entry_order`
 * 単独では境界の順序値を共有する行が飛ぶ(UNIQUE ではない)。
 */
const QUERY_SCAN_CHUNK = 500;

/**
 * 集計を 1 回の走査で作る(#184)。
 *
 * 🔴 **走査は 1 回だけ**(レビュー B-3 で直した)── 1 稿目は目録と表で別々の op に
 * していたため、面を開くたびに全件走査が **2 回**走っていた。
 * ⚠ 読むのは**本文の先頭だけ**。窓の大きさは features 側が cap から導く
 * (`FRONTMATTER_SCAN_CHARS` ── 直書きすると囲みのぶんだけ足りなくなる)。
 */
function runQueryScan(cid: string, key: string | null): {
  keys: unknown;
  groups: unknown;
} {
  const database = need();
  const scan = createQueryScan(key);
  let after: { entryOrder: number; lid: string } | undefined;
  for (;;) {
    /**
     * 🔴 **集計は system 領域のノートを数えない**(設計 doc §1.1、段①)。
     * ⚠ 判定は `USER_REALM_SQL` 1 か所を通す。
     */
    const rows = database.selectObjects(
      after === undefined
        ? `SELECT lid, entry_order, substr(body, 1, ?) AS head, body_tags FROM entries
             WHERE cid = ? AND ${USER_REALM_SQL}
             ORDER BY entry_order, lid LIMIT ?`
        : `SELECT lid, entry_order, substr(body, 1, ?) AS head, body_tags FROM entries
            WHERE cid = ? AND ${USER_REALM_SQL} AND (entry_order > ? OR (entry_order = ? AND lid > ?))
            ORDER BY entry_order, lid LIMIT ?`,
      after === undefined
        ? [FRONTMATTER_SCAN_CHARS, cid, QUERY_SCAN_CHUNK]
        : [FRONTMATTER_SCAN_CHARS, cid, after.entryOrder, after.entryOrder, after.lid, QUERY_SCAN_CHUNK],
    ) as unknown as Array<{
      lid: string;
      entry_order: number;
      head: string | null;
      body_tags?: string | null;
    }>;
    if (rows.length === 0) break;
    scan.feed(
      rows.map((r) => ({
        lid: r.lid,
        head: r.head ?? '',
        /**
         * 🔴 **NULL を `[]` に潰さない**(#550 段④)── 走査(`runSmartScan`)と
         *   **同じ綴り**にする。`null` は「まだ集約していない」で、
         *   「タグが 1 つも無い」とは別である。
         */
        bodyTags: r.body_tags === null || r.body_tags === undefined ? null : decodeTags(r.body_tags),
      })),
    );
    const last = rows[rows.length - 1]!;
    after = { entryOrder: last.entry_order, lid: last.lid };
    if (rows.length < QUERY_SCAN_CHUNK) break;
  }
  return scan.finish();
}

/**
 * 🔴 **スマートフォルダの中身を 1 回の走査で集める**(#421 段①)。
 *
 * ⚠ **集計(`runQueryScan`)と同じ型**である ── 読むのは本文の**先頭だけ**、
 *   窓は features 側が cap から導く(`FRONTMATTER_SCAN_CHARS`)。
 * ⚠ **当て方はここに書かない** ── AND / 大小無視 / 上限 / 自分を除く の規則は
 *   `features/smart/smart-spec.ts` が 1 か所で持つ(worker は流すだけ)。
 */
/**
 * 🔴 **スマートフォルダの走査**(#421)。
 *
 * 🔑 **列で絞ってから、タグの分だけ本文の先頭を舐める**(段②)──
 *   種類 / 更新 / 作成 / 日付は **entries の列**に在るので、SQL が先に落とす。
 *   ⚠ 走査の口は**この 1 本のまま**(集計と同じ型 ── §7)。
 *
 * ⚠ **条件どうしは重ならない** ── 列の 4 つは SQL が、タグは
 *   `matchesSmartTags` が答える。だから「同じ問いに 2 か所が答える」形にはならない。
 * ⚠ **境目の時刻は受け取る**(`updatedFrom` / `createdFrom`)── ここで
 *   `Date.now()` を読むと、走らせるたびに答えが変わって test が書けない。
 */
function runSmartScan(
  cid: string,
  lid: string,
  q: {
    tags: readonly string[];
    kind: string | null;
    updatedFrom: string | null;
    createdFrom: string | null;
    dated: boolean | null;
    text: string | null;
    tasks: boolean | null;
    openTasks: boolean | null;
  },
): { lids: string[]; total: number } {
  const database = need();
  const scan = createSmartScan(
    {
      tags: q.tags,
      /**
       * ⚠ **列の条件は「在る」ことだけ伝える** ── 当てるのは SQL なので、
       *   ここへ実際の値を渡す必要は無い。`isSmartEmpty` が
       *   「条件が 1 つも無い」を正しく答えられるようにするために渡す。
       */
      kind: q.kind,
      updatedDays: q.updatedFrom === null ? null : 1,
      createdDays: q.createdFrom === null ? null : 1,
      dated: q.dated,
      text: q.text,
      /**
       * ⚠ **チェック項目だけは「在る」ではなく実際の値を渡す**(#421 段④)──
       *   ここは SQL では当てられない(`task_total` は多め)ので、
       *   `createSmartScan` が**本文を読んで確定する**。値が要る。
       */
      tasks: q.tasks,
      openTasks: q.openTasks,
    },
    lid,
  );
  /**
   * 列の条件 ── SQL の `AND …` と、その値。
   * 🔴 **`USER_REALM_SQL` を必ず先頭に置く**(設計 doc §1.1、段①)── スマートフォルダは
   *   system 領域のノートを当てない。他の条件が 1 つも無くても `conds` が
   *   空にならないので、下の `where` 組み立て(`conds.length === 0 ? '' : …`)が
   *   必ずこの断片を含む。
   */
  const conds: string[] = [USER_REALM_SQL];
  const args: (string | number)[] = [];
  if (q.kind !== null) {
    conds.push('archetype = ?');
    args.push(q.kind);
  }
  /**
   * ⚠ **`IS NOT NULL` を足さない** ── SQL の比較は三値論理なので、
   *   `NULL >= ?` は真にならない。⚠ 足すと「これが無いと NULL が当たる」と
   *   読める**消しても同じ行**が残り、変異試験で殺せなくなる。
   *   🔑 時刻を持たない行(旧ビルド / 取り込みが作った行)は、この比較だけで落ちる。
   */
  if (q.updatedFrom !== null) {
    conds.push('datetime(updated_at) >= datetime(?)');
    args.push(q.updatedFrom);
  }
  if (q.createdFrom !== null) {
    conds.push('datetime(created_at) >= datetime(?)');
    args.push(q.createdFrom);
  }
  if (q.dated !== null) conds.push(q.dated ? 'date IS NOT NULL' : 'date IS NULL');
  /**
   * 🔴 **チェック項目は「候補へ縮める」だけ**(#421 段④)── 確定は本文を読む側。
   *
   * 🔑 **縮め方はカンバンと同じ 1 か所**(`TASK_CANDIDATE_COND`)── ⚠ 書き写さない。
   *   写した 1 稿目は **NULL の行を外す変異が生き延びた**(変異試験 N11)──
   *   worker の test には NULL の行を作る道が無いからである(§2「弱いのではなく
   *   走っていない」)。⚠ **NULL = まだ数えていない行**を外すと、旧ビルドが作った
   *   ノートが**永久に集まらない**。共有にすれば
   *   `tests/adapter/schema-migration.test.ts`(実 DB に NULL の行を直に挿す)が
   *   この綴りを守る。
   * ⚠ **`tasks: false`(項目が無い)では縮められない** ── `task_total` は多めなので
   *   「> 0」でも実際は 0 件でありうる。縮めると**当たるはずのノートが落ちる**ので、
   *   その向きでは**全件を本文で確かめる**(正しさを速さと交換しない)。
   * ⚠ `openTasks` も同じ ── 未処理が在る側だけ候補で縮められる。
   */
  const taskNarrow = q.tasks === true || q.openTasks === true;
  if (taskNarrow) conds.push(TASK_CANDIDATE_COND);
  /**
   * 🔴 **語で絞る**(#421 段③)── 引き方は **`planSearch` 1 か所**である
   *   (3 文字以上は FTS5 の trigram、2 文字以下は LIKE)。
   *
   * 🔑 **探す欄と同じ規則を通す**(§7)── ここに独自の当て方を書くと、
   *   同じ語で「探した結果」と「集まった結果」が違う、が静かに起きる。
   * ⚠ `entries_fts` は **external content**(`content='entries'`)なので、
   *   `rowid` は `entries` の rowid とそのまま対応する ── join を書かずに
   *   `rowid IN (…)` で足りる。
   * ⚠ `plan.kind === 'none'`(空)は `readSmartSpec` が既に `null` に落としている
   *   ので、ここへは来ない ── 来ても条件を足さないだけで、当たりが広がるだけである。
   */
  if (q.text !== null) {
    const plan = searchPlanOf(q.text, 'plain');
    if (plan.kind === 'fts') {
      conds.push('rowid IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)');
      args.push(plan.match);
    } else if (plan.kind === 'like' || plan.kind === 'like-terms') {
      // ⚠ **`ESCAPE` を宣言する**(`searchEntries` と同じ ── `%` `_` を素で通さない)。空白で区切った語は全部(依頼 194)
      conds.push(...likeWhere(plan, args as (string | number)[], false));
    }
  }
  const where = conds.length === 0 ? '' : ` AND ${conds.join(' AND ')}`;
  /**
   * 🔴 **本文を丸ごと読むかは、走査の側が決める**(#421 段④)。
   *
   * ⚠ ここで「チェック項目の条件が在るなら丸ごと」と自前で判断しない ──
   *   条件を 1 つ足したときに**片方だけ直し忘れる**(§7)。
   * 🔑 **塊の大きさも一緒に変える** ── 丸ごと読むと heap に載る量が桁で違うので、
   *   カンバンと同じ 100 件ずつにする(`TASK_SCAN_CHUNK`)。先頭だけなら 500 件。
   * ⚠ **この行と上の候補で縮める行は「正しさ」を守っていない ── 費用の門である**
   *   (2026-08-26、変異試験 N9 / N10 が SURVIVED で教えた)。どちらを外しても
   *   **答えは 1 バイトも変わらない**(確定は本文を読む側が全部やる)── 変わるのは
   *   **読む量**だけである。🔑 **だから変異試験では生き延びるのが正しい。**
   *   守っている test は無い(CLAUDE.md「これが無いと壊れる、と書く前に外して
   *   壊れるのを見る」── 外しても壊れなかったので、そう書いてある)。
   */
  const full = scan.needsFullBody;
  const chunk = full ? TASK_SCAN_CHUNK : QUERY_SCAN_CHUNK;
  /**
   * 🔴 **集約したタグは、丸ごと読むかに関係なく必ず引く**(#550 段②)。
   *
   * ⚠ 「丸ごと読むときは本文から数え直せばよい」と書きたくなるが、**書かない** ──
   *   同じ問いに答える口が 2 つになり、片方だけ規則が古くなる(§7)。
   *   当たり判定の入口は `tagsForMatch` **1 本**である。
   */
  // ⚠ 先頭だけのときは `substr` に文字数を渡すので、束縛の数が 1 つ増える
  const col = full ? 'body, body_tags' : 'substr(body, 1, ?) AS head, body_tags';
  const head = full ? [] : [FRONTMATTER_SCAN_CHARS];
  let after: { entryOrder: number; lid: string } | undefined;
  for (;;) {
    const rows = database.selectObjects(
      after === undefined
        ? `SELECT lid, entry_order, ${col} FROM entries
             WHERE cid = ?${where}
             ORDER BY entry_order, lid LIMIT ?`
        : `SELECT lid, entry_order, ${col} FROM entries
            WHERE cid = ? AND (entry_order > ? OR (entry_order = ? AND lid > ?))${where}
            ORDER BY entry_order, lid LIMIT ?`,
      after === undefined
        ? [...head, cid, ...args, chunk]
        : [...head, cid, after.entryOrder, after.entryOrder, after.lid, ...args, chunk],
    ) as unknown as Array<{
      lid: string;
      entry_order: number;
      head?: string | null;
      body?: string | null;
      body_tags?: string | null;
    }>;
    if (rows.length === 0) break;
    // ⚠ 塊ごとに捨てる ── 候補が 5000 件あっても heap に載るのは 1 塊ぶん
    scan.feed(
      rows.map((r) => ({
        lid: r.lid,
        body: (full ? r.body : r.head) ?? '',
        /**
         * ⚠ **NULL を `[]` に潰さない** ── `tagsForMatch` の契約が
         *   「まだ集約していない(`null`)」を受け取る形だからである。
         * 🔑 **ただし、いまは出る答えが同じ**(どちらも文書タグだけで当てる)──
         *   だから**ここを潰す変異は生き延びるのが正しい**。守っているのは
         *   意味であって答えではない(CLAUDE.md「これが無いと壊れると書く前に、
         *   外して壊れるのを見る」── 外しても壊れなかったので、そう書いてある)。
         * 🔴 **「まだ集約していない」を実際に拾うのは SQL のほう**である
         *   (`NEEDS_BACKFILL` の `body_tags IS NULL`)── そちらを潰すと、
         *   旧ビルドが書いた行が**永久に埋まらない**。
         */
        bodyTags:
          r.body_tags === null || r.body_tags === undefined
            ? null
            : decodeTags(r.body_tags),
      })),
    );
    const last = rows[rows.length - 1]!;
    after = { entryOrder: last.entry_order, lid: last.lid };
    if (rows.length < chunk) break;
  }
  const out = scan.finish();
  return { lids: [...out.lids], total: out.total };
}

/**
 * 🔴 **候補の条件は 1 か所**(#277 段②。CLAUDE.md §7)。
 *
 * 🔴 **NULL も候補に入れる**(= まだ数えていない行)。⚠ 版を上げていないので
 * **旧ビルドも同じ DB に書く**が、旧ビルドの UPSERT はこの列を知らないので、
 * 新しく作った行が NULL で残る。NULL を外すと、その行は**カンバンから永久に
 * 消える**(取りこぼし)。🔑 多めに拾うのは無害 ── 本文を読んで項目 0 件と
 * 分かるだけである。
 *
 * ⚠ **残っている限界**(2026-08-19 の実地調査で実測):旧ビルドが**既にある行を
 * 書き換えた**ときは、その UPSERT が列を挙げないので値が**据え置かれる**
 * (NULL には戻らない)。チェックが 0 件だったノートに旧ビルドでチェックを
 * 足すと、列は 0 のままなので**その回はカンバンに出ない**。⚠ 壊れではなく遅れ
 * ── 新ビルドで 1 度保存すれば直る(`bindUpsert` が本文から数え直す)。
 * 🔑 直すには「どの本文について数えたか」の印(`updated_at` との突き合わせ)が
 * 要るが、列がもう 1 本増えるので**いまは採らない**。
 *
 * ⚠ **export しているのは test のため**(2026-08-19 の変異試験 M2)。この節を
 *   `task_total > 0` に縮める変異が**生き延びた** ── 保存の口は必ず本文から
 *   数えるので、worker の test から NULL の行を作る道が無い(§2「弱いのでは
 *   なく走っていない」)。`tests/adapter/schema-migration.test.ts` が
 *   **実 DB に NULL の行を直に挿して**この節を当てる。
 */
export const TASK_CANDIDATE_COND = '(task_total IS NULL OR task_total > 0)';

/**
 * 🔴 **かんばん・カレンダーは system 領域のノートを出さない**(設計 doc §1.1、段①)。
 * ⚠ 判定は `USER_REALM_SQL` 1 か所を通す(CLAUDE.md §7 ── 書き写さない)。
 */
export const TASK_CANDIDATE_WHERE = `cid = ? AND ${USER_REALM_SQL} AND ${TASK_CANDIDATE_COND}`;

/**
 * 走査で 1 度に読むノートの数。⚠ **本文を丸ごと**読むので、先頭だけ読む
 * `QUERY_SCAN_CHUNK`(500)より小さくする ── 一度に heap へ載る量が桁で違う。
 */
const TASK_SCAN_CHUNK = 100;

/**
 * 走査で 1 度に読むノートの数(連絡先)。⚠ **frontmatter しか要らない**が、
 * `entries.body` は本文を丸ごと持つので、読む量は予定と同じ ── だから同じ塊にする。
 */
const CONTACT_SCAN_CHUNK = 100;

/** 計った時間の走査で 1 度に読むノートの数。⚠ 本文を丸ごと読むので予定・連絡先と同じ塊にする。 */
const WORK_LOG_SCAN_CHUNK = 100;
/** 🔑 候補を絞る `LIKE` の型。⚠ SQL の字に日本語を混ぜない(画面の字の検査に SQL の `lid` / `entry` が当たる)ので束縛で渡す。 */
const WORK_LOG_LIKE = '%作業 %';

/**
 * 🔴 **計った時間を集める**(#683 ①)── 本文の `- 作業 2026-08-27 06:40–07:03(23:11)` の行。
 *
 * 🔑 `runContactScan` と**同じ形**(塊で読み、塊ごとに捨て、切ったら `truncated`)。
 * 🔑 候補は `LIKE '%作業 %'` で絞る ── 該当しない本文は JS へ運ばない(読むのは sqlite の中だけ)。
 * 🔴 本文は worker から出さない ── 返るのは行(`WorkRun`)だけ(不可侵指示 2026-07-27「速やかな破棄」)。
 */
function runWorkLogScan(cid: string): WorkLogScan {
  const database = need();
  const totalNotes = Number(
    database.selectValue(`SELECT count(*) FROM entries WHERE cid = ? AND ${USER_REALM_SQL}`, [cid]) ?? 0,
  );
  const runs: WorkRun[] = [];
  let scannedNotes = 0;
  let truncated = false;
  let stop = false;
  let after: { entryOrder: number; lid: string } | undefined;
  while (!stop) {
    const rows = database.selectObjects(
      after === undefined
        ? `SELECT lid, entry_order, body FROM entries
             WHERE cid = ? AND ${USER_REALM_SQL} AND body LIKE ?
             ORDER BY entry_order, lid LIMIT ?`
        : `SELECT lid, entry_order, body FROM entries
             WHERE cid = ? AND ${USER_REALM_SQL} AND body LIKE ?
             AND (entry_order > ? OR (entry_order = ? AND lid > ?))
            ORDER BY entry_order, lid LIMIT ?`,
      after === undefined
        ? [cid, WORK_LOG_LIKE, WORK_LOG_SCAN_CHUNK]
        : [cid, WORK_LOG_LIKE, after.entryOrder, after.entryOrder, after.lid, WORK_LOG_SCAN_CHUNK],
    ) as unknown as Array<{ lid: string; entry_order: number; body: string | null }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      // ⚠ 切ったら必ず `truncated` ── 黙って切ると user は「無い」と読む
      if (scannedNotes >= WORK_LOG_LIMITS.notes || runs.length >= WORK_LOG_LIMITS.runs) {
        truncated = true;
        stop = true;
        break;
      }
      scannedNotes += 1;
      for (const r of workRunsOf(row.lid, row.body ?? '')) {
        if (runs.length >= WORK_LOG_LIMITS.runs) {
          truncated = true;
          stop = true;
          break;
        }
        runs.push(r);
      }
      after = { entryOrder: row.entry_order, lid: row.lid };
    }
    if (rows.length < WORK_LOG_SCAN_CHUNK) break;
  }
  return { runs, totalNotes, scannedNotes, truncated };
}

/**
 * 🔴 **連絡先を集める**(#278 段①)。
 *
 * 🔑 **予定(`runTaskScan`)と同じ形**にしてある ── 塊で読み、塊ごとに捨て、
 *   切ったら `truncated` を返す。⚠ 新しい走査の作法を作らない(§7)。
 * 🔑 **本文は worker から出さない** ── 返るのは連絡の手段だけである
 *   (不可侵指示 2026-07-27「速やかな破棄」)。
 * ⚠ **候補を列で絞れない** ── 「`tel:` を持つ」は抽出列に無いので、
 *   予定のような `WHERE` が書けず、**本文を読むまで分からない**。
 *   だから絞りは `contactOf` が返す `null` で行う(読む量は減らない)。
 *   🔑 その代わり、この走査は**タブを開いた人にだけ**走る(呼び側の規律)。
 */
function runContactScan(cid: string): ContactScan {
  const database = need();
  /**
   * ⚠ **ゴミ箱を除く条件は要らない** ── PKC3 のゴミ箱は
   *   「**`entries` に居ない `entry_lid` の最新 revision**」というビューであって、
   *   列ではない(`listTrash` の docstring)。捨てた時点で `entries` から消える。
   * ⚠ 1 稿目は `trashed_at IS NULL` と書いており(**そんな列は無い**)、
   *   worker の test が `no such column` で落として教えた。
   */
  /**
   * 🔴 **連絡先は system 領域のノートを数えない**(設計 doc §1.1、段①)。
   * ⚠ 判定は `USER_REALM_SQL` 1 か所を通す。
   */
  const totalNotes = Number(
    database.selectValue(`SELECT count(*) FROM entries WHERE cid = ? AND ${USER_REALM_SQL}`, [
      cid,
    ]) ?? 0,
  );
  const cards: ContactCard[] = [];
  let scannedNotes = 0;
  let truncated = false;
  let stop = false;
  let after: { entryOrder: number; lid: string } | undefined;
  while (!stop) {
    const rows = database.selectObjects(
      after === undefined
        ? `SELECT lid, title, entry_order, body FROM entries
             WHERE cid = ? AND ${USER_REALM_SQL}
             ORDER BY entry_order, lid LIMIT ?`
        : `SELECT lid, title, entry_order, body FROM entries
             WHERE cid = ? AND ${USER_REALM_SQL}
             AND (entry_order > ? OR (entry_order = ? AND lid > ?))
            ORDER BY entry_order, lid LIMIT ?`,
      after === undefined
        ? [cid, CONTACT_SCAN_CHUNK]
        : [cid, after.entryOrder, after.entryOrder, after.lid, CONTACT_SCAN_CHUNK],
    ) as unknown as Array<{
      lid: string;
      title: string | null;
      entry_order: number;
      body: string | null;
    }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      // ⚠ **切ったら必ず `truncated`** ── 黙って切ると user は「無い」と読む
      if (scannedNotes >= CONTACT_LIMITS.notes || cards.length >= CONTACT_LIMITS.cards) {
        truncated = true;
        stop = true;
        break;
      }
      scannedNotes += 1;
      const card = contactOf(row.lid, row.title ?? '', row.body ?? '');
      if (card !== null) cards.push(card);
      after = { entryOrder: row.entry_order, lid: row.lid };
    }
    if (rows.length < CONTACT_SCAN_CHUNK) break;
  }
  return { cards, totalNotes, scannedNotes, truncated };
}

/**
 * 🔴 **カンバンの札を集める**(#277 段②-b)。
 *
 * 🔑 **本文は worker から出さない** ── 舐めるのはここで、返すのは項目だけ
 * (#184 の全文走査と同じ型。不可侵指示 2026-07-27「速やかな破棄」)。
 * ⚠ 塊で読み、塊ごとに捨てる ── 候補が 5000 件あっても、heap に載るのは
 * 100 件ぶんの本文である。
 */
function runTaskScan(cid: string): TaskScan {
  const database = need();
  const totalNotes = Number(
    database.selectValue(`SELECT count(*) FROM entries WHERE ${TASK_CANDIDATE_WHERE}`, [cid]) ?? 0,
  );
  const cards: TaskCard[] = [];
  /**
   * 🔴 **日付を持つ札と持たない札を別々に数える**(2026-08-23)。
   * ⚠ 1 本の上限だと、体裁のチェックリストが並んだノートが 1 件在るだけで
   *   **予定が 1 つも入らなくなる**(要る物が要らない物に押し出される)。
   */
  let dated = 0;
  let undated = 0;
  let scannedNotes = 0;
  let truncated = false;
  let stop = false;
  let after: { entryOrder: number; lid: string } | undefined;
  while (!stop) {
    const rows = database.selectObjects(
      after === undefined
        ? `SELECT lid, entry_order, body FROM entries WHERE ${TASK_CANDIDATE_WHERE}
             ORDER BY entry_order, lid LIMIT ?`
        : `SELECT lid, entry_order, body FROM entries WHERE ${TASK_CANDIDATE_WHERE}
             AND (entry_order > ? OR (entry_order = ? AND lid > ?))
            ORDER BY entry_order, lid LIMIT ?`,
      after === undefined
        ? [cid, TASK_SCAN_CHUNK]
        : [cid, after.entryOrder, after.entryOrder, after.lid, TASK_SCAN_CHUNK],
    ) as unknown as Array<{ lid: string; entry_order: number; body: string | null }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      // ⚠ **切ったら必ず `truncated`** ── 黙って切ると user は「無い」と読む
      if (scannedNotes >= TASK_LIMITS.notes) {
        truncated = true;
        stop = true;
        break;
      }
      scannedNotes += 1;
      // 🔑 「行 → 札」は `taskCardsOf` 1 本(CLAUDE.md §7)── ここで組み直さない
      for (const card of taskCardsOf(row.lid, row.body ?? '')) {
        const full =
          card.date === null ? undated >= TASK_LIMITS.undated : dated >= TASK_LIMITS.items;
        // ⚠ 片方が埋まっても**もう片方は拾い続ける** ── `break` にすると、
        //    先に埋まったほうが、まだ空いているほうを道連れにする
        if (full) {
          truncated = true;
          continue;
        }
        if (card.date === null) undated += 1;
        else dated += 1;
        cards.push(card);
      }
      // ⚠ 両方埋まったらこのノートで打ち切る(以降を読んでも 1 枚も入らない)
      if (dated >= TASK_LIMITS.items && undated >= TASK_LIMITS.undated) {
        stop = true;
        break;
      }
    }
    const last = rows[rows.length - 1]!;
    after = { entryOrder: last.entry_order, lid: last.lid };
    if (rows.length < TASK_SCAN_CHUNK) break;
  }
  const times = scanNoteTimes(database, cid);
  // 🔴 時刻の読みが上限で切れたことも黙らない(`truncated` は行の予定の切れと同じ口で言う)
  return { cards, totalNotes, scannedNotes, truncated: truncated || times.truncated, noteTimes: times.times };
}

/** 前書きだけが要るので、本文の頭だけ読む。窓は前書きの上限(cap)から導いた `FRONTMATTER_SCAN_CHARS`(直書きしない)。 */
const NOTE_TIME_HEAD_CHARS = FRONTMATTER_SCAN_CHARS;

/**
 * 🔴 **時刻つきのノート 1 件の予定を集める**(台帳 #1852 / 依頼 192 / 284)。
 *
 * 抽出列(`date`)には日付だけが入っている ── 時刻は本文の前書きから読む(保存の形は変えない)。
 * ⚠ 日付を持つノートだけ・本文の頭だけを塊で読み、塊ごとに捨てる(`runTaskScan` と同じ作法)。読む口は `noteTimeOf` 1 本。
 */
function scanNoteTimes(
  database: ReturnType<typeof need>,
  cid: string,
): { times: NoteTime[]; truncated: boolean } {
  const out: NoteTime[] = [];
  let after: { entryOrder: number; lid: string } | undefined;
  for (;;) {
    const rows = database.selectObjects(
      after === undefined
        ? `SELECT lid, entry_order, substr(body, 1, ${NOTE_TIME_HEAD_CHARS}) AS head FROM entries
            WHERE cid = ? AND ${USER_REALM_SQL} AND date IS NOT NULL
            ORDER BY entry_order, lid LIMIT ?`
        : `SELECT lid, entry_order, substr(body, 1, ${NOTE_TIME_HEAD_CHARS}) AS head FROM entries
            WHERE cid = ? AND ${USER_REALM_SQL} AND date IS NOT NULL
              AND (entry_order > ? OR (entry_order = ? AND lid > ?))
            ORDER BY entry_order, lid LIMIT ?`,
      after === undefined
        ? [cid, TASK_SCAN_CHUNK * 5]
        : [cid, after.entryOrder, after.entryOrder, after.lid, TASK_SCAN_CHUNK * 5],
    ) as unknown as Array<{ lid: string; entry_order: number; head: string | null }>;
    if (rows.length === 0) break;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const nt = noteTimeOf(row.lid, row.head ?? '');
      if (nt !== null) out.push(nt);
      // ⚠ 上限に着いた。後ろに読んでいない行(この塊の残り / 次の塊)が在るときだけ「切った」(ちょうど収まったなら切っていない)
      if (out.length >= NOTE_TIME_LIMIT)
        return { times: out, truncated: i < rows.length - 1 || rows.length >= TASK_SCAN_CHUNK * 5 };
    }
    const last = rows[rows.length - 1]!;
    after = { entryOrder: last.entry_order, lid: last.lid };
    if (rows.length < TASK_SCAN_CHUNK * 5) break;
  }
  return { times: out, truncated: false };
}

/**
 * 🔴 **雛形を集める**(#196 / B-2 段②)。
 *
 * ⚠ `runTaskScan` と**同じ形**にしてある(CLAUDE.md §7)── 違うのは
 *   「どれを候補にするか」だけで、走査の作法(上限 / 切ったら言う)は共通である。
 *
 * 🔑 **本文ごと運ぶ**のは、`Tab` を押してから字が出るまでに往復を挟まないため。
 * ⚠ 「全件の本文を主スレッドへ運ばない」(不可侵指示 2026-07-27)とは別物である:
 *   運ぶのは **user が雛形として作ったものだけ**で、`SNIPPET_LIMITS` で上限が付く。
 * ⚠ 候補は `archetype` で絞るので、**本文を読むのは雛形だけ**である
 *   (普通のノートは 1 バイトも読まない)。
 */
function runSnippetScan(cid: string): SnippetScan {
  const database = need();
  const total = Number(
    database.selectValue('SELECT count(*) FROM entries WHERE cid = ? AND archetype = ?', [
      cid,
      SNIPPET_ARCHETYPE,
    ]) ?? 0,
  );
  const rows = database.selectObjects(
    `SELECT lid, title, body FROM entries WHERE cid = ? AND archetype = ?
       ORDER BY entry_order, lid LIMIT ?`,
    [cid, SNIPPET_ARCHETYPE, SNIPPET_LIMITS.notes],
  ) as unknown as Array<{ lid: string; title: string; body: string | null }>;
  const items: SnippetItem[] = [];
  const skipped: SnippetSkipped[] = [];
  for (const row of rows) {
    // 🔑 「本文 → 表の 1 行」は `snippetItemOf` 1 本(§7)── ここで組み直さない
    const item = snippetItemOf(row.lid, row.title, row.body ?? '');
    if (item !== null) items.push(item);
    else {
      // 🔴 載せられなかった物は名前と理由を控える(#1645 項 5)── 理由の規則は `snippetSkipReason` 1 本
      const reason = snippetSkipReason(row.body ?? '');
      if (reason !== null && skipped.length < SNIPPET_SKIPPED_NAMES) skipped.push({ title: row.title, reason });
    }
  }
  const abbrUnread = items.filter((i) => i.abbrUnread === true).length;
  // ⚠ **切ったら必ず言う** ── 黙って切ると user は「無い」と読む。
  //   ⚠ 上限で切った分だけを数える(長すぎて載らなかった雛形は別の理由なので、
  //     ここでは `truncated` にしない ── 画面には「載らなかった」と別に出す)
  return {
    items,
    total,
    truncated: total > SNIPPET_LIMITS.notes,
    ...(abbrUnread > 0 ? { abbrUnread } : {}),
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}

/**
 * op → handler の typed dispatch(review #6): 返り値型を ResultMap に pin する。
 * ⚠ 現状 init 以外は同期実装で、message 間の interleave は起きない。handler を
 * async 化するときは client 側の直列化とセットで行うこと(review #5、p2 log に pin)。
 */
type Handlers = {
  [Op in StorageRequest['op']]: (
    req: RequestFor<Op>,
  ) => ResultMap[Op] | Promise<ResultMap[Op]>;
};

/**
 * 進み具合の見張りを呼ぶ間隔(VDBE の歩数)。⚠ 細かすぎると見張り自体が重くなる。
 * 🔑 1000 は sqlite の例と同じ桁(実測で直積を 3ms で止められた)。
 */
const PROGRESS_EVERY = 1000;

/** `sqlite3_limit` の id(`SQLITE_LIMIT_LENGTH`)。 */
const SQLITE_LIMIT_LENGTH = 0;

/**
 * 🔴 **SQL の答えとして運ぶ字の合計の天井**(升の数ぶん数える)── 常駐 worker の heap を守る。
 * 🔑 2,000 万字 = JS の文字列で約 40 MB(`postMessage` の複製を含めても 100 MB 台)。
 *   通常の表(8 列 × 20 万行 × 平均 10 字 ≒ 1,600 万)は収まり、長い字の表(2,000 字の升)は
 *   1 万行で切れる。⚠ 切ったら `truncated` を返す(画面は「多すぎるので途中まで」と言う)。
 */
const SQL_MAX_TOTAL_CHARS = 20_000_000;

/** 1 つの値の大きさの天井(バイト)。`sqlite3_limit(SQLITE_LIMIT_LENGTH)` で engine に掛ける。 */
const SQL_MAX_VALUE_BYTES = 16 * 1024 * 1024;

// 🔴 1 つの升に運ぶ字数の上限は `@features/query/sql-cell`(DuckDB の答えと**同じ 1 本**。#682 段④d)

/**
 * `postMessage` に載る形へ畳む。
 * ⚠ **BLOB の中身は運ばない** ── 画面に出しても読めず、heap に載せる理由が無い
 *   (2026-07-27 の不可侵指示「bytes は heap に載せない」と同じ向き)。
 * ⚠ **長い字も同じ理由で畳む**(上の `MAX_CELL_CHARS`)── ただし
 *   **全部で何字あったか**は残す(黙って切らない)。
 */
function cellForWire(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return capCellText(v);
  /**
   * 🔴 **字にする ── `Number()` にしない**(2026-09-09 実測)。
   * ⚠ 同梱の sqlite が `bigint` を返すのは **`Number.MAX_SAFE_INTEGER` を超えたときだけ**
   *   なので、この枝に来る値は**定義上すべて `Number()` で表せない**:
   *   `9007199254740993` → `9007199254740992`(1 違う)/
   *   `9223372036854775807` → `9223372036854776000`(別の数)。
   * ⚠ 数として出すために**静かに嘘の数を見せる**より、正しい字を見せる。
   */
  if (typeof v === 'bigint') return String(v);
  if (v instanceof Uint8Array) return `<${String(v.byteLength)} バイト>`;
  return String(v);
}

/** 埋め戻しを回す塊の大きさ(本文を一度に heap へ載せない)。 */
const BACKFILL_CHUNK = 200;

/**
 * 🔴 **埋め戻しが要る行の条件**(§7「同じ判定が 2 か所にある」)。
 *
 * ⚠ 「回すか」を見る probe と「どの行を読むか」を見る塊取りは**必ず同じ条件**で
 *   なければならない ── 食い違うと、probe が「要る」と言い続けるのに塊が
 *   1 件も返らず、**open のたびに空回りする**(または逆に、埋まらない行が残る)。
 * ⚠ 列を足したらここに足す。⚠ **`OR` で並べる**(片方だけ NULL の行が実在する ──
 *   `task_total` は #277 で、`body_chars` は 2026-08-19 に足したので、
 *   その間に書かれた行は前者だけ埋まっている)。
 */
const NEEDS_BACKFILL =
  'task_total IS NULL OR body_chars IS NULL OR body_tags IS NULL';

/**
 * 🔴 **`realm` は ON CONFLICT の SET に無い ── わざとである**(設計 doc §1.1、段①)。
 *
 * ⚠ INSERT の側にだけ列を持たせ、UPDATE の側では触らない ── 領域は
 *   「作られたとき」に決まる値で、**本文を保存し直すたびに再判定する物ではない**。
 *   `EntryUpsert.realm` を省いた呼び側(いまの全経路)は、既存行の領域を
 *   1 バイトも動かさずに済む。
 * 🔴 **`updated_at` は ON CONFLICT で `datetime('now')` を直に打つ**(#1087)── INSERT の値は
 *   取込が運んだ過去の時刻でありうるので、`excluded.updated_at` を使うと通常の保存が
 *   過去の時刻を刻んでしまう。
 */
const UPSERT_SQL = `INSERT INTO entries
    (cid, lid, title, archetype, created_at, updated_at,
     entry_order, status, date, archived, task_total, body_chars, body_tags, realm,
     title_f, body_f, fold_rev, body)
  VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  ON CONFLICT(cid, lid) DO UPDATE SET
    title = excluded.title,
    archetype = excluded.archetype,
    updated_at = datetime('now'),
    entry_order = excluded.entry_order,
    status = excluded.status,
    date = excluded.date,
    archived = excluded.archived,
    task_total = excluded.task_total,
    body_chars = excluded.body_chars,
    body_tags = excluded.body_tags,
    title_f = excluded.title_f,
    body_f = excluded.body_f,
    fold_rev = coalesce(entries.fold_rev, 0) + 1,
    body = excluded.body`;

/**
 * `UPSERT_SQL` に刻印の返却を足した版(#1087)。⚠ DO UPDATE に WHERE は無いので、
 * 挿入でも更新でも**必ず 1 行返る**(書いた直後の行を読み直す SELECT の代わり)。
 */
const UPSERT_RETURNING_SQL = `${UPSERT_SQL} RETURNING created_at, updated_at`;

function bindUpsert(cid: string, e: EntryUpsert): (string | number | null)[] {
  /**
   * 🔴 **全文検索の索引に入れる字も、書くときここで作る**(台帳 #1852 の束 B2)。理由は `task_total` と同じ ──
   * 呼び側の経路に持たせると、落とした経路のノートだけ検索が粗くなる。作り手は `search-text.ts` の 1 本。
   */
  const folded = foldedColumns(e.title, e.body);
  return [
    cid,
    e.lid,
    e.title,
    e.archetype,
    // 取込が運んできた時刻(省略 = 今)。⚠ INSERT の側にしか効かない(UPSERT_SQL の注記)
    e.createdAt ?? null,
    e.updatedAt ?? null,
    e.entryOrder,
    e.status,
    e.date,
    e.archived ? 1 : 0,
    /**
     * 🔴 **チェック項目の数は、書くときここで数える**(#277 段②)。
     *
     * ⚠ 呼び側に持たせない ── 12 ある書込経路のどれかが代入を落とすと、
     *   **そのノートだけカンバンから消える**(しかも tsc は黙る)。
     * ⚠ そして**旧いタブの follower**が要求を proxy してくる形(#286)でも、
     *   本文さえ在れば正しい値になる ── 送ってこない field に依存しない。
     * 🔑 実費は行走査 1 回(16KB の本文で 0.04ms 実測)。
     */
    countTaskCandidates(e.body).total,
    /**
     * 🔴 **本文の大きさも、書くときここで数える**(2026-08-19)。理由は上と同じ
     * ── 呼び側 12 経路に持たせると、落とした経路のノートだけ大きさが古くなる。
     * ⚠ 数えるのは **UTF-16 の長さ**(`String.length`)── 画面には `1.2K` 形式へ
     *   丸めて出すので、書記素まで数え直す実費を払う理由が無い。
     */
    e.body.length,
    /**
     * 🔴 **本文中のタグも、書くときここで集約する**(#550 段②)。理由は上の 2 つと
     * 同じ ── 呼び側 12 経路に持たせると、落とした経路のノートだけタグが古くなる。
     * ⚠ **重複はここで排除する**(user の字「保存時に重複排除して集約する」)。
     * ⚠ **frontmatter へは書き戻さない**(裁定 B)── 集約の置き場はこの列である。
     */
    encodeTags(bodyTags(e.body)),
    /**
     * 🔴 **省略時 `'user'`**(設計 doc §1.1、段①)。⚠ この値は INSERT の側にしか
     * 効かない(`UPSERT_SQL` の ON CONFLICT に `realm` が無い ── 上の注記)。
     */
    e.realm ?? 'user',
    folded.titleF,
    folded.bodyF,
    e.body,
  ];
}

// ── revision チェーン(P5c: jujutsu の「作業コピーはコミット」を写した形)──
//
// entries.body が **tip**(最新状態の全文。複製を持たない)。revisions は
// 「1 つ新しい状態から遡る逆向きパッチ」だけを持つ:
//   rev#k は rev#(k+1) の状態から遡り、鎖の頭は tip から遡る
// 依存が「古い → 新しい」の一方向なので、prune(古い側の削除)が鎖を壊さない。
//
// 書込は 2 モード:
//   checkpoint = 履歴を 1 件伸ばす(COMMIT_EDIT の変更あり)
//   amend      = 伸ばさず、鎖の頭を新しい tip からの符号化に張り替える
//                (todo toggle / rename ── 過去の状態そのものは不変)
// **維持は upsertEntry / deleteEntry の同 tx 内に閉じる**(旧 body は worker が
// 自分で読む ── app 層の協力に依存しない = 構造的に破れない)。

/** 保持上限の既定(caller 未指定時)。差分保持なので PKC2 より大きく取れる。 */
const DEFAULT_REVISION_KEEP = 100;

interface RevRow {
  id: string;
  rev_order: number;
  snapshot: string;
  content_hash: string | null;
  kind: string | null;
}

/** 鎖の頭(= 最も新しい revision 行)。 */
function headRevision(database: Database, cid: string, lid: string): RevRow | null {
  const rows = database.selectObjects(
    `SELECT id, rev_order, snapshot, content_hash, kind FROM revisions
      WHERE cid = ? AND entry_lid = ? ORDER BY rev_order DESC LIMIT 1`,
    [cid, lid],
  ) as unknown as RevRow[];
  return rows[0] ?? null;
}

/** kind NULL は 'full' 扱い(v2 までの既存行はすべて全文)。 */
const isFull = (row: RevRow): boolean => (row.kind ?? 'full') === 'full';

/** row が復元する状態を得る(base = row の 1 つ新しい状態 = tip か次行の状態)。 */
function materialize(row: RevRow, base: string): string {
  return isFull(row) ? row.snapshot : applyLinePatch(base, parseLinePatch(row.snapshot));
}

/**
 * 「base から target へ遡る」保存形を決める。パッチが全文以上に膨らむなら
 * 全文で持つ(git と同じ判断 ── 差分にする意味が無いときは素直に全文)。
 */
function encodeReverse(base: string, target: string): { kind: string; snapshot: string } {
  const patch = serializeLinePatch(diffLines(base, target));
  return patch.length < target.length
    ? { kind: 'patch', snapshot: patch }
    : { kind: 'full', snapshot: target };
}

/**
 * 保持上限を超えた古い側の版を捨てる(#1087)。⚠ **刈り込みはここ 1 か所**にする ──
 * 版を足す口(checkpoint / ゴミ箱へ移す)と、足さずに張り替える口の全部が通る。
 * 依存は「古い → 新しい」の一方向なので、鎖の頭(最も新しい行 = ゴミ箱から戻すときに使う全文)は
 * `keepLatest >= 1` である限り消えない。
 * @returns 捨てた行数
 */
function pruneChain(database: Database, cid: string, lid: string, keepLatest: number): number {
  const head = headRevision(database, cid, lid);
  if (!head) return 0;
  database.exec({
    sql: `DELETE FROM revisions WHERE cid = ? AND entry_lid = ? AND rev_order <= ?`,
    bind: [cid, lid, head.rev_order - Math.max(1, keepLatest)],
  });
  return database.changes();
}

/**
 * body 変更に伴う鎖の維持(同 tx で呼ぶこと)。
 *
 * 🔴 **版の日時 = その本文を書いた時刻**(台帳 #1852 G1 / 依頼 139 ②)。直す前は「その版が次の保存で置き換わった時刻」で、
 * 月曜に書いて金曜に直すと月曜の本文の行に「金曜」と出ていた。`oldWrittenAt` = 置き換える前の行の更新日時
 * (その本文が最後に書かれた時刻)。渡されなければ(行が時刻を持たない古い器)従来どおり置き換えた時刻。
 * ⚠ 既に積まれている版の日時は書き換えない(古い版は従来の意味のまま ── 直せるのはこれから積む分)。
 * @returns 積んだかどうか(checkpoint で新しい行を作ったら true)
 */
function maintainChain(
  database: Database,
  cid: string,
  lid: string,
  oldBody: string,
  newBody: string,
  oldTitle: string,
  oldArchetype: string,
  checkpoint: boolean,
  keepLatest: number,
  oldWrittenAt: string | null = null,
): { added: boolean; pruned: number } {
  const head = headRevision(database, cid, lid);
  const oldHash = contentHash64Hex(oldBody);
  // checkpoint かつ「頭が既に oldBody を記録していない」ときだけ 1 件伸ばす。
  // このとき既存の頭は **oldBody を基準に符号化済み**(直前まで tip だった)なので
  // 触らなくてよい ── 鎖はそのまま自然に伸びる
  if (checkpoint && !(head && head.content_hash === oldHash)) {
    const enc = encodeReverse(newBody, oldBody);
    const nextOrder = (head?.rev_order ?? 0) + 1;
    database.exec({
      sql: `INSERT INTO revisions
              (cid, id, entry_lid, created_at, rev_order, snapshot,
               title, archetype, content_hash, kind)
            VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?)`,
      bind: [
        cid,
        `rev-${crypto.randomUUID()}`,
        lid,
        oldWrittenAt,
        nextOrder,
        enc.snapshot,
        oldTitle,
        oldArchetype,
        oldHash,
        enc.kind,
      ],
    });
    return { added: true, pruned: pruneChain(database, cid, lid, keepLatest) };
  }
  // amend: 頭が復元する状態は変えず、**新しい tip からの符号化**へ張り替える。
  // 行の id / content_hash は保つ(change ID の安定 ── UI の「この版」が生き続ける)
  if (head) {
    const state = materialize(head, oldBody);
    const enc = encodeReverse(newBody, state);
    database.exec({
      sql: `UPDATE revisions SET snapshot = ?, kind = ? WHERE cid = ? AND id = ?`,
      bind: [enc.snapshot, enc.kind, cid, head.id],
    });
    // 🔴 張り替えも刈る(#1087)── ゴミ箱から戻した直後の最初の保存はここを通る
    return { added: false, pruned: pruneChain(database, cid, lid, keepLatest) };
  }
  return { added: false, pruned: 0 };
}

/**
 * 鎖 1 本を書く(P5c の符号化)。⚠ **書込経路はここ 1 本だけ**にする ──
 * 取込(`importRevisionChains`)も復元(`restoreRevisionChains`)もここを通る。
 * PKC2 の教訓: 移行専用の書込経路こそが穴の空いていた場所である。
 *
 * 行 k は「その版の状態」を復元し、tip(entries.body)から rev_order 降順に
 * 遡って materialize される:
 *   行 m: encodeReverse(tip,   S_m)
 *   行 k: encodeReverse(S_k+1, S_k)
 * **全文で積む経路は持たない**(持つと PKC2 と同じ「履歴が本文の N 倍」に戻る)。
 *
 * @param snapshots **古い → 新しい**順の全文
 */
function writeChain(
  database: Database,
  cid: string,
  entryLid: string,
  snapshots: ReadonlyArray<{
    body: string;
    createdAt: string;
    /** その版の題名(復元時のみ持つ)。無ければ entry の値。 */
    title?: string | null;
    archetype?: string | null;
  }>,
  keepLatest: number,
  out: ImportRevisionsResult,
): void {
  const row = database.selectObjects(
    'SELECT body, title, archetype FROM entries WHERE cid = ? AND lid = ?',
    [cid, entryLid],
  )[0] as { body: string; title: string; archetype: string } | undefined;
  // entry が居ない / 既に鎖を持つ ものには積まない ── 既存の鎖に割り込むと
  // 符号化の前提(隣接する版の差分)が崩れる
  if (!row || headRevision(database, cid, entryLid)) {
    out.skippedEntries.push(entryLid);
    return;
  }
  // 無変更の版を畳む(PKC2 は本文が変わらなくても snapshot を作りうる)。
  // 「変更あり commit だけ刻む」= P5b で確立した規律
  const states: Array<{
    body: string;
    createdAt: string;
    title?: string | null;
    archetype?: string | null;
  }> = [];
  for (const s of snapshots) {
    if (states.length > 0 && states[states.length - 1]!.body === s.body) {
      out.skippedNoChange++;
      continue;
    }
    states.push(s);
  }
  // 最新の版が tip と同じなら、その版は履歴として持つ意味がない
  while (states.length > 0 && states[states.length - 1]!.body === row.body) {
    states.pop();
    out.skippedNoChange++;
  }
  // 保持上限(古い側から捨てる ── 直近を残すのが既定)
  if (states.length > keepLatest) {
    out.droppedOverLimit += states.length - keepLatest;
    states.splice(0, states.length - keepLatest);
  }

  // 新しい側から符号化する(基準は 1 つ新しい版、先頭は tip)
  let base = row.body;
  for (let k = states.length - 1; k >= 0; k--) {
    const st = states[k]!;
    const enc = encodeReverse(base, st.body);
    database.exec({
      sql: `INSERT INTO revisions
              (cid, id, entry_lid, created_at, rev_order, snapshot,
               title, archetype, content_hash, kind)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        cid,
        `rev-${crypto.randomUUID()}`,
        entryLid,
        // 履歴の時刻は捏造しない ── PKC2 の created_at をそのまま持ち込む
        st.createdAt || new Date().toISOString(),
        k + 1,
        enc.snapshot,
        // PKC2 の Revision は title / archetype を持たない ── entry の値を使う。
        // 復元(P6e)は版ごとの値を持っているので、あればそちらを立てる
        st.title ?? row.title,
        st.archetype ?? row.archetype,
        contentHash64Hex(st.body),
        enc.kind,
      ],
    });
    out.added++;
    base = st.body;
  }
}

/**
 * 鎖 1 本を**保存形から**復元する(P6e)。
 *
 * ⚠ **decode と encode を 1 パスに融合する**。全版を全文にして配列へ溜めてから
 * 書き直すと、`getRevision` がわざわざ避けている「全面書換 100 世代で 14MB を
 * 一度に持つ」形を復元が構造的にやることになる(review M-3)。
 * decode の向き(新 → 古)と encode の向き(新 → 古)は**同じ**なので、
 * 同時に生きるのは「1 つ新しい状態」と「いまの状態」の 2 本で済む。
 *
 * 積む行は**パッチ(小さい)**なので、`rev_order` を後から振るために貯めても
 * 全文を持つことにはならない。
 */
function restoreOneChain(
  database: Database,
  cid: string,
  chain: EncodedChainInput,
  keepLatest: number,
  out: ImportRevisionsResult,
): void {
  const head = database.selectObjects(
    'SELECT body, title, archetype FROM entries WHERE cid = ? AND lid = ?',
    [cid, chain.entryLid],
  )[0] as { body: string; title: string; archetype: string } | undefined;
  // entry が居ない / 既に鎖を持つ ものには積まない(writeChain と同じ規約)
  if (!head || headRevision(database, cid, chain.entryLid)) {
    out.skippedEntries.push(chain.entryLid);
    return;
  }
  stageAndWriteChain(database, cid, chain.entryLid, head, chain, keepLatest, out);
}

/**
 * 🔴 **鎖の復元の本体**(台帳 #1852 束 F2 で `restoreOneChain` から切り出した)。`head` = 符号化の起点(生きたノートなら
 * `entries` の行、ゴミ箱のノートなら頭の行になる全文)。生きたノートの復元(`restoreOneChain`)とゴミ箱のノートの復元
 * (`restoreOneTrashNote`)が**この 1 本**を通る ── 2 か所に decode / 噛み合わせ検査 / 符号化を書かない。
 * @returns 積んだ古い版の行数(rev_order は 1..n。頭の行を足すなら n + 1)
 */
function stageAndWriteChain(
  database: Database,
  cid: string,
  entryLid: string,
  head: { body: string; title: string; archetype: string },
  chain: { rows: EncodedChainInput['rows']; rewrite?: EncodedChainInput['rewrite'] },
  keepLatest: number,
  out: ImportRevisionsResult,
): number {
  /** 新しい → 古い の順に積む(rev_order は件数が決まってから振る)。 */
  const staged: Array<{
    kind: string;
    snapshot: string;
    createdAt: string;
    title: string | null;
    archetype: string | null;
    hash: string;
  }> = [];
  let base = head.body; // 符号化の基準 = 1 つ新しい状態(先頭は tip)
  let prev = head.body; // 無変更の畳み込み用
  /**
   * 🔴 **戻す起点**(#1087、バックアップ往復の見直し)。ふだんは tip と同じ。取り込みで本文の ID を
   *   付け替えた鎖だけ、**書き出したときの本文**から戻し、戻した各版に同じ付け替えを当てて積む。
   * ⚠ 付け替えた tip から戻すと、書き換えた行が古い版にも残り hash が合わず、鎖ごと捨てていた。
   * ⚠ 起点を差し替える前に「起点に付け替えを当てると、いまの tip になる」を確かめる ── 合わないなら
   *   書き出し後に本文が変わっている(従来の「本文が書き出し時と違います」と同じ扱い)。
   */
  const rewrite = chain.rewrite;
  let decodeBase = head.body;
  if (rewrite !== undefined) {
    if (remapImportedBody(rewrite.tip, rewrite.remap) !== head.body) {
      throw new Error('履歴の起点が合いません。本文が書き出し時と違います');
    }
    decodeBase = rewrite.tip;
  }

  let prevOrder = Number.POSITIVE_INFINITY;
  for (const r of chain.rows) {
    // 🔴 **向きの契約を検査する**(protocol: rows は新しい → 古い)。
    // ⚠ hash では捕まえられない ── 順序が逆でも各版は個別には正しく復元でき、
    // hash も一致する。壊れるのは**並び**で、`rev_order` を位置から振っている
    // ここが黙って履歴を逆順に書く(review M-4 の MUT5 と同根)
    if (!(r.revOrder < prevOrder)) {
      throw new Error(
        `履歴の並びが新しい → 古いになっていません(版 ${r.revOrder} が ${prevOrder} の後ろ)`,
      );
    }
    prevOrder = r.revOrder;
    // ⚠ 未知の保存形は**断る**(JSON parse の生エラーを user に見せない)
    if (r.kind !== 'full' && r.kind !== 'patch') {
      throw new Error(`未対応の履歴の保存形です: ${r.kind}`);
    }
    const original = materialize(
      { id: '', rev_order: r.revOrder, snapshot: r.snapshot, content_hash: null, kind: r.kind },
      decodeBase,
    );
    decodeBase = original;
    // 🔴 **噛み合わせ検査**(review H-1)。`applyLinePatch` は行数さえ合えば通るので、
    // tip がズレた鎖・改竄されたパッチが**例外にならずに**通ってしまう。しかも
    // 書込側は decode 結果から hash を計算し直すので、以後 `getRevision` の
    // 整合性検査も通る = 誤りが自己証明されて固定される
    const originalHash = contentHash64Hex(original);
    if (r.contentHash !== null && originalHash !== r.contentHash) {
      throw new Error(
        `履歴の順序が合いません(版 ${r.revOrder})。バックアップが読めない状態か、本文が書き出し時と違います`,
      );
    }
    // 積むのは**付け替えた後**の版(tip と同じ規則)。hash も積む形で取り直す
    const state = rewrite === undefined ? original : remapImportedBody(original, rewrite.remap);
    const hash = rewrite === undefined ? originalHash : contentHash64Hex(state);
    // 「変更あり commit だけ刻む」= P5b の規律(取込経路と同じ)
    if (state === prev) {
      out.skippedNoChange++;
      base = state;
      continue;
    }
    if (staged.length >= keepLatest) {
      // 保持上限。古い側から捨てる = 新しい側から数えて上限に達したら以降は不要
      out.droppedOverLimit++;
      base = state;
      prev = state;
      continue;
    }
    const enc = encodeReverse(base, state);
    staged.push({
      kind: enc.kind,
      snapshot: enc.snapshot,
      createdAt: r.createdAt ?? '',
      title: r.title,
      archetype: r.archetype,
      hash,
    });
    base = state;
    prev = state;
  }

  // rev_order は**古い = 1**。staged は新しい → 古い なので逆から振る
  for (let i = 0; i < staged.length; i++) {
    const st = staged[i]!;
    database.exec({
      sql: `INSERT INTO revisions
              (cid, id, entry_lid, created_at, rev_order, snapshot,
               title, archetype, content_hash, kind)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        cid,
        `rev-${crypto.randomUUID()}`,
        entryLid,
        // 履歴の時刻は捏造しない
        st.createdAt || new Date().toISOString(),
        staged.length - i,
        st.snapshot,
        // 版ごとの題名を持っているならそちらを立てる(復元だけが持つ情報)
        st.title ?? head.title,
        st.archetype ?? head.archetype,
        st.hash,
        st.kind,
      ],
    });
    out.added++;
  }
  return staged.length;
}

/**
 * 🔴 **ゴミ箱のノート 1 件を、ゴミ箱の中へ復元する**(台帳 #1852 束 F2 / 依頼 105-2・297 A)。
 *
 * ゴミ箱は「`entries` に居ない `entry_lid` の `revisions`」なので、`entries` には**書かない**。積むのは
 * 古い版(`stageAndWriteChain` ── 生きたノートの復元と同じ 1 本)+ 頭の行(ゴミ箱へ移した時点の全文。
 * `deleteEntry` が積む行と同じ形で、題名・種類・作成日・並びの位置・更新日時の控えを持つ)。
 * ⚠ 頭が全文なので、ゴミ箱から戻す道(`getRevision` ── 頭を出発点にして遡る)がそのまま使える。
 * ⚠ 同じ lid が生きているノートに居る / 既に履歴がある lid には積まない(既存の鎖に割り込まない)。
 */
function restoreOneTrashNote(
  database: Database,
  cid: string,
  note: TrashNoteInput,
  keepLatest: number,
  out: ImportRevisionsResult,
): void {
  const alive = database.selectObjects('SELECT 1 AS x FROM entries WHERE cid = ? AND lid = ?', [cid, note.entryLid])[0];
  if (alive !== undefined || headRevision(database, cid, note.entryLid)) {
    out.skippedEntries.push(note.entryLid);
    return;
  }
  const remap = note.remap;
  const headBody = remap === undefined ? note.body : remapImportedBody(note.body, remap);
  // 頭の行も保持上限に数える(`pruneChain` と同じ ── 頭は消えない)
  const n = stageAndWriteChain(
    database,
    cid,
    note.entryLid,
    { body: headBody, title: note.title, archetype: note.archetype },
    { rows: note.rows, ...(remap === undefined ? {} : { rewrite: { tip: note.body, remap } }) },
    Math.max(0, keepLatest - 1),
    out,
  );
  database.exec({
    sql: `INSERT INTO revisions
            (cid, id, entry_lid, created_at, rev_order, snapshot,
             title, archetype, content_hash, kind, entry_created_at, entry_order, entry_updated_at)
          VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, 'full', ?, ?, ?)`,
    bind: [
      cid,
      `rev-${crypto.randomUUID()}`,
      note.entryLid,
      note.trashedAt,
      n + 1,
      headBody,
      note.title,
      note.archetype,
      contentHash64Hex(headBody),
      note.entryCreatedAt,
      note.entryOrder === null ? null : String(note.entryOrder),
      note.entryUpdatedAt,
    ],
  });
  out.added++;
}


/**
 * 🔴 **居場所を張り替える中身**(tx の中で呼ぶ ── `BEGIN` はしない)。
 *
 * ⚠ `setEntryParent`(移動)と `upsertEntry` の `parent`(#258 の作成)の**両方**が
 * ここを通る ── 2 か所に書くと、片方だけ直したときに**移動と作成で結果が違う**
 * (CLAUDE.md §7「同じ判定が複数の場所にある」)。
 */
function writeParent(
  database: Database,
  cid: string,
  lid: string,
  parentLid: string | null,
  relationId: string,
  /**
   * 🔴 **同じ tx で、親をもう何本か足す**(台帳 #1852 G1 / 依頼 227 A)。2 つ以上のフォルダに入っていたノートを移したあとの
   * 「元に戻す」が、**入っていたフォルダ全部**へ戻すための口。⚠ 1 本目(`parentLid`)と同じ門(輪・id のぶつかり)を通す。
   */
  alsoIn: ReadonlyArray<{ parentLid: string; relationId: string }> = [],
): void {
  database.exec({
    sql: `DELETE FROM relations WHERE cid = ? AND to_lid = ? AND kind = 'structural'`,
    bind: [cid, lid],
  });
  if (parentLid === null) return;
  addParentEdge(database, cid, lid, parentLid, relationId);
  for (const extra of alsoIn) addParentEdge(database, cid, lid, extra.parentLid, extra.relationId);
}

/** 居場所の辺を 1 本足す(`writeParent` の後半。輪になる辺・ぶつかる id は断る)。 */
function addParentEdge(
  database: Database,
  cid: string,
  lid: string,
  parentLid: string,
  relationId: string,
): void {
  /**
   * 🔴 **輪になる移動は断る ── 同じ tx の中で、新しい親から祖先を辿る**(#1087)。
   *
   * ## 何が起きていたか
   * 2 つのタブで逆向きに移す(タブ A が X を Y の中へ、更新の届いていないタブ B が Y を X の中へ)と、
   * 画面側の輪の検査(`app-state.ts`)は各タブの古い木しか見ないので両方通り、保存後に
   * X・Y とその中身が**木のどこにも出なくなる**(最上位の判定は「親を持たない物」)。
   * 🔑 だから最後の砦は**書く側の tx の中**に置く(読んでから書くまでの間に別のタブが書けない)。
   * ⚠ 親が移す物自身のとき(自分の中へ)も、辿りの始点で当たるので同じ門で断る。
   */
  // 🔴 辿るのは**親の辺すべて**(多重親の別の鎖に自分が居ても輪)── 判定は画面側と同じ `wouldMakeCycle`
  if (
    wouldMakeCycle(lid, parentLid, (child) =>
      (
        database.selectObjects(
          `SELECT from_lid FROM relations WHERE cid = ? AND to_lid = ? AND kind = 'structural'`,
          [cid, child],
        ) as Array<{ from_lid: string }>
      ).map((r) => r.from_lid),
    )
  ) {
    throw new Error(
      '移そうとした先が、移すフォルダの中に入っています(別のウィンドウで先に移されたかもしれません)。' +
        '画面を読み込み直してから、もう一度お試しください。',
    );
  }
  /**
   * 🔴 **ぶつかったら断る ── 黙って上書きしない**(#973)。
   *
   * ## 何が起きていたか
   *
   * ⚠ 直す前は `ON CONFLICT(cid, id) DO UPDATE` で、**ぶつかりを「上書き」に変えていた**。
   * 窓を 2 つ開いて同じミリ秒で整理すると同じ id が採番されることがあり
   * (`generateLid` に乱数が無かった)、そのとき **先に在った別のノートの居場所の行が、
   * こちらのノートのものに書き換わる** ── 画面では入ったように見えたまま、
   * 読み込み直すと**別のノートがフォルダから出て、いちばん上へ戻っている**。
   * ⚠ error は 1 つも出ず、履歴にも残らない。
   *
   * ## 🔑 なぜ「残っている行 = 別物」と言い切れるか
   *
   * すぐ上の `DELETE` が **この lid の structural を消したあと**なので、
   * ここで同じ id が残っているなら、それは**他のノートの行**である。
   * 🔑 だから断ってよい(同じノートを 2 回保存しても、DELETE が先に効くのでぶつからない)。
   *
   * ## ⚠ 取り込み(`bulkUpsertRelations`)の `ON CONFLICT` は**正しい**ので触らない
   *
   * あちらは id が**取り込んだファイルの中**から来るので、ぶつかり =
   * 「**同じ関係をもう一度入れた**」である ── 断ると
   * **同じバックアップを取り込み直しただけで落ちる**。
   * 🔑 同じ綴りでも目的が違えば直し方も違う(CLAUDE.md §7)。
   */
  const taken = database.selectValue('SELECT count(*) FROM relations WHERE cid = ? AND id = ?', [
    cid,
    relationId,
  ]) as number;
  if (taken > 0) {
    throw new Error(
      'フォルダへの所属を書き込めませんでした(同じ番号が既に使われています)。' +
        'ウィンドウを 2 つ開いている場合は 1 つ閉じて、もう一度お試しください。',
    );
  }
  database.exec({
    sql: `INSERT INTO relations (cid, id, from_lid, to_lid, kind, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'structural', datetime('now'), datetime('now'))`,
    bind: [cid, relationId, parentLid, lid],
  });
}

/**
 * 🔴 **この端末だけの id を採番する**(#260)。
 *
 * ⚠ 綴りの制約は 2 つあり、どちらも**別の file が持っている**:
 * ① `pkc://<cid>/entry/<lid>` の token 規則 `[A-Za-z0-9_-]+`
 *    (`features/link/permalink.ts` の `TOKEN_RE`)
 * ② `':'` を含めない(`asset-blob-store.ts` の `assertCid` ── key 空間が混ざる)
 * 16 進 32 桁 + `c-` の前置きは、その両方に収まる**最も狭い形**である。
 */
class WorkspacesRemainError extends Error {}

/**
 * 🔴 **いま使う器の cid**(#1455。ワークスペース)。
 *
 * - `workspaces` 表の 1 行(`id = 'main'`)の `active_cid` が実在する器ならそれ。
 * - 無い / 実在しない(削除された)なら、**いちばん古い器**(今までの選び方 ── 既存の DB は何も変わらない)。
 * ⚠ 選び方を変えると既存のデータが丸ごと見えなくなる(cid は全表の区画鍵) ── だから既定は今までと同じ。
 */
function activeContainerCid(database: Database): string | undefined {
  const marked = database.selectValue(
    `SELECT c.cid FROM workspaces w JOIN containers c ON c.cid = w.active_cid WHERE w.id = 'main'`,
  ) as string | undefined;
  if (typeof marked === 'string' && marked !== '') return marked;
  return database.selectValue('SELECT cid FROM containers ORDER BY created_at, cid LIMIT 1') as
    | string
    | undefined;
}

function mintContainerId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `c-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 🔴 **本文に触らずに 1 列だけ書き換える**(#178。改名 / 並べ替えが使う)。
 *
 * 🔑 **本文を書き戻さなければ、タブ間の衝突は起こりようがない** ── 検出ではなく
 * 消滅である(読んでから書くまでの窓が無い)。
 * ⚠ **鎖は触らないのが正しい** ── `upsertEntry` も
 * `if (old && old.body !== req.entry.body)` で本文が変わったときだけ鎖を維持する。
 * ここでは常に偽なので、**元から鎖は動いていなかった**(この口はその等価物である)。
 * ⚠ 抽出列(status / date / archived)も本文由来なので触らない。
 * ⚠ **列名は呼び側のリテラルだけ**を受ける(user の値が SQL に入る口を作らない)。
 */
/**
 * 🔴 **本文を 1 件書く(tx は呼び側が張る)**。
 *
 * 🔑 **取り出した理由**(#178、2026-08-25)── 書込の作法(読んだものと違えば
 * 書かない / 鎖を維持する / 居場所を張る / 刻んだ時刻を返す)を **1 か所**に
 * 置くため。⚠ 同じ判定が 2 か所に生えると、**片方だけ壊しても検査に届かない**
 * (CLAUDE.md §7 ── `anyEditing` で実際に踏んだ型)。
 *
 * ⚠ **`BEGIN` / `COMMIT` はここでは打たない。** 呼び側が張った tx の中で走る
 * ことが要点である ── `replaceAssetRefs` は **走査と書込を 1 tx に閉じ込める**
 * ために存在するので、ここで tx を張ると**その保証が消える**。
 */
function writeEntryRow(
  database: Database,
  cid: string,
  entry: EntryUpsert,
  opts: {
    checkpoint?: boolean;
    keepLatest?: number;
    expectHash?: string;
    parent?: { parentLid: string | null; relationId: string };
    keepMeta?: boolean;
  },
): { stamps: EntryStamps; conflict: boolean } {
  const old = database.selectObjects(
    'SELECT title, archetype, entry_order, body, updated_at FROM entries WHERE cid = ? AND lid = ?',
    [cid, entry.lid],
  )[0] as
    | { title: string; archetype: string; entry_order: number; body: string; updated_at: string | null }
    | undefined;
  /**
   * 🔴 **本文だけを書く**(#1087、複数タブの見直し。`keepMeta`)── 既に在る行の題名・種類・並びは disk の値を保つ。
   * ⚠ 同じ tx の中で読んだ値なので、別のタブの改名・並べ替えとの間に隙間が無い。
   */
  if (opts.keepMeta === true && old) {
    entry = { ...entry, title: old.title, archetype: old.archetype, entryOrder: old.entry_order };
  }
  /**
   * 🔴 **読んだものと違っていたら、1 バイトも書かない**(#178、2026-08-22)。
   *
   * ⚠ **追記のためにある** ── `getBody` → `appendBlock` → 書込 の間に
   * 別のタブ / 窓が書くと、その版を消す(`checkpoint` を渡さないので
   * **履歴にも残らない** = どこからも戻せない)。
   * 🔑 **同じ tx の中で比べる**のが要点である ── ここで読んだ `old.body` は
   * 「まさにこれから上書きする値」なので、比較と書込の間に隙間が無い
   * (呼び側で `getBody` して比べる形にすると、その隙間がまた開く)。
   * ⚠ hash は**頼まれたときだけ**計算する(全書込に負荷を足さない)。
   * ⚠ 行が無いときは比べない ── 消えていたら普通に作る(追記側が先に弾く)。
   */
  if (opts.expectHash !== undefined && old && contentHash64Hex(old.body) !== opts.expectHash) {
    return { stamps: { createdAt: null, updatedAt: null }, conflict: true };
  }
  if (old && old.body !== entry.body) {
    // 🔒 **履歴より本文が上位**(review P5c F1 ── データ喪失方向で実証済み):
    // 鎖が既に壊れていると amend の materialize が throw し、tx ごと巻き戻って
    // **本文の保存が失敗する**。しかも toggle 系は永久に通らなくなる。
    // 鎖の維持に失敗しても body の書込は続行する ── 壊れた鎖は読み側の
    // 可視エラー(revision restore failed)で既に扱えている
    try {
      maintainChain(
        database,
        cid,
        entry.lid,
        old.body,
        entry.body,
        old.title,
        old.archetype,
        opts.checkpoint === true,
        opts.keepLatest ?? DEFAULT_REVISION_KEEP,
        old.updated_at,
      );
    } catch {
      /* 履歴の維持失敗は本文の保存を巻き添えにしない */
    }
  }
  // 🔑 刻んだ時刻は書いた文から直接受ける(#1087。以前は同じ行を SELECT で読み直していた)
  const stamped = database.selectObjects(UPSERT_RETURNING_SQL, bindUpsert(cid, entry))[0] as
    | { created_at: string | null; updated_at: string | null }
    | undefined;
  /**
   * 🔴 **同じ tx で居場所も張る**(#258)。
   * ⚠ 順序に **FK の制約は無い**(`schema.ts` の relations に FK は無い)── 行を先に
   *   書くのは**読み手の期待**と 2 手だった頃の並びに合わせるためで、入れ替えても
   *   DB は壊れない(「これが無いと壊れる」と書かない ── CLAUDE.md §1)。
   */
  if (opts.parent) writeParent(database, cid, entry.lid, opts.parent.parentLid, opts.parent.relationId);
  // 🔑 **刻んだ時刻を返す**(P9 段①)。`datetime('now')` を打つのはここだけなので、
  // 返さないと主スレッドは**次の boot まで作成・更新の時刻を知らない**
  // (実際に情報列が終日「—」になっていた)。⚠ 同 tx 内で読む ──
  // COMMIT の後に読むと、別タブの書込が割り込んだ値を返しうる。
  // ⚠ 主スレッド側で時刻を作らない(DB に無い値を画面に出すことになる)
  return {
    stamps: {
      createdAt: stamped?.created_at ?? null,
      updatedAt: stamped?.updated_at ?? null,
      // 🔑 `bindUpsert` が `body_chars` に書いた値と同じ(UTF-16 の長さ)
      bodyChars: entry.body.length,
      // ⚠ **書いたときだけ名乗る**(旧 worker は名乗らない = 呼び側が 2 手へ落ちる)
      ...(opts.parent ? { parentWritten: true } : {}),
      // 🔴 編集の保存なのに行が無かった = 別のタブが先に消していた(依頼 108 A)── 書いたうえで、呼び側が言う
      ...(opts.keepMeta === true && !old ? { recreated: true } : {}),
    },
    conflict: false,
  };
}

function updateEntryColumn(
  cid: string,
  lid: string,
  column: 'title' | 'entry_order',
  value: string | number,
): EntryStamps | null {
  const database = need();
  database.exec({
    // 🔴 並べ替えは更新日時を進めない(#1087)── 居場所の移動(`setEntryParent`)と同じ。改名だけ進める
    // 🔴 改名は索引の元の字(`title_f`)も一緒に書く(台帳 #1852 の束 B2)
    sql: `UPDATE entries SET ${column} = ?${column === 'title' ? ", updated_at = datetime('now'), title_f = ?, fold_rev = coalesce(fold_rev, 0) + 1" : ''}
            WHERE cid = ? AND lid = ?`,
    bind: column === 'title' ? [value, foldedColumns(String(value), '').titleF, cid, lid] : [value, cid, lid],
  });
  // ⚠ **書いた行が無ければ null** ── 消えたノートの書き換えを「成功」と言わない
  if (database.changes() === 0) return null;
  // 🔑 刻んだ時刻を返す(`upsertEntry` と同じ約束 ── P9 段①)
  const stamped = database.selectObjects(
    'SELECT created_at, updated_at FROM entries WHERE cid = ? AND lid = ?',
    [cid, lid],
  )[0] as { created_at: string | null; updated_at: string | null } | undefined;
  return {
    createdAt: stamped?.created_at ?? null,
    updatedAt: stamped?.updated_at ?? null,
  };
}

/**
 * 🔴 **本文の名前つき csv を、引ける表として組み立てる**(#681 段③)。
 *
 * ⚠ **`PRAGMA query_only = 1` を掛ける前に呼ぶ** ── temp の表を作るのも
 *   engine から見れば書き込みなので、掛けた後では作れない。
 * 🔑 目録(`csv_tables`)は**必ず**作る ── これが無いと、user は
 *   「どんな名前を打てばよいか」を画面のどこからも知れない。
 * ⚠ 中身の表は**打った字に名前が出てくる物だけ** ── 全部組み立てると、
 *   引かない表のために本文を升まで開くことになる。
 *
 * @param made 作った表の名前を積む先(呼び側が `finally` で落とす)。
 *   ⚠ **戻り値にしない** ── 投げた回に呼び側へ届かず、作りかけが残る。
 */
/**
 * 1 回の `INSERT` に積む行数(#968)。
 *
 * ⚠ sqlite の「`?` の上限」(既定 **32766**)を割らない大きさにする ── 1 行が
 *   3 つなので 500 行で 1500 個。⚠ ここを上げるときは**1 行あたりの `?` の数**と
 *   掛けて確かめる(超えると `too many SQL variables` で落ちる)。
 */
const CSV_INSERT_CHUNK = 500;

function buildCsvTables(database: Database, sql: string, made: string[]): void {
  /**
   * ⚠ **粗く絞ってから正しく読む** ── `name=` は本文のどこにでも書けるので、
   *   ここで当たった本文を `collectCsvTables` が囲みとして読み直す。
   * ⚠ 索引は無いので全走査になる。⚠ それでよい:この op は user が
   *   `Ctrl+Enter` を押したときにだけ走る(打鍵ごとではない)。
   * 🔴 **system 領域のノートは読まない**(設計 doc §1.1、段①)── これは
   *   user の本文を表として引く機能であって、system のノートを混ぜる理由が無い。
   */
  /**
   * 🔑 名前の無い囲みの既定の表(`csv`)は、打った SQL に `csv` / `csv_tables` / `csv_columns` が出る回だけ拾う
   *   (#681。拾うと csv / tsv / psv を含む本文を全部読むことになるので、引かない回には払わせない)。
   */
  const unnamed =
    csvTablesMentioned(sql, [CSV_DEFAULT_TABLE, 'csv_tables', 'csv_columns']).length > 0;
  const notes = database.selectObjects(
    unnamed
      ? `SELECT lid, title, body FROM entries WHERE ${USER_REALM_SQL} AND (body LIKE '%name=%' OR body LIKE '%csv%' OR body LIKE '%tsv%' OR body LIKE '%psv%')`
      : `SELECT lid, title, body FROM entries WHERE ${USER_REALM_SQL} AND body LIKE '%name=%'`,
  ) as unknown as Array<{ lid: string; title: string; body: string }>;
  /**
   * 🔴 **受けられなかった名前も拾う**(#681 段③)── 目録で理由を言うため。
   * ⚠ 黙って落とすと、user に見えるのは「表が出てこない」だけで、
   *   **なぜ出ないのかが画面のどこにも無い**(CLAUDE.md §4)。
   */
  const rejects: CsvTableReject[] = [];
  const blocks = notes.flatMap((n) =>
    collectCsvTables(n.body, { lid: n.lid, title: n.title }, rejects, { unnamed }),
  );
  const tables = mergeCsvTables(blocks);
  /**
   * ⚠ **作る前に落とす ── ただしこれは 2 つ目の網である**(2026-09-09、正直に書く)。
   *
   * ふだん落としているのは呼び側の `finally` なので、**この 1 行を外しても
   * test は 1 つも落ちない**(変異試験 W1 が SURVIVED で教えた ── CLAUDE.md
   * 「『これが無いと壊れる』と書く前に、外して壊れるのを見る」)。
   * 🔑 それでも残す理由は 1 つ:**`finally` の落としは例外を飲む**(下の註記)。
   *   飲んだ回に残った表を、次の回が**古い中身のまま引く**のを止めるのはここだけである。
   */
  const fresh = (name: string): void => {
    database.exec({ sql: `DROP TABLE IF EXISTS temp."${name}"` });
    made.push(name);
  };

  fresh('csv_tables');
  database.exec({
    sql: 'CREATE TEMP TABLE "csv_tables" (name TEXT, note TEXT, lid TEXT, rows INTEGER, cols INTEGER, why TEXT)',
  });
  const listed =
    'INSERT INTO temp."csv_tables" (name, note, lid, rows, cols, why) VALUES (?, ?, ?, ?, ?, ?)';
  /**
   * ⚠ **名前ごとに 1 度だけ束ねる**(#968)── 直す前は表ごとに `blocks.filter` を
   *   回しており、**表の数 × 囲みの数**だけ走査していた。
   */
  const blocksByName = new Map<string, typeof blocks>();
  for (const b of blocks) {
    const list = blocksByName.get(b.name);
    if (list === undefined) blocksByName.set(b.name, [b]);
    else list.push(b);
  }
  for (const t of tables) {
    for (const b of blocksByName.get(t.name) ?? []) {
      database.exec({
        sql: listed,
        bind: [t.name, b.noteTitle, b.lid, b.rows.length, b.columns.length, ''],
      });
    }
  }
  // ⚠ 受けられなかった囲みも**同じ表に**出す(別の表にすると、探す先が 2 つになる)
  for (const r of rejects) {
    database.exec({ sql: listed, bind: [r.raw, r.noteTitle, r.lid, r.rows, r.cols, r.why] });
  }

  /**
   * 🔴 **列の名前の目録**(`csv_columns`。#918 段⑤d-2)。
   *
   * ## なぜ「別の表」にしたか
   *
   * ⚠ `csv_tables` に列名を**詰め込む**案(`"a, b, c"` の 1 列)は捨てた ──
   *   csv の見出しは**何でも書ける**ので、区切り字が名前の中に出た回に**静かに割れる**。
   * 🔑 sqlite 自身が同じ形をしている(`sqlite_master` + `pragma_table_info`)ので、
   *   **1 行 1 列**に開く ── どんな名前でも壊れないし、user も素直に引ける。
   *
   * ## 何に要るか
   *
   * 🔴 本文の csv は **temp の表**なので `sqlite_master` に出ない ── つながり図(ER)は
   *   そこを読むので、**本文の表だけ図に出てこなかった**。
   * ⚠ 図のために `sqlite_temp_master` を読むのは**採らない** ── 名前を修飾しない
   *   `pragma_table_info` は **temp を先に解決する**ので、本表と混ざって
   *   **同じ名前の行が二重に出る**(CLAUDE.md §7)。
   */
  fresh('csv_columns');
  database.exec({
    sql: 'CREATE TEMP TABLE "csv_columns" (tbl TEXT, cid INTEGER, col TEXT)',
  });
  /**
   * ⚠ **まとめて入れる**(#968)── 直す前は**列の数だけ `exec`** を打っていた。
   * 🔑 1 回に積む件数は `CSV_INSERT_CHUNK` ── sqlite の「? の上限」(既定 32766)を
   *   割らない大きさにする(1 行 3 つなので 500 行 = 1500 個)。
   * ⚠ **0 件のときは打たない**(`VALUES` の後ろが空の SQL を組まない)。
   */
  const colRows: Array<[string, number, string]> = [];
  for (const t of tables) t.columns.forEach((c, i) => colRows.push([t.name, i, c]));
  for (let at = 0; at < colRows.length; at += CSV_INSERT_CHUNK) {
    const chunk = colRows.slice(at, at + CSV_INSERT_CHUNK);
    database.exec({
      sql:
        'INSERT INTO temp."csv_columns" (tbl, cid, col) VALUES ' +
        chunk.map(() => '(?, ?, ?)').join(', '),
      bind: chunk.flat(),
    });
  }

  const wanted = new Set(csvTablesMentioned(sql, tables.map((t) => t.name)));
  const build = tables.filter((t) => wanted.has(t.name));
  /**
   * ⚠ **組み立てる前に、まとめて断る**(判断は `csv-tables.ts` の 1 本)──
   *   途中まで作ってから投げると、`finally` が落とす前に worker の heap を食う。
   */
  const tooBig = csvCellsOverBudget(build);
  if (tooBig !== null) throw new Error(tooBig);
  for (const t of build) createCsvTable(database, t, fresh);
}

/** 1 つの表を temp に作って中身を入れる。⚠ 名前と列は `csv-tables.ts` が検めた物だけが来る。 */
function createCsvTable(database: Database, t: CsvTable, fresh: (name: string) => void): void {
  fresh(t.name);
  const cols = t.columns.map((c) => `"${c}" TEXT`).join(', ');
  database.exec({ sql: `CREATE TEMP TABLE "${t.name}" (${cols})` });
  const marks = t.columns.map(() => '?').join(', ');
  const insert = `INSERT INTO temp."${t.name}" VALUES (${marks})`;
  for (const row of t.rows) database.exec({ sql: insert, bind: [...row] });
}

/**
 * 客の DB に作る表 1 つ。⚠ **形だけで受ける** ── `.csv` の 1 つも、`.xlsx` の
 * 枚ごとの 1 枚も、ここから見れば「名前・列・行」でしかない(どちらの型を
 * import しても、もう片方が通らなくなるだけである)。
 */
interface GuestTable {
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
}

/**
 * 🔴 **添付の `.csv` / `.xlsx` を、客の DB に表として作る**(#854 段① / 段③)。
 *
 * ⚠ `createCsvTable`(本文の囲み用)とは**別**にしてある ── あちらは
 *   「毎回の走らせるたびに作り直して `finally` で落とす」temp 表だが、
 *   こちらは**客の DB そのものに 1 回だけ**作る(sqlite guest と同じ寿命 ──
 *   選び直すか窓を閉じるまで残る)。同じ関数に条件を足すと、
 *   「いつ落とすか」が 2 つの異なる寿命で混線する。
 */
function createGuestTable(database: Database, t: GuestTable): void {
  const cols = t.columns.map((c) => `"${c}" TEXT`).join(', ');
  database.exec({ sql: `CREATE TABLE "${t.name}" (${cols})` });
  const marks = t.columns.map(() => '?').join(', ');
  const insert = `INSERT INTO "${t.name}" VALUES (${marks})`;
  for (const row of t.rows) database.exec({ sql: insert, bind: [...row] });
}

/**
 * 🔴 **取り込んだ `.sqlite` の接続**(#681 段③ の 2 つ目)。
 *
 * ⚠ **ノートの DB とは別**である(issue の指示「混ぜない」)── 同じ接続へ
 *   `ATTACH` すると、打ち間違い 1 つで**こちらの表と向こうの表が混ざる**。
 * ⚠ `:memory:` に画像を流し込む形なので、**書いてもどこにも残らない**
 *   (客の file を書き換えない)。
 * 🔴 **常駐メモリを食う**ので、外したら必ず閉じる(不可侵指示 2026-07-27
 *   「生成とライフサイクル後の速やかな破棄」)。
 *
 * 🔴 **窓ごとに 1 つ持つ**(#836、2026-09-09)。
 *
 * ⚠ 直す前は `let guestDb` の**1 つだけ**だった ── SQL の面は同じタイルを
 *   2 回押せば 2 枚開く(#300 段③ の裁定)ので、**2 枚目が開いた瞬間に 1 枚目の
 *   客が閉じられていた**。1 枚目の選び所も上の行も `売上.sqlite` と言ったまま、
 *   返る中身は 2 枚目の `顧客.db` である ── この面がいちばん恐れている
 *   「ノートを数えたつもりで、よその DB を数えていた」が、そのまま起きていた。
 * 🔑 鍵は**窓の合言葉**(`store-port.ts` が窓ごとに 1 回だけ作る)。
 * ⚠ 窓が閉じたことは worker へ届かないので、上限(`GUEST_MAX`)で押し出す。
 */
const guestDbs = new Map<string, Database>();

/**
 * 同時に抱える客の上限(#836)。
 *
 * 🔴 **窓が閉じたことは worker に届かない** ── follower の窓を × で閉じても
 *   `closeSqlGuest` は飛ばない(飛ばす口が無い)。だから**上限で押し出す**。
 * ⚠ 押し出された窓は、次に走らせたとき「取り込んだ .sqlite が開かれていません
 *   (先に選んでください)」と**言われる** ── 黙って別の DB の中身を返すより
 *   はるかに良い(直す前は後者だった)。
 * 🔑 4 は「見比べる」に足りて、常駐メモリの上限が読める数である
 *   (取り込んだ DB は `:memory:` に展開されるので、枚数がそのまま積む)。
 */
const GUEST_MAX = 4;

/** 客の DB を 1 つ閉じて手放す。⚠ **二度呼ばれても落ちない**(外す口は 2 つある)。 */
/**
 * 🔴 **窓ごとの世代**(#1087)。閉じるたびに進める ── `openSqlGuest` は途中で待つ(xlsx を解く)ので、
 *   待つ間に同じ窓で選び直す / 外すと、後から来た古い回が新しい客を上書きして閉じずに残していた
 *   (常駐メモリ。しかも以後の問い合わせが、画面と違う相手へ飛ぶ)。
 */
const guestGen = new Map<string, number>();

/** 開けた客を窓に置く。⚠ 待つ間に世代が進んでいたら(選び直し・外した)、自分を閉じて置かない。 */
function registerGuest(key: string, gen: number, db: Database): void {
  if ((guestGen.get(key) ?? 0) !== gen) {
    db.close();
    return;
  }
  guestDbs.set(key, db);
}

function closeGuest(key: string): void {
  guestGen.set(key, (guestGen.get(key) ?? 0) + 1);
  const db = guestDbs.get(key);
  guestDbs.delete(key);
  try {
    db?.close();
  } catch {
    // ⚠ 閉じられなくても、参照は手放した(次に開くときは作り直す)
  }
}

/** 客を全部畳む(worker を閉じるとき)。 */
function closeAllGuests(): void {
  for (const key of [...guestDbs.keys()]) closeGuest(key);
}

/**
 * 客の DB。⚠ **開いていないのに打たれたら断る**(黙って本体を返さない)。
 * ⚠ **別の窓の客も返さない**(#836)── 合言葉が違えば「開かれていません」である。
 */
function needGuest(key: string): Database {
  const db = guestDbs.get(key);
  if (db === undefined) {
    throw new Error('取り込んだ .sqlite が開かれていません(先に選んでください)');
  }
  return db;
}

/**
 * 🔴 **客の `.sqlite` の「user の表」の名前を引く 1 文**(客を開く口。案内に並ぶ名前になる)。
 *
 * ⚠ **`_` は `LIKE` で任意の 1 字**である ── `NOT LIKE 'sqlite_%'` は `sqlitedata` のような
 *   **user の表まで黙って外した**(着地後のレビューで出た)。内部の表(`sqlite_sequence` 等)だけを
 *   外すために `\_` で逃がし、`ESCAPE` を明示する。
 * 🔴 **本文検索(FTS5)の影の表は外す**(`NOT_FTS_SHADOW`。着地後レビュー ⚠2)── 案内に `docs_data` / `docs_idx` が並び、
 *   書いてあるとおり DuckDB で打つと `no such table` だった。⚠ **仮想表本体(`docs`)は残す** ──
 *   内蔵の sqlite は `select` で引ける(DuckDB へ写す口 `EXPORT_TABLE_NAMES_SQL` は本体も外す)。
 */
const USER_TABLE_NAMES_SQL =
  `SELECT m.name AS name FROM sqlite_schema m WHERE m.type = 'table' AND ${NOT_SQLITE_INTERNAL_SQL}` +
  `${NOT_FTS_SHADOW} ORDER BY m.name`;

/**
 * 🔴 **DuckDB へ写す表の名前を引く 1 文**(#682 段④d の着地後レビュー)。
 *
 * ⚠ 客を開く口(`USER_TABLE_NAMES_SQL`)と**同じ判定**(`sqlite_` の内部の表を外す)に**もう 1 つ足す**:本文検索(FTS5)の
 *   **仮想表本体も**外す(客を開く口は影の表だけ外し、本体は残す ── 内蔵の sqlite は引ける)。
 *   直す前は影の表が全部 DuckDB へ写り、user の表と並んで出ていた(構造を採る側 `SCHEMA_COLUMNS_SQL` は #967 で外している)。
 * 🔑 判定は `NOT_FTS_BACKSTAGE` **1 本**(`schema-digest.ts`)── 「仮想表の影であること」で見る
 *   (名前が `_data` で終わるだけの user の表は残る)。⚠ 本体は**写さなかったと言う**(`openSqliteExport` の `ftsTables`)。
 */
const EXPORT_TABLE_NAMES_SQL =
  `SELECT m.name AS name FROM sqlite_schema m WHERE m.type = 'table' AND ${NOT_SQLITE_INTERNAL_SQL}` +
  `${NOT_FTS_BACKSTAGE} ORDER BY m.name`;

/**
 * 🔴 **ビューの名前を引く 1 文**(写さないので、**写さなかったと言う**ために要る)。
 * ⚠ ビューは中身が別の表への問い合わせで、行を持たない ── 写すと「元の表が変わっても古い行のまま」の偽物になる。
 */
const EXPORT_VIEW_NAMES_SQL =
  `SELECT m.name AS name FROM sqlite_schema m WHERE m.type = 'view' AND ${NOT_SQLITE_INTERNAL_SQL} ORDER BY m.name`;

/**
 * 🔴 **写しを取っている最中の `.sqlite`**(#682 段④d。**表ごとに写すので、開いたまま次の依頼を待つ**)。
 *
 * ⚠ **客の DB(`guestDbs`)とは別の入れ物** ── 窓の客を押し出さず、窓の合言葉も要らない。
 * 🔴 **開いたのは必ず閉じる**(呼び側 `DuckDbRunner.load` の `finally` が `closeSqliteExport` を呼ぶ)。
 *   ⚠ 呼び側が落ちて閉じ損ねても溜まり続けないよう**上限(下)で古い物から畳む**(`closeGuest` の押し出しと同じ作法)。
 */
const exportDbs = new Map<string, Database>();
let exportSeq = 0;
/**
 * 同時に開いておく写しの上限。🔑 器へ並べる `.sqlite` の枚数(表の名前を決めるため**全部を先に開く**)に足りる数で、
 *   常駐メモリの上限が読める数(各枚が `:memory:` に展開される)。
 */
const EXPORT_MAX = 8;

function closeExport(session: string): void {
  const db = exportDbs.get(session);
  exportDbs.delete(session);
  try {
    db?.close();
  } catch {
    // ⚠ 閉じられなくても、参照は手放した
  }
}

function closeAllExports(): void {
  for (const k of [...exportDbs.keys()]) closeExport(k);
}

/**
 * 🔴 **1 回に続けて読む長さ(ms)**。これを超えたら**他の依頼に順番を譲る**(`exportOneTable`)。
 *
 * 実測(2026-10-03、100k 行 = NDJSON 30.7MB の表):読み切るまで **約 0.75〜0.8 秒**、その間この worker の
 *   他の依頼(ノートの保存・検索)は**1 件も返らない**(worker は 1 本の同期の処理で、写しの符号化は
 *   DB の錠を握る側にある)。🔑 100 ms を超えたので、**行を読む途中でも区切る**
 *   (1 表の間に他の依頼が割り込める。表と表の間は、呼び側が 1 表ずつ頼むので元から割り込める)。
 * ⚠ 小さいほど割り込みは早いが、譲るたびに `setTimeout` の待ちが入るので写しそのものは遅くなる
 *   (20 ms ごとに 1〜4 ms)。25 ms は「保存を押して待たされたと感じない」長さに足りる。
 */
const EXPORT_SLICE_MS = 25;

/** 他の依頼に順番を譲る(待っているメッセージが先に処理される)。 */
const yieldToQueue = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 🔴 **`.sqlite` の表 1 つを NDJSON にする**(#682 段④d)。⚠ 投げない ── 読めなかった表は
 *   `refused` に理由を載せて返す(他の表を巻き込まない)。
 * 🔴 **途中で他の依頼に順番を譲る**(`EXPORT_SLICE_MS`)── 大きい表を 1 回で読み切ると、その間この worker の
 *   保存・検索が全部待たされる。⚠ 譲っている間に**この写しが閉じられる**(`close` / 押し出し)ことがあるので、
 *   譲るたびに `alive()` を確かめる(閉じた器を読み続けない)。
 *
 * 🔑 **列は `PRAGMA table_xinfo` から採る**(行からではない)── 行から採ると**空の表で列が消える**。
 *   ⚠ 隠し列(`hidden = 1`)は `SELECT *` にも出ないので**除く**。生成列(2 / 3)は出るので入れる。
 */
async function exportOneTable(
  database: Database,
  name: string,
  maxBytes: number,
  alive: () => boolean,
): Promise<SqliteExportedTable> {
  const fail = (
    columns: readonly SqliteColumnShape[],
    why: string,
    fks: readonly SqliteExportFk[] = [],
  ): SqliteExportedTable => ({
    name,
    columns,
    fks,
    ndjson: null,
    rows: 0,
    asText: false,
    refused: why,
  });
  let columns: SqliteColumnShape[];
  try {
    columns = (
      database.selectObjects(`PRAGMA table_xinfo(${quoteIdent(name)})`) as unknown as Array<{
        name: string;
        type: string;
        hidden: number;
        notnull: number;
        pk: number;
      }>
    )
      .filter((c) => c.hidden === 0 || c.hidden === 2 || c.hidden === 3)
      .map((c) => ({ name: c.name, type: c.type, notNull: c.notnull === 1, primaryKey: c.pk !== 0 }));
  } catch (e) {
    return fail([], `列を読めませんでした: ${String(e)}`);
  }
  if (columns.length === 0) return fail([], '読める列がありません');
  /**
   * 🔴 **外部キー**(#918 段⑦の続き)。⚠ **読めなくても表は写す**(構造の線が欠けるだけ ──
   *   線のために行の写しまで断らない)。`id` / `seq` 順 = 構造を採る sqlite 側(`SCHEMA_FK_SQL`)と同じ並び。
   */
  let fks: SqliteExportFk[];
  try {
    fks = (
      database.selectObjects(
        'SELECT "table" AS ref, "from" AS col, "to" AS refcol FROM pragma_foreign_key_list(?) ORDER BY id, seq',
        [name],
      ) as unknown as Array<{ ref: string; col: string; refcol: string | null }>
    ).map((f) => ({ fromColumn: f.col, toTable: f.ref, toColumn: f.refcol ?? '' }));
  } catch {
    fks = [];
  }
  const keys = ndjsonKeysOf(columns.map((c) => c.name));
  const out = new NdjsonCollector(maxBytes);
  // 🔴 型へ写すと値が黙って変わる行(小数の入った INTEGER 列 / Infinity / 2^53 超)を読みながら見つける
  const watch = new LossyWatch(columns);
  /**
   * ⚠ `exec` の callback ではなく **`prepare` / `step`** で読む ── callback の中では `await` できず、
   *   途中で他の依頼に順番を譲れない。`stmt.get([])` は `exec` の `rowMode: 'array'` と同じ値の変換
   *   (大きい整数は `bigint` / BLOB は `Uint8Array`)をする。
   */
  let stmt: ReturnType<Database['prepare']> | null = null;
  try {
    stmt = database.prepare(
      `SELECT ${columns.map((c) => quoteIdent(c.name)).join(', ')} FROM ${quoteIdent(name)}`,
    );
    let sliceStart = performance.now();
    let n = 0;
    while (stmt.step()) {
      const row = stmt.get([]) as unknown[];
      watch.see(row);
      // ⚠ 天井を超えたら、ここで読むのをやめる(全行を読み切らない)
      if (!out.push(ndjsonLineOf(keys, row))) break;
      n += 1;
      // 🔑 時計を見るのは 256 行ごと(毎行だと時計の呼び出しが読む時間に響く)
      if ((n & 255) === 0 && performance.now() - sliceStart >= EXPORT_SLICE_MS) {
        await yieldToQueue();
        if (!alive()) {
          return fail(columns, '読み込みの途中で閉じられました(もう一度押してください)', fks);
        }
        sliceStart = performance.now();
      }
    }
  } catch (e) {
    return fail(columns, `行を読めませんでした: ${String(e)}`, fks);
  } finally {
    try {
      stmt?.finalize();
    } catch {
      // ⚠ 器ごと閉じられていたら、文はもう手放されている(`close` が畳む)
    }
  }
  /**
   * ⚠ **`finish()` の後で天井を見る** ── 天井は束ねるごと(約 1 MiB か 1000 行)の符号化で数えるので、それに満たない表は
   *   `finish()` が最後の 1 束を符号化して**初めて**超えたと分かる(先に見ると、小さい天井を素通りする)。
   */
  const ndjson = out.finish();
  if (out.exceeded) return fail(columns, tooBigReason(maxBytes), fks);
  return { name, columns, fks, ndjson, rows: out.rows, asText: watch.lossy, refused: null };
}

/**
 * 🔴 **器 1 つぶんの行を、全部の表から消す**(#1455)── 器の削除と、人に渡す画像から他の器を除く処理が同じ 1 本を通る。
 * 消す表は `CID_SCOPED_TABLES`(旧版・つながり・添付の目録まで)+ タグの色(`settings` の区画)+ `containers` の行。
 * ⚠ 呼び側が transaction を握っている前提(ここでは開かない)。
 */
function deleteContainerRows(database: Database, cid: string): void {
  for (const table of CID_SCOPED_TABLES) {
    database.exec({ sql: `DELETE FROM ${table} WHERE cid = ?`, bind: [cid] });
  }
  database.exec({ sql: 'DELETE FROM settings WHERE scope = ?', bind: [tagColorScope(cid)] });
  database.exec({ sql: 'DELETE FROM settings WHERE scope = ?', bind: [notePinScope(cid)] });
  database.exec({ sql: 'DELETE FROM containers WHERE cid = ?', bind: [cid] });
}

/**
 * 🔴 **メッセージ(・処理の記録)の行を除いた状態で `make` を走らせる**(台帳 #1852 束 L1。依頼 216 / 344)。
 *
 * ⚠ 人に渡す PKC3 入り HTML に、送り主の知らせ(使った機能と時刻)を入れない。
 * 🔑 **除く操作は確定させない** ── 書き込みの transaction の中で行を消し、その状態の画像を作ってから **ROLLBACK** する。
 *   消した事実が disk に確定する瞬間が無いので、途中でタブやワーカーが落ちても**メッセージは 1 件も減らない**
 *   (直す前は、消して確定 → 書き出し → 入れ直す の形で、間で落ちると消えたままになった)。
 * ⚠ `sqlite3_serialize` は pager を通してページを読むので、transaction の中の(まだ確定していない)状態が画像に入る。
 * ⚠ 除いた行の名残が空きページに残らないよう、除く間だけ `secure_delete` を入れる(元の値へ戻す)。
 */
function withMessagesRemoved<T>(make: () => T, keepCid?: string): T {
  const database = need();
  const lids = [SYSTEM_MESSAGE_LID, SYSTEM_JOB_LID];
  const has = database.selectValue(
    `SELECT count(*) FROM entries WHERE realm = 'system' AND lid IN (?, ?)`,
    lids,
  ) as number | undefined;
  /**
   * 🔴 **使っているワークスペース以外も除く**(#1455)。人に渡すファイルに、ほかのワークスペース(仕事用 /
   * 個人用 …)のノートを 1 件も入れない。除く物と除き方はメッセージと同じ(確定させず ROLLBACK する)。
   */
  /**
   * 🔴 **残す器は、呼んだタブの器**(`keepCid`。レビュー 🔴2)。⚠ 「次に開く器の印」(`activeContainerCid`)ではない ──
   *   別のタブで切り替えの印だけが動いた後は、印 ≠ このタブが開いている器になる。印で残すと、**書き出す人が見ている器ではなく
   *   別の器**が人に渡るファイルに入る。渡されなければ(古い呼び側)印で決める。
   */
  const active = keepCid ?? activeContainerCid(database);
  if (keepCid !== undefined && database.selectValue('SELECT count(*) FROM containers WHERE cid = ?', [keepCid]) === 0) {
    throw new Error('書き出すワークスペースが見つかりません(開き直してください)');
  }
  const others =
    active === undefined
      ? []
      : (database.selectObjects('SELECT cid FROM containers WHERE cid <> ?', [active]) as Array<{ cid: string }>).map(
          (r) => String(r.cid),
        );
  if ((has === undefined || has === 0) && others.length === 0) return make();
  const secure = database.selectValue('PRAGMA secure_delete') as number | undefined;
  database.exec('PRAGMA secure_delete = ON');
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec({ sql: `DELETE FROM entries WHERE realm = 'system' AND lid IN (?, ?)`, bind: lids });
      for (const cid of others) deleteContainerRows(database, cid);
      return make();
    } finally {
      database.exec('ROLLBACK');
    }
  } finally {
    database.exec(`PRAGMA secure_delete = ${secure === 1 ? 'ON' : 'OFF'}`);
  }
}

/**
 * 🔴 **選んだノートだけの DB 画像を作る**(#1038 A2)。
 *
 * 🔑 本体の DB は**読むだけ**(書かない・消さない)。新しい `:memory:` の DB に `applySchema` を当て、
 *   SQL の `INSERT … SELECT` の代わりに 1 行ずつ `step` → 束縛で写す(本文を worker の配列に貯めない)。
 *   写す物: コレクションの行 / `lids` のノート / 両端が `lids` に居るつながり / `assetKeys` の添付の目録。
 *   ⚠ 写さない物: 履歴・ゴミ箱(`revisions`)/ メッセージと処理の記録 / 設定(受け手の既定から始まる)。
 * 🔑 作った DB は画像にしたらすぐ閉じる(生成物の即破棄)。
 */
function subsetImage(only: { cid: string; lids: string[]; assetKeys: string[] }): Uint8Array {
  const api = sqliteApi;
  if (api === null) throw new Error('sqlite が初期化されていません');
  const src = need();
  const oo1 = (api as unknown as { oo1: { DB: new (name: string) => Database } }).oo1;
  const dst = new oo1.DB(':memory:');
  try {
    applySchema(dst);
    const lids = JSON.stringify(only.lids);
    const keys = JSON.stringify(only.assetKeys);
    const copy = (table: string, where: string, bind: unknown[]): number => {
      const cols = (
        dst.selectObjects(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`) as Array<{ name: string }>
      ).map((c) => `"${c.name}"`);
      const ins = dst.prepare(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      );
      const sel = src.prepare(`SELECT ${cols.join(', ')} FROM ${table} WHERE ${where}`);
      let n = 0;
      try {
        sel.bind(bind as never);
        while (sel.step()) {
          ins.bind(sel.get([]) as never);
          ins.step();
          ins.reset(true);
          n += 1;
        }
      } finally {
        sel.finalize();
        ins.finalize();
      }
      return n;
    };
    dst.exec('BEGIN IMMEDIATE');
    try {
      copy('containers', 'cid = ?', [only.cid]);
      copy(
        'entries',
        'cid = ? AND lid IN (SELECT value FROM json_each(?))',
        [only.cid, lids],
      );
      copy(
        'relations',
        'cid = ? AND from_lid IN (SELECT value FROM json_each(?)) AND to_lid IN (SELECT value FROM json_each(?))',
        [only.cid, lids, lids],
      );
      copy('assets', 'cid = ? AND key IN (SELECT value FROM json_each(?))', [only.cid, keys]);
      dst.exec('COMMIT');
    } catch (e) {
      dst.exec('ROLLBACK');
      throw e;
    }
    return runImageExport((a, ptr) => exportDbImage(a, ptr), dst);
  } finally {
    try {
      dst.close();
    } catch {
      // ⚠ 閉じられなくても、参照は手放す
    }
  }
}

/**
 * 🔴 **DB 画像を作る処理の外側**(#971 段④の残り / #1416)── `exportImage` が通る **1 か所**(確保の失敗を言い直す作法)。
 *
 * ⚠ ここは **DB を丸ごと**配列にするので、wasm(32bit)では数 GB を確保できない ──
 *   user の保存領域が 4GB を超えたとき、**必ずここで詰まる**。直す前は素の error がそのまま出ていた。
 * 🔑 **先回りして断らない** ── 確保できる上限は端末で変わるので、測っていない数で門を作ると
 *   **通ったはずの端末で通らなくなる**。試して、失敗したときだけ**代わりの道**(一式の書き出し)へ送る。
 */
function runImageExport<T>(
  make: (api: Parameters<typeof exportDbImage>[0], pointer: unknown) => T,
  target?: Database,
): T {
  const api = sqliteApi;
  if (api === null) throw new Error('sqlite が初期化されていません');
  const database = target ?? need();
  let size: number | null = null;
  try {
    const pages = database.selectValue('PRAGMA page_count') as number | undefined;
    const per = database.selectValue('PRAGMA page_size') as number | undefined;
    if (typeof pages === 'number' && typeof per === 'number') size = pages * per;
  } catch {
    // ⚠ 測れなかった = 断る理由にしない(下で `null` として扱う)
  }
  try {
    return make(
      api as unknown as Parameters<typeof exportDbImage>[0],
      (database as unknown as { pointer: unknown }).pointer,
    );
  } catch (e) {
    if (looksOutOfMemory(e)) throw new Error(imageTooBigMessage(size), { cause: e });
    throw e;
  }
}

/**
 * 🔴 **壊れていても読める分だけ拾う、共通の走査**(#971 段③ / #1087)。
 *
 * ⚠ **表名は呼び側の定数だけ**(user の字を SQL に通さない)。⚠ 必ず `NOT INDEXED`。
 * ⚠ **落ちた区画は飛ばして次へ進む**。⚠ `got`(区画に何か在ったか)は **raw の行数** ──
 *   呼び側が `take` で除外しても数え直さない(壊れの診断を汚さない)。
 */
function rescueScan(
  database: Database,
  opts: {
    readonly table: 'entries' | 'relations' | 'revisions';
    readonly columns: string;
    readonly afterRowid: number | undefined;
    readonly chunks: number | undefined;
    readonly take: (r: unknown[]) => void;
  },
): { lastRowid: number; skipped: number; empty: number; maxRowid: number | null; done: boolean } {
  const after = Math.max(0, Math.floor(opts.afterRowid ?? 0));
  const chunks = Math.max(1, Math.min(Math.floor(opts.chunks ?? 20), 200));
  /**
   * ⚠ 読めなければ `null` ── 進み具合が出せないだけで、拾うのは続けられる。
   * ⚠ `catch` で `null` を代入し直さない(初期値のまま) ── lint が
   *   「使われない代入」として落とす。
   * 🔴 `null` のままだと `done` が立たない ── 呼び側(`collectRescued` など)が
   *   「何も拾えない周が続いたら打ち切る」で守る(#1087)。
   */
  let maxRowid: number | null = null;
  try {
    const v = database.selectValue(`SELECT max(rowid) FROM ${opts.table} NOT INDEXED`);
    maxRowid = v === null || v === undefined ? 0 : Number(v);
  } catch {
    /* 読めない = 進み具合を出さない(拾うのは続ける) */
  }
  let skipped = 0;
  let empty = 0;
  let lo = after + 1;
  for (let c = 0; c < chunks; c += 1) {
    const hi = lo + RESCUE_CHUNK - 1;
    let got = 0;
    try {
      database.exec({
        sql: `SELECT ${opts.columns} FROM ${opts.table} NOT INDEXED WHERE rowid BETWEEN ? AND ?`,
        bind: [lo, hi],
        rowMode: 'array',
        callback: (r: unknown[]): void => {
          got += 1;
          opts.take(r);
        },
      });
    } catch {
      // ⚠ ここで throw しない ── 飛ばして先へ進むのが、この op の存在理由である
      skipped += 1;
    }
    if (got === 0) empty += 1;
    lo = hi + 1;
    if (maxRowid !== null && lo > maxRowid) break;
  }
  const lastRowid = lo - 1;
  return {
    lastRowid,
    skipped,
    empty,
    maxRowid,
    done: maxRowid !== null && lastRowid >= maxRowid,
  };
}

const handlers: Handlers = {
  init: (req) => init(req.dbName, req.journalMode, { memory: req.memory, image: req.image }),
  /**
   * 🔴 **いまの DB を 1 枚の画像にする**(#400 段③④)。
   *
   * 🔑 **VFS を問わない**(2 稿目で広げた)── 1 稿目は `:memory:` に限っていたが、
   * それだと**書き出し(段④)が使えない**。ふだんの PKC3 は OPFS なので、
   * そこから画像を出せなければ「持ち歩ける 1 枚」を焼けない。
   * ⚠ 画像は**正本ではなく、配る 1 枚の中身**である ── 出したところで
   *   「どちらが正本か」は増えない(器はここに在り続ける)。
   */
  /**
   * 🔴 **入れ物ごと捨てる**(#986 段③)。⚠ **取り消せない。**
   *
   * ## 順番が肝である
   *
   * 1. **DB を閉じる** ── 開いたまま file を捨てると、SAHPool が掴んだままになる。
   *    ⚠ **閉じるのが失敗しても進む** ── 壊れた DB は閉じる操作すら落ちうるが、
   *    ここで止めると**壊れているときだけ捨てられない**(= いちばん要る場面で効かない)。
   * 2. **module の控えを落とす** ── 残すと、この後の op が死んだ口を触る。
   * 3. **file を捨てる**(`wipeFiles`)── SQL を 1 文も打たない。
   *
   * ⚠ この後 worker は**何にも答えられない**。呼び側が読み込み直すのが前提である。
   */
  wipeStorage: async () => {
    /**
     * 🔴 **ほかのワークスペースが居るとき、全部を消す操作は通さない**(#1455)。「作り直す」「初期化する」は
     * DB のファイルごと捨てる ── 使っている 1 つのつもりで、ほかのワークスペースまで消える。
     * ⚠ 壊れた DB は数えられないことがある ── その場合は断らない(壊れを直す道を塞がない)。
     */
    try {
      const n = db?.selectValue('SELECT count(*) FROM containers') as number | undefined;
      if (typeof n === 'number' && n > 1) {
        throw new WorkspacesRemainError();
      }
    } catch (e) {
      if (e instanceof WorkspacesRemainError) throw new Error(WORKSPACES_REMAIN_MESSAGE, { cause: e });
    }
    const pool = sahPool;
    if (pool === null) {
      /**
       * ⚠ **失敗ではない。** OPFS が使えない端末では DB は `:memory:` に在るので、
       *   読み込み直せば消える ── 捨てる file がそもそも無い。
       * 🔑 それを**そのまま言う** ── 「消えました」と嘘をつかない。
       */
      return {
        wiped: false,
        note: 'この端末では中身がメモリ上にあります(読み込み直すと消えます)',
      };
    }
    try {
      db?.close();
    } catch {
      // ⚠ 壊れた DB は閉じる操作も落ちうる ── 捨てる邪魔をさせない
    }
    db = null;
    initResult = null;
    await pool.wipeFiles();
    return { wiped: true, note: null };
  },
  exportImage: (req) => ({
    /**
     * 🔴 **複製を 1 枚減らす**(#1416)── 判断は `db-image-export.ts`。memdb なら sqlite に
     *   画像の複製を作らせず、wasm heap から直に写す(wasm heap は一度広がると縮まない)。
     */
    image:
      req.only !== undefined
        ? subsetImage(req.only)
        : req.withoutMessages === true
        ? withMessagesRemoved(() => runImageExport((api, ptr) => exportDbImage(api, ptr)), req.keepCid)
        : runImageExport((api, ptr) => exportDbImage(api, ptr)),
  }),
  /**
   * 🔴 **user が打った SQL を、読むだけで走らせる**(#681 段②)。
   *
   * ⚠ 安全は**字ではなく engine** に置く(protocol の注記) ── ここが境である。
   * 🔑 通す門は 2 つで、**どちらも `finally` で必ず戻す**:
   * ① `PRAGMA query_only` ── 戻し損ねると、この面を 1 度開いた user は
   *    **以後ノートを保存できない**(同じ接続なので)
   * ② 進み具合の見張り ── 戻し損ねると、**以後の全部の問い合わせ**が
   *    身に覚えのない中断を受ける
   *
   * ⚠ **見張りを張れない環境では走らせない** ── 張れないまま走らせると、
   *   終わらない 1 行で**保存ごと固まる**(このワーカーは DB の lease を握っている)。
   *   ⚠ 「たぶん軽いから」で通さない ── 軽いかどうかは打つ前に分からない。
   */
  runReadOnlySql: (req) => {
    /**
     * 🔴 **打つ先は 1 か所で決める**(#681 段③ の 2 つ目)。
     * ⚠ 既定は**この PKC の DB** ── 取り違えると「ノートを数えたつもりで
     *   よその DB を数えていた」になる(いちばん気づけない外し方)。
     */
    const guest = req.guest !== undefined;
    const database = req.guest === undefined ? need() : needGuest(req.guest);
    const api = sqliteApi;
    if (api === null) throw new Error('sqlite が初期化されていません');
    const install = api.wasm['installFunction'] as unknown as
      | ((sig: string, fn: () => number) => number)
      | undefined;
    const uninstall = api.wasm['uninstallFunction'] as unknown as
      | ((p: number) => void)
      | undefined;
    const setProgress = api.capi['sqlite3_progress_handler'] as unknown as
      | ((db: unknown, n: number, fn: number, arg: number) => void)
      | undefined;
    if (install === undefined || setProgress === undefined) {
      throw new Error('このバージョンでは問い合わせを止められないので実行しません');
    }
    const pointer = (database as unknown as { pointer: unknown }).pointer;
    const started = Date.now();
    let steps = 0;
    /**
     * 🔴 **1 つの値の大きさに天井を置く**(`SQLITE_LIMIT_LENGTH` = 0)── `zeroblob(300000000)` や
     *   `printf('%.*c', 200000000, 'a')` のような 1 つの巨大な値は、engine が先に全部を確保してしまい、
     *   升ごとの字数の天井(`MAX_CELL_CHARS`)は**取り出した後**にしか効かない。
     * ⚠ この接続は**保存にも使う**ので、**終わったら必ず元の値へ戻す**(`finally`)。
     * ⚠ `sqlite3_limit` が無い版では天井なしで走る(機能が減るだけ ── 止めない)。
     */
    const setLimit = api.capi['sqlite3_limit'] as unknown as
      | ((db: unknown, id: number, v: number) => number)
      | undefined;
    let oldLength: number | null = null;
    /**
     * 🔑 **0 以外を返した瞬間に `SQLITE_INTERRUPT`** になる(実測済み)。
     *
     * 🔴 **歩数と実時間の 2 つで切る**(2026-09-09 の着地前レビュー、実測で判明)。
     * ⚠ 初稿は歩数だけだった ── **1 歩の重さが 7 倍以上ぶれる**ので、同じ上限でも
     *   止まるまでの実時間が桁で違う:
     *
     *   | 打った物 | 見張りの回数 | 実時間 | 1 回あたり |
     *   |---|---|---|---|
     *   | 再帰 300 万行を**返す** | 54,000 | 5.6 秒 | 0.104 ms |
     *   | 再帰 300 万行を**数える** | 51,000 | 0.73 秒 | 0.014 ms |
     *
     * 🔴 なぜ実時間が要るか:この面を**別窓**で開いた user は follower なので、
     *   本体タブへの依頼は **10 秒**で諦める(`store-proxy.ts` の `REQUEST_TIMEOUT_MS`)。
     *   ⚠ そこを越えると、面には「**メインのタブと通信できません**」という**嘘**が出る
     *   (本体は生きていて、user 自身の問い合わせで塞がっているだけ)。
     *   しかも問い合わせは走り続けるので、**その間ノートの保存が進まない**。
     * ⚠ だから engine 側が**必ず先に**止まる ── 上限は呼び側が引いて渡す。
     */
    const fn = install('i(p)', () => {
      steps += 1;
      if (Date.now() - started > req.maxMs) return 1;
      return steps > req.maxSteps ? 1 : 0;
    });
    /**
     * ⚠ **2 つとも `try` の中で張る** ── 外で張ると、張った直後に例外が出た回に
     *   `finally` が回らず、**張りっぱなしのまま**この worker が生き続ける
     *   (= 以後ノートを保存できない / 身に覚えのない中断を受ける)。
     */
    /**
     * 組み立てた temp の表(`finally` で必ず落とす)。
     * 🔴 **控えは呼び側が持つ**(2026-09-09、変異試験で判明)── 組み立ての途中で
     *   投げた回に、**そこまでに作った表が落ちない**形になっていた(断りが出る
     *   大きな表で実際に残った)。積む先を渡せば、投げても `finally` が拾う。
     */
    const made: string[] = [];
    try {
      /**
       * 🔴 **`query_only` を掛ける前に組み立てる**(#681 段③)── temp の表を
       *   作るのも engine から見れば書き込みなので、掛けた後では作れない。
       * ⚠ 見張りもまだ張っていない ── 組み立ての重さは
       *   `CSV_TABLE_CELLS_MAX` が断る(見張りでは切れない)。
       */
      /**
       * ⚠ **本文の csv は、この PKC の側にしか組み立てない** ── 客の DB は
       *   別の器なので、そこへノートの表を混ぜると「どちらの話か」が消える。
       */
      if (!guest) buildCsvTables(database, req.sql, made);
      database.exec({ sql: 'PRAGMA query_only = 1' });
      setProgress(pointer, PROGRESS_EVERY, fn, 0);
      if (setLimit !== undefined) oldLength = setLimit(pointer, SQLITE_LIMIT_LENGTH, SQL_MAX_VALUE_BYTES);
      const columns: string[] = [];
      const rows: Array<Array<string | number | null>> = [];
      /**
       * 🔴 **運んだ字の合計に天井を置く**(1 行ずつ積みながら数える)。
       * ⚠ 行数(`maxRows`)と升ごとの字数(`MAX_CELL_CHARS`)の**積**は桁違いに大きい ──
       *   2000 字 × 6 列 × 9 万行で、timeout の前に常駐 worker が約 900 MB に膨らんだ(実測)。
       *   行数の天井は「短い升の表」のための値で、長い字の表には効かない。
       * 🔑 数えるのは字数(`length`)── 数や NULL も 1 と数える(列が千もある表の行数ぶんの重さ)。
       */
      let chars = 0;
      let overBudget = false;
      /**
       * ⚠ **1 件多く取って切れたか判る**(`searchEntries` と同じ作法)。
       * ⚠ 値は `postMessage` に載る形だけにする ── BLOB(`Uint8Array`)は
       *   **中身を運ばない**(画面に出しても読めないし、heap に載せる理由が無い)。
       */
      database.exec({
        sql: req.sql,
        rowMode: 'array',
        columnNames: columns,
        callback: (row: unknown[]) => {
          /**
           * 🔴 **`false` を返して `exec` を止める**(2026-09-09 実測)。
           * ⚠ 初稿は `return;` だった ── 同梱の `oo1.DB.exec` は
           *   **`false === callback(...)` のときだけ `break`** するので、
           *   `undefined` では**回り続ける**。実測(100 万行を返す再帰 CTE、上限 500):
           *   `return;` = callback **100 万回 / 2030 ms** →
           *   `return false;` = **502 回 / 6 ms**。
           * ⚠ つまり上限が守っていたのは「**返す件数**」だけで、
           *   worker が止まる時間もメモリも 1 つも守っていなかった。
           */
          if (rows.length > req.maxRows) return false;
          const wire = row.map((v) => cellForWire(v));
          let cost = 0;
          for (const v of wire) cost += typeof v === 'string' ? Math.max(1, v.length) : 1;
          // ⚠ 超えた行は積まない(持つのは天井以内だけ)。⚠ 止めるのは `return false`(上の註記)
          if (chars + cost > SQL_MAX_TOTAL_CHARS) {
            overBudget = true;
            return false;
          }
          chars += cost;
          rows.push(wire);
          return undefined;
        },
      } as unknown as Parameters<Database['exec']>[0]);
      const truncated = rows.length > req.maxRows || overBudget;
      return {
        columns,
        rows: truncated ? rows.slice(0, req.maxRows) : rows,
        truncated,
        ms: Date.now() - started,
      };
    } finally {
      /**
       * ⚠ **順番が効く**:sqlite から**外してから**枠を解除する(逆にすると宙を指す)。
       * 🔴 **入れ子にする**(2026-09-09 の着地前レビュー)── 初稿は 3 文を並べて
       *   「どちらも必ず通る」と**書いていた**が、直列なので**前の 2 つが投げれば
       *   `query_only = 0` は飛ぶ**。飛んだ結果はこの file が上で書いているとおり
       *   「**この面を 1 度開いた user は以後ノートを保存できない**」である。
       * ⚠ **test は持っていない**(`setProgress` を投げさせる口がここには無い)──
       *   だから「これが無いと壊れる」ではなく「**戻し損ねの結果がいちばん重いので、
       *   最後尾に置かない**」と書いておく。
       */
      try {
        try {
          setProgress(pointer, 0, 0, 0);
          uninstall?.(fn);
        } finally {
          // 🔴 値の天井は**元へ戻す**(この接続は保存にも使う ── 戻し損ねるとノートが書けなくなる)
          if (setLimit !== undefined && oldLength !== null) {
            setLimit(pointer, SQLITE_LIMIT_LENGTH, oldLength);
          }
        }
      } finally {
        try {
          database.exec({ sql: 'PRAGMA query_only = 0' });
        } finally {
          /**
           * ⚠ **落とすのは `query_only` を戻した後** ── 落とすのも書き込みである。
           * ⚠ 例外は飲む ── ここで投げると、上の本当の理由が消える。
           *   ⚠ 残っても次の回の頭で `DROP … IF EXISTS` が落とすので、
           *   **古い中身が引ける**形にはならない(`buildCsvTables` の註記)。
           */
          for (const name of made) {
            try {
              database.exec({ sql: `DROP TABLE IF EXISTS temp."${name}"` });
            } catch {
              // 落とせなくても、次の回が作り直す前に落とす
            }
          }
        }
      }
    }
  },
  /**
   * 🔴 **取り込んだ `.sqlite` を開く**(#681 段③ の 2 つ目)。
   *
   * ⚠ **前の客は必ず閉じる** ── 開きっぱなしにすると、選び直すたびに
   *   常駐メモリが積み上がる(worker は DB の lease を握るので常駐する)。
   *   🔴 **これは test では殺せない**(変異試験 G3 が SURVIVED)── 閉じ忘れても
   *   **振る舞いは 1 つも変わらない**(答えは新しい客から返る)。正直に書くと、
   *   守っているのは**メモリだけ**で、それを外から観測する口はこの箱に無い
   *   (CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れるのを見る」)。
   *   ⚠ それでも残す ── 不可侵指示 2026-07-27「生成とライフサイクル後の速やかな破棄」。
   * ⚠ **中身を 1 回読む** ── `sqlite3_deserialize` は**でたらめな bytes でも
   *   rc = 0 を返す**ので、ここで読まないと「開けたのに打つと落ちる」になる
   *   (`init` の画像と同じ罠。同じ形で言い直す)。
   */
  openSqlGuest: async (req) => {
    const api = sqliteApi;
    if (api === null) throw new Error('sqlite が初期化されていません');
    // ⚠ **この窓の前の客だけ**を閉じる(ほかの窓の客は触らない ── #836)
    closeGuest(req.guest);
    const myGen = guestGen.get(req.guest) ?? 0;
    /**
     * 🔴 **上限を超えたら、いちばん古い客から押し出す**(#836)。
     * ⚠ `Map` は入れた順を保つので、先頭が最古である。
     * ⚠ **自分を入れる前に押し出す** ── 後だと、自分が最古のときに自分を畳む。
     */
    while (guestDbs.size >= GUEST_MAX) {
      const oldest = guestDbs.keys().next().value;
      if (oldest === undefined) break;
      closeGuest(oldest);
    }
    const oo1 = (api as unknown as { oo1: { DB: new (name: string) => Database } }).oo1;
    const db = new oo1.DB(':memory:');
    /**
     * 🔴 **添付の `.csv` / `.tsv` を開く**(#854 段①)。
     *
     * ⚠ **拡張子の判定はしない** ── `req.csv` の有無だけを見る(呼び側の
     *   `store-effects.ts` が既に見分けている。§7「判定を 2 か所に置かない」)。
     * ⚠ **重い処理はここ(worker)で完結させる**(不可侵指示)── bytes を
     *   main スレッドへ戻して組み立て直す形にしない。
     */
    const src = req.source;
    if (src !== undefined) {
      const note = { lid: src.lid, title: src.name };
      try {
        /**
         * ⚠ **`switch` で網羅する** ── 種類を足した人が枝を書き忘れたら
         *   `never` の代入で **tsc が落ちる**(`if` を並べると黙って素通りする)。
         */
        let built: { tables: readonly GuestTable[]; truncated: boolean; sjis?: boolean };
        switch (src.kind) {
          case 'csv': {
            // 🔴 文字コードを見分ける(UTF-8 固定だと Shift_JIS / UTF-16 が黙って文字化けする)
            const decoded = decodeImportTextInfo(req.image);
            const one = buildCsvAttachmentTable(decoded.text, src.lang, note, CSV_TABLE_CELLS_MAX);
            if (one === null) throw new Error('空か、区切りの見つかる行が 1 つもありません');
            built = { tables: [one], truncated: one.truncated, sjis: decoded.used === 'sjis' };
            break;
          }
          case 'xlsx': {
            // 🔴 zip を解くのはここ(worker)である ── bytes を主スレッドへ戻さない
            built = await readXlsxBook(req.image, note);
            break;
          }
          default: {
            const never: never = src;
            throw new Error(`知らない開き方です: ${JSON.stringify(never)}`);
          }
        }
        for (const t of built.tables) createGuestTable(db, t);
        registerGuest(req.guest, myGen, db);
        return {
          tables: built.tables.map((t) => t.name),
          bytes: req.image.byteLength,
          truncated: built.truncated,
          // 🔴 Shift_JIS と**推測**して読んだ回だけ(省略 = そうではない)
          ...(built.sjis === true ? { sjis: true } : {}),
        };
      } catch (e) {
        // ⚠ **読めなかった器も閉じる**(下の sqlite 側と同じ理由)
        db.close();
        throw new Error(`このファイルは ${src.kind} として読めませんでした(${errorText(e)})`, {
          cause: e,
        });
      }
    }
    try {
      deserializeInto(
        api as unknown as Parameters<typeof deserializeInto>[0],
        db,
        req.image,
      );
      const tables = (
        db.selectObjects(USER_TABLE_NAMES_SQL) as unknown as Array<{ name: string }>
      ).map((r) => r.name);
      registerGuest(req.guest, myGen, db);
      return { tables, bytes: req.image.byteLength, truncated: false };
    } catch (e) {
      /**
       * ⚠ **読めなかった器も閉じる**(同上 ── 変異試験 G4 も SURVIVED)。
       *   振る舞いは変わらないが、断った回に器が残るのは「速やかな破棄」の逆である。
       */
      db.close();
      throw new Error(`このファイルは sqlite の DB として読めませんでした(${errorText(e)})`, {
        cause: e,
      });
    }
  },
  /** 客の DB を手放す。⚠ 開いていなくても落ちない(押し所は常に在る)。 */
  closeSqlGuest: (req) => {
    closeGuest(req.guest);
    return null;
  },
  /**
   * 🔴 **取り込んだ `.sqlite` を開き、表の名前を返す**(#682 段④d。写しを取る 3 つの口の 1 つ目)。
   *
   * ⚠ **客の DB(`openSqlGuest`)とは別物** ── `guestDbs` へは入れない(窓の客を押し出さない)。
   *   開いたまま次の依頼(`exportSqliteTable`)を待ち、**呼び側が `closeSqliteExport` で閉じる**。
   * 🔴 **表ごとに分ける理由**:全部を 1 回で返すと、表が多い file は**全表ぶんの NDJSON が worker と main に
   *   同時に載る**(1 表の天井は在るが、合計の天井が無かった)。1 表ずつ「読む → 器へ入れる → 手放す」にすれば、
   *   同時に載るのは**1 表ぶん**で済む。⚠ そして**表と表の間で、この worker の他の依頼(保存・検索)が割り込める**。
   * ⚠ 投げるのは**file そのものが DB として読めないとき**だけ(`GUEST_OPS` ── 壊れた `.sqlite` を選んだだけで
   *   「うちの DB が壊れた」と読まない)。
   */
  openSqliteExport: (req) => {
    const api = sqliteApi;
    if (api === null) throw new Error('sqlite が初期化されていません');
    // ⚠ 自分を入れる前に押し出す(`guestDbs` と同じ作法 ── 後だと、自分が最古のときに自分を畳む)
    while (exportDbs.size >= EXPORT_MAX) {
      const oldest = exportDbs.keys().next().value;
      if (oldest === undefined) break;
      closeExport(oldest);
    }
    const oo1 = (api as unknown as { oo1: { DB: new (name: string) => Database } }).oo1;
    const tmp = new oo1.DB(':memory:');
    try {
      deserializeInto(api as unknown as Parameters<typeof deserializeInto>[0], tmp, req.image);
      const tables = (
        tmp.selectObjects(EXPORT_TABLE_NAMES_SQL) as unknown as Array<{ name: string }>
      ).map((r) => r.name);
      const views = (
        tmp.selectObjects(EXPORT_VIEW_NAMES_SQL) as unknown as Array<{ name: string }>
      ).map((r) => r.name);
      // 🔴 本文検索の仮想表は写さない ── 写さなかったと言うために名前を返す(影の表は黙って外したまま)
      const ftsTables = (
        tmp.selectObjects(FTS_VIRTUAL_NAMES_SQL) as unknown as Array<{ name: string }>
      ).map((r) => r.name);
      exportSeq += 1;
      const session = 'e' + String(exportSeq);
      exportDbs.set(session, tmp);
      return { session, tables, views, ftsTables };
    } catch (e) {
      // ⚠ 読めなかった器も閉じる(断った回に器が残るのは「速やかな破棄」の逆である)
      try {
        tmp.close();
      } catch {
        // 次の回は新しい器を作る
      }
      throw new Error(`このファイルは sqlite の DB として読めませんでした(${errorText(e)})`, {
        cause: e,
      });
    }
  },
  /**
   * 🔴 **開いてある `.sqlite` の表 1 つを NDJSON にして返す**(2 つ目)。
   *
   * 🔑 **1 表の失敗は、その表だけ**(`refused` に理由を載せて返す)── 他の表は引ける。
   * 🔴 **行は全部ここで読み切る**(メインへ行の配列を載せない)。天井(`maxTableBytes`)を超えたら
   *   **その時点で読むのをやめる**(`NdjsonCollector`)。⚠ 応答の bytes は transfer で渡る(ゼロコピー)。
   * ⚠ 開いていない / 押し出された写しには**断る**(黙って別の file の表を返さない)。
   */
  exportSqliteTable: (req) => {
    const db = exportDbs.get(req.session);
    if (db === undefined) {
      throw new Error('取り込んだ .sqlite のコピーが開かれていません(もう一度実行してください)');
    }
    return exportOneTable(db, req.table, req.maxTableBytes, () => exportDbs.get(req.session) === db);
  },
  /** 🔴 写しを取り終えた `.sqlite` を手放す(3 つ目)。⚠ 開いていなくても落ちない(`finally` から呼ばれる)。 */
  closeSqliteExport: (req) => {
    closeExport(req.session);
    return null;
  },
  /**
   * 🔴 **PKC3 入り HTML に焼かれた DB の写しから、バックアップの材料を読む**(#1416)。
   *
   * ⚠ **いま開いているコレクション(`db`)には触れない。** 一時の `:memory:` の DB に画像を流し込み、
   *   `db` を**この呼び出しの間だけ**差し替えて、既存の読み口をそのまま当てる(読み口の SQL を
   *   2 本目書かない ── 書き出しと同じ規則が、取り込みでも効く)。
   * ⚠ **全部が同期** ── 差し替えている間に他の依頼が割り込めない(handler の頭書きの前提)。
   *   `await` を足すと `db` が戻る前に別の依頼が一時の DB を読む。足さないこと。
   * ⚠ `applySchema` は古い版の画像を新しい版へ移す(`init` と同じ道)。その途中で壊れの綴りが出ても、
   *   **本体を壊れ扱いにしない**(`dbCorrupt` を元に戻す ── 客の画像の話である)。
   */
  readImageArchive: (req) => {
    const api = sqliteApi;
    if (api === null) throw new Error('sqlite が初期化されていません');
    const oo1 = (api as unknown as { oo1: { DB: new (name: string) => Database } }).oo1;
    const tmp = new oo1.DB(':memory:');
    const prevDb = db;
    const prevCorrupt = dbCorrupt;
    const sync = <T,>(v: T | Promise<T>): T => v as T;
    try {
      try {
        // 🔴 細工した画像の引き金・ビューを、`applySchema` の更新で走らせない(この worker を占有させない)
        tmp.exec('PRAGMA trusted_schema=OFF');
        deserializeInto(api as unknown as Parameters<typeof deserializeInto>[0], tmp, req.image);
        // ⚠ `sqlite3_deserialize` は中身を見ない ── ここで 1 回読んで、画像の話として言い直す
        tmp.selectValue('SELECT count(*) FROM sqlite_schema');
      } catch (e) {
        throw new Error(`ファイルの中身を読み込めませんでした(${String(e)})`, { cause: e });
      }
      // 🔴 引き金・ビューは、PKC3 が作るもの(新しい DB に作られる 3 本の引き金)だけを通す。それ以外は読まずに断る
      if (!hasOnlyOwnTriggers(oo1, tmp)) {
        throw new Error('この HTML の中身は、PKC3 が書き出したものではないため取り込めません');
      }
      try {
        applySchema(tmp);
      } catch (e) {
        throw new Error(`ファイルの中身を読み込めませんでした(${String(e)})`, { cause: e });
      }
      if (dbCorrupt !== prevCorrupt) throw new Error('ファイルの中身が読み取れない形になっています');
      const first = tmp.selectObjects(
        'SELECT cid, title FROM containers ORDER BY created_at, cid LIMIT 1',
      )[0];
      const cid = first?.cid;
      if (typeof cid !== 'string' || cid === '') {
        throw new Error('ファイルの中にコレクションが入っていません');
      }
      db = tmp;
      const metas = sync(handlers.listEntryMetas({ op: 'listEntryMetas', cid }));
      const bodies = sync(
        handlers.listBodies({ op: 'listBodies', cid, maxBytes: Number.MAX_SAFE_INTEGER }),
      ).rows;
      const chains: ResultMap['readImageArchive']['chains'] = [];
      for (const lid of sync(handlers.listRevisionLids({ op: 'listRevisionLids', cid }))) {
        chains.push({
          lid,
          rows: sync(handlers.exportRevisionChain({ op: 'exportRevisionChain', cid, entryLid: lid })),
        });
      }
      return {
        cid,
        title: typeof first?.title === 'string' ? first.title : '',
        metas,
        bodies,
        relations: sync(handlers.listRelations({ op: 'listRelations', cid })),
        assets: sync(handlers.listAssetMetas({ op: 'listAssetMetas', cid })),
        tagColors: sync(handlers.listTagColors({ op: 'listTagColors', cid })),
        chains,
        trash: sync(handlers.listTrashHeads({ op: 'listTrashHeads', cid })),
      };
    } finally {
      db = prevDb;
      dbCorrupt = prevCorrupt;
      try {
        tmp.close();
      } catch {
        /* 閉じ損ねても本体には届かない */
      }
    }
  },
  openContainer: (req) => {
    need().exec({
      sql: `INSERT INTO containers (cid, title, created_at, updated_at, schema_version)
            VALUES (?, ?, datetime('now'), datetime('now'), ?)
            ON CONFLICT(cid) DO NOTHING`,
      bind: [req.cid, req.title ?? '', DB_SCHEMA_VERSION],
    });
    return null;
  },
  /**
   * 🔴 **選ぶのと作るのを 1 op に閉じる**(#260)。
   *
   * ⚠ 「読んで、無ければ書く」を呼び側で 2 回に分けてはいけない ──
   *   初回起動の 2 枚のタブが**別々の cid を挿して器が 2 つに割れる**。
   *   worker は単一 queue なので、**この関数の中は割り込まれない**。
   * ⚠ 既に在るものは**そのまま返す**(既存 DB の `'default'` を含む)──
   *   cid は全テーブルの区画鍵なので、採番し直すと既存データが消えて見える。
   * ⚠ 並びは `created_at` **と `cid`** で採る ── `created_at` は秒精度なので、
   *   同秒に 2 件在ると順序が決まらず、起動のたびに違う器を開きうる。
   */
  listContainerIds: () => ({
    containers: need()
      .selectObjects('SELECT cid, created_at FROM containers ORDER BY created_at, cid')
      .map((r) => ({
        cid: String(r['cid']),
        createdAt: typeof r['created_at'] === 'string' ? r['created_at'] : null,
      })),
  }),
  /**
   * 🔴 **ワークスペースの一覧**(#1455)。ノートの数は user の領域の数(システムのメッセージは数えない)。
   */
  listWorkspaces: () => {
    const database = need();
    const rows = database.selectObjects(
      `SELECT c.cid AS cid, c.title AS title, c.created_at AS created_at,
              (SELECT count(*) FROM entries e WHERE e.cid = c.cid AND e.${USER_REALM_SQL}) AS notes
         FROM containers c ORDER BY c.created_at, c.cid`,
    );
    return {
      workspaces: rows.map((r) => ({
        cid: String(r['cid']),
        title: typeof r['title'] === 'string' ? r['title'] : '',
        createdAt: typeof r['created_at'] === 'string' ? r['created_at'] : null,
        notes: Number(r['notes'] ?? 0),
      })),
      activeCid: activeContainerCid(database) ?? null,
    };
  },
  createWorkspace: (req) => {
    const database = need();
    const title = req.title.replace(/\s+/g, ' ').trim();
    if (title === '') throw new Error('ワークスペースの名前を入れてください');
    const cid = mintContainerId();
    /**
     * ⚠ 作成時刻は**必ず今までのどの器よりも後**にする。`created_at` は秒精度で、同じ秒に 2 つ作ると並び
     *   (`ORDER BY created_at, cid`)が cid の乱数で決まり、「いちばん古い器」(印が無いときに開く器)が揺れる。
     */
    database.exec({
      sql: `INSERT INTO containers (cid, title, created_at, updated_at, schema_version)
            VALUES (?1, ?2,
              datetime(max(CAST(strftime('%s','now') AS INTEGER), COALESCE((SELECT max(CAST(strftime('%s', created_at) AS INTEGER)) FROM containers), 0) + 1), 'unixepoch'),
              datetime('now'), ?3)`,
      bind: [cid, title, DB_SCHEMA_VERSION],
    });
    return { cid };
  },
  switchWorkspace: (req) => {
    const database = need();
    const has = database.selectValue('SELECT count(*) FROM containers WHERE cid = ?', [req.cid]) as number;
    if (!has) throw new Error('そのワークスペースは見つかりません');
    database.exec({
      sql: `INSERT INTO workspaces (id, name, active_cid) VALUES ('main', '', ?)
            ON CONFLICT(id) DO UPDATE SET active_cid = excluded.active_cid`,
      bind: [req.cid],
    });
    return null;
  },
  renameWorkspace: (req) => {
    const title = req.title.replace(/\s+/g, ' ').trim();
    if (title === '') throw new Error('ワークスペースの名前を入れてください');
    need().exec({
      sql: `UPDATE containers SET title = ?, updated_at = datetime('now') WHERE cid = ?`,
      bind: [title, req.cid],
    });
    return null;
  },
  deleteWorkspace: (req) => {
    const database = need();
    const all = database.selectValue('SELECT count(*) FROM containers') as number;
    if (all <= 1) throw new Error('最後のワークスペースは削除できません');
    if (activeContainerCid(database) === req.cid) {
      throw new Error('使っているワークスペースは削除できません(先に別のワークスペースへ切り替えてください)');
    }
    const has = database.selectValue('SELECT count(*) FROM containers WHERE cid = ?', [req.cid]) as number;
    if (!has) throw new Error('そのワークスペースは見つかりません');
    const removedNotes = database.selectValue(
      `SELECT count(*) FROM entries WHERE cid = ? AND ${USER_REALM_SQL}`,
      [req.cid],
    ) as number;
    database.exec('BEGIN IMMEDIATE');
    try {
      deleteContainerRows(database, req.cid);
      database.exec('COMMIT');
    } catch (e) {
      database.exec('ROLLBACK');
      throw e;
    }
    return { removedNotes };
  },
  resolveContainer: (req) => {
    const database = need();
    // 🔴 ワークスペース(#1455)── 印が付いた器があればそれ、無ければ今までどおりいちばん古い器
    const existing = activeContainerCid(database);
    if (typeof existing === 'string' && existing !== '') {
      return { cid: existing, created: false };
    }
    const cid = mintContainerId();
    database.exec({
      sql: `INSERT INTO containers (cid, title, created_at, updated_at, schema_version)
            VALUES (?, ?, datetime('now'), datetime('now'), ?)`,
      bind: [cid, req.title ?? '', DB_SCHEMA_VERSION],
    });
    return { cid, created: true };
  },
  listEntryMetas: (req) =>
    // body 列を読まない ── boot / 一覧は O(メタ)(設計 doc §4.1)
    // 🔴 system 領域のノートは出さない(設計 doc §1.1、段①)
    need().selectObjects(
      `SELECT lid, title, archetype, created_at, updated_at, entry_order,
              status, date, archived, body_chars
         FROM entries WHERE cid = ? AND ${USER_REALM_SQL} ORDER BY entry_order`,
      [req.cid],
    ) as unknown as ResultMap['listEntryMetas'],
  /**
   * 🔴 **system 領域のノートだけを一覧する**(設計 doc §1.1、段①)。
   *
   * ⚠ **段②(「メッセージ」)がここを使って開く** ── いまはまだ system 領域の
   *   ノートを作る経路が無いので、この op は空配列を返すだけである
   *   (実害は無い ── 「作る口だけ用意する」が段①の範囲)。
   * ⚠ `listEntryMetas` と綴りを揃える(`EntryMetaRow` を共有)── 描画側が
   *   別の形を覚え直さずに済む。
   */
  listSystemEntries: (req) =>
    need().selectObjects(
      `SELECT lid, title, archetype, created_at, updated_at, entry_order,
              status, date, archived, body_chars
         FROM entries WHERE cid = ? AND realm = 'system' ORDER BY entry_order`,
      [req.cid],
    ) as unknown as ResultMap['listSystemEntries'],
  /**
   * 🔴 **メッセージ 1 件を追記する**(設計 doc §7、段②a)。
   *
   * ⚠ **本文の書込は `upsertEntry` の外に置く** ── メッセージは `checkpoint`
   *   (履歴を伸ばす)も `amend`(鎖を張り替える)も要らない(履歴を積まない)ので、
   *   `writeEntryRow` を通す理由が無い(通すと、要らない鎖の維持コストを払う)。
   * ⚠ **無ければ作る(冪等)** ── 起動のたびに「メッセージ」「処理の記録」を
   *   作り直さない。`ON CONFLICT` にはしない(追記は既存行の `body` を
   *   読んだ値に依存するので、`excluded.body` では前の節を捨ててしまう)。
   */
  appendMessage: (req) => {
    const database = need();
    database.exec('BEGIN IMMEDIATE');
    try {
      const rows = database.selectObjects(
        'SELECT body FROM entries WHERE cid = ? AND lid = ?',
        [req.cid, req.lid],
      ) as Array<{ body: string }>;
      const existing = rows[0]?.body ?? '';
      const next = trimToCap(`${existing}${req.section}`, req.cap, trimSlackForLid(req.lid, req.cap));
      const nextFold = foldedColumns(req.title, next);
      if (rows.length === 0) {
        database.exec({
          sql: `INSERT INTO entries
                  (cid, lid, title, archetype, created_at, updated_at,
                   entry_order, status, date, archived, task_total, body_chars,
                   body_tags, realm, title_f, body_f, fold_rev, body)
                VALUES (?, ?, ?, 'textlog', datetime('now'), datetime('now'),
                   0, NULL, NULL, 0, NULL, ?, NULL, 'system', ?, ?, 1, ?)`,
          bind: [req.cid, req.lid, req.title, next.length, nextFold.titleF, nextFold.bodyF, next],
        });
      } else {
        database.exec({
          sql: `UPDATE entries SET body = ?, body_chars = ?, body_f = ?, fold_rev = coalesce(fold_rev, 0) + 1,
                  updated_at = datetime('now')
                  WHERE cid = ? AND lid = ?`,
          bind: [next, next.length, nextFold.bodyF, req.cid, req.lid],
        });
      }
      database.exec('COMMIT');
      return null;
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
  },
  taskScan: (req) => runTaskScan(req.cid),
  contactScan: (req) => runContactScan(req.cid),
  workLogScan: (req) => runWorkLogScan(req.cid),
  snippetScan: (req) => runSnippetScan(req.cid),
  getBody: (req) => {
    const rows = need().selectObjects(
      'SELECT body FROM entries WHERE cid = ? AND lid = ?',
      [req.cid, req.lid],
    );
    return rows.length > 0 ? (rows[0]?.body as string) : null;
  },
  getBodies: (req) => {
    // ⚠ postMessage を 1 回にするのが目的。SQL は 500 件ずつの IN 句にまとめる
    // (#1087。SQLITE_MAX_VARIABLE_NUMBER の下限 999 より小さく保つ)。
    // 結果は req.lids の順・重複そのまま・無い lid は出さない(以前の 1 件ずつと同じ)
    const database = need();
    const CHUNK = 500;
    const found = new Map<string, string>();
    for (let i = 0; i < req.lids.length; i += CHUNK) {
      const part = req.lids.slice(i, i + CHUNK);
      const rows = database.selectObjects(
        `SELECT lid, body FROM entries WHERE cid = ? AND lid IN (${part.map(() => '?').join(',')})`,
        [req.cid, ...part],
      );
      for (const r of rows) found.set(r.lid as string, r.body as string);
    }
    const out: Array<{ lid: string; body: string }> = [];
    for (const lid of req.lids) {
      const body = found.get(lid);
      if (body !== undefined) out.push({ lid, body });
    }
    return out;
  },
  assetShareProbe: (req) => {
    const database = need();
    const target = database.selectObjects('SELECT body FROM entries WHERE cid = ? AND lid = ?', [
      req.cid,
      req.targetLid,
    ])[0] as { body: string } | undefined;
    if (!target) return null;
    const oldKey = readAttachmentMeta(target.body).assetKey;
    if (oldKey === null) return null;
    let sharers = 0;
    let linkNotes = 0;
    let links = 0;
    database.exec({
      sql: 'SELECT lid, archetype, body FROM entries WHERE cid = ? AND lid <> ?',
      bind: [req.cid, req.targetLid],
      rowMode: 'object',
      callback: (row) => {
        const r = row as unknown as { lid: string; archetype: string; body: string };
        if (r.archetype === 'attachment' && readAttachmentMeta(r.body).assetKey === oldKey) sharers += 1;
        // 🔑 数える規則は書き換えと同じ(`rewriteAssetRefs`)── 見せる数と、実際に変わる数を食い違わせない
        const n = rewriteAssetRefs(r.body, oldKey, `${oldKey}-probe`).count;
        if (n > 0) {
          linkNotes += 1;
          links += n;
        }
      },
    });
    return { sharers, linkNotes, links };
  },
  findAssetOwner: (req) => {
    /**
     * #100 段② ── key → 所有 entry の逆引き。
     * 🔴 判定は**狭く当てる**: `archetype='attachment'` に絞った上で、frontmatter の
     * `attachment.asset_key` の**等値**だけを見る(protocol.ts の注記)。
     * ⚠ 全 body を一度に materialize しない ── 行ごとの callback で読み、
     * 見つかったら false を返して走査を止める(GC の scanText と同じ作法)。
     */
    let found: string | null = null;
    let name: string | null = null;
    need().exec({
      sql: "SELECT lid, body FROM entries WHERE cid = ? AND archetype = 'attachment'",
      bind: [req.cid],
      rowMode: 'object',
      callback: (row) => {
        // ⚠ 型は SqlValue のまま来る ── rowMode 'object' の実行時形へ狭める
        const r = row as unknown as { lid: string; body: string };
        const meta = readAttachmentMeta(r.body);
        if (meta.assetKey === req.assetKey) {
          found = r.lid;
          // 元の file 名(#1207 I4)。⚠ 空なら null ── 呼び側が「名前が無い」と読む
          name = meta.name !== '' ? meta.name : null;
          return false; // 走査を止める
        }
      },
    });
    return { lid: found, name };
  },
  /**
   * 🔴 **本文の全文検索**(#181)。引き方の規則は `planSearch` が 1 か所で持つ。
   *
   * ⚠ **並びは entry_order**(一覧と同じ)── 関連度順にしない。検索のたびに
   * 並びが変わると、user は「さっき見ていたもの」を見失う。
   * ⚠ **上限を置き、切ったことを言う**(`truncated`)── 黙って切ると、user は
   * 「無い」と読む(§1 の「無言の欠落」)。
   */
  searchEntries: (req) => {
    const limit = Math.max(1, Math.min(req.limit ?? SEARCH_LIMIT, SEARCH_LIMIT));
    const rawQuery = req.query.trim();
    if (req.raw === true) {
      // 🔴 書いた字のまま 1 句で引く(リンクの宛先の字を本文から探す内部の用途 ── `protocol.ts` の注記)
      if (rawQuery === '') return { lids: [], truncated: false };
      const rows = need().selectObjects(
        `SELECT lid FROM entries
          WHERE cid = ?1 AND ${USER_REALM_SQL} AND (title LIKE ?2 ESCAPE '\\' OR body LIKE ?2 ESCAPE '\\')
          ORDER BY entry_order, lid LIMIT ?3`,
        [req.cid, toLikePattern(rawQuery), limit + 1],
      ) as Array<{ lid: string }>;
      return { lids: rows.slice(0, limit).map((r) => r.lid), truncated: rows.length > limit };
    }
    const plan = searchPlanOf(req.query, 'plain');
    if (plan.kind === 'none') return { lids: [], truncated: false };
    // 🔴 題名の検索は system 領域のノートを出さない(設計 doc §1.1、段①)
    let rows: Array<{ lid: string }>;
    if (plan.kind === 'fts') {
      rows = need().selectObjects(
        `SELECT e.lid AS lid FROM entries_fts f
           JOIN entries e ON e.rowid = f.rowid
          WHERE f.entries_fts MATCH ? AND e.cid = ? AND e.${USER_REALM_SQL}
          ORDER BY e.entry_order, e.lid LIMIT ?`,
        [plan.match, req.cid, limit + 1],
      ) as Array<{ lid: string }>;
    } else {
      // 2 文字以下(または 3 字未満の語が混じる)は trigram が当たらないので LIKE(実測)。⚠ ESCAPE を宣言する
      const bind: (string | number)[] = [req.cid];
      const conds = likeWhere(plan, bind, true);
      bind.push(limit + 1);
      rows = need().selectObjects(
        `SELECT lid FROM entries
          WHERE cid = ?1 AND ${USER_REALM_SQL} AND ${conds.join(' AND ')}
          ORDER BY entry_order, lid LIMIT ?${bind.length}`,
        bind,
      ) as Array<{ lid: string }>;
    }
    // 🔑 **1 件多く取って切れたか判る**(件数を数え直す 2 回目の問い合わせを避ける)
    const truncated = rows.length > limit;
    return { lids: rows.slice(0, limit).map((r) => r.lid), truncated };
  },
  /**
   * 🔴 **探す面のための検索**(#680)── 題名・抜粋・関連度を返す。
   *
   * ⚠ `searchEntries` と**引き方(`planSearch`)は同じ 1 か所**、違うのは返す物と並び:
   * - FTS 側: `snippet(entries_fts, 1, …)`(列 1 = 本文。`schema.ts` の
   *   `entries_fts(title, body)` の並び)で当たった語を印で囲んだ抜粋、
   *   `bm25(entries_fts)` で**関連度順**(小さいほど良い)。同点は entry_order
   * - LIKE 側(3 字未満): 本文を読んで `excerptAround` で同じ顔の抜粋を作る。
   *   関連度は持たない(`rank: 0`)ので並びは entry_order
   *
   * ⚠ **ゴミ箱の中は返さない** ── 捨てたノートは `entries` から行ごと消える(`deleteEntry`)ので、
   *   ここは何もしなくてよい。🔴 `archived`(片付けた todo)で絞らない(#1087)── 片付けた todo は
   *   一覧にも左の列の検索にも出るので、ここだけ外すと**左の列と結果が食い違う**。
   * ⚠ 印の綴りは `search-snippet.ts` の 1 か所 ── 描画器も同じ物を読む。
   * ⚠ 上限と「切った」の作法は `searchEntries` と同じ(`limit + 1`)。
   */
  searchDetail: (req) => {
    /**
     * 🔴 **書き方は探す面だけ**(`syntax: 'query'`── 空白 = AND / `"…"` = フレーズ /
     * `-語` = 除外)。左の列(`searchEntries`)は `plain` のまま。
     * ⚠ 3 字未満の項が 1 つでも混じれば `like-terms`(全項を LIKE で並べる)── trigram は
     *   2 字を当てられず、除外側なら**黙って効かない**ので、FTS へは渡さない。
     * 🔴 台帳 #1852 の束 B2:引くのは**揃えた字**(全角半角・濁点)で、**隠したメモとリンクの宛先の字は当たらない**。
     *   索引を作り直している間は `searchPlanOf` が全走査に落とす(答えの集合は同じ)。
     */
    const plan = searchPlanOf(req.query, 'query');
    if (plan.kind === 'none') return { rows: [], truncated: false };
    const limit = Math.max(1, Math.min(req.limit ?? SEARCH_LIMIT, SEARCH_LIMIT));
    // 抜粋に印を付ける語(最初に見つかった語の所を窓にする ── 揃えた字で探し、書いた字で出す)
    const needles = plannedTerms(req.query, 'query').include;
    /**
     * 🔴 抜粋は**書いた字から JS で作る**(`excerptAroundFolded`)。FTS の `snippet()` は索引の元の字(揃えた字・メモと
     *   リンクの宛先を除いた字)から切るので、抜粋が「ＰＫＣ」でなく「PKC」で出てしまう ── 書いたまま出す。
     * ⚠ 本文は当たった行(上限 200 件 + 1)だけ読む。
     */
    const excerptOf = (body: string): string => excerptAroundFolded(searchableBody(body), needles);
    /**
     * 🔴 **行ごとに step して抜粋だけ作り、本文は捨てる**(最大 201 件の本文を配列に載せない ── ゼロコピーの規律)。
     * ⚠ `limit + 1` 件目は「切ったか」を知るためだけに数え、抜粋は作らない。
     */
    const stream = (sql: string, bind: (string | number)[], withRank: boolean): SearchDetailResult => {
      const rows: SearchDetailResult['rows'] = [];
      let seen = 0;
      need().exec({
        sql,
        bind,
        rowMode: 'object',
        callback: (row: unknown) => {
          seen += 1;
          if (seen > limit) return false; // 1 件多く取れたら止める
          const r = row as { lid: string; title: string; body: string; rank?: number };
          rows.push({ lid: r.lid, title: r.title, snippet: excerptOf(r.body), rank: withRank ? Number(r.rank) : 0 });
          return undefined;
        },
      });
      return { rows, truncated: seen > limit };
    };
    // 🔴 全文検索(探す面)は system 領域のノートを出さない(設計 doc §1.1、段①)
    if (plan.kind === 'fts') {
      return stream(
        `SELECT e.lid AS lid, e.title AS title, e.body AS body, bm25(entries_fts) AS rank
           FROM entries_fts f
           JOIN entries e ON e.rowid = f.rowid
          WHERE f.entries_fts MATCH ?1 AND e.cid = ?2 AND e.${USER_REALM_SQL}
          ORDER BY rank, e.entry_order, e.lid LIMIT ?3`,
        [plan.match, req.cid, limit + 1],
        true,
      );
    }
    /**
     * LIKE 側 ── 項ごとに `(題名 LIKE ? OR 本文 LIKE ?)` を AND で並べ、除外は `NOT (…)`。
     * ⚠ `plain` の `like`(1 句)は `query` では来ないが、型の上では在るので 1 項として畳む(`likeWhere` が受ける)。
     */
    const bind: (string | number)[] = [req.cid];
    const conds = likeWhere(plan, bind, true);
    bind.push(limit + 1);
    return stream(
      `SELECT lid, title, body FROM entries
        WHERE cid = ?1 AND ${USER_REALM_SQL} AND ${conds.join(' AND ')}
        ORDER BY entry_order, lid LIMIT ?${bind.length}`,
      bind,
      false,
    );
  },
  /**
   * 🔴 **このノートを参照しているのはどれか**(#348、user 裁定 2026-08-23)。
   *
   * ## user の物語
   *
   * ノート A を開いている。「**このノートを参照しているのはどれか**」が分からないので、
   * 探し直すしかない ── 書けば書くほど、書いたことが**見つからなくなる**。
   *
   * ## 探し方
   *
   * ノート間のリンクは **`entry:<lid>` の 1 形式**しか無い(`markdown-render.ts` /
   * `features/link/permalink.ts`)。だから needle も 1 つで足りる。
   *
   * ⚠ **FTS は使わない。** trigram は**部分一致**を引けるが、lid は英数字の並びなので
   * 「たまたま同じ 3 文字」で当たる ── **`entry:` を前に付けた完全な文字列**を
   * `LIKE` で探すほうが**当たり方が正確**である(§1「形ではなく構文で拾う」の同じ向き)。
   * ⚠ 速さは**測ってから**直す(いまは索引を持たない ── 持つと保存のたびの維持が要る)。
   *
   * ⚠ **自分自身は外す** ── 本文に自分へのリンクを書けてしまうが、
   *   「自分が自分を参照している」を一覧に出しても user は何もできない。
   * ⚠ **ゴミ箱の中は出さない**(押しても一覧に無いものへ飛ぶ)── 捨てたノートは `entries` に居ないので
   *   何もしなくてよい。🔴 `archived`(片付けた todo)で絞らない(#1087)── 片付けた todo は一覧に居るのに、
   *   参照元から黙って消え、ゴミ箱へ移すときの「リンクは開けません」の件数も足りなくなっていた。
   * ⚠ 並びは `entry_order`(一覧と同じ)/ 上限を置き、**切ったことを言う**。
   */
  findBacklinks: (req) => {
    const limit = Math.max(1, Math.min(req.limit ?? SEARCH_LIMIT, SEARCH_LIMIT));
    /**
     * 🔴 **LIKE は候補を絞るだけ。合否は文法で決める**(2026-08-25)。
     *
     * ⚠ `LIKE '%entry:n1%'` は **`entry:n12` の中にも当たる** ── 参照していない
     *   ノートが参照元として並ぶ(過剰報告)。CLAUDE.md §1「file 名で見分ける
     *   ときは、path の頭と尻を両方留める」の同じ型である。
     * 🔑 だから **`bodyLinksTo` を通す** ── 出ていく側(つながりの図)と
     *   **同じ 1 つの文法**で答える(§7「判定を 1 か所へ寄せる」)。
     * ⚠ 索引は持たない(持つと保存のたびの維持が要る)ので、LIKE で粗く削ってから
     *   本文を読む形にしてある ── **全件を JS へ積まない**。
     */
    /**
     * ⚠ **同じ容れ物を指す字面は 2 つある**(#379)── `entry:<lid>` と
     * `pkc://<cid>/entry/<lid>`。⚠ 片方だけで絞ると、**もう片方は候補にすら
     * 挙がらない**(取りこぼし側へ倒れる)。字面は `bodyLinkNeedles` が持つ。
     */
    const needles = bodyLinkNeedles(req.lid, req.cid);
    /**
     * 🔴 **`[[題名]]` で指されたノートの参照元にも出す**(#1174 段②)。題名で指す記法は、画面で押したとき開くノート
     *   (`findTodayNote` と同じ規則 ── 片付けていない同名の中で `entry_order` がいちばん小さい)だけを指す。
     *   ⚠ 同順位の同名が他に居る・自分が片付け済み・題名が `[[ ]]` に書けない字のときは、どれを指すか決まらない/指さないので出さない。
     */
    const me = need().selectObjects(
      `SELECT title, entry_order, archived FROM entries WHERE cid = ?1 AND lid = ?2`,
      [req.cid, req.lid],
    ) as Array<{ title: string; entry_order: number; archived: number }>;
    let titleOfTarget: string | null = null;
    const m0 = me[0];
    if (m0 !== undefined && m0.archived === 0 && isWritableLinkTitle(m0.title)) {
      const rival = need().selectObjects(
        `SELECT 1 AS x FROM entries WHERE cid = ?1 AND lid <> ?2 AND title = ?3 AND archived = 0 AND ${USER_REALM_SQL} AND entry_order <= ?4 LIMIT 1`,
        [req.cid, req.lid, m0.title, m0.entry_order],
      );
      if (rival.length === 0) {
        titleOfTarget = m0.title.trim();
        needles.push(`[[${titleOfTarget}`);
      }
    }
    const where = needles.map((_, i) => `body LIKE ?${i + 3} ESCAPE '\\'`).join(' OR ');
    // 🔴 backlink は system 領域のノートを出さない(設計 doc §1.1、段①)
    const rows = need().selectObjects(
      `SELECT lid, body FROM entries
        WHERE cid = ?1 AND lid <> ?2 AND ${USER_REALM_SQL} AND (${where})
        ORDER BY entry_order, lid`,
      [req.cid, req.lid, ...needles.map((n) => toLikePattern(n))],
    ) as Array<{ lid: string; body: string }>;
    /**
     * ⚠ **SQL 側で件数を切らない。** LIKE は過剰に当たるので、`limit + 1` 件だけ
     * 取ると「候補が偽物ばかりで本物が漏れる」── 誤差が**取りこぼし側**へ倒れる。
     * 🔑 候補の数は「本文に `entry:<lid>` という並びを literal で含むノート」なので、
     *   実質は参照元の数である(前置が重なる lid はまず無い)。
     */
    const hit: string[] = [];
    let truncated = false;
    for (const r of rows) {
      if (
        !bodyLinksTo(r.body, req.lid, req.cid) &&
        !(titleOfTarget !== null && scanTitleLinks(r.body).some((x) => x.title === titleOfTarget))
      )
        continue;
      // 🔑 **1 件多く取って切れたか判る**(`searchEntries` と同じ作法)
      if (hit.length >= limit) {
        truncated = true;
        break;
      }
      hit.push(r.lid);
    }
    return { lids: hit, truncated };
  },
  /**
   * 🔴 **frontmatter で束ねる**(#184)。舐めるのは worker、返すのは**束ねた結果**だけ。
   * ⚠ 目録と表を**同じ 1 回の走査**で作る(別々の op にすると走査が 2 回になる)。
   */
  queryScan: (req) =>
    runQueryScan(req.cid, req.key ?? null) as ResultMap['queryScan'],
  smartScan: (req) => runSmartScan(req.cid, req.lid, req),
  listBodies: (req) => {
    // 🔴 **カーソルは ORDER BY と同じ複合キー**。`entry_order > ?` だけだと
    // 境界の順序値を共有する行が全部飛ぶ(entry_order に UNIQUE は無い)。
    // ⚠ lid だけ持ち回って worker 側で順序値を引き直す形も駄目 ── その行が
    // 消えていると位置が解決できず、先頭から読み直して**重複する**
    const database = need();
    const a = req.after;
    /**
     * 🔴 **書出し(バックアップ zip / Markdown zip / 閲覧用 HTML)は system 領域の
     * ノートを含めない**(設計 doc §1.1、段①)── system のノートは user の
     * ディレクトリと明確に分かれているのが裁定の条件である。
     */
    // 🔴 **行ごとの callback で読み、予算に達したら走査を止める**(findAssetOwner と同じ作法)。
    // ⚠ `selectObjects` は after より後ろの**全行の本文**を一度に heap へ載せ、
    // しかも 1 ページごとに先頭から読み直すので、ページ数の 2 乗に時間が伸びた
    const out: Array<{ lid: string; body: string }> = [];
    let total = 0;
    let next: { entryOrder: number; lid: string } | undefined;
    let last: { entry_order: number; lid: string } | undefined;
    database.exec({
      sql:
        a === undefined
          ? `SELECT lid, body, entry_order FROM entries WHERE cid = ? AND ${USER_REALM_SQL}
             ORDER BY entry_order, lid`
          : `SELECT lid, body, entry_order FROM entries
             WHERE cid = ? AND ${USER_REALM_SQL} AND (entry_order > ? OR (entry_order = ? AND lid > ?))
             ORDER BY entry_order, lid`,
      bind: a === undefined ? [req.cid] : [req.cid, a.entryOrder, a.entryOrder, a.lid],
      rowMode: 'object',
      callback: (row) => {
        // ⚠ 型は SqlValue のまま来る ── rowMode 'object' の実行時形へ狭める
        const r = row as unknown as { lid: string; body: string; entry_order: number };
        const size = r.body.length;
        // 1 メッセージの合計で切る。⚠ **1 件目は必ず返す** ── maxBytes より大きい
        // body が 1 件あるだけで、そこから先が永遠に進まなくなる(無限ループ)
        if (out.length > 0 && total + size > req.maxBytes) {
          next = { entryOrder: last!.entry_order, lid: last!.lid };
          return false; // 走査を止める(残りの本文は読まない)
        }
        out.push({ lid: r.lid, body: r.body });
        total += size;
        last = r;
      },
    });
    if (next !== undefined) return { rows: out, done: false, next };
    return { rows: out, done: true };
  },
  upsertEntry: (req) => {
    // 本文の書込は**すべてここを通る** ── 鎖の維持を同 tx に閉じ込める唯一の場所。
    // checkpoint(履歴を伸ばす)か amend(頭を張り替える)かだけが caller の裁量
    const database = need();
    database.exec('BEGIN IMMEDIATE');
    try {
      const written = writeEntryRow(database, req.cid, req.entry, {
        ...(req.checkpoint === undefined ? {} : { checkpoint: req.checkpoint }),
        ...(req.keepLatest === undefined ? {} : { keepLatest: req.keepLatest }),
        ...(req.expectHash === undefined ? {} : { expectHash: req.expectHash }),
        ...(req.parent === undefined ? {} : { parent: req.parent }),
        ...(req.keepMeta === true ? { keepMeta: true } : {}),
      });
      if (written.conflict) {
        database.exec('ROLLBACK'); // ⚠ 何も書いていないことを明示して閉じる
        return { createdAt: null, updatedAt: null, conflict: true };
      }
      database.exec('COMMIT');
      return written.stamps;
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
  },
  /**
   * 🔴 **題名だけを書き換える**(#178、2026-08-22)。
   *
   * ⚠ 直す前、改名は `getBody` → 題名を差し替えて `upsertEntry` で**行全体を書く**
   * 形だった ── 読んでから書くまでの間に**別のタブ / 窓が本文を書いていると消える**。
   * しかも本文は変わらないので `maintainChain` は呼ばれず、**履歴にも残らない**
   * (= 上書きされた版はどこからも戻せない)。
   * 🔑 **本文に触らなければ、衝突は起こりようがない。** 検出ではなく消滅である。
   *
   * ⚠ **鎖は触らない**のが正しい ── `upsertEntry` も
   * `if (old && old.body !== req.entry.body)` で本文が変わったときだけ鎖を維持する。
   * 改名では常に偽なので、**元から鎖は動いていなかった**(この op はその等価物である)。
   * ⚠ 抽出列(status / date / archived)も本文由来なので触らない。
   */
  renameEntry: (req) => updateEntryColumn(req.cid, req.lid, 'title', req.title),
  /**
   * 🔴 **並びだけを書き換える**(#178 の残り、2026-08-24)。改名と**同じ理由**で、
   * 本文には 1 バイトも触らない(protocol の注記)。
   */
  reorderEntry: (req) => updateEntryColumn(req.cid, req.lid, 'entry_order', req.entryOrder),
  /**
   * 🔴 **添付の実体を差し替え、参照を書き換える(走査も書込も 1 tx)**
   * (#205 / #178 の残り / #212、2026-08-25)。
   *
   * ## なぜ worker へ移したか
   *
   * 直す前は主スレッドが `listBodies` で**全ノートの本文**を読み、`planSaveBack` を
   * 掛け、`upsertEntry` を**1 件ずつ**呼んでいた。⚠ 読んでから書くまでの間に
   * 別のタブ / 窓が書くと**それを消し**、`checkpoint` を渡していないので **amend**
   * = **履歴にも残らない**(改名 / 並べ替えで塞いだ穴と**まったく同じ形**)。
   * 🔑 **走査と書込を同じ `BEGIN IMMEDIATE` に閉じ込めれば、衝突は起こりようがない**
   * ── 検出(`expectHash` で断る / やり直す)ではなく**消滅**である。
   * 🔑 だから `oldKey` も**ここで読む** ── 呼び側から渡すと「呼び側が読んだ
   *   時点の値」になり、隙間がまた開く。
   *
   * ⚠ 副産物として **#212** も消える(全ノートの走査が主スレッドから出る ──
   *   5,000 件で 36.7ms を、user が字を打っている最中に踏まなくなる)。
   *   ⚠ ただし**速くなったとは書かない** ── 測っていない。動いたのは**場所**である。
   *
   * ## ⚠ 例外を投げずに `problem` で返すもの
   *
   * 「添付ノートが見つからない」「添付の実体が分からない」は**断りの理由**であって
   * こちらの故障ではない ── 投げると呼び側が `String(e)` を画面に出すことになる。
   */
  replaceAssetRefs: (req) => {
    const database = need();
    database.exec('BEGIN IMMEDIATE');
    try {
      const target = database.selectObjects(
        'SELECT body FROM entries WHERE cid = ? AND lid = ?',
        [req.cid, req.targetLid],
      )[0] as { body: string } | undefined;
      if (!target) {
        database.exec('ROLLBACK');
        return { problem: 'missing-entry', unchanged: false, wrote: [], stale: [], overBudget: false };
      }
      const meta = readAttachmentMeta(target.body);
      const oldKey = meta.assetKey;
      if (oldKey === null) {
        database.exec('ROLLBACK');
        return { problem: 'missing-asset', unchanged: false, wrote: [], stale: [], overBudget: false };
      }

      // ⚠ **全ノートを舐める** ── 参照(`asset:`)はどのノートにも書けるので、
      //    範囲を狭めると**書き換え漏れ**が出る(旧 key を指したまま残り、GC が
      //    実体を消した時点で切れる)。🔑 同じ tx の中なので、読んだ後に
      //    誰かが書き込むことはない。
      const rows = database.selectObjects(
        'SELECT lid, title, archetype, body, entry_order FROM entries WHERE cid = ? ORDER BY entry_order, lid',
        [req.cid],
      ) as Array<{ lid: string; title: string; archetype: string; body: string; entry_order: number }>;
      const bodies = new Map<string, string>();
      const metas = new Map<string, { title: string; archetype: string; entryOrder: number }>();
      for (const r of rows) {
        bodies.set(r.lid, r.body);
        metas.set(r.lid, { title: r.title, archetype: r.archetype, entryOrder: r.entry_order });
      }

      const plan = planSaveBack({
        targetLid: req.targetLid,
        oldKey,
        newKey: req.newKey,
        newHash: req.newHash,
        newBytes: req.newBytes,
        newName: req.newName,
        newMime: req.newMime,
        oldBytes: meta.size ?? 0,
        savedAt: req.savedAt,
        bodies,
        // 🔴 **他の添付が既に使っている分を数える**(渡さないと上限が
        //    この添付の中だけで閉じ、全体では超える)。数えるが**落とさない**。
        otherBytes: totalHistoryBytes(
          [...bodies].filter(([lid]) => lid !== req.targetLid).map(([, body]) => readVersions(body)),
        ),
      });
      if (plan.unchanged) {
        database.exec('ROLLBACK'); // ⚠ 何も書いていないことを明示して閉じる
        return { problem: null, unchanged: true, wrote: [], stale: [], overBudget: false };
      }

      const wrote: Array<{ lid: string; body: string; stamps: EntryStamps }> = [];
      for (const edit of plan.edits) {
        const m = metas.get(edit.lid);
        if (!m) continue; // 走査の間に消えた(同 tx なので起きないが、型の穴は塞ぐ)
        const base = edit.nextText ?? bodies.get(edit.lid) ?? '';
        const next = edit.frontmatter ? spliceFrontmatterKeys(base, edit.frontmatter) : base;
        const ext = extractMeta(m.archetype, next);
        // 🔑 **書込は `writeEntryRow` の 1 本を通す** ── 鎖の維持も刻印も
        //    `upsertEntry` と同じ作法になる(判定を 2 か所に生やさない)。
        // ⚠ `expectHash` は渡さない ── **同じ tx で読んだ値をそのまま書く**ので、
        //    比べる隙間が無い(比べる相手が自分自身になる)。
        const w = writeEntryRow(
          database,
          req.cid,
          {
            lid: edit.lid,
            title: m.title,
            archetype: m.archetype,
            body: next,
            entryOrder: m.entryOrder,
            status: ext.status,
            date: ext.date,
            archived: ext.archived,
          },
          {},
        );
        wrote.push({ lid: edit.lid, body: next, stamps: w.stamps });
      }
      database.exec('COMMIT');
      return {
        problem: null,
        unchanged: false,
        wrote,
        stale: [...plan.stale],
        overBudget: plan.overBudget,
      };
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
  },
  /**
   * 🔴 **改名のとき、ほかのノートのリンクの字を新しい題名へ**(#1163 依頼 177、#1648)。
   *
   * ⚠ 走査も書込も**同じ `BEGIN IMMEDIATE`**(`replaceAssetRefs` と同じ理由 ── 主スレッドで読んでから
   *   書くと、その間に別の窓が書いた本文を消す)。候補は LIKE で削り、合否は `renameLinkTexts`(文法 1 本)。
   * ⚠ system 領域のノートには触れない(`USER_REALM_SQL`)。自分自身と `skipLids`(編集中)も触れない。
   * ⚠ 履歴に 1 版積む(`checkpoint`)── 書き換え前の字へ戻せる。題名・並びは disk の値を保つ。
   */
  renameLinkTexts: (req) => {
    const database = need();
    database.exec('BEGIN IMMEDIATE');
    try {
      const needles = bodyLinkNeedles(req.lid, req.cid);
      /**
       * 🔴 **`[[旧い題名]]` も候補に入れる**(#1174 段②)。書き換えるのは次の 2 つがどちらも無いときだけ:
       *   ① 同じ(旧い)題名のノートが**ほかにも在る**(`[[題名]]` は一覧で上のほうを指すので、どちらを指していたか分からない)
       *   ② 新しい題名のノートが**既に在る**(書き換えると、リンクが別のノートを指してしまう)
       * ⚠ 数えるのは画面の `titleNoteIndex`(`findTodayNote`)と同じ範囲 ── 片付けた(`archived`)ノートは数えない。
       *   ゴミ箱へ移したノートは `entries` に居ないので数えない。
       */
      const titleTaken = (title: string): boolean =>
        database.selectObjects(
          `SELECT 1 AS x FROM entries WHERE cid = ?1 AND lid <> ?2 AND title = ?3 AND archived = 0 AND ${USER_REALM_SQL} LIMIT 1`,
          [req.cid, req.lid, title],
        ).length > 0;
      const titleLinks =
        req.oldTitle.trim() !== '' &&
        isWritableLinkTitle(req.newTitle) &&
        !titleTaken(req.oldTitle) &&
        !titleTaken(req.newTitle);
      if (titleLinks) needles.push(`[[${req.oldTitle.trim()}`);
      const where = needles.map((_, i) => `body LIKE ?${i + 3} ESCAPE '\\'`).join(' OR ');
      const rows = database.selectObjects(
        `SELECT lid, title, archetype, body, entry_order FROM entries
          WHERE cid = ?1 AND lid <> ?2 AND ${USER_REALM_SQL} AND (${where})
          ORDER BY entry_order, lid`,
        [req.cid, req.lid, ...needles.map((n) => toLikePattern(n))],
      ) as Array<{ lid: string; title: string; archetype: string; body: string; entry_order: number }>;
      const skip = new Set(req.skipLids);
      const wrote: Array<{ lid: string; body: string; stamps: EntryStamps }> = [];
      let links = 0;
      for (const r of rows) {
        if (skip.has(r.lid)) continue;
        const first = renameLinkTexts(r.body, req.lid, req.cid, req.oldTitle, req.newTitle);
        const second = titleLinks
          ? renameTitleLinks(first.body, req.oldTitle, req.newTitle)
          : { body: first.body, count: 0 };
        const res = { body: second.body, count: first.count + second.count };
        if (res.count === 0) continue;
        const ext = extractMeta(r.archetype, res.body);
        const w = writeEntryRow(
          database,
          req.cid,
          {
            lid: r.lid,
            title: r.title,
            archetype: r.archetype,
            body: res.body,
            entryOrder: r.entry_order,
            status: ext.status,
            date: ext.date,
            archived: ext.archived,
          },
          { checkpoint: true, ...(req.keepLatest === undefined ? {} : { keepLatest: req.keepLatest }) },
        );
        wrote.push({ lid: r.lid, body: res.body, stamps: w.stamps });
        links += res.count;
      }
      database.exec('COMMIT');
      return { wrote, links };
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
  },
  bulkUpsertEntries: (req) => {
    // 1 tx に束ねる ── journal 増幅対策(計器 1 で実測した ~120 倍の主因が
    // upsert 毎の暗黙 tx であることの検証と対策を兼ねる)
    const database = need();
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const e of req.entries)
        database.exec({ sql: UPSERT_SQL, bind: bindUpsert(req.cid, e) });
      database.exec('COMMIT');
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
    return null;
  },
  deleteEntry: (req) => {
    // entry の削除は relations(両向き)を**同 tx**で掃除する(storage
    // review #8 ── orphan relation を作らない)。revisions は P5 から**消さない**:
    // 削除直前の行から trash snapshot を同 tx で積み、「entries に居ない
    // entry_lid の revisions」= ゴミ箱、が復元経路になる(掃除は purgeTrash)。
    // assets の掃除は body 参照ベースなので asset GC(P4b)
    const database = need();
    database.exec('BEGIN IMMEDIATE');
    try {
      const row = database.selectObjects(
        'SELECT title, archetype, body, created_at, updated_at, entry_order FROM entries WHERE cid = ? AND lid = ?',
        [req.cid, req.lid],
      )[0] as
        | {
            title: string;
            archetype: string;
            body: string;
            created_at: string | null;
            updated_at: string | null;
            entry_order: number | null;
          }
        | undefined;
      if (row && req.untouched === true) {
        /**
         * 🔴 **何も書かれていない作りたてのノートは、ゴミ箱を経由せず行ごと消す**(#1087)。
         * ⚠ 戻す先の無い物なので、履歴(作成時に積まれた版があれば)も居場所の辺も**同じ tx で**掃除する。
         *   版を残すと「entries に居ない entry_lid の revisions」= ゴミ箱になり、空のノートが一覧に現れる。
         */
        database.exec({
          sql: 'DELETE FROM revisions WHERE cid = ? AND entry_lid = ?',
          bind: [req.cid, req.lid],
        });
        database.exec({
          sql: 'DELETE FROM relations WHERE cid = ? AND (from_lid = ? OR to_lid = ?)',
          bind: [req.cid, req.lid, req.lid],
        });
      } else if (row) {
        // 削除で tip(entries.body)が消えるので、鎖の base を**全文で確定**する。
        // 頭が既に同内容を記録していれば、その行を全文化するだけでよい
        // (行 id / content_hash は保つ ── change ID の安定)
        const hash = contentHash64Hex(row.body);
        const head = headRevision(database, req.cid, req.lid);
        if (head && head.content_hash === hash) {
          // 🔴 **題名と種類も今の値にする**(#1087、ゴミ箱の見直し)── 本文を変えずに改名してから消すと、
          //   頭の版は**改名前の題名**のままで、ゴミ箱の一覧にも、戻したノートにもその題名が出ていた
          //   (戻すときの題名はこの行から読む)。改名は本文に触らない口(`renameEntry`)なので、ここで拾う
          database.exec({
            sql: `UPDATE revisions SET snapshot = ?, kind = 'full', title = ?, archetype = ?, entry_created_at = ?,
                         entry_order = ?, entry_updated_at = ? WHERE cid = ? AND id = ?`,
            bind: [
              row.body,
              row.title,
              row.archetype,
              row.created_at,
              row.entry_order === null ? null : String(row.entry_order),
              row.updated_at,
              req.cid,
              head.id,
            ],
          });
        } else {
          database.exec({
            sql: `INSERT INTO revisions
                    (cid, id, entry_lid, created_at, rev_order, snapshot,
                     title, archetype, content_hash, kind, entry_created_at, entry_order, entry_updated_at)
                  VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, 'full', ?, ?, ?)`,
            bind: [
              req.cid,
              `rev-${crypto.randomUUID()}`,
              req.lid,
              (head?.rev_order ?? 0) + 1,
              row.body,
              row.title,
              row.archetype,
              hash,
              row.created_at,
              row.entry_order === null ? null : String(row.entry_order),
              row.updated_at,
            ],
          });
          // 🔴 ゴミ箱へ移すときに足す行の後も刈る(#1087)── 刈らないと「移す → 戻す → 保存」の
          //   繰り返しで 1 ノートの履歴が上限を超えて育つ。頭(今足した全文)は消えない
          pruneChain(database, req.cid, req.lid, req.keepLatest ?? DEFAULT_REVISION_KEEP);
        }
      }
      // 🔴 **relations は消さない**(2026-08-05、user 報告の調査で判明)。
      //
      // 直す前はここで `from_lid` / `to_lid` の両側を消していた。すると
      // **ゴミ箱から戻しても居場所が戻らない** ── 子を消して復元すると root へ出て、
      // フォルダを消して復元すると中身が空になる(実測)。ゴミ箱は「戻せる」ための
      // 機構なのに、戻すと必ず階層から外れていた。
      //
      // ⚠ 残しても**木は壊れない**:`resolveCanonicalParents` は
      //    「親が metas に実在する folder」でなければ辺を無視するので、
      //    ゴミ箱の間は子が root に出る(= 従来どおりの見え方)。
      //    戻せば親が metas に戻り、辺がそのまま効く。
      // ⚠ 本当に消えるのは `purgeTrash`(そこで参照の切れた行を掃除する)。
      database.exec({
        sql: 'DELETE FROM entries WHERE cid = ? AND lid = ?',
        bind: [req.cid, req.lid],
      });
      database.exec('COMMIT');
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
    return null;
  },
  listRelations: (req) =>
    need().selectObjects(
      `SELECT id, from_lid, to_lid, kind, created_at, updated_at
         FROM relations WHERE cid = ? ORDER BY id`,
      [req.cid],
    ) as unknown as ResultMap['listRelations'],
  /**
   * 🔴 **関係を 1 件消す**(#185)。⚠ 作れて消せない導線は dead click の一種なので、
   * UI より先にここを開ける。
   * ⚠ 居ない id を消しても**成功**にする(冪等 ── 2 回押しても壊れない)。
   */
  deleteRelation: (req) => {
    need().exec({
      sql: 'DELETE FROM relations WHERE cid = ? AND id = ?',
      bind: [req.cid, req.id],
    });
    return null;
  },
  bulkUpsertRelations: (req) => {
    const database = need();
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const r of req.relations) {
        database.exec({
          sql: `INSERT INTO relations (cid, id, from_lid, to_lid, kind, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                ON CONFLICT(cid, id) DO UPDATE SET
                  from_lid = excluded.from_lid,
                  to_lid = excluded.to_lid,
                  kind = excluded.kind,
                  updated_at = excluded.updated_at`,
          bind: [req.cid, r.id, r.fromLid, r.toLid, r.kind],
        });
      }
      database.exec('COMMIT');
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
    return null;
  },
  /**
   * 🔴 **居場所を張り替える**(2026-08-05。フォルダ整理)。
   *
   * ⚠ 1 tx で「落として張る」── 2 op に割ると、途中で落ちたときに
   * **親無しの宙ぶらりん**が残る。
   * ⚠ 落とすのは **structural だけ**。意味リンクなど他の kind は居場所と無関係で、
   *    まとめて消すと**別の情報が黙って失われる**。
   */
  setEntryParent: (req) => {
    const database = need();
    database.exec('BEGIN IMMEDIATE');
    try {
      writeParent(database, req.cid, req.lid, req.parentLid, req.relationId, req.alsoIn ?? []);
      database.exec('COMMIT');
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
    return null;
  },
  importRevisionChains: (req) => {
    // 取込の履歴を **P5c の鎖**として積む(user 裁定 2026-08-01
    // 「revisions の考え方は持ち込む、ただし jujutsu 的に遡及パッチ」)。
    // 符号化は maintainChain と同一 ── 行 k は「その版の状態」を復元し、
    // tip(entries.body)から rev_order 降順に遡って materialize される。
    //   行 m: encodeReverse(tip,   S_m)
    //   行 k: encodeReverse(S_k+1, S_k)
    // **全文で積む経路は持たない**(持つと取込だけが設計から外れ、PKC2 と同じ
    // 「履歴が本文の N 倍」に戻る)。保存形は listRevisionMetas の kind で観測できる
    const database = need();
    const keepLatest = Math.max(1, req.keepLatest ?? DEFAULT_REVISION_KEEP);
    const out: ResultMap['importRevisionChains'] = {
      added: 0,
      skippedNoChange: 0,
      droppedOverLimit: 0,
      skippedEntries: [],
      brokenChains: [],
    };
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const chain of req.chains) {
        writeChain(database, req.cid, chain.entryLid, chain.snapshots, keepLatest, out);
      }
      database.exec('COMMIT');
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
    return out;
  },
  /**
   * 保存形の鎖を復元する(P6e)。**decode してから `writeChain` へ流す** ──
   * 移行専用の書込経路を作らないための形(PKC2 の教訓: 移行専用の書込経路こそが
   * 穴の空いていた場所)。codec(`materialize`)もここにしか無いので、
   * 読み側と書き側がずれようがない。
   *
   * ⚠ 保証するのは「**同じ状態列**が戻る」ことで、同じバイト列ではない ──
   * decode → encode を往復するので、刈り込みと無変更版の畳み込みが再適用される
   * (user 裁定 2026-08-02「目的に合っていればそれでいい」)。
   */
  /**
   * 保存形の鎖を復元する(P6e)。**decode してから `writeChain` へ流す** ──
   * 移行専用の書込経路を作らないための形(PKC2 の教訓: 移行専用の書込経路こそが
   * 穴の空いていた場所)。codec(`materialize`)もここにしか無いので、
   * 読み側と書き側がずれようがない。
   *
   * ⚠ 保証するのは「**同じ状態列**が戻る」ことで、同じバイト列ではない ──
   * decode → encode を往復するので、刈り込みと無変更版の畳み込みが再適用される
   * (user 裁定 2026-08-02「目的に合っていればそれでいい」)。
   */
  restoreRevisionChains: (req) => {
    const database = need();
    const keepLatest = Math.max(1, req.keepLatest ?? DEFAULT_REVISION_KEEP);
    const out: ResultMap['restoreRevisionChains'] = {
      added: 0,
      skippedNoChange: 0,
      droppedOverLimit: 0,
      skippedEntries: [],
      brokenChains: [],
    };
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const chain of req.chains) {
        // 🔴 **鎖ごとに救う**(review M-1)。1 本が壊れているだけで全 entry の
        // 履歴が巻き戻ると、user に残るのは「本文はあるが履歴ゼロ」で、
        // 取り直しても同じ場所で落ちる。添付は既に 1 件ずつ救っている
        database.exec('SAVEPOINT chain');
        try {
          restoreOneChain(database, req.cid, chain, keepLatest, out);
          database.exec('RELEASE chain');
        } catch (e) {
          database.exec('ROLLBACK TO chain');
          database.exec('RELEASE chain');
          out.skippedEntries.push(chain.entryLid);
          out.brokenChains.push(
            `${chain.entryLid}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      database.exec('COMMIT');
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
    return out;
  },
  /** 鎖を**保存形のまま**返す(P6e)。⚠ materialize しない。 */
  exportRevisionChain: (req) =>
    (
      need().selectObjects(
        `SELECT rev_order, created_at, title, archetype, kind, snapshot, content_hash
           FROM revisions WHERE cid = ? AND entry_lid = ?
          ORDER BY rev_order DESC`,
        [req.cid, req.entryLid],
      ) as unknown as Array<{
        rev_order: number;
        created_at: string | null;
        title: string | null;
        archetype: string | null;
        kind: string | null;
        snapshot: string;
        content_hash: string | null;
      }>
    ).map((r) => ({
      revOrder: r.rev_order,
      createdAt: r.created_at,
      title: r.title,
      archetype: r.archetype,
      // ⚠ NULL は 'full' 扱い(schema の規約)── **書出しの時点で正規化する**
      kind: r.kind ?? 'full',
      snapshot: r.snapshot,
      contentHash: r.content_hash,
    })),

  /**
   * 🔴 **版ごとの増減行数**(#398 段①)。
   *
   * ⚠ **本文は 1 バイトも返さない** ── `snapshot` はここで読んで**数だけ**にする
   *   (`listRevisionMetas` が snapshot を読まない規律と同じ向き)。
   * 🔴 **向きは見出しと同じ**(#1231 着地後レビュー: 札と見出しが逆向きだった)。
   *   「**`+` = この版にだけある行 = 戻すと戻る行**、`−` = 1 つ新しい版にだけある行」。
   *   保存形は「1 つ新しい版 → この版」の**逆向き**パッチなので:
   *   - 逆向きで**入れる**行 = 此処に在って新しい側に無い = 🔑 `+`(この版にだけある)
   *   - 逆向きで**消す**行 = 新しい側に在って此処に無い = 🔑 `−`(1 つ新しい版にだけある)
   *   ⚠ ここを取り違えると、行の札と開いた見出し(`diffCounts(相手, この版)`)の
   *     `+` と `-` が**そっくり入れ替わる**
   *     ── しかも数字は出るので、誰も気づけない(CLAUDE.md §4「出た値は本物、
   *     測っている対象だけが違う」の向き違い版)。
   * ⚠ 全文で持っている版は**比べる相手が居ない**ので `null`(0 と潰さない)。
   * ⚠ 壊れたパッチでも**落ちない** ── その行だけ `null` にする(履歴の一覧が
   *   1 件の壊れで丸ごと開けなくなるほうが実害が大きい)。
   */
  revisionDiffStats: (req) => {
    const rows = need().selectObjects(
      `SELECT id, kind, snapshot FROM revisions
        WHERE cid = ? AND entry_lid = ? ORDER BY rev_order DESC`,
      [req.cid, req.entryLid],
    ) as unknown as { id: string; kind: string | null; snapshot: string }[];
    return rows.map((r) => {
      if (r.kind !== 'patch') return { id: r.id, added: null, removed: null };
      try {
        const { ops } = parseLinePatch(r.snapshot);
        let back = 0;
        let ins = 0;
        for (const op of ops) {
          if (typeof op === 'number') {
            if (op < 0) back += -op;
          } else ins += op.length;
        }
        // 🔑 見出しと同じ向き(上の注記)── `+` = この版にだけある行 = 逆向きの「入れる」
        return { id: r.id, added: ins, removed: back };
      } catch {
        return { id: r.id, added: null, removed: null };
      }
    });
  },
  listRevisionMetas: (req) =>
    // snapshot 列を読まない ── 一覧は meta だけ、本文は getRevision で 1 行ずつ
    need().selectObjects(
      `SELECT id, entry_lid, rev_order, created_at, title, archetype, kind
         FROM revisions WHERE cid = ? AND entry_lid = ?
        ORDER BY rev_order DESC`,
      [req.cid, req.entryLid],
    ) as unknown as ResultMap['listRevisionMetas'],
  listRevisionLids: (req) =>
    // 取込の lid 衝突判定は **entries だけでは足りない**(review H-1)。
    // ゴミ箱は「entries に居ない entry_lid の revisions」ビューなので、削除済み lid は
    // entryMetas に居ない ── そこへ同じ lid を書くと ① その item がゴミ箱から消え
    // ② 取り込んだ entry の履歴に他人の版が並ぶ(復元で上書き)。両方とも実証済み
    (
      need().selectObjects(
        'SELECT DISTINCT entry_lid FROM revisions WHERE cid = ?',
        [req.cid],
      ) as unknown as Array<{ entry_lid: string }>
    ).map((r) => r.entry_lid),
  listTrash: (req) =>
    // ゴミ箱 = 「entries に居ない entry_lid の最新 revision」ビュー(P5 設計 §1)。
    // 独立 trash 機構は作らない ── PKC2 の設計を sqlite で自然に表現
    need().selectObjects(
      `SELECT r.id, r.entry_lid, r.rev_order, r.created_at, r.title, r.archetype, r.kind
         FROM revisions r
         JOIN (SELECT entry_lid, MAX(rev_order) AS mx FROM revisions
                WHERE cid = ?1 GROUP BY entry_lid) m
           ON m.entry_lid = r.entry_lid AND m.mx = r.rev_order
        WHERE r.cid = ?1
          AND NOT EXISTS (SELECT 1 FROM entries e
                           WHERE e.cid = r.cid AND e.lid = r.entry_lid)
        ORDER BY r.created_at DESC, r.entry_lid`,
      [req.cid],
    ) as unknown as ResultMap['listTrash'],
  listTrashHeads: (req) => {
    const rows = need().selectObjects(
      `SELECT r.entry_lid AS lid, r.title AS title, r.archetype AS archetype,
              r.entry_created_at AS created_at, r.entry_updated_at AS updated_at,
              r.entry_order AS entry_order, r.created_at AS trashed_at
         FROM revisions r
         JOIN (SELECT entry_lid, MAX(rev_order) AS mx FROM revisions
                WHERE cid = ?1 GROUP BY entry_lid) m
           ON m.entry_lid = r.entry_lid AND m.mx = r.rev_order
        WHERE r.cid = ?1
          AND NOT EXISTS (SELECT 1 FROM entries e
                           WHERE e.cid = r.cid AND e.lid = r.entry_lid)
        ORDER BY r.created_at DESC, r.entry_lid`,
      [req.cid],
    ) as unknown as Array<Omit<ResultMap['listTrashHeads'][number], 'entry_order'> & { entry_order: string | number | null }>;
    // 並びの位置は TEXT で控えてある(列の型は TEXT)── 数へ読み戻す。読めなければ「控え無し」
    return rows.map((r) => {
      const n = r.entry_order === null || r.entry_order === undefined ? Number.NaN : Number(r.entry_order);
      return { ...r, entry_order: Number.isFinite(n) ? n : null };
    });
  },
  restoreTrashNotes: (req) => {
    const database = need();
    const keepLatest = Math.max(1, req.keepLatest ?? DEFAULT_REVISION_KEEP);
    const out: ResultMap['restoreTrashNotes'] = {
      added: 0,
      skippedNoChange: 0,
      droppedOverLimit: 0,
      skippedEntries: [],
      brokenChains: [],
    };
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const note of req.notes) {
        // 🔴 1 件ずつ救う(`restoreRevisionChains` と同じ) ── 1 件が壊れていても、ほかのゴミ箱のノートは戻す
        database.exec('SAVEPOINT trashnote');
        try {
          restoreOneTrashNote(database, req.cid, note, keepLatest, out);
          database.exec('RELEASE trashnote');
        } catch (e) {
          database.exec('ROLLBACK TO trashnote');
          database.exec('RELEASE trashnote');
          out.skippedEntries.push(note.entryLid);
          out.brokenChains.push(`${note.entryLid}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      database.exec('COMMIT');
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
    return out;
  },
  purgeTrash: (req) => {
    const database = need();
    /**
     * 🔴 **1 件だけ完全に消す**(台帳 #1852 G2 / 依頼 301 A)。下の「空にする」の注記が予告していた部分 purge ──
     * 消すのは**この lid の履歴と、この lid に触るつながり**だけ(ほかのゴミ箱のノートの居場所を壊さない)。
     * ⚠ 生きているノート(entries に居る lid)は消さない ── 画面が古くて、戻した後に押されても履歴を落とさない。
     */
    if (req.lid !== undefined) {
      database.exec({
        sql: `DELETE FROM revisions
               WHERE cid = ?1 AND entry_lid = ?2
                 AND entry_lid NOT IN (SELECT lid FROM entries WHERE cid = ?1)`,
        bind: [req.cid, req.lid],
      });
      const purgedOne = database.changes();
      if (purgedOne > 0)
        database.exec({
          sql: `DELETE FROM relations WHERE cid = ?1 AND (from_lid = ?2 OR to_lid = ?2)`,
          bind: [req.cid, req.lid],
        });
      return { purged: purgedOne };
    }
    database.exec({
      sql: `DELETE FROM revisions
             WHERE cid = ?1
               AND entry_lid NOT IN (SELECT lid FROM entries WHERE cid = ?1)`,
      bind: [req.cid],
    });
    const purged = database.changes();
    /**
     * 🔴 **ここが relations の最終処分場**(2026-08-05)。`deleteEntry` は
     * 「ゴミ箱から戻したら居場所も戻る」ために辺を残すので、**本当に消えた lid の
     * 辺**はここで掃除する。掃除しないと、消えた lid を指す辺が永久に溜まる。
     *
     * ⚠ 判定は「**entries に居ない**」の 1 つで足りる ── この op は
     * **ゴミ箱を空にする**(= entries に居ない lid の revisions を全部落とす)op で
     * あって、部分的な掃除ではない。だから「entries に居ない」= 「もう戻せない」。
     * 🔑 最初は「entries にも revisions にも居ない」と 2 条件で書いていたが、
     * revisions 側は**結果を変えない死んだ判定**だった(変異試験で露見 ──
     * 落としても全 test が緑)。判定を増やさない(CLAUDE.md)。
     * ⚠ 部分 purge を将来入れるなら、**ここも一緒に狭める**
     * (「消した lid の辺だけ」にする)── でないと戻せる item の居場所を壊す。
     */
    database.exec({
      sql: `DELETE FROM relations
             WHERE cid = ?1
               AND (from_lid NOT IN (SELECT lid FROM entries WHERE cid = ?1)
                 OR to_lid NOT IN (SELECT lid FROM entries WHERE cid = ?1))`,
      bind: [req.cid],
    });
    return { purged };
  },
  revisionCounts: (req) =>
    // snapshot 列を読まない ── revisions は常駐ゼロ、件数は index scan(§4.1)
    need().selectObjects(
      `SELECT entry_lid, COUNT(*) AS n FROM revisions
        WHERE cid = ? GROUP BY entry_lid`,
      [req.cid],
    ) as unknown as ResultMap['revisionCounts'],
  getRevision: (req) => {
    // 要求駆動(§4.1)。鎖を tip 側から目標まで遡って復元する ── 読むのは
    // 「その entry の、目標以降の行」だけ(他 entry も古い側も触らない)
    const database = need();
    const target = database.selectObjects(
      `SELECT entry_lid, rev_order, title, archetype, content_hash, entry_created_at, entry_order, entry_updated_at
         FROM revisions WHERE cid = ? AND id = ?`,
      [req.cid, req.id],
    )[0] as
      | {
          entry_lid: string;
          rev_order: number;
          title: string | null;
          archetype: string | null;
          content_hash: string | null;
          entry_created_at: string | null;
          entry_order: string | number | null;
          entry_updated_at: string | null;
        }
      | undefined;
    if (!target) return null;

    // ① まず **snapshot を読まずに** 骨組みだけ引き、出発点(anchor)を決める。
    // 出発点 = 目標に最も近い全文行(あれば)/ 無ければ tip(entries.body)。
    // ⚠ 先に snapshot 込みで全部読むと、anchor より新しい行の本文まで
    // materialize してしまう(review P5c F5 ── 全面書換 100 世代で 14MB を
    // 1 回の select で読む実測)。生成物を作らない = 即破棄以前の問題
    const skeleton = database.selectObjects(
      `SELECT rev_order, kind FROM revisions
        WHERE cid = ? AND entry_lid = ? AND rev_order >= ?
        ORDER BY rev_order DESC`,
      [req.cid, target.entry_lid, target.rev_order],
    ) as unknown as Array<{ rev_order: number; kind: string | null }>;
    let anchorOrder: number | null = null;
    for (let i = skeleton.length - 1; i >= 0; i--) {
      if ((skeleton[i]!.kind ?? 'full') === 'full') {
        anchorOrder = skeleton[i]!.rev_order;
        break;
      }
    }
    // ② 実際に遡る区間の snapshot だけを読む
    const rows = (
      anchorOrder === null
        ? database.selectObjects(
            `SELECT id, rev_order, snapshot, content_hash, kind FROM revisions
              WHERE cid = ? AND entry_lid = ? AND rev_order >= ?
              ORDER BY rev_order DESC`,
            [req.cid, target.entry_lid, target.rev_order],
          )
        : database.selectObjects(
            `SELECT id, rev_order, snapshot, content_hash, kind FROM revisions
              WHERE cid = ? AND entry_lid = ? AND rev_order BETWEEN ? AND ?
              ORDER BY rev_order DESC`,
            [req.cid, target.entry_lid, target.rev_order, anchorOrder],
          )
    ) as unknown as RevRow[];

    let state: string;
    let from: number;
    if (anchorOrder !== null) {
      state = rows[0]!.snapshot; // 区間の先頭 = anchor(全文行)
      from = 1;
    } else {
      const tip = database.selectObjects(
        'SELECT body FROM entries WHERE cid = ? AND lid = ?',
        [req.cid, target.entry_lid],
      )[0] as { body: string } | undefined;
      if (!tip) {
        // 全文行も tip も無い = 鎖の base が失われている。**嘘の本文を返さない**
        throw new Error(`revision restore failed (no base): ${target.entry_lid}`);
      }
      state = tip.body;
      from = 0;
    }
    try {
      // ⚠ 段ごとに parse → apply する(review M2): 全段を先に parse して
      // 配列に持つと、パッチの ops が**同時生存**して JS ヒープの峰が増える
      // (実測: 100 世代の全面書換で 15.8MB → 28.5MB、+80% の回帰だった)。
      // wasm 経路を配線するときは「全段を 1 往復で渡す」形に戻すが、そのときは
      // 中間の全文文字列が消える見返りがある ── 今は TS が本番経路なので、
      // 峰を上げるだけの前借りはしない
      for (let i = from; i < rows.length; i++) {
        state = materialize(rows[i]!, state);
      }
    } catch (e) {
      // パッチが base に噛み合わない = 鎖が壊れている(bulk 書込で tip を
      // 差し替えた等)。復元不能として可視で終える
      throw new Error(`revision restore failed (chain broken): ${String(e)}`, {
        cause: e,
      });
    }
    // git 的な整合性検証: 復元結果の hash が記録と食い違えば可視エラーで止める
    // (壊れた鎖から「それらしい本文」を返さない ── S3 規律)
    if (target.content_hash && contentHash64Hex(state) !== target.content_hash) {
      throw new Error(`revision restore failed (integrity check): ${req.id}`);
    }
    return {
      body: state,
      title: target.title,
      archetype: target.archetype,
      entryCreatedAt: target.entry_created_at,
      // 🔴 TEXT で控えた並びを数へ読み戻す(数にならなければ控え無し ── 従来どおり)
      entryOrder:
        target.entry_order === null || !Number.isFinite(Number(target.entry_order))
          ? null
          : Number(target.entry_order),
      entryUpdatedAt: target.entry_updated_at,
    };
  },
  putAssetMeta: (req) => {
    const m = req.meta;
    // 🔴 同じ中身(= 同じ key)を、種類の分からない取り込み(`application/octet-stream`)で入れ直しても、
    //   すでに分かっている種類(image/png など)を一般の種類へ**格下げしない**(画像として開けなくなる)。
    //   逆向き(一般 → 具体)と、同じ key の別の具体的な種類への更新は今までどおり書く(meta の自己修復)。
    need().exec({
      sql: `INSERT INTO assets (cid, key, mime, size, hash)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(cid, key) DO UPDATE SET
              mime = CASE WHEN excluded.mime = 'application/octet-stream' AND assets.mime <> ''
                          THEN assets.mime ELSE excluded.mime END,
              size = excluded.size, hash = excluded.hash`,
      bind: [req.cid, m.key, m.mime, m.size, m.hash ?? null],
    });
    return null;
  },
  listAssetMetas: (req) =>
    need().selectObjects(
      'SELECT key, mime, size, hash FROM assets WHERE cid = ? ORDER BY key',
      [req.cid],
    ) as unknown as ResultMap['listAssetMetas'],
  deleteAssetMeta: (req) => {
    need().exec({
      sql: 'DELETE FROM assets WHERE cid = ? AND key = ?',
      bind: [req.cid, req.key],
    });
    return null;
  },
  /**
   * 🔴 **何が容量を食っているか**(#415)。
   *
   * ⚠ **数字だけ返す**(`revisionDiffStats` と同じ形)── 本文も bytes も
   *   worker の外へ出ない。添付の大きさは `assets` の列に在るので
   *   `AssetBlobStore` は 1 度も触らない。
   * ⚠ 本文は**行ごとに callback で見て保持しない**(全 body の同時 materialize は
   *   500MB 級で OOM ── `scanAssetRefs` と同じ理由)。
   * 🔑 照合は `assetRefsIn`(規則の正本は `features/asset/asset-ref-scan.ts`)。
   *
   * ⚠ **共有している添付は、参照している全部のノートに満額で数える** ──
   *   按分すると「1.4MB の写真が 0.7MB と 0.7MB」に見えて、消しても
   *   その分しか減らないと誤解される。⚠ そのぶん行の合計は器の総量を超えうるので、
   *   `totalAssetBytes`(重複を数えない)と `sharedAssets` を併せて返す。
   */
  storageProfile: (req) => {
    const size = new Map<string, number>();
    need().exec({
      sql: 'SELECT key, size FROM assets WHERE cid = ?',
      bind: [req.cid],
      rowMode: 'object',
      callback: (row: unknown) => {
        const r = row as { key?: unknown; size?: unknown };
        const key = typeof r.key === 'string' ? r.key : '';
        // ⚠ `size` は NULL がありうる(`listAssetMetas` の注記)── 0 として数える
        if (key !== '') size.set(key, typeof r.size === 'number' ? r.size : 0);
      },
    });
    const keys = [...size.keys()];
    /** 何本のノートから参照されているか(共有の判定)。 */
    const refCount = new Map<string, number>();
    const rows: { lid: string; assetBytes: number; bodyChars: number; keys: string[] }[] = [];
    need().exec({
      sql: 'SELECT lid, body, body_chars FROM entries WHERE cid = ?',
      bind: [req.cid],
      rowMode: 'object',
      callback: (row: unknown) => {
        const r = row as { lid?: unknown; body?: unknown; body_chars?: unknown };
        const lid = typeof r.lid === 'string' ? r.lid : '';
        if (lid === '') return;
        const body = typeof r.body === 'string' ? r.body : '';
        const hit = keys.length === 0 ? [] : assetRefsIn(body, keys);
        for (const k of hit) refCount.set(k, (refCount.get(k) ?? 0) + 1);
        rows.push({
          lid,
          assetBytes: hit.reduce((n, k) => n + (size.get(k) ?? 0), 0),
          // ⚠ `null`(まだ数えていない)は 0 として出す ── 画面は「重い順」を見るだけ
          bodyChars: typeof r.body_chars === 'number' ? r.body_chars : 0,
          keys: hit,
        });
      },
    });
    /**
     * 🔴 **履歴とゴミ箱が使っている添付は「使われていない」に数えない**(#1087)。
     * ⚠ 整理(`scanAssetRefs`)は revisions も保持扱いにする ── ここが entries しか見ないと、
     *   ゴミ箱のノートの添付を「消せます」と案内したのに、整理は「使われていない添付はありません」と言う。
     *   判定は整理と同じ `scanAssetRefsInto`(規則を写さない)。
     */
    const unused = new Set(keys.filter((k) => (refCount.get(k) ?? 0) === 0));
    if (unused.size > 0) {
      need().exec({
        sql: 'SELECT snapshot FROM revisions WHERE cid = ?',
        bind: [req.cid],
        rowMode: '$snapshot',
        callback: (row: unknown): false | void => {
          if (unused.size === 0) return false;
          scanAssetRefsInto(typeof row === 'string' ? row : '', unused, () => {});
        },
      });
    }
    let orphanBytes = 0;
    for (const k of unused) orphanBytes += size.get(k) ?? 0;
    return {
      rows: rows.map((r) => ({
        lid: r.lid,
        assetBytes: r.assetBytes,
        bodyChars: r.bodyChars,
        sharedAssets: r.keys.filter((k) => (refCount.get(k) ?? 0) > 1).length,
      })),
      totalAssetBytes: [...size.values()].reduce((a, b) => a + b, 0),
      orphanBytes,
    } as ResultMap['storageProfile'];
  },
  scanAssetRefs: (req) => {
    // asset GC(P4b)の keep-set: 候補 key が**どこかの body に substring として
    // 現れるか**で判定する。frontmatter(attachment.asset_key / app_icon_asset_key /
    // extra 内 JSON)も本文の asset: 参照も、参照は必ず key 文字列そのものを含むので
    // この 1 規則が全参照源を包摂する。誤差は false-keep 側にしか出ない
    // (本文の無関係な散文が key 文字列を偶然含む)── GC で許されるのはその向きだけ。
    // body は行ごとに callback で見て保持しない(全 body の同時 materialize は
    // 500MB 級で OOM ── PKC2 の reconcile 走査の教訓)。
    // ⚠ P5(revisions)着地時: 履歴 snapshot が参照する asset を消さないよう、
    // revisions 表も同じ規則で走査に加えること
    const remaining = new Set(req.candidates);
    const referenced: string[] = [];
    const scanText = (row: unknown): false | void => {
      if (remaining.size === 0) return false; // 全候補確定 ── 以降の行読みごと停止
      const body = typeof row === 'string' ? row : '';
      // ⚠ raw だけでは足りない(review F2 ── false-delete の反例):
      // markdown-it は link destination を unescape してから key を取り出すので、
      // `asset:ast\-key` / `asset:ast&#45;key` は**生きた参照なのに raw に key が
      // 現れない**。backslash escape と数値実体だけ畳んだ第 2 形でも照合する
      // (keep 側に広がるだけで安全)。正規 key の字母 [a-z0-9-] は名前付き
      // 実体では書けない(英数字と '-' の名前付き実体が存在しない)ため 2 形で閉じる
      // ⚠ 2 回通す(review P5c F2 ── P5c で入った回帰):revisions.snapshot は
      // patch のとき **JSON テキスト**なので backslash が二重化している
      // (`asset:ast\-k` → snapshot 上は `ast\\-k`)。1 パスでは `\-k` までしか
      // 戻らず、古い版にしか無い escape 済み参照を GC が消してしまう。
      // 2 パスは keep 側にしか広がらないので安全
      // 🔴 判定は **features/asset/asset-ref-scan.ts が正本**(P6f review H-1)──
      // 同じ規則を別々に書くと、片方だけが「生きた参照」を落とす
      if (!scanAssetRefsInto(body, remaining, (k) => referenced.push(k))) return false;
    };
    if (remaining.size > 0) {
      need().exec({
        sql: 'SELECT body FROM entries WHERE cid = ?',
        bind: [req.cid],
        rowMode: '$body', // 列値を直接受ける(行 object を作らない)
        callback: scanText,
      });
    }
    if (remaining.size > 0) {
      // P5: revisions(履歴 + ゴミ箱)が参照する asset も keep ── trash から
      // 復元した entry の添付が purge 済み、を防ぐ(P4b worker コメントの義務)
      need().exec({
        sql: 'SELECT snapshot FROM revisions WHERE cid = ?',
        bind: [req.cid],
        rowMode: '$snapshot',
        callback: scanText,
      });
    }
    return { referenced };
  },
  counts: (req) => {
    const one = (sql: string): number =>
      Number(need().selectObjects(sql, [req.cid])[0]?.n ?? 0);
    return {
      entries: one('SELECT COUNT(*) AS n FROM entries WHERE cid = ?'),
      relations: one('SELECT COUNT(*) AS n FROM relations WHERE cid = ?'),
      revisions: one('SELECT COUNT(*) AS n FROM revisions WHERE cid = ?'),
      assets: one('SELECT COUNT(*) AS n FROM assets WHERE cid = ?'),
    };
  },
  /** 🔴 **保存領域の太り具合を測る**(#999 段①)── 読むだけ。実体は `measureGauge`。 */
  storageGauge: () => measureGauge(need()),
  /**
   * 🔴 **索引の片づけを 1 回打つ**(#999 段①の計測 → 段③)。
   *
   * ⚠ 打つのは FTS5 の `optimize` **だけ**。🔴 **VACUUM をここへ足さない**
   *   (#1218: 途中でタブが殺されると DB が開けなくなる ── 自動で打ってはいけない)。
   * ⚠ 同期の handler なので、**他の op と交わらない**(worker は 1 本で、
   *   書込の途中に割り込まない)。呼び側は書込の列にも載せる(`StoreEffects.run`)。
   * 🔑 前後の計器を同じ口(`measureGauge`)で採る ── 判断を 2 か所に書かない。
   */
  optimizeIndexes: () => {
    const database = need();
    const before = measureGauge(database);
    const started = Date.now();
    database.exec(`INSERT INTO entries_fts(entries_fts) VALUES ('optimize')`);
    const elapsedMs = Date.now() - started;
    return { elapsedMs, before, after: measureGauge(database) };
  },
  /**
   * 🔴 **保存領域を縮める**(#999。Gemini 裁定 A)── `VACUUM` を 1 回。
   *
   * ⚠ **押した user からしか来ない**(自動の係は打たない ── `optimizeIndexes` にも足さない)。
   * ⚠ 同期の handler なので**終わるまで他の op は待つ**(= その間は保存できない。
   *   呼び側が長さの見込みを先に言う ── `vacuumEstimateText`)。
   * 🔑 途中でタブが殺されても巻き戻る(#1218、`reserved-lock.ts`)。
   * 🔑 前後の計器は `optimizeIndexes` と同じ口(`measureGauge`)で採る。
   */
  vacuum: () => {
    const database = need();
    const before = measureGauge(database);
    const started = Date.now();
    database.exec('VACUUM');
    const elapsedMs = Date.now() - started;
    return { elapsedMs, before, after: measureGauge(database) };
  },
  /**
   * 🔴 **中身が壊れていないかを調べる**(#971 段③)。
   *
   * ⚠ **時間の上限を掛けない** ── 数 GB では分の単位になるが、ここで切ると
   *   「壊れているかどうか分からない」しか返せない(SQL の面が 8 秒で切れるので、
   *   救出の口をそこに置けないのが、そもそもこの op を足した理由である)。
   * 🔑 **読み解きはここでやらない** ── 返すのは測った物(生の行 + root の対応表)
   *   だけで、日本語に直すのは `features/storage/db-rescue.ts` である。
   */
  checkIntegrity: (req) => {
    const database = need();
    const started = Date.now();
    const rows: string[] = [];
    /**
     * 🔴 **表を名指しされたら、その表(と索引)だけ**(#1007 段①)。
     *
     * ⚠ 名前は `sqlite_schema` に**在る表**でなければ通さない ── ここは
     *   `PRAGMA` の引数に字を埋める口なので、user の字を通す形にしない。
     *   無ければ落とす(黙って丸ごとへ倒さない ── 倒すと「表ごとに軽く」の
     *   前提が静かに崩れ、保存が分の単位で待たされる)。
     * ⚠ 二重引用符で囲む(`"` は `""` へ)── 名前に空白が在っても通る。
     */
    let target = `${QUICK_CHECK_MAX_ERRORS}`;
    if (req.table !== undefined) {
      const known = database.selectValue(
        "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = ?",
        [req.table],
      );
      if (Number(known) !== 1) throw new Error(`確認する表が無い: ${req.table}`);
      target = `"${req.table.replaceAll('"', '""')}"`;
    }
    database.exec({
      // ⚠ 埋め込む数はこちらの定数(user の値が SQL に入る口を作らない)。
      //    表の名前は上で `sqlite_schema` と突き合わせた物だけ。
      sql: `PRAGMA quick_check(${target})`,
      rowMode: 'array',
      // ⚠ 式の body にしない ── `push` は number を返すので、`false | void` に当たらない
      callback: (r: unknown[]): void => {
        rows.push(String(r[0]));
      },
    });
    /**
     * ⚠ **schema が読めないほど壊れていることがある** ── そのときは空で返す。
     *   🔑 投げると「調べる」ごと失敗して、**壊れの報告まで捨てる**ことになる。
     */
    const schema: Array<{ type: string; name: string; rootpage: number }> = [];
    try {
      database.exec({
        sql: 'SELECT type, name, rootpage FROM sqlite_schema WHERE rootpage IS NOT NULL',
        rowMode: 'array',
        callback: (r: unknown[]): void => {
          schema.push({ type: String(r[0]), name: String(r[1]), rootpage: Number(r[2]) });
        },
      });
    } catch {
      /* 空のまま返す ── 名前に直せないことは呼び側が言う */
    }
    return { rows, schema, elapsedMs: Date.now() - started };
  },
  /**
   * 🔴 **タグの色**(#1457)── `settings` 表の 1 タグ 1 行(`k` = 大小無視の鍵、
   * `v` = `{"tag","color"}` の JSON)。表を足さない = 版(`DB_SCHEMA_VERSION`)を上げない。
   * ⚠ 読むときも `#rrggbb` を検める(手で書き換えた / 壊れた行を画面へ出さない)。
   */
  listTagColors: (req) => {
    const rows = need().selectObjects(
      'SELECT v FROM settings WHERE scope = ? ORDER BY k',
      [tagColorScope(req.cid)],
    ) as Array<{ v: string | null }>;
    const out: Array<{ tag: string; color: string }> = [];
    for (const r of rows) {
      try {
        const o = JSON.parse(r.v ?? '') as { tag?: unknown; color?: unknown };
        const color = normalizeTagColor(o.color);
        if (typeof o.tag === 'string' && o.tag !== '' && color !== null) {
          out.push({ tag: o.tag, color });
        }
      } catch {
        /* 読めない行は無いものとして扱う */
      }
    }
    return out;
  },
  putTagColor: (req) => {
    const database = need();
    if (req.color === null) {
      database.exec({
        sql: 'DELETE FROM settings WHERE scope = ? AND k = ?',
        bind: [tagColorScope(req.cid), req.key],
      });
      return null;
    }
    // ⚠ worker でも検める(呼び側が検め損ねても、壊れた色を表に書かない)
    const color = normalizeTagColor(req.color);
    if (color === null || req.key === '') throw new Error('タグの色は #rrggbb で指定してください');
    // 🔴 上限(`MAX_TAG_COLORS`)── 画面側(`withTagColor`)と同じ数を worker でも守る。
    //   新しい鍵だけ断り、付いているタグの色変更は通す(上限いっぱいでも直せる)
    const scope = tagColorScope(req.cid);
    const existing = database.selectValue('SELECT 1 FROM settings WHERE scope = ? AND k = ?', [
      scope,
      req.key,
    ]);
    if (existing === undefined || existing === null) {
      const n = Number(database.selectValue('SELECT count(*) FROM settings WHERE scope = ?', [scope]));
      if (n >= MAX_TAG_COLORS) {
        throw new Error(`色を付けられるタグは ${MAX_TAG_COLORS} 個までです`);
      }
    }
    database.exec({
      sql: `INSERT INTO settings(scope, k, v) VALUES (?, ?, ?)
              ON CONFLICT(scope, k) DO UPDATE SET v = excluded.v`,
      bind: [tagColorScope(req.cid), req.key, JSON.stringify({ tag: req.tag, color })],
    });
    return null;
  },
  /**
   * 🔴 **ノートのピン留め**(#1377)── `settings` 表の 1 ノート 1 行(`k` = lid、`v` = 留めた順の通し番号)。
   * 表を足さない = 版(`DB_SCHEMA_VERSION`)を上げない。⚠ ノートの本文・更新日時には触れない。
   */
  listNotePins: (req) => {
    const rows = need().selectObjects(
      'SELECT k, v FROM settings WHERE scope = ?',
      [notePinScope(req.cid)],
    ) as Array<{ k: string; v: string | null }>;
    return rows
      .map((r) => ({ lid: r.k, at: Number(r.v) }))
      .filter((r) => r.lid !== '')
      .sort((a, b) => (Number.isFinite(a.at) ? a.at : 0) - (Number.isFinite(b.at) ? b.at : 0) || a.lid.localeCompare(b.lid))
      .map((r) => r.lid);
  },
  putNotePin: (req) => {
    const database = need();
    const scope = notePinScope(req.cid);
    database.exec('BEGIN IMMEDIATE');
    try {
      // 消えたノートのピンの掃除(同じ tx)
      for (const lid of req.prune ?? []) {
        database.exec({ sql: 'DELETE FROM settings WHERE scope = ? AND k = ?', bind: [scope, lid] });
      }
      if (!req.on) {
        database.exec({ sql: 'DELETE FROM settings WHERE scope = ? AND k = ?', bind: [scope, req.lid] });
      } else {
        if (req.lid === '') throw new Error('ピン留めするノートが指定されていません');
        const existing = database.selectValue('SELECT 1 FROM settings WHERE scope = ? AND k = ?', [scope, req.lid]);
        if (existing === undefined || existing === null) {
          const n = Number(database.selectValue('SELECT count(*) FROM settings WHERE scope = ?', [scope]));
          if (n >= MAX_NOTE_PINS_STORED) throw new Error('ピン留めの記録がいっぱいです');
          const max = Number(database.selectValue('SELECT max(CAST(v AS INTEGER)) FROM settings WHERE scope = ?', [scope]));
          database.exec({
            sql: 'INSERT INTO settings(scope, k, v) VALUES (?, ?, ?)',
            bind: [scope, req.lid, String((Number.isFinite(max) ? max : 0) + 1)],
          });
        }
      }
      database.exec('COMMIT');
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
    return null;
  },
  /**
   * 🔴 **起動の検めの計画**(#1007 段①)。
   *
   * ⚠ 印が読めなくても落とさない ── `settings` 表が読めないほど壊れているなら、
   *   それは「印が無い」= **検める側へ倒す**のが正しい(門の目的は壊れに気づくこと)。
   * ⚠ 表は `rootpage > 0` だけ ── FTS の仮想表は `rootpage = 0` で、
   *   `quick_check` に渡しても何も見ない(影の表を見る)。
   */
  integrityPlan: () => {
    const database = need();
    let lastCheckedAt: string | null = null;
    try {
      const v = database.selectValue('SELECT v FROM settings WHERE scope = ? AND k = ?', [
        INTEGRITY_STAMP_SCOPE,
        INTEGRITY_STAMP_KEY,
      ]);
      lastCheckedAt = v === null || v === undefined ? null : String(v);
    } catch {
      /* 読めない = 印が無い(検める) */
    }
    const tables: string[] = [];
    database.exec({
      sql: "SELECT name FROM sqlite_schema WHERE type = 'table' AND rootpage > 0 ORDER BY rootpage",
      rowMode: 'array',
      callback: (r: unknown[]): void => {
        tables.push(String(r[0]));
      },
    });
    return { lastCheckedAt, tables };
  },
  /**
   * 🔴 **検め終えた印**(#1007 段①)── 壊れが無かった回だけ呼ばれる。
   * ⚠ 壊れていると分かった後は `CORRUPT_BLOCKED_OPS` が断る(それで正しい)。
   */
  integrityStamp: (req) => {
    need().exec({
      sql: `INSERT INTO settings(scope, k, v) VALUES (?, ?, ?)
              ON CONFLICT(scope, k) DO UPDATE SET v = excluded.v`,
      bind: [INTEGRITY_STAMP_SCOPE, INTEGRITY_STAMP_KEY, req.at],
    });
    return null;
  },
  /**
   * 🔴 **壊れていても読める分だけノートを拾う**(#971 段③)。
   *
   * ⚠ **`NOT INDEXED` を外さない** ── 索引だけ壊れた DB では、索引を使う形で
   *   引くと**無事なデータでも rc 11 で落ちる**(2026-09-16 実測)。
   * ⚠ **落ちた区画は飛ばして次へ進む** ── 1 か所で諦めると、その先が全部捨たる。
   * ⚠ **空で返る区画は「壊れていない」ではない** ── 実測では壊れているときほど
   *   空が増える(区切り 100 行で 38/40)。だから数えて返し、呼び側が必ず出す。
   */
  rescueEntries: (req) => {
    const database = need();
    const rows: ResultMap['rescueEntries']['rows'] = [];
    /**
     * 🔴 **拾い出しは(`realm: 'system'` を頼まれない限り)system 領域のノートを出さない**(設計 doc §1.1、段①)。
     *
     * ⚠ **`WHERE` へは足さない** ── `got`(= 区画に何か在ったか)は
     *   「空だった区画」という**壊れの診断**(`rescue-archive.ts` の
     *   `miss.push`)に使われる。system のノートだけが並ぶ区画を `WHERE` で
     *   落とすと、**壊れていないのに「空だった」と誤って数える**ことになる
     *   (CLAUDE.md §1「後条件は確かめた事実の上にだけ書く」の逆 ── ここでは
     *   「診断の材料を、除外の都合で減らさない」)。
     * 🔑 だから **`got` は raw の行数のまま**(`rescueScan` が数える)、
     *   **`rows` へ積む段だけ**で選ぶ。
     */
    const page = rescueScan(database, {
      table: 'entries',
      columns: 'rowid, cid, lid, title, archetype, body, realm, entry_order, created_at, updated_at',
      afterRowid: req.afterRowid,
      chunks: req.chunks,
      take: (r) => {
        if (r[6] !== (req.realm === 'system' ? 'system' : 'user')) return;
        rows.push({
          rowid: Number(r[0]),
          cid: String(r[1]),
          lid: String(r[2]),
          title: String(r[3]),
          archetype: String(r[4]),
          body: String(r[5] ?? ''),
          entryOrder: r[7] === null || r[7] === undefined || !Number.isFinite(Number(r[7])) ? null : Number(r[7]),
          createdAt: r[8] === null || r[8] === undefined ? null : String(r[8]),
          updatedAt: r[9] === null || r[9] === undefined ? null : String(r[9]),
        });
      },
    });
    return { rows, ...page };
  },
  /**
   * 🔴 **壊れていても読める分だけ、つながりを拾う**(#1087)。
   *
   * ⚠ 索引だけ壊れた DB では `NOT INDEXED` の表走査で読める(2026-10-14 実測:
   *   `relations` の 3 つの索引と主キーの索引を潰した DB で、500 件中 500 件読めた。
   *   索引を使う形の `WHERE cid=? AND from_lid=?` は rc 11)。
   */
  rescueRelations: (req) => {
    const rows: ResultMap['rescueRelations']['rows'] = [];
    const page = rescueScan(need(), {
      table: 'relations',
      columns: 'rowid, cid, id, from_lid, to_lid, kind',
      afterRowid: req.afterRowid,
      chunks: req.chunks,
      take: (r) => {
        rows.push({
          rowid: Number(r[0]),
          cid: String(r[1]),
          id: String(r[2]),
          fromLid: String(r[3]),
          toLid: String(r[4]),
          kind: String(r[5]),
        });
      },
    });
    return { rows, ...page };
  },
  /**
   * 🔴 **壊れていても読める分だけ、履歴を保存形のまま拾う**(#1087)。
   *
   * ⚠ 復元は `restoreRevisionChains`(鎖を decode して通常の書込経路へ流す)── 移行専用の
   *   書込経路は作らない。⚠ `snapshot` を運ぶので 1 区画ずつ刻む(`RESCUE_CHUNK`)。
   */
  rescueRevisions: (req) => {
    const rows: ResultMap['rescueRevisions']['rows'] = [];
    const page = rescueScan(need(), {
      table: 'revisions',
      columns:
        'rowid, cid, entry_lid, rev_order, created_at, title, archetype, kind, snapshot, content_hash, entry_created_at, entry_order, entry_updated_at',
      afterRowid: req.afterRowid,
      chunks: req.chunks,
      take: (r) => {
        rows.push({
          rowid: Number(r[0]),
          cid: String(r[1]),
          entryLid: String(r[2]),
          revOrder: Number(r[3]),
          createdAt: r[4] === null || r[4] === undefined ? null : String(r[4]),
          title: r[5] === null || r[5] === undefined ? null : String(r[5]),
          archetype: r[6] === null || r[6] === undefined ? null : String(r[6]),
          // ⚠ NULL は 'full' 扱い(schema の規約。`exportRevisionChain` と同じ)
          kind: r[7] === null || r[7] === undefined ? 'full' : String(r[7]),
          snapshot: r[8] === null || r[8] === undefined ? '' : String(r[8]),
          contentHash: r[9] === null || r[9] === undefined ? null : String(r[9]),
          entryCreatedAt: r[10] === null || r[10] === undefined ? null : String(r[10]),
          entryOrder:
            r[11] === null || r[11] === undefined || !Number.isFinite(Number(r[11])) ? null : Number(r[11]),
          entryUpdatedAt: r[12] === null || r[12] === undefined ? null : String(r[12]),
        });
      },
    });
    return { rows, ...page };
  },
  close: () => {
    // ⚠ 客の DB も一緒に手放す(閉じ忘れると、この worker が持ったまま消える)
    closeAllGuests();
    closeAllExports();
    // ⚠ close は DB 接続を閉じるだけで、SAHPool の SAH は worker 破棄まで残る
    // (review #9)。multi-tab リース実装時はこの前提で設計する
    db?.close();
    db = null;
    initResult = null;
    sqliteApi = null;
    return null;
  },
};

/**
 * 🔴 **中身が壊れていると分かったら、書き込みだけ止める**(#971)。
 *
 * ⚠ **一度立ったら下ろさない**(sticky)── 壊れた DB は、次の 1 文で治らない。
 * 🔑 **読みは通す** ── 読みこそが**持ち出す道**である(全部止めると
 *   「データは在るのに取り出せない」という、いちばん悪い形になる)。
 */
let dbCorrupt = false;

/**
 * 🔴 **増やす書き込みの前に、空きを見る**(#971 段②の残り)。
 *
 * ⚠ ここまでの容量の門は **添付(IDB)にしか掛かっていなかった** ── sqlite が
 *   育つ経路は素通りで、2026-09-16 に user の DB が 4GB を超えて壊れたのは
 *   こちら側である。
 *
 * ⚠ **毎回は測らない**(`estimate()` は安くない)── 時間と回数の両方で間隔を決める。
 * ⚠ **読めない端末では断らない** ── 測れないことを理由に保存できないアプリに
 *   するほうが、はるかに害が大きい(`refuseWrite` が `false` を返す)。
 */
let quotaSample: QuotaSample = {};
let quotaCheckedAt: number | null = null;
let writesSinceQuota = 0;

async function quotaBlocks(op: string): Promise<boolean> {
  if (!QUOTA_BLOCKED_OPS.includes(op)) return false;
  writesSinceQuota += 1;
  const now = Date.now();
  if (shouldRecheck({ lastAt: quotaCheckedAt, now, writesSince: writesSinceQuota })) {
    /**
     * ⚠ **worker にも `navigator.storage` は在る**が、無い環境(node の unit)も
     *   ある ── 無ければ**測らないだけ**で、断りはしない。
     */
    const api = (globalThis as { navigator?: { storage?: { estimate?: () => Promise<QuotaSample> } } })
      .navigator?.storage;
    if (api?.estimate) {
      try {
        /**
         * 🔴 **遅いときは待たない**(#971 段②)。
         *
         * ⚠ ここは**書き込みの直前**なので、`estimate()` が戻らなければ
         *   **その保存ごと止まる** ── 別のタブからの依頼は 10 秒で打ち切られるので、
         *   測っている間にその期限を使い切ると「**保存できなかった**」になる。
         * 🔑 打ち切った回は**前回の値のまま**で進む(初回なら `{}` = 通す)。
         */
        quotaSample = await Promise.race([
          api.estimate(),
          new Promise<QuotaSample>((resolve) =>
            setTimeout(() => resolve(quotaSample), QUOTA_ESTIMATE_TIMEOUT_MS),
          ),
        ]);
      } catch {
        // ⚠ 読めなかった = 断る理由にしない(前回の値も捨てない)
      }
    }
    quotaCheckedAt = now;
    writesSinceQuota = 0;
  }
  return refuseWrite(quotaSample);
}

/**
 * 🔴 **応答の bytes を transfer で渡す**(#682 段④d。ゼロコピー ── 不可侵指示 2026-07-27)。
 *
 * ⚠ 対象は **bytes を運ぶ op だけ**(いまは `exportSqliteTable`)。🔑 transfer した buffer は
 *   こちらからは**空になる**ので、ここへ入れる op は「返した後に自分が読み直さない」物に限る。
 */
function transferablesOf(op: StorageRequest['op'], result: unknown): ArrayBuffer[] {
  if (op === 'exportImage') {
    /**
     * 🔴 **DB 画像は DB の大きさそのもの**(#1416)。clone にすると worker 内で複製が 1 枚、
     *   main で受け取る複製がもう 1 枚できる(150MB の DB で +300MB の山)。transfer なら 0 枚。
     * ⚠ この op は返した後に画像を読み直さない(毎回 sqlite から作り直す)ので手放してよい。
     */
    const t = result as ResultMap['exportImage'];
    return t.image.byteLength === 0 ? [] : [t.image.buffer as ArrayBuffer];
  }
  if (op !== 'exportSqliteTable') return [];
  const t = result as ResultMap['exportSqliteTable'];
  return t.ndjson === null ? [] : [t.ndjson.buffer as ArrayBuffer];
}

self.onmessage = (ev: MessageEvent<{ id: number; req: StorageRequest }>) => {
  const { id, req } = ev.data;
  const handler = handlers[req.op] as ((r: StorageRequest) => unknown) | undefined;
  Promise.resolve()
    .then(async () => {
      // 🔴 壊れていると分かった後は、**書き換える op だけ**断る(#971)
      if (dbCorrupt && CORRUPT_BLOCKED_OPS.includes(req.op)) {
        throw new Error(CORRUPT_REFUSAL);
      }
      /**
       * 🔴 **空きが無いなら、増やす書き込みだけ断る**(#971 段②)。
       * ⚠ **消す op はここを通らない** ── 止めると空きを作る手段が消えて詰む。
       */
      if (await quotaBlocks(req.op)) {
        throw new Error(WRITE_QUOTA_REFUSAL);
      }
      // 🔴 **未知の op を名指しで断る**。無条件に呼ぶと `TypeError: handler is not
      // a function` になるだけで、**どの op が無いのか分からない**(nightly の
      // store probe が P5c で消えた `bulkAddRevisions` を呼び続け、この文言だけを
      // 残して落ちていた)。op の増減は改名で起きるので、名前を出す価値がある
      if (typeof handler !== 'function') {
        throw new Error(`未知の op です: ${String((req as { op?: unknown }).op)}`);
      }
      return handler(req);
    })
    .then(
      (result) =>
        postMessage({ id, ok: true, result } satisfies StorageResponse, {
          transfer: transferablesOf(req.op, result),
        }),
      (err: unknown) => {
        const raw = String(err);
        /**
         * 🔴 **ここが、すべての error が通る 1 か所**(#971)── だから見張りもここに置く。
         * ⚠ 分けて置くと「**同じ問いに答える口が 2 つ**」になる(CLAUDE.md §7)。
         */
        // ⚠ **客の file の破損を、うちの破損として扱わない**(`shouldFlagCorrupt` の註記)
        const towardGuest =
          (req as { guest?: unknown }).guest === true ||
          typeof (req as { guest?: unknown }).guest === 'string';
        if (!dbCorrupt && shouldFlagCorrupt(req.op, towardGuest, raw)) {
          dbCorrupt = true;
          postMessage({
            id,
            ok: false,
            error: corruptReport(req.op, raw),
          } satisfies StorageResponse);
          return;
        }
        postMessage({ id, ok: false, error: raw } satisfies StorageResponse);
      },
    );
};
