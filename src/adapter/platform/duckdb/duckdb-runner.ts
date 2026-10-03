/**
 * 🔴 **DuckDB で 1 件引く**(#682 段②)。目録を検め、相手を写し、**外を塞いでから**打つ。
 *
 * ## 🔴 「外へ出ない」をどう守るか ── 実測で 1 つに絞れた(2026-09-15、実ブラウザ)
 *
 * 3 つの門を測った結果、**単独で足りる物は 1 つも無かった**:
 *
 * | 掛けた門 | 差し込んだ csv を読めるか | 遠くの file を読めるか |
 * |---|---|---|
 * | `autoinstall` / `autoload` を切る | 🟢 読める | 🔴 **読めてしまう**(`read_csv_auto('https://…')` が XHR で外へ出た) |
 * | `enable_external_access=false` | 🔴 **読めない**(差し込んだ物まで塞がる) | 🟢 塞がる |
 *
 * 🔑 **だから順番で解く**(この順で実測済み):
 * ① 拡張の自動取得を切る(`duckdb-open.ts`)② 相手を差し込む
 * ③ **中身を表へ写し切る**(`CREATE OR REPLACE TABLE … AS SELECT …`)④ **外を塞ぐ**
 * ⑤ そこから先が user の字。
 *
 * 実測(2026-09-15):④ の後でも ③ で写した表は `SELECT` も `count` も `GROUP BY` も通り、
 * **差し込んだ file の読み直し**も、**遠くの 3 通り**
 * (`read_csv_auto('https://…')` / `FROM 'https://…'` / `ATTACH 'https://…'`)も
 * 全部断られ、**外への要求は 0 件**だった。
 * 🔴 そして **一度塞ぐと同じ器では二度と開けられない**
 * (「Cannot enable external access while database is running」)── つまり
 * **打つ人にも外せない、本物の境**である。
 * ⚠ 字の門(`duckdb-guard.ts`)が `SET` / `RESET` を断っているのは **① の取り消しを
 * 防ぐため** ── ④ は engine が守るが、① は打ち直せてしまう(実測)。
 *
 * ## ⚠ 相手を替えたら器ごと作り直す
 *
 * ④ を掛けた器へ 2 件目は差し込めない(file を読めないので)。
 * 🔑 `DuckDbLease` が**鍵が変わったら畳んで起こし直す** ── 使い捨ての規律と同じ向き。
 *
 * ## 🔴 入っていれば端末の一式、無ければ同一オリジンの fetch(#682 段③b)
 *
 * `resolveUrls()` は**呼ばれるたび**に `deps.lendInstalled` を確かめる ──
 * 在れば端末の IDB(`DuckDbPackStore`)が貸す **blob: URL** を使い、
 * `null`(未設置)なら今までどおり同一オリジンへ `fetch` する。
 *
 * ⚠ **blob: URL は `this.urls` へ控えない**(同一オリジンの URL とは寿命が違う)。
 * 理由は 3 つ:
 * ① blob: URL は貸した側が `dispose()`(`URL.revokeObjectURL`)すると死ぬので、
 *   2 度目の `open()` で使い回せる保証が無い
 * ② 不可侵指示「ObjectURL は表示の寿命終端で revoke」に沿うなら、**寿命は
 *   1 回の `open()` の間だけ**にするのが最短(器を畳んでも握ったままにしない)
 * ③ 借り直すコスト(IDB の `get` 1 回)は、器を起こす操作(実測 1.28 秒)に
 *   比べれば無視できる
 * 🔑 だから**器を起こすたびに借り直す**。`dispose()` は `deps.open(urls)` が
 * **終わった直後**(`Worker` の生成と wasm の fetch/instantiate が済んだ後)に
 * 呼ぶ ── この file 冒頭の実測表のとおり、その後は blob: URL が生きている
 * 必要が無い。
 */
import { CSV_SOURCE_COLUMNS } from '@features/query/csv-tables';
import {
  guestTableNameOf,
  type DuckDbFileGuestSource,
  type DuckDbReadableGuestSource,
} from '@features/query/sql-guest-source';
import { duckDbTable } from '@features/query/duckdb-rows';
import { duckDbTableGroupsOf } from '@features/query/sql-multi-source';
import {
  SQLITE_NDJSON_TABLE_MAX_BYTES,
  createTableSql,
  insertFromNdjsonSql,
  quoteIdent,
  refusedNote,
  type SqliteExportSession,
  type SqliteExportedTable,
} from '@features/query/sqlite-ndjson';
import { duckDbWriteKind } from '@features/query/duckdb-write';
import {
  DUCKDB_SCHEMA_COLUMNS_SQL,
  DUCKDB_SCHEMA_FK_SQL,
  duckDbMetaOf,
  mergeDuckDbSchema,
  type DuckDbTableMeta,
} from '@features/query/duckdb-schema';
import {
  sqliteFallbackHint,
  type DuckDbCopyReport,
  type DuckDbRefusedItem,
} from '@features/query/duckdb-copy-report';
import { DUCKDB_TABLE_LIST_SQL } from '@features/query/sql-tip';
import { tableNameFromFileTable } from '@features/query/sql-table-name';
import { countsSql, schemaTableNames, type Grid } from '@features/query/schema-digest';
import {
  DUCKDB_EXTENSIONS,
  DUCKDB_EXT_DIR,
  DUCKDB_WASM,
  DUCKDB_WORKER,
  duckDbAssetUrl,
  readDuckDbPack,
} from '@features/query/duckdb-pack';
import { DuckDbLease, type DuckDbHandle } from './duckdb-lease';
import { resolveDuckDbBase } from './duckdb-pack-acquire';

/** 配る一式の置き場(`build/duckdb-assets-plugin.ts` の `DUCKDB_DIR` と同じ)。 */
export const DUCKDB_BASE = 'duckdb/';

/**
 * 器を起こすのに要る在り処ひとそろい(#682 段④b)。
 *
 * 🔑 **1 つの型にまとめてある**のは、拡張を**足し忘れられないようにする**ため ──
 * 貸す側(端末の一式)と組む側(同一オリジン)の**どちらか片方だけが拡張を持つ**と、
 * 「入れておいた人だけ parquet が読めない」という、いちばん再現しない形になる。
 * ⚠ `extensions` は**必須の field** にしてある(省ける形にすると、口を後から
 *   足す人が書き忘れても tsc が黙る ── CLAUDE.md §7 の「optional にしない」)。
 */
export interface DuckDbOpenUrls {
  readonly wasmUrl: string;
  readonly workerUrl: string;
  /**
   * 拡張の置き場と名前。⚠ **必須の field** にしてある ── 省ける形にすると、
   * 口を後から足す人が書き忘れても tsc が黙る(CLAUDE.md §7)。
   */
  readonly extensions: { readonly repository: string; readonly names: readonly string[] };
}

/**
 * 🔴 **時間の門**(ms)。⚠ sqlite 側(8 秒)と**違う理由で**違う値にしてある:
 * - sqlite は**ノートの DB を持つワーカー**で走るので、長引くと**保存が止まる**
 * - DuckDB は**別の使い捨てワーカー**なので、止まるのは DuckDB だけ
 * 🔑 だから少し長く取れる ── ただし**無限には待たせない**。
 * ⚠ 実測(2026-09-15):上流に中断の口は無く、`worker.terminate()` を呼んでも
 *   飛んでいる問い合わせは **10 秒待っても pending のまま**だった ── つまり
 *   **待ち手を解くのは呼び側の時計だけ**である(`duckdb-lease.ts` の `raceQuery`)。
 */
export const DUCKDB_MAX_MS = 30_000;

/**
 * 🔴 **器へ写す所の時間の門**(ms。#682 段④d の着地後レビュー R5)。
 *
 * ⚠ 器へ写す仕事(`load`)は**直列の列**(`serial`)の中で走る。直す前は**この仕事に時間の門が無かった** ──
 *   写しの途中で止まる(storage worker が応えない / 器が固まる)と、**後ろの仕事が全部永久に待つ**
 *   (つながり図も「走らせる」も無反応)。⚠ 同じ種の救い(`DuckDbLease` の `forget(stale)`)は、
 *   **次の仕事が走り出して初めて**効くので、列が詰まっていると**届かない**。
 * 🔑 だから**写す所にも**時計を置く(`DuckDbJob.loadMaxMs`)── 超えたら器ごと畳んで断る(次に押せば最初から写し直す)。
 * ⚠ 長めに取る(120 秒):表が多い `.sqlite` は 1 表あたり最大 64 MB を **1 表ずつ**写す ── 正しく動いている重い写しを
 *   切らない。⚠ 上流には中断の口が無いので、**待ち手を解くのは時計だけ**(`DUCKDB_MAX_MS` と同じ事情)。
 */
export const DUCKDB_LOAD_MAX_MS = 120_000;

/** 返す行の上限(sqlite 側と揃える)。⚠ 切ったら**必ず言う**。 */
export const DUCKDB_MAX_ROWS = 200_000;

export interface DuckDbRunnerDeps {
  /** 同一オリジンの字を取ってくる(目録)。 */
  fetchText(url: string): Promise<string>;
  /** 実体を起こす。⚠ 渡す URL は**こちらが組んだ同一オリジンの物か、端末の一式が貸す blob: URL**。 */
  open(input: DuckDbOpenUrls): Promise<DuckDbHandle>;
  /** 基点。既定は `document.baseURI`。 */
  baseUrl?: string;
  /**
   * 一式の置き場。既定は `DUCKDB_BASE`(= 相対の `duckdb/`)。
   *
   * 🔴 **差せる形にしてあるのは、門が本当に効くことを検められるようにするため**である
   *   (#682 段③a、変異試験 2026-09-15)。⚠ `DUCKDB_BASE` は**相対の定数**なので、
   *   差せないと `resolveDuckDbBase()` を**外しても結果が 1 バイトも変わらない** ──
   *   実測で変異 A4(門を `new URL(...).href` に戻す)が **SURVIVED** した。
   *   🔑 つまり守っていたのは「門が在ること」であって「門が効くこと」ではなかった。
   * ⚠ **製品からは差しません**(既定のまま)── 差す口が要るからではなく、
   *   **門の通り道を test から通せるようにする**ためだけに在ります。
   */
  packBase?: string;
  idleMs?: number;
  /**
   * 🔴 **端末に入っている一式を貸す口**(#682 段③b。任意 ── 省けば今までどおり
   *   同一オリジンへ fetch する)。
   * ⚠ **呼ぶたびに借り直す**(この file 冒頭の理由)── 返す `dispose` は
   *   `deps.open()` が終わった直後に必ず呼ぶので、呼び側は握り続けなくてよい。
   * 🔑 `null` を返せば「入っていない」= 同一オリジン fetch 経路へ倒す
   *   (`DuckDbPackStore.readMeta()` が `null` を返す形と揃えてある)。
   */
  lendInstalled?: () => Promise<{ wasmUrl: string; workerUrl: string; dispose: () => void } | null>;
  /**
   * 🔴 **`.sqlite` を開き、表ごとの NDJSON にしてもらう口**(#682 段④d。任意 ── 渡さない版では
   *   `.sqlite` を DuckDB へ入れるとき**理由を言って断る**)。
   * 🔑 行を読むのは **sqlite を持つ storage worker** である(DuckDB の器では `ATTACH` が bytes を
   *   読めない ── 実測)。⚠ 呼ぶのは**器へ入れ直すときだけ**。
   * 🔴 返すのは**表を 1 つずつ頼める口**(`SqliteExportSession`)── 全表を 1 回で返すと
   *   **全表ぶんの NDJSON が同時に載る**。`load` は表ごとに「頼む → 器へ入れる → 手放す」を回し、
   *   終わったら(落ちた回も)`close` する。
   */
  exportSqlite?: (image: Uint8Array) => Promise<SqliteExportSession>;
}

/** 器へ差し込む相手 1 件(#918 段⑦ で、1 件から N 件へ)。 */
export interface DuckDbInputSource {
  /**
   * 相手。
   * 🔴 **型が `DuckDbReadableGuestSource`** なので、`.xlsx` をここへ渡す道は
   *   **構造から消えている**(#682 段④c)── だから `load` に「読めない相手が来たら断る」枝が要らない。
   * 🔴 `.sqlite` は渡せる(#682 段④d)── ただし `duckDbLoadSql`(1 file = 1 表)ではなく
   *   `loadSqlite`(中の表の数だけ)で写す。`load` が `kind` で振り分ける。
   */
  readonly source: DuckDbReadableGuestSource;
  /**
   * 🔴 **相手の中身を読む口**(⚠ 呼ばれるのは**器へ入れ直すときだけ**)。
   *
   * 🔑 **ここが受け取る形にしてあるのは、lid から bytes を出す道が
   *   `store-effects.ts` に 1 本だけ在るから**である(添付なら本文から鍵を読んで
   *   IDB を引き、手持ちの file なら控えを読む)。
   *   ⚠ こちらで組み直すと、同じ問いに答える口が 2 つになる(§7)。
   * ⚠ 読めなければ `null`(断る理由を画面へ出す)。
   */
  readonly readBytes: () => Promise<Uint8Array | null>;
}

export interface DuckDbRunInput {
  readonly sql: string;
  /**
   * 🔴 **器へ並べる相手**(1〜`SQL_MAX_SOURCES` 件。#918 段⑦)。
   * ⚠ **集合(順番も含む)が変わったら器ごと作り直す** ── 外を塞いだ器へは差し込めない
   *   (`DuckDbLease` の鍵)。作り直せば `hold` も解ける(作った表は消える)。
   * ⚠ 空は受けない(呼び側が `source` を 1 つも持たない回は走らせない)。
   */
  readonly sources: readonly DuckDbInputSource[];
}

export interface DuckDbRunResult {
  readonly columns: string[];
  readonly rows: Array<Array<string | number | null>>;
  readonly truncated: boolean;
  readonly ms: number;
  /**
   * 🔴 **いまの器へ写したときの報告**(写せなかった表・ビュー / 全列を文字で写した表。#682 段④d の着地後レビュー)。
   * ⚠ 必須の field(省ける形にすると、返す側が書き忘れても tsc が黙る ── 書き忘れは「写せなかった表が画面に出ない」側へ倒れる)。
   */
  readonly copy: DuckDbCopyReport;
}

/**
 * 🔴 **器の中の構造 1 枚ぶん**(#918。構造ノート・つながり図が読む形 = `SchemaDigestInput` の 3 枚)。
 * ⚠ `counts` は**落ちても進む**(行数が採れなくても構造は出せる ── `null` なら「行数は採れませんでした」)。
 */
export interface DuckDbSchemaResult {
  readonly columns: Grid;
  readonly fks: Grid;
  readonly counts: Grid | null;
  /** 🔴 写せなかった表・ビュー / 全列を文字で写した表(構造ノート・つながり図が言う。`DuckDbRunResult.copy` と同じ物)。 */
  readonly copy: DuckDbCopyReport;
}

/** SQL の文字列に埋める。⚠ 題名は user の字なので**必ず**通す。 */
export function sqlQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * 🔴 **器の中での file 名は、こちらが決める固定の字**にする。
 * ⚠ 題名をそのまま使わない ── `'` や改行を含む題名が SQL の字へ混ざる。
 * 🔑 拡張子だけは残す(`read_csv_auto` が区切りを見分ける手がかりになる /
 *   `read_json_auto` は `.ndjson` で 1 行 1 件を見分ける)。
 * ⚠ **`.csv` は実測済み / `.tsv` は未測** ── 区切りの見分けは上流の推定に任せている。
 *   外した回は上流の断り文がそのまま画面に出る(黙って化けはしない)。
 */
export function duckDbFileNameOf(
  source: DuckDbReadableGuestSource,
  slot = 0,
  /**
   * 🔴 **`.sqlite` だけ使う**(#682 段④d)── 中の表ごとに 1 つの NDJSON を差すので、
   *   同じ相手でも**表の番号で名前を変える**(同じ名前を 2 度 `put` すると入れ替わる)。
   */
  table = 0,
): string {
  /**
   * 🔴 **N 件を並べるときは、器の中の名前もぶつからないようにする**(#918 段⑦)。
   * ⚠ `slot` が 0 の回(= 1 件目 / 1 件だけ)は**今までと 1 バイトも変えない**(`source.csv`)。
   *   2 件目以降は `source_2.csv` …(同じ名前を 2 度 `put` すると**入れ替わる**ので、
   *   2 件目が 1 件目を黙って上書きする)。
   */
  const stem = slot === 0 ? 'source' : `source_${String(slot + 1)}`;
  switch (source.kind) {
    case 'csv':
      return source.lang === 'tsv' ? `${stem}.tsv` : `${stem}.csv`;
    case 'parquet':
      return `${stem}.parquet`;
    case 'json':
      return source.lang === 'ndjson' ? `${stem}.ndjson` : `${stem}.json`;
    case 'sqlite':
      return `${stem}_t${String(table + 1)}.ndjson`;
    default: {
      // ⚠ 種類を足した人がここを書き忘れたら tsc が落とす(`if` を並べると黙って素通りする)
      const never: never = source;
      throw new Error(`知らない開き方です: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * 差し込んだ file を読む `FROM …` の 1 句。
 * 🔑 **`DUCKDB_READABLE_KINDS` のうち「1 file = 1 表」の 3 つ**を網羅する ── 一覧はあちらが正本で、
 *   ここは `never` の網羅検査で追随を強制される(#682 段④c)。
 * 🔴 **`.sqlite` は引数の型に入れていない**(#682 段④d)── 表の数が中身次第で、1 つの `FROM …` に
 *   ならない。`sqlite` を足す枝を書くと、誰も通らない死んだ枝になる(`DuckDbFileGuestSource`)。
 *   読み方は `sqlite-ndjson.ts` の `insertFromNdjsonSql`。
 */
function duckDbReadFrom(source: DuckDbFileGuestSource, file: string): string {
  switch (source.kind) {
    case 'csv':
      return 'read_csv_auto(' + sqlQuote(file) + ')';
    case 'parquet':
      return 'read_parquet(' + sqlQuote(file) + ')';
    case 'json':
      return 'read_json_auto(' + sqlQuote(file) + ')';
    default: {
      const never: never = source;
      throw new Error(`知らない読み方です: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * 差し込んだ file から表を組む 1 文。
 *
 * 🔑 **csv は、表の名前も足す 2 列も sqlite 側と同じ**(`csv` / `_note` / `_lid`)──
 *   揃えてあるので、**同じ SQL がどちらの engine でも通る**(比べられる)。
 *
 * 🔴 **`.parquet` / `.json` には `_note` / `_lid` を足さない**(#682 段④c)。
 * ⚠ これは手抜きではなく判断である ── 理由は 2 つ:
 *   ① **比べる相手が居ない**(内蔵の sqlite はこの形式を読めないので、
 *      「両方の engine で同じ列が出る」という足す理由そのものが無い)
 *   ② 🔴 **相手の列名を、こちらが勝手に増やさない** ── parquet / json は
 *      **書いた人が列名を決めている形式**である。`SELECT *` に見覚えのない列が
 *      2 つ増えるのは驚きであり、⚠ 相手が `_note` という列を持っていたら
 *      **名前がぶつかって、そもそも開けない**。
 * 🔑 覆る条件は「**複数の相手を 1 つの器へ並べて引けるようにしたとき**」と書いていた ──
 *   #918 段⑦ でその日が来たが、**覆さなかった**:並べたときは**表の名前そのものが file 名**
 *   (`duckDbTableNamesOf`)なので、どの file の行かは表を見れば分かる。
 *   ⚠ 列を足すと「相手の列名を勝手に増やさない」が再び破れる(上の ②)。
 *
 * ⚠ **VIEW にしない** ── VIEW は打つたびに file を読み直すので、
 *   外を塞いだ後に**引けなくなる**(実測で `Permission Error`)。
 */
export function duckDbLoadSql(
  source: DuckDbFileGuestSource,
  file: string,
  /**
   * 🔴 **作る表の名前**(#918 段⑦)。省けば今までどおり(1 件のときの `csv` / `json` / `parquet`)。
   * ⚠ 2 件以上のときは `duckDbTableNamesOf` が file 名から決めた物を渡す
   *   (画面の案内と**同じ 1 本**から)。
   */
  table: string = guestTableNameOf(source),
): string {
  const from = duckDbReadFrom(source, file);
  if (source.kind !== 'csv') {
    return 'CREATE OR REPLACE TABLE ' + table + ' AS SELECT * FROM ' + from;
  }
  const noteCol = CSV_SOURCE_COLUMNS[0] ?? '_note';
  const lidCol = CSV_SOURCE_COLUMNS[1] ?? '_lid';
  return (
    'CREATE OR REPLACE TABLE ' + table + ' AS SELECT ' +
    sqlQuote(source.name) + ' AS ' + noteCol + ', ' + sqlQuote(source.lid) + ' AS ' + lidCol + ', * ' +
    'FROM ' + from
  );
}


/** 🔴 外を塞ぐ 1 文。⚠ **写し切った後に**打つ(前に打つと写せない ── 実測)。 */
export const DUCKDB_SEAL_SQL = 'SET enable_external_access=false';

export class DuckDbRunner {
  private readonly lease: DuckDbLease;
  /** 検めた目録(1 度読めば替わらない)。⚠ 読めなかった回は控えない。 */
  private urls: DuckDbOpenUrls | null = null;
  /**
   * 🔴 **いまの器へ写せなかった表の理由**(#682 段④d)。⚠ `load` が入れ直すたびに作り直す。
   *
   * 🔑 写せなかった表は**器に作らない**(空の表を作ると「0 件の表」に読める)── だから user が
   *   その名前を引くと DuckDB は「そんな表は無い」としか言わない。**引いた回が落ちたとき**は、
   *   **どの失敗にも**ここの理由を添える(`withRefused`)── 落ちた理由が「その表」だったかを
   *   こちらでは見分けない(DuckDB の断りの字を読み解く形にしない)。引いていない回には何も言わない。
   * 🔴 **器と同じ寿命**(`dropStaleRefused`)── 器が畳まれた後に別の理由で落ちた回へ、**もう無い器の理由**を
   *   添えない。
   */
  private refused: DuckDbRefusedItem[] = [];
  /** 🔴 全列 VARCHAR で写した表の名前(`refused` と同じ寿命)。 */
  private asText: string[] = [];
  /** `.sqlite` を写したか / BLOB の列を持つ表を写したか(`refused` と同じ寿命)。 */
  private copiedSqlite = false;
  private copiedBlob = false;
  /**
   * 🔴 **`load` の世代**(着地後レビュー ⚠1)。⚠ 120 秒の時計(`DUCKDB_LOAD_MAX_MS`)が鳴っても、
   *   **古い `load` は止まらず走り続ける**(`DuckDbLease` の `race` は遅れた答えを捨てるだけ)。
   *   止めないと、畳まれた器への `query` が投げて**現在の控え(`refused`)に積み**、user には実際は写せている
   *   表が「写せなかった表」と出る / 残りの表の分だけ storage worker へ頼み続ける。
   * 🔑 `load` の頭で進め、**自分の世代でなくなったら、控えにも器にも触らずに手を引く**(`gen !== this.loadGen`)。
   */
  private loadGen = 0;
  /**
   * 🔴 **いまの器へ写した `.sqlite` の表の「元の姿」**(型 / 主キー / 外部キー。#918)。
   * ⚠ `load` が入れ直すたびに作り直す(器と同じ寿命 ── 器が畳まれれば次の `load` で組み直す)。
   * 🔑 器の `duckdb_columns()` には元の型・主キー・外部キーが残らないので、構造を採るとき重ねる。
   */
  private meta = new Map<string, DuckDbTableMeta>();
  /**
   * 🔴 **器へ触る仕事を 1 本ずつ通す**(#918)。⚠ つながり図を開く(構造を採る)と SQL を走らせるが
   *   **同じ器へ同時に飛ぶ** ── どちらも「まだ入っていなければ差し込む」ので、2 つ目が差し込みの
   *   最中に入ると**二重に差し込もうとして**(塞いだ後は file を読めない)落ちる。
   *   前の仕事が落ちても次は走る(`then(fn, fn)`)。
   */
  private tail: Promise<unknown> = Promise.resolve();

  /** いまの器へ写したときの報告(写した時点の控えを**複製**して渡す ── 呼び側が書き換えても器の控えは動かない)。 */
  private report(): DuckDbCopyReport {
    return {
      refused: [...this.refused],
      asText: [...this.asText],
      sqlite: this.copiedSqlite,
      blob: this.copiedBlob,
    };
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => undefined);
    return next;
  }

  constructor(private readonly deps: DuckDbRunnerDeps) {
    this.lease = new DuckDbLease({
      open: async () => {
        const { urls, dispose } = await this.resolveUrls();
        /**
         * ⚠ **`dispose` は `deps.open()` が終わってから**呼ぶ ── 早く呼ぶと、
         *   端末の一式(blob: URL)を貸してもらった回で `Worker` の生成や
         *   wasm の instantiate がまだ終わっていない可能性がある(この file
         *   冒頭の「入っていれば端末の一式」節の理由③)。失敗しても畳んで返す
         *   (借りた URL を握ったままにしない)。
         */
        try {
          return await this.deps.open(urls);
        } finally {
          dispose();
        }
      },
      ...(deps.idleMs === undefined ? {} : { idleMs: deps.idleMs }),
    });
  }

  /** ⚠ **test と計測のための観測点**(製品の分岐には使わない)。 */
  get awake(): boolean {
    return this.lease.awake;
  }

  /** いま畳む(面を閉じたとき)。 */
  async release(): Promise<void> {
    await this.lease.release();
  }

  /**
   * 器へ差し込む相手の組(鍵と入れ方)。
   * ⚠ 鍵は lid と名前の両方(名前だけだと、同じ題名の別ノートで入れ替わらない)。
   * 🔴 **N 件の全部を鍵に入れる**(#918 段⑦)── 足す / 外す / 順番が変わるたびに
   *   鍵が変わるので、`DuckDbLease` が**器を作り直す**(`hold` も解ける ──
   *   作った表は消える。画面は「足したり外したりすると、作った表は消えます」と言う)。
   * 🔑 `run`(SQL を走らせる)と `schema`(構造を採る)が**同じ鍵**を使う ── 構造を採った後の
   *   SQL は器を作り直さない(同じ file を 2 度読まない)。
   */
  private dataOf(sources: readonly DuckDbInputSource[]): {
    key: string;
    load: (h: DuckDbHandle) => Promise<void>;
  } {
    return {
      key: sources.map((s) => s.source.lid + '|' + s.source.name).join('||'),
      load: (h) => this.load(h, sources),
    };
  }

  /**
   * 🔴 **器の中の構造を採る**(#918。🟣 Gemini 裁定 2026-10-02 = A)。
   *
   * ⚠ 打つのは**構造を採る SQL だけ**(`DUCKDB_SCHEMA_*` と `countsSql`)で、user の字ではない ──
   *   書き込みの門(`duckDbWriteKind`)は通らず、`hold` も立てない(読むだけ)。
   * 🔑 器へ**まだ差し込んでいなければ差し込む**(`run` と同じ鍵)── 構造を見るだけで相手を全部読み込む
   *   ことになるが、行を数えるのに必要で、その後の SQL は同じ器をそのまま使える。
   * ⚠ 行数が採れなくても**構造は返す**(`counts: null`)。他の落ち方(器を起こせない等)は投げる。
   */
  schema(sources: readonly DuckDbInputSource[]): Promise<DuckDbSchemaResult> {
    return this.serial(async () => {
      this.dropStaleRefused();
      if (sources.length === 0) throw new Error('調べる相手がありません');
      const data = this.dataOf(sources);
      const ask = async (sql: string): Promise<Grid> => {
        const raw = await this.lease.run({ sql, maxMs: DUCKDB_MAX_MS, loadMaxMs: DUCKDB_LOAD_MAX_MS, data });
        return duckDbTable(raw);
      };
      const columns = await ask(DUCKDB_SCHEMA_COLUMNS_SQL);
      const fks = await ask(DUCKDB_SCHEMA_FK_SQL);
      const merged = mergeDuckDbSchema({ columns, fks }, this.meta);
      const sql = countsSql(schemaTableNames(merged.columns));
      const counts = sql === null ? null : await ask(sql).catch(() => null);
      return { columns: merged.columns, fks: merged.fks, counts, copy: this.report() };
    });
  }

  run(input: DuckDbRunInput): Promise<DuckDbRunResult> {
    return this.serial(() => {
      this.dropStaleRefused();
      return this.runNow(input);
    });
  }

  /**
   * 🔴 **器が無いなら、前の器の「写せなかった理由」を捨てる**(着地後のレビューで出た)。
   *
   * 理由は `load`(器へ写す)でしか作り直さないので、**器が畳まれた後に電波なしで引き直す**回
   * (器を起こす所で落ちる)は、`load` に**届く前に**落ちる ── そこへ前の器の理由
   * (「大きい は写せませんでした」)が**別の失敗に付いて**出ていた。
   * ⚠ **毎回空にはしない** ── 器が生きている間は、2 回目以降の `SELECT * FROM 大` にも理由を添えたい
   *   (写し直さないので、ここで空にすると**最初の 1 回だけ**理由が出る)。
   */
  private dropStaleRefused(): void {
    if (!this.lease.awake) this.clearCopy();
  }

  private clearCopy(): void {
    this.refused = [];
    this.asText = [];
    this.copiedSqlite = false;
    this.copiedBlob = false;
  }

  private async runNow(input: DuckDbRunInput): Promise<DuckDbRunResult> {
    const started = Date.now();
    if (input.sources.length === 0) throw new Error('調べる相手がありません');
    const multi = input.sources.length > 1;
    const raw = await this.lease.run({
      sql: input.sql,
      maxMs: DUCKDB_MAX_MS,
      loadMaxMs: DUCKDB_LOAD_MAX_MS,
      /**
       * 🔴 **書き込みが通ったら、アイドルで畳まない**(#918 段⑧)。
       * ⚠ 作った表は器の中にしか無い ── 30 秒で畳むと、user が作った表が
       *   「ウィンドウを閉じると消えます」と言いながら**黙って**消える。
       * 🔑 判定は字の門と**同じ 1 本**(`duckDbWriteKind`)。
       */
      hold: duckDbWriteKind(input.sql) !== null,
      data: this.dataOf(input.sources),
    }).catch((e: unknown) => {
      // 🔴 引いた回が落ちたときは、**どの失敗にも**写せなかった表の理由を添える(`withRefused`)
      throw this.withRefused(e, multi);
    });
    const table = duckDbTable(raw);
    const truncated = table.rows.length > DUCKDB_MAX_ROWS;
    return {
      columns: table.columns,
      rows: truncated ? table.rows.slice(0, DUCKDB_MAX_ROWS) : table.rows,
      truncated,
      ms: Date.now() - started,
      copy: this.report(),
    };
  }

  /**
   * 相手を全部差し込み、表へ写し切り、**外を塞ぐ**。
   * ⚠ **この 3 つは 1 組** ── 途中で止めると、外が開いたままの器が残る。
   *   🔑 落ちた回は `DuckDbLease` が「入っている」と控えないので、次に**やり直す**。
   * 🔴 **塞ぐのは全部を写し切った後に 1 度だけ**(#918 段⑦)── 1 件ごとに塞ぐと
   *   2 件目を差し込めない(塞いだ後は file を読めない)。
   */
  private async load(h: DuckDbHandle, sources: readonly DuckDbInputSource[]): Promise<void> {
    const gen = (this.loadGen += 1);
    const stale = (): boolean => gen !== this.loadGen;
    this.clearCopy();
    this.meta = new Map();
    this.copiedSqlite = sources.some((s) => s.source.kind === 'sqlite');
    /**
     * 🔴 **`.sqlite` だけ、先に開いて表の名前を知る**(#682 段④d)── 表の名前が**中の表の名前**で決まる
     *   (1 件なら元の名前のまま / 2 件以上は `ファイル名_表名`)ので、名前を決める前に要る。
     * ⚠ 開くのは sqlite を持つ storage worker(DuckDB の器では `ATTACH` が bytes を読めない ── 実測)。
     * 🔑 **行はまだ読まない** ── 表ごとに `loadSqlite` が頼む(全表ぶんの NDJSON を同時に持たない)。
     */
    const sessions = new Map<number, SqliteExportSession>();
    try {
      for (const [i, { source, readBytes }] of sources.entries()) {
        if (source.kind !== 'sqlite') continue;
        const bytes = await readBytes();
        if (bytes === null) throw new Error(source.name + ' の中身を読めませんでした');
        const exportSqlite = this.deps.exportSqlite;
        if (exportSqlite === undefined) {
          throw new Error('この版では .sqlite を DuckDB で引けません(アプリを読み直すと直ることがあります)');
        }
        const opened = await exportSqlite(bytes);
        sessions.set(i, opened);
        // ⚠ 時計で畳まれた後に開けた写しは、`finally` が閉じる(手を引く)
        if (stale()) return;
      }
      const groups = duckDbTableGroupsOf(
        sources.map((s) => s.source),
        (i) => sessions.get(i)?.tables ?? [],
      );
      for (const [i, { source, readBytes }] of sources.entries()) {
        // 🔴 時計で畳まれた後の古い `load` は、残りの表を頼まない(storage worker を使い続けない)
        if (stale()) return;
        if (source.kind === 'sqlite') {
          const session = sessions.get(i);
          // ⚠ 上の頭で、`.sqlite` の全部に開いてある(崩れたら黙って飛ばさず落とす)
          if (session === undefined) throw new Error('前提が崩れている(.sqlite の写しが開いていない)');
          await this.loadSqlite(h, source, i, session, groups[i] ?? [], sources.length > 1, stale);
          if (stale()) return;
          // ⚠ 写し終えた file はすぐ手放す(次の file を写す間、worker に開いたまま残さない)
          sessions.delete(i);
          await session.close().catch(() => undefined);
          continue;
        }
        const bytes = await readBytes();
        if (bytes === null) throw new Error(source.name + ' の中身を読めませんでした');
        if (stale()) return;
        const file = duckDbFileNameOf(source, i);
        await h.put(file, bytes);
        await h.query(duckDbLoadSql(source, file, groups[i]?.[0]));
      }
      if (stale()) return;
      await h.query(DUCKDB_SEAL_SQL);
    } finally {
      // 🔴 落ちた回も、開いたままの写しを worker に残さない(不可侵指示 2026-07-27「即破棄」)
      for (const session of sessions.values()) await session.close().catch(() => undefined);
    }
  }

  /**
   * 🔴 **`.sqlite` の表を 1 枚ずつ、器へ写す**(#682 段④d)。
   *
   * 表 1 枚あたり:①worker に**その表だけ**頼む →②宣言から `CREATE TABLE`(**空の表も列を持つ**)→
   * ③行があれば NDJSON を差す →④`INSERT … SELECT … read_json(列と型を明示)` →⑤**NDJSON を外す**
   * (表と同じ中身を 2 回持たない)。⚠ 次の表へ進む前に①の bytes は手放している
   * (**同時に載るのは 1 表ぶん**)。
   *
   * 🔑 **型が合わない行が在る表は、その表だけ全列 VARCHAR で作り直す** ── sqlite は INTEGER の列に
   *   文字を入れられるので、型どおりに入れると落ちる(実測)。黙って NULL にはしない(値を失わない)。
   * 🔑 **型に入れると値が黙って変わる表**(小数の入った INTEGER 列など)は、worker が旗(`asText`)を付けて
   *   返す ── 落ちないので作り直しでは救えず、**最初から全列 VARCHAR** で写す。
   * 🔑 **それでも入らない表は、その表だけ断る**(`refused`)── 他の表は引ける。
   *   ⚠ 表が作れない(名前が空など、DuckDB が受けない宣言)のも**その表だけ**断る。
   *   ⚠ 断った表は**作らない**(空の表を残すと「0 件の表」に読める)。
   */
  private async loadSqlite(
    h: DuckDbHandle,
    source: Extract<DuckDbReadableGuestSource, { kind: 'sqlite' }>,
    slot: number,
    session: SqliteExportSession,
    names: readonly string[],
    multi: boolean,
    /** 🔴 この `load` が時計で畳まれた後か(`loadGen`)── 真になったら控えにも器にも触らず手を引く。 */
    stale: () => boolean,
  ): Promise<void> {
    /**
     * 外部キーの相手は元の名前で来る ── 器での名前へ直す(2 件以上なら `ファイル名_表名`)。
     * 🔴 **小文字で引く**(sqlite の表の名前は大小を区別しない)/ **この file の表に無い相手の線は捨てる**
     *   (`duckDbMetaOf`。⚠ 元の名前へ落とすと、並べた別の file に同名の表が在るとき**偽の線**になる)。
     */
    const finalOf = new Map(session.tables.map((n, k) => [n.toLowerCase(), names[k] ?? n] as const));
    const firstLine = (e: unknown): string =>
      (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';
    for (const [k, original] of session.tables.entries()) {
      // 🔴 表ごとの頭でも確かめる(残りの表を storage worker へ頼み続けない)。⚠ 下の「待った後の確認」と二重で、
      //   後から足す経路が確認を忘れたときの最後の網(外しても今の test は落ちない = 等価な変異)
      if (stale()) return;
      const name = names[k] ?? original;
      let t: SqliteExportedTable;
      try {
        t = await session.table(original, SQLITE_NDJSON_TABLE_MAX_BYTES);
      } catch (e) {
        if (stale()) return;
        // ⚠ 頼めなかった(写しが閉じられた等)表も、その表だけ断る
        this.refused.push({ name, view: false, why: `読めませんでした: ${firstLine(e)}` });
        continue;
      }
      // ⚠ 頼んでいる間に畳まれていたら、この表の答えは古い器のもの(控えへ積まない)
      if (stale()) return;
      if (t.refused !== null) {
        this.refused.push({ name, view: false, why: t.refused });
        continue;
      }
      /**
       * 🔴 **表を作る所も、その表だけの失敗にする**(着地後のレビューで出た)。名前が空の表・列
       *   (sqlite は許す)を DuckDB は `zero-length delimited identifier` で断る ── 外へ投げると
       *   **file 全体が英語の断りで落ち、ほかの表まで引けなくなる**。
       */
      try {
        await h.query(createTableSql(name, t.columns, t.asText));
      } catch (e) {
        // 🔴 畳まれた器への `query` が投げた失敗は「写せなかった」ではない(控えへ積まない)
        if (stale()) return;
        this.refused.push({ name, view: false, why: `DuckDB が表を作れませんでした: ${firstLine(e)}` });
        continue;
      }
      /**
       * 🔴 **元の姿を控える**(#918)── 器の表は型を 3 つへ潰し、主キーも外部キーも持たない。
       * ⚠ **表を作った直後に控える**(行を入れる所で断られても、列は器に在る)。引けなくなった表
       *   (下で `DROP` する)は、構造を採るとき器に無いので `mergeDuckDbSchema` が出さない。
       */
      if (stale()) return;
      this.meta.set(name, duckDbMetaOf(t.columns, t.fks, finalOf));
      // 🔴 BLOB の列が在る表を写した(案内の BLOB の注記は、在るときだけ出す)
      if (t.columns.some((c) => /BLOB/i.test(c.type))) this.copiedBlob = true;
      // ⚠ 行が 0 件の表は file を作らない(列は上で作った ── `read_json_auto` は空だと列を失う)
      if (t.ndjson === null) continue;
      const file = duckDbFileNameOf(source, slot, k);
      await h.put(file, t.ndjson);
      if (stale()) return;
      /** 🔴 全列 VARCHAR で入れたか(最初から / 型が合わなくて作り直した)── 帯でその表の名前を言う。 */
      let asText = t.asText;
      try {
        try {
          // 🔑 旗が立っていれば作り直しではなく、最初から全列 VARCHAR で入れる(上で作ってある)
          await h.query(insertFromNdjsonSql(name, file, t.columns, t.asText));
        } catch (first) {
          if (t.asText) throw first;
          await h.query(createTableSql(name, t.columns, true));
          await h.query(insertFromNdjsonSql(name, file, t.columns, true));
          asText = true;
        }
        if (stale()) return;
        if (asText) this.asText.push(name);
      } catch (e) {
        // 🔴 畳まれた器への失敗は、控えへ積まず、`DROP` も打たない
        if (stale()) return;
        await h.query('DROP TABLE ' + quoteIdent(name));
        this.refused.push({ name, view: false, why: `DuckDB が読めませんでした: ${firstLine(e)}` });
      } finally {
        // ⚠ 畳まれた器の file は器ごと消えている(手を引いた回は触らない)
        if (!stale()) await h.drop(file);
      }
    }
    /**
     * 🔴 **ビューは写さない ── 写さなかったと言う**(着地後レビュー D3)。⚠ 直す前は、ビューがあることすら
     *   どこにも出ず、`SELECT * FROM 在庫ビュー` が英語の「そんな表は無い」で返るだけだった。
     * 🔑 名前は表と同じ決め方(2 件以上なら `ファイル名_名前`)── 画面で「無い」と言うとき、user が打った名前と同じにする。
     */
    if (stale()) return;
    for (const v of session.views) {
      const name = multi ? tableNameFromFileTable(source.name, v, new Set()) : v;
      this.refused.push({ name, view: true, why: 'ビューは写しません' });
    }
    /**
     * 🔴 **全文検索(FTS5)の仮想表本体も、写さなかったと言う**(着地後レビュー 💭8)。⚠ 直す前は本体を黙って外していて、
     *   `SELECT * FROM docs` が英語の「そんな表は無い」で返るだけだった。影の表(`docs_data` 等)は user の表ではないので黙って外したまま。
     * 🔑 逃げ道(内蔵の sqlite なら引ける)は `refusedLine` / `withRefused` が添える(ここへは書かない ── 並べているかで字が変わる)。
     */
    for (const f of session.ftsTables) {
      const name = multi ? tableNameFromFileTable(source.name, f, new Set()) : f;
      this.refused.push({ name, view: false, why: '全文検索の表は写しません' });
    }
  }

  /**
   * 引いた回が落ちたとき、写せなかった表の理由を添える(引いていない回は何も言わない)。
   *
   * 🔴 **並べているとき、表が無いと言われたら名前の決め方を添える**(着地後レビュー D5)── file を足すと
   *   表の名前が `csv` → `売上` / `ファイル名_表名` へ変わるので、前の名前で引いた user は DuckDB の英語の
   *   「Table with name … does not exist」だけを見る。⚠ 1 つだけのときは言わない(名前は変わらない)。
   */
  private withRefused(e: unknown, multi: boolean): Error {
    const err = e instanceof Error ? e : new Error(String(e));
    const notes = this.refused.map((r) => refusedNote(r.name, r.why, sqliteFallbackHint(multi)));
    if (multi && /Table with name .+ does not exist/i.test(err.message)) {
      notes.push(`表の名前は ファイル名_表名 になっています(一覧は ${DUCKDB_TABLE_LIST_SQL} で引けます)`);
    }
    if (notes.length === 0) return err;
    return new Error(`${err.message} ── ${notes.join(' / ')}`, { cause: err });
  }

  /**
   * 実体の在り処を決める。**呼ばれるたびに**端末の一式(`lendInstalled`)を
   * 先に確かめ、無ければ同一オリジンの目録(`resolveNetworkUrls`)へ倒す。
   *
   * 🔑 `lendInstalled` の有無は**毎回**問う ── 前回は未設置でも、その後 user が
   *   設置していれば次の `open()` からは端末の一式へ切り替わる(この runner は
   *   長生きするので、途中で状態が変わりうる)。
   * ⚠ 端末側には `this.urls` のような控えを**持たせない** ── 理由はこの file
   *   冒頭の節。
   */
  private async resolveUrls(): Promise<{ urls: DuckDbOpenUrls; dispose: () => void }> {
    const lend = this.deps.lendInstalled;
    if (lend !== undefined) {
      const lent = await lend();
      if (lent !== null) {
        /**
         * 🔴 **拡張だけは、端末の一式からは貸せない**(#682 段④b。実測 2026-09-16)。
         * ⚠ engine は拡張を**必ず HTTP GET** で取りに来るので、置き場は
         *   **path を持つ URL** でなければならない ── `blob:` には path が作れない。
         * 🔑 だから器と worker は端末から、**拡張はいつも同一オリジンから**。
         * ⚠ 帰結として、**電波が無いと拡張は読み込めない**(一式を入れてあっても)。
         */
        return {
          urls: { wasmUrl: lent.wasmUrl, workerUrl: lent.workerUrl, extensions: this.extensions() },
          dispose: lent.dispose,
        };
      }
    }
    return { urls: await this.resolveNetworkUrls(), dispose: () => undefined };
  }

  /**
   * 拡張の置き場(同一オリジン)と名前。
   * ⚠ **目録を読まずに組める** ── 目録が読めなくても器は起こせるべきだからではなく、
   *   端末の一式を使う回は**目録を 1 度も引かない**からである(上の `resolveUrls`)。
   * 🔑 門(`resolveDuckDbBase`)はここでも通す ── 通さない口を 1 つも作らない。
   */
  private extensions(): { repository: string; names: readonly string[] } {
    const base = resolveDuckDbBase(this.deps.packBase ?? DUCKDB_BASE, this.deps.baseUrl ?? document.baseURI);
    // ⚠ 末尾の `/` は付けない ── engine が `<置き場>/<版>/…` と繋ぐので二重になる
    return { repository: duckDbAssetUrl(base, DUCKDB_EXT_DIR), names: DUCKDB_EXTENSIONS };
  }

  /**
   * 目録を読んで、同一オリジンの実体の在り処を決める。1 度読めば替わらないので
   * `this.urls` へ控える(端末の一式とは寿命が違う ── 上の `resolveUrls` を見よ)。
   * ⚠ **信じずに検める**(`readDuckDbPack`)── 壊れた物を渡すと、上流は
   *   wasm の解釈の所で分かりにくく落ちる(user には「開かない」としか見えない)。
   */
  private async resolveNetworkUrls(): Promise<DuckDbOpenUrls> {
    const known = this.urls;
    if (known !== null) return known;
    /**
     * 🔴 **門は 1 つ**(#682 段③a、2026-09-15)── 取得元が同じ場所かを検めるのは
     *   `resolveDuckDbBase()` だけにする(§7「同じ問いに答える口を 2 つ作らない」)。
     * ⚠ 製品が渡すのは相対の `duckdb/` だけなので、**そこだけ見ていると必ず通る** ──
     *   だから「渡す物が相対だから安全」に**寄りかからない**。次に書く人が別の字を
     *   渡した日に、門が無ければ外の宛先がそのまま組める。
     * 🔑 その「別の字を渡した日」を **いま test から作れる**ようにしてある
     *   (`deps.packBase`)── 作れないと、門を外しても何も落ちない。
     */
    const base = resolveDuckDbBase(this.deps.packBase ?? DUCKDB_BASE, this.deps.baseUrl ?? document.baseURI);
    let text: string;
    try {
      text = await this.deps.fetchText(duckDbAssetUrl(base, 'pack.json'));
    } catch {
      /**
       * ⚠ **一式は precache に載っていない**(設計 doc §11)── 電波が無い日は
       *   ここで落ちる。🔑 だから理由を**その言葉で**言う。
       */
      throw new Error('DuckDB の一式を取ってこられませんでした(つながっているか確かめてください)');
    }
    const read = readDuckDbPack(text);
    if (!read.ok) throw new Error(read.why);
    const urls: DuckDbOpenUrls = {
      wasmUrl: duckDbAssetUrl(base, DUCKDB_WASM),
      workerUrl: duckDbAssetUrl(base, DUCKDB_WORKER),
      extensions: this.extensions(),
    };
    this.urls = urls;
    return urls;
  }
}
