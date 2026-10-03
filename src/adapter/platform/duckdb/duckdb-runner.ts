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
  type SqliteExportedTable,
} from '@features/query/sqlite-ndjson';
import { duckDbWriteKind } from '@features/query/duckdb-write';
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
   * 🔴 **`.sqlite` を表ごとの NDJSON にしてもらう口**(#682 段④d。任意 ── 渡さない版では
   *   `.sqlite` を DuckDB へ入れるとき**理由を言って断る**)。
   * 🔑 行を読むのは **sqlite を持つ storage worker** である(DuckDB の器では `ATTACH` が bytes を
   *   読めない ── 実測)。⚠ 呼ぶのは**器へ入れ直すときだけ**。
   */
  exportSqlite?: (
    image: Uint8Array,
    maxTableBytes: number,
  ) => Promise<{ tables: readonly SqliteExportedTable[] }>;
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
   *   その名前を引くと DuckDB は「そんな表は無い」としか言わない。**そのとき**だけ、ここの理由を
   *   添える(`withRefused`)。引いていない回には何も言わない。
   */
  private refused: string[] = [];

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

  async run(input: DuckDbRunInput): Promise<DuckDbRunResult> {
    const started = Date.now();
    if (input.sources.length === 0) throw new Error('調べる相手がありません');
    const raw = await this.lease.run({
      sql: input.sql,
      maxMs: DUCKDB_MAX_MS,
      /**
       * 🔴 **書き込みが通ったら、アイドルで畳まない**(#918 段⑧)。
       * ⚠ 作った表は器の中にしか無い ── 30 秒で畳むと、user が作った表が
       *   「ウィンドウを閉じると消えます」と言いながら**黙って**消える。
       * 🔑 判定は字の門と**同じ 1 本**(`duckDbWriteKind`)。
       */
      hold: duckDbWriteKind(input.sql) !== null,
      /**
       * ⚠ 鍵は lid と名前の両方(名前だけだと、同じ題名の別ノートで入れ替わらない)。
       * 🔴 **N 件の全部を鍵に入れる**(#918 段⑦)── 足す / 外す / 順番が変わるたびに
       *   鍵が変わるので、`DuckDbLease` が**器を作り直す**(`hold` も解ける ──
       *   作った表は消える。画面は「足したり外したりすると、作った表は消えます」と言う)。
       */
      data: {
        key: input.sources.map((s) => s.source.lid + '|' + s.source.name).join('||'),
        load: (h) => this.load(h, input.sources),
      },
    }).catch((e: unknown) => {
      // 🔴 引いた回が落ちたときだけ、写せなかった表の理由を添える(`withRefused`)
      throw this.withRefused(e);
    });
    const table = duckDbTable(raw);
    const truncated = table.rows.length > DUCKDB_MAX_ROWS;
    return {
      columns: table.columns,
      rows: truncated ? table.rows.slice(0, DUCKDB_MAX_ROWS) : table.rows,
      truncated,
      ms: Date.now() - started,
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
    this.refused = [];
    /**
     * 🔴 **`.sqlite` だけ、先に中身を読む**(#682 段④d)── 表の名前が**中の表の名前**で決まる
     *   (1 件なら元の名前のまま / 2 件以上は `ファイル名_表名`)ので、名前を決める前に要る。
     * ⚠ 読むのは sqlite を持つ storage worker(DuckDB の器では `ATTACH` が bytes を読めない ── 実測)。
     */
    const exported = new Map<number, readonly SqliteExportedTable[]>();
    for (const [i, { source, readBytes }] of sources.entries()) {
      if (source.kind !== 'sqlite') continue;
      const bytes = await readBytes();
      if (bytes === null) throw new Error(source.name + ' の中身を読めませんでした');
      const exportSqlite = this.deps.exportSqlite;
      if (exportSqlite === undefined) {
        throw new Error('この版では .sqlite を DuckDB で引けません(アプリを読み直すと直ることがあります)');
      }
      exported.set(i, (await exportSqlite(bytes, SQLITE_NDJSON_TABLE_MAX_BYTES)).tables);
    }
    const groups = duckDbTableGroupsOf(
      sources.map((s) => s.source),
      (i) => (exported.get(i) ?? []).map((t) => t.name),
    );
    for (const [i, { source, readBytes }] of sources.entries()) {
      if (source.kind === 'sqlite') {
        await this.loadSqlite(h, source, i, exported.get(i) ?? [], groups[i] ?? []);
        // ⚠ 写し終えた分は手放す(同じ bytes を 2 回持たない)
        exported.delete(i);
        continue;
      }
      const bytes = await readBytes();
      if (bytes === null) throw new Error(source.name + ' の中身を読めませんでした');
      const file = duckDbFileNameOf(source, i);
      await h.put(file, bytes);
      await h.query(duckDbLoadSql(source, file, groups[i]?.[0]));
    }
    await h.query(DUCKDB_SEAL_SQL);
  }

  /**
   * 🔴 **`.sqlite` の表を 1 枚ずつ、器へ写す**(#682 段④d)。
   *
   * 表 1 枚あたり:①宣言から `CREATE TABLE`(**空の表も列を持つ**)→ ②行があれば NDJSON を差す →
   * ③`INSERT … SELECT … read_json(列と型を明示)` → ④**NDJSON を外す**(表と同じ中身を 2 回持たない)。
   *
   * 🔑 **型が合わない行が在る表は、その表だけ全列 VARCHAR で作り直す** ── sqlite は INTEGER の列に
   *   文字を入れられるので、型どおりに入れると落ちる(実測)。黙って NULL にはしない(値を失わない)。
   * 🔑 **それでも入らない表は、その表だけ断る**(`refused`)── 他の表は引ける。
   *   ⚠ 断った表は**作らない**(空の表を残すと「0 件の表」に読める)。
   */
  private async loadSqlite(
    h: DuckDbHandle,
    source: Extract<DuckDbReadableGuestSource, { kind: 'sqlite' }>,
    slot: number,
    tables: readonly SqliteExportedTable[],
    names: readonly string[],
  ): Promise<void> {
    for (const [k, t] of tables.entries()) {
      const name = names[k] ?? t.name;
      if (t.refused !== null) {
        this.refused.push(refusedNote(name, t.refused));
        continue;
      }
      await h.query(createTableSql(name, t.columns));
      // ⚠ 行が 0 件の表は file を作らない(列は上で作った ── `read_json_auto` は空だと列を失う)
      if (t.ndjson === null) continue;
      const file = duckDbFileNameOf(source, slot, k);
      await h.put(file, t.ndjson);
      try {
        try {
          await h.query(insertFromNdjsonSql(name, file, t.columns));
        } catch {
          await h.query(createTableSql(name, t.columns, true));
          try {
            await h.query(insertFromNdjsonSql(name, file, t.columns, true));
          } catch (e) {
            await h.query('DROP TABLE ' + quoteIdent(name));
            const first = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';
            this.refused.push(refusedNote(name, `DuckDB が読めませんでした: ${first}`));
          }
        }
      } finally {
        await h.drop(file);
      }
    }
  }

  /** 引いた回が落ちたとき、写せなかった表の理由を添える(引いていない回は何も言わない)。 */
  private withRefused(e: unknown): Error {
    const err = e instanceof Error ? e : new Error(String(e));
    if (this.refused.length === 0) return err;
    return new Error(`${err.message} ── ${this.refused.join(' / ')}`, { cause: err });
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
