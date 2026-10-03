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
 * storage worker が返す「表 1 つ分の写し」。
 *
 * ⚠ `ndjson` が `null` の理由は 2 つ ── ①行が 0 件(空の表)②断った(`refused` が非 null)。
 *   🔑 見分けは `refused`(空の表は**写せている**ので `refused` は `null`)。
 */
export interface SqliteExportedTable {
  readonly name: string;
  readonly columns: readonly SqliteExportColumn[];
  /** 行を 1 つずつ JSON にして改行で繋いだ bytes(UTF-8)。 */
  readonly ndjson: Uint8Array | null;
  readonly rows: number;
  /** 写せなかった理由の字(表の名前を含まない ── 呼び側が最終の名前を前置する)。`null` = 写せた。 */
  readonly refused: string | null;
}

/** 天井を超えた理由(字)。⚠ 表の名前は含めない。 */
export function tooBigReason(maxBytes: number): string {
  // 🔑 大きさの綴りは `humanBytes` 1 本(自前で単位を付けない ── `human-bytes.test.ts` が全数で見る)
  return `行の写しが ${humanBytes(maxBytes)} を超えました。内蔵の sqlite なら引けます`;
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

/** 一度に符号化する行数(小さすぎると呼び出しが増え、大きすぎると一時の字が膨らむ)。 */
const ENCODE_BATCH_ROWS = 1000;

/**
 * 🔴 **天井つきの組み立て**。
 *
 * ⚠ **巨大な 1 本の字を作らない** ── 行を小分けにして符号化し、bytes を積む
 *   (字の長さの上限で落ちる形にしない)。⚠ 超えたら**そこで読むのをやめる**
 *   (`push` が `false` を返す)── 天井を超えるとわかってから全行を読み切らない。
 * 🔑 数えるのは**符号化した後の bytes**(= 実際に運ぶ量)。字数ではない。
 */
export class NdjsonCollector {
  private readonly parts: Uint8Array[] = [];
  private pending: string[] = [];
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
    this.rows += 1;
    if (this.pending.length >= ENCODE_BATCH_ROWS) this.flush();
    return !this.over;
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const u = this.enc.encode(this.pending.join('\n') + '\n');
    this.pending = [];
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

/** 写せなかった表の理由を、画面へ出す 1 文にする(`name` は user が打つ表の名前)。 */
export function refusedNote(name: string, why: string): string {
  return `${name} は DuckDB へ写せませんでした(${why})`;
}
