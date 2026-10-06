/**
 * 🔴 **取り込んだ `.sqlite` を、DuckDB でも引けるように「NDJSON の写し」にする**(#682 段④d)。
 *
 * ## ① user が何を求めていたのか
 *
 * 添付した `.sqlite` を、いつもの「内蔵の sqlite」ではなく **DuckDB でも引きたい**
 * (🟣 Gemini 裁定 2026-10-02:表の名前 = 元の名前のまま / 方式 = NDJSON の写し)。
 *
 * ## ② 何が分かっていたか(実測済み)
 *
 * 🔴 DuckDB wasm の器の中では `ATTACH … (TYPE sqlite)` が **PKC が渡した bytes を読めない**
 * (全経路で `unable to open database file`)。だから使わない。
 * 🟢 通った道は **表を NDJSON に写して `registerFileBuffer` → `read_json`** で、同梱の
 * `json` 拡張だけで足りる(100k 行 = NDJSON 27.5MB / put 116ms / CTAS 223ms)。
 * ⚠ 行を読むのは **storage worker の中**で、メインへ載せるのは組み上がった bytes だけ
 * (wasm-sqlite で 100k 行を `selectObjects` すると 1,365ms ── 行の配列をメインへ載せない)。
 *
 * ## ③ この file は何か
 *
 * 判断だけを持つ **純粋関数**(worker も DuckDB の側も、ここを呼ぶ ── §7「同じ問いに答える口を
 * 2 つ作らない」):行 → NDJSON の 1 行 / 天井つきの組み立て / 型の写し表 / DDL と読み込みの字。
 *
 * ## ④ 決めたこと(理由を 1 行ずつ)
 *
 * | 決めること | 決め方 | 理由 |
 * |---|---|---|
 * | BLOB | **base64 の文字列**で入れる | NULL にすると中身が**黙って消える**(元に在った値が無かったことになる)。JSON は bytes を持てない |
 * | 型 | 宣言の型から **BIGINT / DOUBLE / VARCHAR** の 3 つへ写す(下の表) | sqlite は動的型なので、細かく写すほど**写せない行**が増える |
 * | 写せない型 | **VARCHAR** | 値は 1 つも失わない |
 * | 型が合わない行が在る表 | その表だけ**全列 VARCHAR で作り直す** | sqlite は INTEGER の列に文字を入れられる ── 黙って NULL にしない |
 * | 型に入れると**黙って値が変わる**行が在る表 | その表だけ**最初から全列 VARCHAR**(下の {@link LossyWatch}) | DuckDB は BIGINT へ小数を**丸めて**入れ(19.99 → 20)、DOUBLE へ `Infinity` を **NULL** で入れる。落ちれば作り直せるが、**落ちない**ので気づけない |
 * | 空の表 | 宣言から `CREATE TABLE` だけ作る | `read_json_auto` は行が無いと**列を失う** |
 * | 大きい表 | 1 表あたり **{@link SQLITE_NDJSON_TABLE_MAX_BYTES}** で、**その表だけ**断る | 他の表は引ける(下の定数の理由) |
 */
import { humanBytes } from '../human-bytes';

/**
 * 🔴 **1 表あたりの NDJSON の天井(バイト)**。
 *
 * 実測(2026-10-02、100k 行 / 本文 300 字ほど):NDJSON **27.5MB**、`registerFileBuffer` **116ms**、
 * `CREATE TABLE … AS SELECT` **223ms**。⚠ 値は行の幅で大きく変わるので、行数ではなく
 * **バイト**で切る。
 * 🔑 **64MiB** は実測の約 2.4 倍 ── 時間は線形に伸ばして 1 秒に届かない見込みだが、
 * 根拠は時間ではなく**常駐メモリ**(配る量ではなく継続使用):storage worker は組み立てる間
 * 「積んだ部品」と「結合した 1 本」で**最大 2 倍**を持ち、メインが受け、DuckDB の器へ差した後は
 * 読み込みの作業領域と表の分が加わる。⚠ **ピークそのものは測っていない**(天井は実測の倍数であって、
 * 上限の実測ではない)── 測れたら見直す。
 * ⚠ 超えた表は**断る**(黙って先頭だけ写さない ── 件数が合わない表で集計すると、
 *   user は「これで全部」と読む)。内蔵の sqlite なら同じ file を引ける。
 */
export const SQLITE_NDJSON_TABLE_MAX_BYTES = 64 * 1024 * 1024;

/** 1 列(宣言の型は sqlite が持つ字のまま。⚠ 型が無い列は空の字)。 */
export interface SqliteExportColumn {
  readonly name: string;
  readonly type: string;
}

/**
 * 🔴 **宣言のままの列の形**(#918 段⑦の続き。つながり図・構造ノートが DuckDB でも出る)。
 *
 * ⚠ 器の表は `createTableSql` が **型を 3 つ(BIGINT / DOUBLE / VARCHAR)へ潰して**作り、**主キーも空を許さない
 *   印も付けない**(付けると、写しの INSERT が sqlite では通っていた行で落ちる)。だから構造を採るとき、
 *   器の `duckdb_columns()` だけでは**元の型・主キー・空を許さない印が消える** ── ここへ元のまま運び、
 *   構造の組み立て(`duckdb-schema.ts`)が器の答えに**重ねる**。
 */
export interface SqliteColumnShape extends SqliteExportColumn {
  readonly notNull: boolean;
  /** 主キーの一部か(複合なら全部の列が真)。 */
  readonly primaryKey: boolean;
}

/**
 * 外部キー 1 本(`PRAGMA foreign_key_list` のまま)。
 * ⚠ `toColumn` は空のことがある(相手の主キーを指す書き方)。`toTable` は**元の名前**(器での名前ではない)。
 */
export interface SqliteExportFk {
  readonly fromColumn: string;
  readonly toTable: string;
  readonly toColumn: string;
}

/**
 * storage worker が返す「表 1 つ分の写し」。
 *
 * ⚠ `ndjson` が `null` の理由は 2 つ ── ①行が 0 件(空の表)②断った(`refused` が非 null)。
 *   🔑 見分けは `refused`(空の表は**写せている**ので `refused` は `null`)。
 */
export interface SqliteExportedTable {
  readonly name: string;
  readonly columns: readonly SqliteColumnShape[];
  /**
   * 🔴 **外部キー**(#918 段⑦の続き)。⚠ 器の表には**写さない**(DuckDB の `FOREIGN KEY` は
   *   相手の列に主キーを要求し、行の順にも縛られる ── 写しの INSERT が落ちる)。構造を採るときだけ
   *   `duckdb-schema.ts` が使う。⚠ 必須の field(省ける形にすると、worker が書き忘れても tsc が黙る)。
   */
  readonly fks: readonly SqliteExportFk[];
  /** 行を 1 つずつ JSON にして改行で繋いだ bytes(UTF-8)。 */
  readonly ndjson: Uint8Array | null;
  readonly rows: number;
  /**
   * 🔴 **型に入れると値が黙って変わる行が在った**(= この表は最初から全列 VARCHAR で写す。{@link LossyWatch})。
   * ⚠ 必須の field(省ける形にすると、worker が書き忘れても tsc が黙る ── 書き忘れは**値が黙って丸まる**側へ倒れる)。
   */
  readonly asText: boolean;
  /** 写せなかった理由の字(表の名前を含まない ── 呼び側が最終の名前を前置する)。`null` = 写せた。 */
  readonly refused: string | null;
}

/**
 * 🔴 **開いてある `.sqlite` から、表を 1 つずつ写してもらう口**(#682 段④d の着地後レビュー)。
 *
 * ⚠ 全部を 1 回で返す形にしない ── 表が多い file は**全表ぶんの NDJSON が同時に載る**(1 表の天井だけでは
 *   合計が青天井)。表ごとに「写す → 器へ入れる → 手放す」を回せば、同時に載るのは 1 表ぶんになる。
 * 🔑 `tables` は**元の名前**(器での名前は呼び側が決める)。`close` は**必ず呼ぶ**(`finally` で ──
 *   落ちた回も、写しを開いたまま残さない)。
 */
export interface SqliteExportSession {
  readonly tables: readonly string[];
  /**
   * 🔴 **写さないビューの名前**(元の名前。名前順)。⚠ 必須の field(省ける形にすると、口を作る側が書き忘れても
   *   tsc が黙る ── 書き忘れは「ビューが黙って無い」側へ倒れる)。⚠ 行は頼めない(`table` に渡しても写せない)──
   *   **写さなかったと言う**ためだけに在る(`duckdb-copy-report.ts`)。
   */
  readonly views: readonly string[];
  /**
   * 🔴 **写さない全文検索(FTS5)の仮想表本体の名前**(元の名前。名前順。影の表は含めない)。⚠ 必須の field(`views` と同じ理由)。
   *   **写さなかったと言う**ためだけに在る ── 内蔵の sqlite なら引けるので、逃げ道を添える(`duckdb-copy-report.ts`)。
   */
  readonly ftsTables: readonly string[];
  table(name: string, maxTableBytes: number): Promise<SqliteExportedTable>;
  close(): Promise<void>;
}

/**
 * 天井を超えた理由(字)。⚠ 表の名前は含めない。
 *
 * 🔴 **file の大きさではなく、写した行の大きさ**で言う ── 直す前は「行の写しが 64 MiB を超えました」で、
 *   file が 35 MB でも出るので「file は 64 MB もないのに」と読まれた。⚠ 写すと NDJSON(字)になり、
 *   **元の file より大きくなる**(BLOB は base64 で 3 割増える / 数も字で書く)── それを先に言う。
 * 🔑 **内蔵の sqlite への逃げ道は、ここへ書かない**(`sqliteFallbackHint`)── 並べているときは
 *   「file を 1 つに戻すと」と言い直す必要があり、worker は並べているかを知らない。
 */
export function tooBigReason(maxBytes: number): string {
  // 🔑 大きさの綴りは `humanBytes` 1 本(自前で単位を付けない ── `human-bytes.test.ts` が全数で見る)
  return `読み込んだ行が ${humanBytes(maxBytes)} を超えました(元のファイルより大きくなることがあります)`;
}

/** SQL の識別子の引用(sqlite も DuckDB も `"` を `""` と書く)。 */
export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** SQL の文字列の引用。 */
function sqlStr(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * 🔴 **BLOB → base64**。⚠ 大きい BLOB でも引数の数で落ちないよう、小分けにして字へ直す。
 * (`btoa` は worker / node / ブラウザのどこにも在る)
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const STEP = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(bin);
}

/** 列の名前 → NDJSON の key の前置き(`"名前":`)。⚠ 行ごとに組み直さないよう、先に作る。 */
export function ndjsonKeysOf(columns: readonly string[]): string[] {
  return columns.map((c) => JSON.stringify(c) + ':');
}

/**
 * 1 つの値を JSON の字へ。
 *
 * - `null` / `undefined` → `null`
 * - 整数が 2^53 を超える `bigint` → **桁をそのまま**(`JSON.stringify` は `bigint` で落ちる ──
 *   しかも `Number` へ丸めると**下の桁が黙って変わる**)
 * - `NaN` → `null`(sqlite が保存できない値)/ `±Infinity` → 字(JSON に無いので。BIGINT でない列へ入る)
 * - `Uint8Array`(BLOB)→ base64 の字
 */
function valueText(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'number':
      if (Number.isNaN(v)) return 'null';
      if (!Number.isFinite(v)) return v > 0 ? '"Infinity"' : '"-Infinity"';
      return JSON.stringify(v);
    case 'bigint':
      return v.toString();
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return JSON.stringify(v);
    default:
      if (v instanceof Uint8Array) return JSON.stringify(bytesToBase64(v));
      return JSON.stringify(String(v));
  }
}

/**
 * 🔴 **行 → NDJSON の 1 行**。
 *
 * ⚠ **全ての列を、いつも同じ順で書く**(`NULL` も省かない)── `read_json` は列の並びを
 *   key の並びから決めるので、省くと行ごとに並びが揺れる。
 * ⚠ 改行は `JSON.stringify` が `\n` へ逃がす ── 値に改行が在っても 1 行のまま。
 */
export function ndjsonLineOf(keys: readonly string[], row: readonly unknown[]): string {
  let out = '{';
  for (let i = 0; i < keys.length; i += 1) {
    if (i > 0) out += ',';
    out += keys[i] + valueText(row[i]);
  }
  return out + '}';
}

/**
 * 🔴 **型へ写すと値が黙って変わる行を、読みながら見つける**(着地後のレビューで出た欠陥)。
 *
 * sqlite は型が動的で、宣言と値の型が一致しない行を持てる。DuckDB へ `read_json` で入れるとき、
 * **落ちる**型違いは「全列 VARCHAR で作り直す」(`DuckDbRunner`)で救えるが、次の 2 つは**落ちずに値が変わる**:
 *
 * | 宣言の写し先 | 来た値 | DuckDB で起きること |
 * |---|---|---|
 * | BIGINT(`INT` / `BOOL` を含む宣言) | **小数**(`price INTEGER` に 19.99 ── sqlite の INTEGER 親和性は小数を REAL のまま保つ) | **丸まる**(3.5 → 4 / 2.5 → 2) |
 * | DOUBLE(`REAL` / `FLOA` / `DOUB` / `DECIMAL` / `NUMERIC` を含む宣言) | `±Infinity` | **NULL** になる |
 * | DOUBLE | 2^53 を超える整数(`NUMERIC` に入った 64 bit 整数。`bigint` で来る) | 倍精度へ**丸まる** |
 *
 * 🔑 1 つでも見つかったら、その表は**最初から全列 VARCHAR で写す**(旗 `asText` を応答に付ける)。
 * VARCHAR なら JSON の数は**字のまま**入る(19.99 は 19.99、桁も変わらない)── user は `CAST` で自分で選べる。
 * ⚠ NaN は見ない(`valueText` が `null` にする ── sqlite は NaN を保存できず NULL にする)。
 * ⚠ 型違いで**落ちる**組み合わせ(INTEGER の列に文字)は見ない ── 既存の作り直しが救う。
 */
export class LossyWatch {
  private readonly kinds: readonly DuckDbColumnType[];
  /** 1 つでも見つかったら `true`(以後は見ない)。 */
  lossy = false;

  constructor(columns: readonly SqliteExportColumn[]) {
    this.kinds = columns.map((c) => duckDbColumnTypeOf(c.type));
  }

  see(row: readonly unknown[]): void {
    if (this.lossy) return;
    for (let i = 0; i < this.kinds.length; i += 1) {
      const v = row[i];
      const kind = this.kinds[i];
      if (kind === 'BIGINT') {
        if (typeof v === 'number' && !Number.isNaN(v) && !Number.isInteger(v)) this.lossy = true;
      } else if (kind === 'DOUBLE') {
        if (typeof v === 'bigint' || (typeof v === 'number' && !Number.isNaN(v) && !Number.isFinite(v))) {
          this.lossy = true;
        }
      }
      if (this.lossy) return;
    }
  }
}

/**
 * 一度に符号化する行数の上限(小さすぎると呼び出しが増え、大きすぎると一時の字が膨らむ)。
 * ⚠ **これだけでは天井を守れない** ── 行が太いと 1000 行で数百 MB になる(下の {@link ENCODE_BATCH_CHARS})。
 */
const ENCODE_BATCH_ROWS = 1000;

/**
 * 🔴 **一度に符号化する字数の上限(約 1 MiB)**(#682 段④d の着地後レビュー)。
 *
 * 天井(64MiB)を見るのは**符号化して束ねた回**だけなので、行数だけで束ねると
 * **1 行 64 KB の表は 999 行目(= 64 MB を超えた後)まで止まらず**、1 行 512 KB では
 * `Array.join` が字の長さの上限(`RangeError`)で**天井より先に落ちた**
 * (断り文が「64 MB 超」ではなく「行を読めませんでした」になる)。
 * 🔑 だから**行数ではなく字数で束ねる** ── 天井を超えて読み続ける量が「1 束(約 1 MiB)」で頭打ちになる。
 * ⚠ 字数は UTF-16 の長さで、bytes ではない(日本語は 1 字 3 bytes まで膨らむ)── 天井そのものの判定は
 *   束ねた後の **bytes** で行う(数えるのは実際に運ぶ量)。ここは「どれだけ溜めてから確かめるか」だけ。
 */
const ENCODE_BATCH_CHARS = 1024 * 1024;

/**
 * 🔴 **天井つきの組み立て**。
 *
 * ⚠ **巨大な 1 本の字を作らない** ── 行を小分けにして符号化し、bytes を積む
 *   (字の長さの上限で落ちる形にしない)。⚠ 超えたら**そこで読むのをやめる**
 *   (`push` が `false` を返す)── 天井を超えるとわかってから全行を読み切らない。
 * 🔑 数えるのは**符号化した後の bytes**(= 実際に運ぶ量)。字数ではない。
 * 🔑 束ねる区切りは**行数と字数のどちらか先に来たほう**(行が細ければ 1000 行 / 太ければ約 1 MiB)。
 */
export class NdjsonCollector {
  private readonly parts: Uint8Array[] = [];
  private pending: string[] = [];
  /** `pending` の字数(改行を含む)。 */
  private pendingChars = 0;
  private total = 0;
  private over = false;
  private readonly enc = new TextEncoder();
  /** 積んだ行数(超えて止めた回は、止めるまでの行数)。 */
  rows = 0;

  constructor(private readonly maxBytes: number) {}

  /** @returns `false` = 天井を超えた(呼び側はここで読むのをやめる) */
  push(line: string): boolean {
    if (this.over) return false;
    this.pending.push(line);
    this.pendingChars += line.length + 1;
    this.rows += 1;
    if (this.pending.length >= ENCODE_BATCH_ROWS || this.pendingChars >= ENCODE_BATCH_CHARS) {
      this.flush();
    }
    return !this.over;
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const u = this.enc.encode(this.pending.join('\n') + '\n');
    this.pending = [];
    this.pendingChars = 0;
    this.total += u.byteLength;
    if (this.total > this.maxBytes) {
      this.over = true;
      // ⚠ 超えた回は積んだ分も捨てる(返さない物を握り続けない ── 即破棄)
      this.parts.length = 0;
      return;
    }
    this.parts.push(u);
  }

  /** 🔑 超えていれば `null`。⚠ 行が 0 件でも `null`(空の表は file を作らない)。 */
  finish(): Uint8Array | null {
    this.flush();
    if (this.over || this.total === 0) return null;
    // ⚠ 丁度の大きさの buffer にする(transfer で渡すので、余りを運ばない)
    const out = new Uint8Array(this.total);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    this.parts.length = 0;
    return out;
  }

  /** 超えて止めたか。 */
  get exceeded(): boolean {
    return this.over;
  }
}

/** DuckDB へ写す型。 */
export type DuckDbColumnType = 'BIGINT' | 'DOUBLE' | 'VARCHAR';

/**
 * 🔴 **宣言の型 → DuckDB の型**(写し表はここ 1 か所)。
 *
 * sqlite の型の決め方(型の字に含まれる語で決まる)に沿う:
 *
 * | 宣言に含まれる語 | DuckDB |
 * |---|---|
 * | `INT` / `BOOL` | `BIGINT`(sqlite の真偽は 0 / 1 の整数) |
 * | `REAL` / `FLOA` / `DOUB` / `DECIMAL` / `NUMERIC` | `DOUBLE` |
 * | それ以外(`TEXT` / `CHAR` / `BLOB` / 型なし / `DATE` / `JSON` …) | `VARCHAR` |
 *
 * ⚠ **`DATE` / `DATETIME` を日付型へ写さない** ── sqlite は日付を文字列で持つので、
 *   写すと**書き方の揺れた行**で落ちる。VARCHAR なら `CAST` で自分で選べる。
 * ⚠ **BLOB は VARCHAR**(base64 の字で入る ── このファイル冒頭の表)。
 */
export function duckDbColumnTypeOf(declared: string): DuckDbColumnType {
  const t = declared.toUpperCase();
  if (t.includes('INT') || t.includes('BOOL')) return 'BIGINT';
  if (
    t.includes('REAL') ||
    t.includes('FLOA') ||
    t.includes('DOUB') ||
    t.includes('DECIMAL') ||
    t.includes('NUMERIC')
  ) {
    return 'DOUBLE';
  }
  return 'VARCHAR';
}

/** 列の型の決め方。`allText` = 型が合わなかった表を作り直すときの全列 VARCHAR。 */
function typeFor(col: SqliteExportColumn, allText: boolean): DuckDbColumnType {
  return allText ? 'VARCHAR' : duckDbColumnTypeOf(col.type);
}

/**
 * 🔴 **空の表も列を持つように、宣言から表を作る 1 文**。
 * ⚠ `CREATE OR REPLACE` ── 前の回が途中で落ちたとき、同じ器でやり直しても**同じ結果**になる。
 * ⚠ 名前は**元のまま引用して**作る(`売上` のまま引ける / 空白や記号が在っても作れる)。
 */
export function createTableSql(
  table: string,
  columns: readonly SqliteExportColumn[],
  allText = false,
): string {
  const cols = columns.map((c) => `${quoteIdent(c.name)} ${typeFor(c, allText)}`).join(', ');
  return `CREATE OR REPLACE TABLE ${quoteIdent(table)} (${cols})`;
}

/**
 * 🔴 **NDJSON の file から行を入れる 1 文**。
 *
 * 🔑 **`read_json_auto` ではなく、列と型を明示した `read_json`** ── 推定に任せると、
 *   ①先頭の一部(既定は 2 万行)だけを見て型を決めるので、**後ろの行で型が合わなくなって落ちる**
 *   (sqlite の列は行ごとに型が違いうる)②文字列が**日付へ化ける**
 *   (`2024-01-01T10:00:00` が `2024-01-01 10:00:00` になる)── どちらも実測で確かめた
 *   (列の型を渡せば、書いた型のまま入る)。
 */
export function insertFromNdjsonSql(
  table: string,
  file: string,
  columns: readonly SqliteExportColumn[],
  allText = false,
): string {
  const cols = columns.map((c) => `${sqlStr(c.name)}: ${sqlStr(typeFor(c, allText))}`).join(', ');
  return (
    `INSERT INTO ${quoteIdent(table)} SELECT * FROM read_json(${sqlStr(file)}, ` +
    `format='newline_delimited', columns={${cols}})`
  );
}

/**
 * 写せなかった表の理由を、画面へ出す 1 文にする(`name` は user が打つ表の名前)。
 *
 * @param hint 逃げ道の 1 文(`sqliteFallbackHint`)。⚠ 省けば添えない。
 */
export function refusedNote(name: string, why: string, hint = ''): string {
  // 🔑 名前が空の表(sqlite は許す)も、何の表か分かる字で言う
  return `${name === '' ? '(名前の無い表)' : name} は DuckDB に読み込めませんでした(${why}${hint === '' ? '' : `。${hint}`})`;
}
