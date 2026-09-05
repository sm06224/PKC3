/**
 * PKC3 storage worker(設計 doc §4.4)。
 * sqlite(OPFS SAHPool)はこの worker に閉じる。OPFS 不可環境(旧ブラウザ /
 * SAH を他タブが保持)は :memory: に fallback し、**理由を InitResult に載せる**
 * (silent fallback にしない ── review #1)。多重タブの writer リースは P2 残作業。
 *
 * メモリ 2 原則(§4.2): stmt は毎回 finalize(exec/selectObjects/selectValue の
 * 内部完結 API のみを使う)/ 大きな値は保持しない。
 */
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import {
  DB_SCHEMA_VERSION,
  SCHEMA_DDL,
  REVISION_ADDED_COLUMNS,
  ENTRY_ADDED_COLUMNS,
  FTS_DDL,
} from './schema';
/**
 * 全文検索が 1 度に返す上限(#181)。⚠ **切ったことは呼び側へ言う** ── 黙って
 * 切ると user は「無い」と読む。上限そのものは「一覧に出して意味がある量」で決めた。
 */
const SEARCH_LIMIT = 200;
import type { EntryStamps, EntryUpsert } from './schema';
import { contentHash64Hex } from './content-hash';
import { assetRefsIn, scanAssetRefsInto } from '@features/asset/asset-ref-scan';
import { readAttachmentMeta } from '@features/flavor/attachment-flavor';
import { extractMeta } from '@features/flavor';
import { readVersions, totalHistoryBytes } from '@features/flavor/attachment-versions';
import { planSaveBack } from '@features/asset/asset-replace-plan';
import { spliceFrontmatterKeys } from '@features/markdown/frontmatter';
import { bodyLinkNeedles, bodyLinksTo } from '@features/entry-ref/body-links';
import {
  SNIPPET_ARCHETYPE,
  SNIPPET_LIMITS,
  snippetItemOf,
  type SnippetItem,
  type SnippetScan,
} from '@features/snippet/snippet-table';
import { planSearch, toLikePattern } from '@features/filter/search-query';
import {
  excerptAround,
  SNIPPET_ELLIPSIS,
  SNIPPET_MARK_CLOSE,
  SNIPPET_MARK_OPEN,
  SNIPPET_TOKENS,
} from '@features/filter/search-snippet';
import { countTaskCandidates } from '@features/markdown/task-count';
import { bodyTags } from '@features/flavor/entry-tags';
import { decodeTags, encodeTags } from '@features/flavor/tags';
import {
  TASK_LIMITS,
  type TaskCard,
  taskCardsOf,
  type TaskScan,
} from '@features/schedule/task-cards';
import {
  CONTACT_LIMITS,
  contactOf,
  type ContactCard,
  type ContactScan,
} from '@features/contact/contact-card';
import { createQueryScan, FRONTMATTER_SCAN_CHARS } from '@features/query/group-by';
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
    try {
      const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: dbName });
      opened = new poolUtil.OpfsSAHPoolDb(`/${dbName}.db`);
    } catch (e) {
      vfs = 'memory';
      fallbackReason = String(e);
      opened = new sqlite3.oo1.DB(':memory:');
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
  } catch (e) {
    opened.close();
    throw e;
  }

  db = opened;
  const base = { ...meta, vfs, journalMode: actualJournalMode };
  const withReason = fallbackReason ? { ...base, fallbackReason } : base;
  initResult = restoredBytes === undefined ? withReason : { ...withReason, restoredBytes };
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
    // 新規 DB は最新 DDL がそのまま最新形を作る(既存 DB では no-op)。
    // ⚠ 索引はここで作られる ── 上で列を足した**後**であることが要。
    for (const ddl of SCHEMA_DDL) database.exec(ddl);
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
    syncFtsIndex(database);
    if (
      database.selectValue(`SELECT 1 FROM entries WHERE ${NEEDS_BACKFILL} LIMIT 1`) !== undefined
    )
      backfillDerivedColumns(database);
    // 🔴 **タグの規則を直したら既存行も引き直す**(#550。上の注記)
    redriveBodyTags(database);
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
}

function need(): Database {
  if (!db) throw new Error('storage worker not initialized');
  return db;
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
    const rows = database.selectObjects(
      after === undefined
        ? `SELECT lid, entry_order, substr(body, 1, ?) AS head, body_tags FROM entries WHERE cid = ?
             ORDER BY entry_order, lid LIMIT ?`
        : `SELECT lid, entry_order, substr(body, 1, ?) AS head, body_tags FROM entries
            WHERE cid = ? AND (entry_order > ? OR (entry_order = ? AND lid > ?))
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
  /** 列の条件 ── SQL の `AND …` と、その値。 */
  const conds: string[] = [];
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
    conds.push('updated_at >= ?');
    args.push(q.updatedFrom);
  }
  if (q.createdFrom !== null) {
    conds.push('created_at >= ?');
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
    const plan = planSearch(q.text);
    if (plan.kind === 'fts') {
      conds.push('rowid IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)');
      args.push(plan.match);
    } else if (plan.kind === 'like') {
      // ⚠ **`ESCAPE` を宣言する**(`searchEntries` と同じ ── `%` `_` を素で通さない)
      conds.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
      args.push(plan.pattern, plan.pattern);
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

export const TASK_CANDIDATE_WHERE = `cid = ? AND ${TASK_CANDIDATE_COND}`;

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
  const totalNotes = Number(
    database.selectValue('SELECT count(*) FROM entries WHERE cid = ?', [cid]) ?? 0,
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
             WHERE cid = ?
             ORDER BY entry_order, lid LIMIT ?`
        : `SELECT lid, title, entry_order, body FROM entries
             WHERE cid = ?
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
  return { cards, totalNotes, scannedNotes, truncated };
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
  for (const row of rows) {
    // 🔑 「本文 → 表の 1 行」は `snippetItemOf` 1 本(§7)── ここで組み直さない
    const item = snippetItemOf(row.lid, row.title, row.body ?? '');
    if (item !== null) items.push(item);
  }
  // ⚠ **切ったら必ず言う** ── 黙って切ると user は「無い」と読む。
  //   ⚠ 上限で切った分だけを数える(長すぎて載らなかった雛形は別の理由なので、
  //     ここでは `truncated` にしない ── 画面には「載らなかった」と別に出す)
  return { items, total, truncated: total > SNIPPET_LIMITS.notes };
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

const UPSERT_SQL = `INSERT INTO entries
    (cid, lid, title, archetype, created_at, updated_at,
     entry_order, status, date, archived, task_total, body_chars, body_tags, body)
  VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(cid, lid) DO UPDATE SET
    title = excluded.title,
    archetype = excluded.archetype,
    updated_at = excluded.updated_at,
    entry_order = excluded.entry_order,
    status = excluded.status,
    date = excluded.date,
    archived = excluded.archived,
    task_total = excluded.task_total,
    body_chars = excluded.body_chars,
    body_tags = excluded.body_tags,
    body = excluded.body`;

function bindUpsert(cid: string, e: EntryUpsert): (string | number | null)[] {
  return [
    cid,
    e.lid,
    e.title,
    e.archetype,
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
 * body 変更に伴う鎖の維持(同 tx で呼ぶこと)。
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
            VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)`,
      bind: [
        cid,
        `rev-${crypto.randomUUID()}`,
        lid,
        nextOrder,
        enc.snapshot,
        oldTitle,
        oldArchetype,
        oldHash,
        enc.kind,
      ],
    });
    database.exec({
      sql: `DELETE FROM revisions WHERE cid = ? AND entry_lid = ? AND rev_order <= ?`,
      bind: [cid, lid, nextOrder - Math.max(1, keepLatest)],
    });
    return { added: true, pruned: database.changes() };
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
    const state = materialize(
      { id: '', rev_order: r.revOrder, snapshot: r.snapshot, content_hash: null, kind: r.kind },
      base,
    );
    // 🔴 **噛み合わせ検査**(review H-1)。`applyLinePatch` は行数さえ合えば通るので、
    // tip がズレた鎖・改竄されたパッチが**例外にならずに**通ってしまう。しかも
    // 書込側は decode 結果から hash を計算し直すので、以後 `getRevision` の
    // 整合性検査も通る = 誤りが自己証明されて固定される
    const hash = contentHash64Hex(state);
    if (r.contentHash !== null && hash !== r.contentHash) {
      throw new Error(
        `履歴が噛み合いません(版 ${r.revOrder})── アーカイブが壊れているか、本文が書き出し時と違います`,
      );
    }
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
        chain.entryLid,
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
): void {
  database.exec({
    sql: `DELETE FROM relations WHERE cid = ? AND to_lid = ? AND kind = 'structural'`,
    bind: [cid, lid],
  });
  if (parentLid === null) return;
  database.exec({
    sql: `INSERT INTO relations (cid, id, from_lid, to_lid, kind, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'structural', datetime('now'), datetime('now'))
          ON CONFLICT(cid, id) DO UPDATE SET
            from_lid = excluded.from_lid,
            to_lid = excluded.to_lid,
            kind = excluded.kind,
            updated_at = excluded.updated_at`,
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
  },
): { stamps: EntryStamps; conflict: boolean } {
  const old = database.selectObjects(
    'SELECT title, archetype, body FROM entries WHERE cid = ? AND lid = ?',
    [cid, entry.lid],
  )[0] as { title: string; archetype: string; body: string } | undefined;
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
      );
    } catch {
      /* 履歴の維持失敗は本文の保存を巻き添えにしない */
    }
  }
  database.exec({ sql: UPSERT_SQL, bind: bindUpsert(cid, entry) });
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
  const stamped = database.selectObjects(
    'SELECT created_at, updated_at FROM entries WHERE cid = ? AND lid = ?',
    [cid, entry.lid],
  )[0] as { created_at: string | null; updated_at: string | null } | undefined;
  return {
    stamps: {
      createdAt: stamped?.created_at ?? null,
      updatedAt: stamped?.updated_at ?? null,
      // ⚠ **書いたときだけ名乗る**(旧 worker は名乗らない = 呼び側が 2 手へ落ちる)
      ...(opts.parent ? { parentWritten: true } : {}),
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
    sql: `UPDATE entries SET ${column} = ?, updated_at = datetime('now')
            WHERE cid = ? AND lid = ?`,
    bind: [value, cid, lid],
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
  exportImage: () => {
    const api = sqliteApi;
    if (api === null) throw new Error('sqlite が初期化されていません');
    const exportDb = api.capi.sqlite3_js_db_export as unknown as (p: unknown) => Uint8Array;
    return { image: exportDb((need() as unknown as { pointer: unknown }).pointer) };
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
  resolveContainer: (req) => {
    const database = need();
    const rows = database.selectObjects(
      'SELECT cid FROM containers ORDER BY created_at, cid LIMIT 1',
    );
    const existing = rows[0]?.cid;
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
    need().selectObjects(
      `SELECT lid, title, archetype, created_at, updated_at, entry_order,
              status, date, archived, body_chars
         FROM entries WHERE cid = ? ORDER BY entry_order`,
      [req.cid],
    ) as unknown as ResultMap['listEntryMetas'],
  taskScan: (req) => runTaskScan(req.cid),
  contactScan: (req) => runContactScan(req.cid),
  snippetScan: (req) => runSnippetScan(req.cid),
  getBody: (req) => {
    const rows = need().selectObjects(
      'SELECT body FROM entries WHERE cid = ? AND lid = ?',
      [req.cid, req.lid],
    );
    return rows.length > 0 ? (rows[0]?.body as string) : null;
  },
  getBodies: (req) => {
    // ⚠ postMessage を 1 回にするのが目的 ── SQL は 1 件ずつでよい
    // (worker の中の N 回は往復ではない)。無い lid は結果に出さない
    const database = need();
    const out: Array<{ lid: string; body: string }> = [];
    for (const lid of req.lids) {
      const rows = database.selectObjects(
        'SELECT body FROM entries WHERE cid = ? AND lid = ?',
        [req.cid, lid],
      );
      if (rows.length > 0) out.push({ lid, body: rows[0]?.body as string });
    }
    return out;
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
    need().exec({
      sql: "SELECT lid, body FROM entries WHERE cid = ? AND archetype = 'attachment'",
      bind: [req.cid],
      rowMode: 'object',
      callback: (row) => {
        // ⚠ 型は SqlValue のまま来る ── rowMode 'object' の実行時形へ狭める
        const r = row as unknown as { lid: string; body: string };
        if (readAttachmentMeta(r.body).assetKey === req.assetKey) {
          found = r.lid;
          return false; // 走査を止める
        }
      },
    });
    return { lid: found };
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
    const plan = planSearch(req.query);
    if (plan.kind === 'none') return { lids: [], truncated: false };
    const limit = Math.max(1, Math.min(req.limit ?? SEARCH_LIMIT, SEARCH_LIMIT));
    const sql =
      plan.kind === 'fts'
        ? `SELECT e.lid AS lid FROM entries_fts f
             JOIN entries e ON e.rowid = f.rowid
            WHERE f.entries_fts MATCH ? AND e.cid = ?
            ORDER BY e.entry_order, e.lid LIMIT ?`
        : // 2 文字以下は trigram が当たらないので LIKE(実測)。⚠ ESCAPE を宣言する
          `SELECT lid FROM entries
            WHERE cid = ? AND (title LIKE ?2 ESCAPE '\\' OR body LIKE ?2 ESCAPE '\\')
            ORDER BY entry_order, lid LIMIT ?3`;
    const bind =
      plan.kind === 'fts'
        ? [plan.match, req.cid, limit + 1]
        : [req.cid, plan.pattern, limit + 1];
    const rows = need().selectObjects(sql, bind) as Array<{ lid: string }>;
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
   * ⚠ **ゴミ箱の中は返さない**(`archived = 0`)── 行を押すと小窓で開くので、
   *   一覧に無い物を開かせない(`findBacklinks` と同じ理由)。
   * ⚠ 印の綴りは `search-snippet.ts` の 1 か所 ── 描画器も同じ物を読む。
   * ⚠ 上限と「切った」の作法は `searchEntries` と同じ(`limit + 1`)。
   */
  searchDetail: (req) => {
    /**
     * 🔴 **書き方は探す面だけ**(`syntax: 'query'`── 空白 = AND / `"…"` = フレーズ /
     * `-語` = 除外)。左の列(`searchEntries`)は `plain` のまま ── 一覧の意味論は変えない。
     * ⚠ 3 字未満の項が 1 つでも混じれば `like-terms`(全項を LIKE で並べる)── trigram は
     *   2 字を当てられず、除外側なら**黙って効かない**ので、FTS へは渡さない。
     */
    const plan = planSearch(req.query, { syntax: 'query' });
    if (plan.kind === 'none') return { rows: [], truncated: false };
    const limit = Math.max(1, Math.min(req.limit ?? SEARCH_LIMIT, SEARCH_LIMIT));
    if (plan.kind === 'fts') {
      const rows = need().selectObjects(
        `SELECT e.lid AS lid, e.title AS title,
                snippet(entries_fts, 1, ?3, ?4, ?5, ?6) AS snippet,
                bm25(entries_fts) AS rank
           FROM entries_fts f
           JOIN entries e ON e.rowid = f.rowid
          WHERE f.entries_fts MATCH ?1 AND e.cid = ?2 AND e.archived = 0
          ORDER BY rank, e.entry_order, e.lid LIMIT ?7`,
        [
          plan.match,
          req.cid,
          SNIPPET_MARK_OPEN,
          SNIPPET_MARK_CLOSE,
          SNIPPET_ELLIPSIS,
          SNIPPET_TOKENS,
          limit + 1,
        ],
      ) as Array<{ lid: string; title: string; snippet: string; rank: number }>;
      return { rows: rows.slice(0, limit), truncated: rows.length > limit };
    }
    /**
     * LIKE 側 ── 項ごとに `(title LIKE ? OR body LIKE ?)` を AND で並べ、除外は `NOT (…)`。
     * ⚠ `plain` の `like`(1 句)は `query` では来ないが、型の上では在るので 1 項として畳む。
     * ⚠ 抜粋の印は**最初の正の項**に付ける(2 項目以降は当たっていても印が付かない ──
     *   1 行の窓に全項は入らないので、先頭の項を優先する)。
     */
    const terms =
      plan.kind === 'like-terms'
        ? plan
        : { include: [req.query.trim()], exclude: [] as string[] };
    const clause = (i: number): string => `(title LIKE ?${i} ESCAPE '\\' OR body LIKE ?${i} ESCAPE '\\')`;
    const bind: (string | number)[] = [req.cid];
    const conds: string[] = [];
    for (const t of terms.include) {
      bind.push(toLikePattern(t));
      conds.push(clause(bind.length));
    }
    for (const t of terms.exclude) {
      bind.push(toLikePattern(t));
      conds.push(`NOT ${clause(bind.length)}`);
    }
    bind.push(limit + 1);
    const rows = need().selectObjects(
      `SELECT lid, title, body FROM entries
        WHERE cid = ?1 AND archived = 0 AND ${conds.join(' AND ')}
        ORDER BY entry_order, lid LIMIT ?${bind.length}`,
      bind,
    ) as Array<{ lid: string; title: string; body: string }>;
    const first = terms.include[0] ?? '';
    return {
      rows: rows.slice(0, limit).map((r) => ({
        lid: r.lid,
        title: r.title,
        snippet: excerptAround(r.body, first),
        rank: 0,
      })),
      truncated: rows.length > limit,
    };
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
   * ⚠ **ゴミ箱の中は出さない**(押しても一覧に無いものへ飛ぶ)。
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
    const where = needles.map((_, i) => `body LIKE ?${i + 3} ESCAPE '\\'`).join(' OR ');
    const rows = need().selectObjects(
      `SELECT lid, body FROM entries
        WHERE cid = ?1 AND lid <> ?2 AND archived = 0 AND (${where})
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
      if (!bodyLinksTo(r.body, req.lid, req.cid)) continue;
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
    const rows = database.selectObjects(
      a === undefined
        ? `SELECT lid, body, entry_order FROM entries WHERE cid = ?
             ORDER BY entry_order, lid`
        : `SELECT lid, body, entry_order FROM entries
             WHERE cid = ? AND (entry_order > ? OR (entry_order = ? AND lid > ?))
             ORDER BY entry_order, lid`,
      a === undefined ? [req.cid] : [req.cid, a.entryOrder, a.entryOrder, a.lid],
    ) as unknown as Array<{ lid: string; body: string; entry_order: number }>;

    // 1 メッセージの合計で切る。⚠ **1 件目は必ず返す** ── maxBytes より大きい
    // body が 1 件あるだけで、そこから先が永遠に進まなくなる(無限ループ)
    const out: Array<{ lid: string; body: string }> = [];
    let total = 0;
    for (const r of rows) {
      const size = r.body.length;
      if (out.length > 0 && total + size > req.maxBytes) {
        const last = rows[out.length - 1]!;
        return {
          rows: out,
          done: false,
          next: { entryOrder: last.entry_order, lid: last.lid },
        };
      }
      out.push({ lid: r.lid, body: r.body });
      total += size;
    }
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
        'SELECT title, archetype, body FROM entries WHERE cid = ? AND lid = ?',
        [req.cid, req.lid],
      )[0] as { title: string; archetype: string; body: string } | undefined;
      if (row) {
        // 削除で tip(entries.body)が消えるので、鎖の base を**全文で確定**する。
        // 頭が既に同内容を記録していれば、その行を全文化するだけでよい
        // (行 id / content_hash は保つ ── change ID の安定)
        const hash = contentHash64Hex(row.body);
        const head = headRevision(database, req.cid, req.lid);
        if (head && head.content_hash === hash) {
          database.exec({
            sql: `UPDATE revisions SET snapshot = ?, kind = 'full' WHERE cid = ? AND id = ?`,
            bind: [row.body, req.cid, head.id],
          });
        } else {
          database.exec({
            sql: `INSERT INTO revisions
                    (cid, id, entry_lid, created_at, rev_order, snapshot,
                     title, archetype, content_hash, kind)
                  VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, 'full')`,
            bind: [
              req.cid,
              `rev-${crypto.randomUUID()}`,
              req.lid,
              (head?.rev_order ?? 0) + 1,
              row.body,
              row.title,
              row.archetype,
              hash,
            ],
          });
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
      writeParent(database, req.cid, req.lid, req.parentLid, req.relationId);
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
   * 🔴 **向きを裏返す。** 保存形は「1 つ新しい版 → この版」の**逆向き**パッチなので、
   *   ops の意味は user が読む向きと**反対**である:
   *   - 逆向きで**消す**行 = 新しい側に在って此処に無い = 🔑 user から見て**足された**
   *   - 逆向きで**入れる**行 = 此処に在って新しい側に無い = 🔑 user から見て**消された**
   *   ⚠ ここを取り違えると、画面の `+` と `-` が**そっくり入れ替わる**
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
        // 🔑 裏返す(上の注記)── 逆向きの「消す」が、user から見た「足された」
        return { id: r.id, added: back, removed: ins };
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
  purgeTrash: (req) => {
    const database = need();
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
      `SELECT entry_lid, rev_order, title, archetype, content_hash
         FROM revisions WHERE cid = ? AND id = ?`,
      [req.cid, req.id],
    )[0] as
      | {
          entry_lid: string;
          rev_order: number;
          title: string | null;
          archetype: string | null;
          content_hash: string | null;
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
    return { body: state, title: target.title, archetype: target.archetype };
  },
  putAssetMeta: (req) => {
    const m = req.meta;
    need().exec({
      sql: `INSERT INTO assets (cid, key, mime, size, hash)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(cid, key) DO UPDATE SET
              mime = excluded.mime, size = excluded.size, hash = excluded.hash`,
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
    let orphanBytes = 0;
    for (const [k, n] of size) if ((refCount.get(k) ?? 0) === 0) orphanBytes += n;
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
  close: () => {
    // ⚠ close は DB 接続を閉じるだけで、SAHPool の SAH は worker 破棄まで残る
    // (review #9)。multi-tab リース実装時はこの前提で設計する
    db?.close();
    db = null;
    initResult = null;
    sqliteApi = null;
    return null;
  },
};

self.onmessage = (ev: MessageEvent<{ id: number; req: StorageRequest }>) => {
  const { id, req } = ev.data;
  const handler = handlers[req.op] as ((r: StorageRequest) => unknown) | undefined;
  Promise.resolve()
    .then(() => {
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
      (result) => postMessage({ id, ok: true, result } satisfies StorageResponse),
      (err: unknown) =>
        postMessage({ id, ok: false, error: String(err) } satisfies StorageResponse),
    );
};
