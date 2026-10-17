/**
 * 🔴 **DuckDB が返した値を、画面と書き出しが扱える形へ揃える**(#682 段②)。
 *
 * ## なぜ「境界で揃える」のが要るのか
 *
 * 🔴 **実測**(2026-09-15、実ブラウザ / `@duckdb/duckdb-wasm@1.33.1-dev57.0`)──
 * 1 文で 12 列を返させ、`typeof` と `Object.prototype.toString.call` と `String()` を採った:
 *
 * | 式 | `typeof` | 器 | `String(v)` |
 * |---|---|---|---|
 * | `count(*)` | 🔴 **bigint** | BigInt | `"10"` |
 * | `sum(k)` / `HUGEINT` | object | 🔴 **`[object Uint32Array]`** | 🔑 **`"45"` / 30 桁そのまま**(器が正しい 10 進を組む) |
 * | `avg(k)` | number | Number | `"4.5"` |
 * | `DATE` / `TIMESTAMP` | 🔴 **number** | Number | 🔴 **`"1789430400000"`**(ミリ秒) |
 * | `[1,2]`(LIST) | object | `[object IntVector<Int>]` | `"[1,2]"` |
 * | `{'x':1}`(STRUCT) | object | `[object Row]` | `'{"x": 1}'` |
 * | `NULL` | object | `[object Null]` | ── |
 * | `true` | boolean | Boolean | `"true"` |
 *
 * ⚠ sqlite 側(`runReadOnlySql`)が返すのは `string | number | null` だけである。
 * 🔴 **そのまま流すと、表の描画か書き出しが落ちるか、静かに化ける**:
 * - `JSON.stringify` は BigInt で**投げる**(書き出しが落ちる)
 * - 🔴 **日付が `1789430400000` と出る** ── 落ちないので**誰も気づかない**
 * - LIST / STRUCT を `JSON.stringify` すると中身が消える(器が Arrow の物なので)
 *
 * 🔑 だから**ここ 1 か所**で揃える ── 描画・書き出し・ノート化の 3 経路が
 *   別々に直すと、直し忘れた経路だけが化ける(CLAUDE.md §7)。
 *
 * ## 🔴 `castBigIntToDouble` / `castDecimalToDouble` を使わない(測って決めた)
 *
 * 上流には「開くときに double へ倒す」設定が在り、**実際に効いた**。
 * ⚠ ところが同じ実測で **HUGEINT が `"1.2345678901234568e+29"` になった** ──
 *   30 桁が**静かに 17 桁へ落ちる**。🔑 だから**倒さずに、こちらで揃える**。
 *
 * ## 🔑 多倍長の「整数部分」は器に聞き、小数点は型の字から入れる
 *
 * ⚠ 初稿は 32bit を 4 つ並べて自分で組んでいたが、それだと **`DECIMAL(n, s)` の
 *   小数点(scale)を落とす**(器は scale を知っていて、こちらは知らない)。
 * 🔴 **ところが器の `toString()` も scale を入れない**(2026-10-17 に実エンジンで再測定)──
 *   返るのは **スケール前の整数**(`SELECT 12.50` → 型 `Decimal[4e+2]`、`toString()` = `"1250"`)。
 *   「器が小数点を知っている」と信じて流すと **10^scale 倍の値が画面に出る**(`0.1+0.2` が `3`)。
 * 🔑 だから **scale は列の型の字(`Decimal[<精度>e<+scale>]`)から読み**、
 *   整数の字の右から scale 桁目に小数点を入れる(`Number` を経由しない ── 浮動小数点の誤差を作らない)。
 *   組み直すのは、器が素の並び(`"1,0,0,0"`)しか返さなかったときだけ。
 *
 * ## 🔴 日付・時刻の「時差」と TIME / INTERVAL(2026-10-17、実エンジンで再測定)
 *
 * - `TIMESTAMP`(型 `Timestamp<MICROSECOND>`)と `DATE` は **壁時計の時刻をそのまま UTC の ms にした値**で返る
 *   ── 端末の時差を足して読むと **JST で 10:00 が 19:00 になる**。だから **UTC の getter で読む**。
 *   `TIMESTAMPTZ`(型 `Timestamp<MICROSECOND, UTC>`)は本物の時刻なので、端末の時刻で見せる。
 * - `TIME`(型 `Time64<MICROSECOND>`)は **µs の整数**で返る(`36000000000` = 10:00:00)。
 * - `INTERVAL`(型 `Interval<MONTH_DAY_NANO>`)は Arrow の読み手が **月しか読めない**(日と時間が落ちる)。
 *   だから呼び側(`duckdb-open.ts`)が列の素の 16 byte から `[月, 日, ns 下位, ns 上位]` の
 *   `Int32Array` を組み、ここで読める字にする。
 */
import { capCellText } from './sql-cell';

/** DuckDB から生で返る 1 枚。⚠ 列は**schema から**採る(0 行でも列が消えない)。 */
export interface DuckDbRaw {
  readonly columns: readonly string[];
  /**
   * 🔴 **列の型の字**(`String(field.type)`。実測 `Date32<DAY>` / `Timestamp<MICROSECOND>` /
   *   `Decimal[38e0]` / `Utf8` …)。
   * ⚠ **これが無いと日付を日付と見分けられない** ── 値はただの数(ミリ秒)で返るので、
   *   型を見ずに流すと `1789430400000` が画面に出る(落ちないので誰も気づかない)。
   * ⚠ 長さは `columns` と揃う。揃っていない分は「型を知らない」として扱う。
   */
  readonly types: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}

/** 揃えた後の 1 枚。⚠ sqlite 側(`runReadOnlySql`)と**同じ形**にする。 */
export interface DuckDbTable {
  readonly columns: string[];
  readonly rows: Array<Array<string | number | null>>;
}

/**
 * 🔴 **4 つに割れた 32bit を 1 つの整数へ戻す**(little-endian、符号つき)。
 *
 * ⚠ DuckDB の `HUGEINT` / `DECIMAL` / 整数の `sum()` は 128bit なので、
 *   JS には**32bit 4 つの並び**で渡ってくる。
 * ⚠ **符号を忘れない** ── 最上位の bit が立っていれば負である
 *   (忘れると、負の合計が**巨大な正の数**になる ── いちばん静かな化け方)。
 */
export function limbsToBigInt(limbs: ArrayLike<number>): bigint {
  let v = 0n;
  for (let i = limbs.length - 1; i >= 0; i -= 1) {
    v = (v << 32n) | BigInt((limbs[i] ?? 0) >>> 0);
  }
  const bits = BigInt(limbs.length) * 32n;
  // ⚠ 2 の補数 ── 上位 bit が立っていたら、桁数ぶん引く
  return v >= 1n << (bits - 1n) ? v - (1n << bits) : v;
}

/**
 * 整数を、**桁を落とさずに**画面へ出せる形にする。
 *
 * 🔑 `Number` に収まるものは `number`(右寄せ・並べ替え・書き出しが数として効く)、
 *   収まらないものは **`string`**(⚠ `Number` にすると**静かに桁が落ちる**)。
 */
function fromBigInt(v: bigint): string | number {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
}

/** 2 桁に揃える(日付の字を組むため)。 */
const p2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 🔴 **スケール前の整数に、小数点を入れる**(`DECIMAL(n, s)`)。
 *
 * ⚠ `Number` を経由しない ── `0.1 + 0.2` 型の誤差と、17 桁を超える桁落ちを作らない。
 * ⚠ 先頭の 0 を補う(`5` / scale 2 → `0.05`)。符号は数の頭に 1 つだけ。
 */
function withScale(v: bigint, scale: number): string {
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(scale + 1, '0');
  const cut = digits.length - scale;
  return `${neg ? '-' : ''}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

/** 型の字 `Decimal[<精度>e<+scale>]` から scale を読む(実測:`Decimal[4e+2]` / `Decimal[38e0]`)。 */
function decimalScale(type: string): number {
  const m = /^Decimal\[\d+e([+-]?\d+)\]$/.exec(type);
  const n = m?.[1] === undefined ? 0 : Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * 🔴 **器が組んだ 10 進の字を受け取る**(多倍長 / 小数)。
 *
 * ⚠ 素の型付き配列の `toString()` は **`"1,0,0,0"`** のように `,` で繋ぐ ──
 *   それが来たら「器は組んでいない」ので、こちらで組み直す。
 * 🔑 実測では `sum()` も `HUGEINT` も **`,` を含まない正しい 10 進**を返した。
 * 🔴 `DECIMAL` は **スケール前の整数**が返る(小数点は無い)── 型の字の scale で入れる(`withScale`)。
 */
function fromLimbedNumber(v: ArrayLike<number> & { toString(): string }, type: string): string | number {
  const s = v.toString();
  const n = /^-?\d+$/.test(s) ? BigInt(s) : limbsToBigInt(v);
  const scale = decimalScale(type);
  return scale > 0 ? withScale(n, scale) : fromBigInt(n);
}

/**
 * 🔴 **日付・時刻の列を読める字にする**。
 *
 * ⚠ 値は**ただの数(ミリ秒)**で返る(実測)ので、**列の型を見ないと見分けられない**。
 * ⚠ `Date32` は日だけなので、時刻を足さない。
 * 🔴 **時差の扱いは型で決まる**:タイムゾーンを持たない `Timestamp` / `Date` は
 *   **壁時計の時刻が UTC の ms として返る**ので UTC の getter で読む(端末の getter で読むと、
 *   JST で 10:00 が 19:00、西側の時差では DATE が前の日になる)。
 *   型の字に `, <tz>` が付く `Timestamp<MICROSECOND, UTC>`(`TIMESTAMPTZ`)は本物の時刻なので端末の時刻で見せる。
 */
function fromEpochMs(ms: number, type: string): string | number {
  if (!Number.isFinite(ms)) return ms;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return ms;
  const isDate = type.startsWith('Date');
  const utc = isDate || !/^Timestamp<[A-Z]+,/.test(type);
  const Y = utc ? d.getUTCFullYear() : d.getFullYear();
  const M = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
  const D = utc ? d.getUTCDate() : d.getDate();
  const day = `${String(Y).padStart(4, '0')}-${p2(M)}-${p2(D)}`;
  if (isDate) return day;
  const h = utc ? d.getUTCHours() : d.getHours();
  const mi = utc ? d.getUTCMinutes() : d.getMinutes();
  const se = utc ? d.getUTCSeconds() : d.getSeconds();
  return `${day} ${p2(h)}:${p2(mi)}:${p2(se)}`;
}

/** `HH:MM:SS`(端数があれば `.ffffff`)。`ns` は負でない整数ナノ秒。 */
function clockOfNs(ns: bigint): string {
  const sec = ns / 1_000_000_000n;
  const frac = ns % 1_000_000_000n;
  const h = sec / 3600n;
  const hh = h < 100n ? p2(Number(h)) : h.toString();
  const base = `${hh}:${p2(Number((sec / 60n) % 60n))}:${p2(Number(sec % 60n))}`;
  if (frac === 0n) return base;
  // µs 精度(6 桁)で足りるなら 6 桁、ns まで要るなら 9 桁
  const f9 = frac.toString().padStart(9, '0');
  return `${base}.${f9.endsWith('000') ? f9.slice(0, 6) : f9}`;
}

const TIME_UNIT_NS: Readonly<Record<string, bigint>> = {
  SECOND: 1_000_000_000n,
  MILLISECOND: 1_000_000n,
  MICROSECOND: 1_000n,
  NANOSECOND: 1n,
};

/** 型の字 `Time64<MICROSECOND>`(`Time32<…>`)の単位。DuckDB の `TIME` は `Time64<MICROSECOND>`(実測)。 */
function timeUnitNs(type: string): bigint | null {
  const m = /^Time(?:32|64)<([A-Z]+)>$/.exec(type);
  return m?.[1] === undefined ? null : (TIME_UNIT_NS[m[1]] ?? null);
}

/**
 * 🔴 **`INTERVAL` を読める字にする**(`5 months` / `3 days 02:00:00`)。
 * `m` は `[月, 日, ns 下位, ns 上位]`(`duckdb-open.ts` が列の素の 16 byte から組む)。
 */
function fromIntervalLimbs(m: ArrayLike<number>): string {
  const months = m[0] ?? 0;
  const days = m[1] ?? 0;
  const ns = (BigInt(m[3] ?? 0) << 32n) | BigInt((m[2] ?? 0) >>> 0);
  const parts: string[] = [];
  const years = Math.trunc(months / 12);
  const restMonths = months % 12;
  if (years !== 0) parts.push(`${String(years)} ${Math.abs(years) === 1 ? 'year' : 'years'}`);
  if (restMonths !== 0) parts.push(`${String(restMonths)} ${Math.abs(restMonths) === 1 ? 'month' : 'months'}`);
  if (days !== 0) parts.push(`${String(days)} ${Math.abs(days) === 1 ? 'day' : 'days'}`);
  if (ns !== 0n) parts.push(`${ns < 0n ? '-' : ''}${clockOfNs(ns < 0n ? -ns : ns)}`);
  return parts.length === 0 ? '00:00:00' : parts.join(' ');
}

/** その列は日付・時刻か。⚠ 実測した型の字(`Date32<DAY>` / `Timestamp<MICROSECOND>`)に当てる。 */
function isTimeType(type: string): boolean {
  return type.startsWith('Date') || type.startsWith('Timestamp');
}

/**
 * 1 つの値を揃える。
 *
 * @param type 列の型の字(`String(field.type)`)。⚠ 空文字 = 知らない。
 *
 * ⚠ **判定の順番に意味がある** ── `Uint8Array`(BLOB)と多倍長の器はどちらも
 *   型付き配列なので、**器の種類で先に分ける**。混ぜると、合計が
 *   「(バイナリ 16 byte)」になる(静かな化け方)。
 */
export function normalizeDuckDbValue(v: unknown, type = ''): string | number | null {
  if (v === null || v === undefined) return null;
  const unitNs = timeUnitNs(type);
  if (unitNs !== null && (typeof v === 'number' || typeof v === 'bigint')) {
    // 🔴 TIME は µs の整数で返る ── そのまま出すと `36000000000`
    const ns = BigInt(v) * unitNs;
    return ns < 0n ? `-${clockOfNs(-ns)}` : clockOfNs(ns);
  }
  if (typeof v === 'bigint') return fromBigInt(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    return isTimeType(type) ? fromEpochMs(v, type) : v;
  }
  if (typeof v === 'string') return v;
  /**
   * ⚠ **真偽は字にする** ── sqlite は 1 / 0 を返すが、DuckDB は `true` / `false` を
   *   返す。数に潰すと、画面で「1」が**数えた結果なのか真偽なのか**読めなくなる。
   */
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) {
    // ⚠ ISO の `T` と `Z` を出さない ── 画面に出る字なので、そのまま読める形にする
    return `${v.getFullYear()}-${p2(v.getMonth() + 1)}-${p2(v.getDate())} ${p2(v.getHours())}:${p2(v.getMinutes())}:${p2(v.getSeconds())}`;
  }
  /**
   * 🔴 **BLOB は中身を運ばない**(sqlite 側と同じ規律)── 画面に出しても読めないし、
   *   heap に載せる理由が無い(2026-07-27 の不可侵指示)。
   */
  if (v instanceof Uint8Array || v instanceof Int8Array || v instanceof Uint8ClampedArray) {
    return `(バイナリ ${v.byteLength} byte)`;
  }
  // 🔴 INTERVAL は 4 つの 32bit(月 / 日 / ns 下位 / ns 上位)── 多倍長と取り違えない
  if (type.startsWith('Interval')) {
    return v instanceof Int32Array && v.length === 4 ? fromIntervalLimbs(v) : '(読み取れない間隔)';
  }
  if (v instanceof Uint32Array || v instanceof Int32Array) return fromLimbedNumber(v, type);
  if (Array.isArray(v)) return safeJson(v);
  if (typeof v === 'object') {
    /**
     * 🔑 **まず器に聞く**(実測:LIST は `"[1,2]"`、STRUCT は `'{"x": 1}'` を返す)──
     *   Arrow の器を `JSON.stringify` に掛けると**中身が消える**ので、
     *   自前で組むより器の字のほうが正しい。
     * ⚠ 器が何も組んでいない(`[object Object]`)ときだけ、自前の JSON へ落とす。
     */
    const s = String(v);
    if (!/^\[object [A-Za-z]+\]$/.test(s)) return s;
    /**
     * ⚠ **`{"0":…,"1":…}` の形で来ることがある**(型付き配列が素の object へ
     *   写された経路 ── `postMessage` や `structuredClone` を跨ぐと起きる)。
     *   数の key だけで埋まっていれば、多倍長として読む。
     */
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length > 0 && keys.every((k, i) => k === String(i) && typeof o[k] === 'number')) {
      return fromBigInt(limbsToBigInt(keys.map((k) => o[k] as number)));
    }
    return safeJson(v);
  }
  return String(v);
}

/**
 * ⚠ `JSON.stringify` は **BigInt で投げる**ので、包んでから当てる。
 * ⚠ 投げた回も**落とさない** ── 画面の 1 升のために表ごと消さない。
 */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)) ?? '';
  } catch {
    return String(v);
  }
}

/**
 * 1 枚まるごと揃える。
 *
 * 🔴 **長い字は畳む**(#682 段④d の着地後レビュー)── 内蔵の sqlite の道(`cellForWire`)と**同じ上限・同じ書き方**
 *   (`sql-cell.ts`)。⚠ 直す前は素通しで、BLOB(base64 で入る)や長い本文の 1 行が**そのまま画面と書き出しへ
 *   渡っていた**(同じ `.sqlite` を内蔵の sqlite で引くと畳まれるのに、DuckDB では畳まれない)。
 * ⚠ 畳むのは**揃えた後**の字 ── 器が `toString()` で組んだ長い字(LIST / STRUCT の字)も同じ天井に当たる。
 */
export function duckDbTable(raw: DuckDbRaw): DuckDbTable {
  return {
    columns: [...raw.columns],
    rows: raw.rows.map((r) =>
      raw.columns.map((_c, i) => {
        const v = normalizeDuckDbValue(r[i], raw.types[i] ?? '');
        return typeof v === 'string' ? capCellText(v) : v;
      }),
    ),
  };
}
