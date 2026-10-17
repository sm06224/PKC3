/** @vitest-environment node */
/**
 * 🔴 **DuckDB の返り値を揃える**(#682 段②)。
 *
 * ⚠ 台は**実測した形**から組む(2026-09-15、実ブラウザの probe)── 想像した形で
 *   組むと、実物が別の形で来た日に**通っているのに化ける**。
 * 🔑 実測で分かった「自分の初稿が間違っていた」2 つを、名指しで守る:
 *   ① 多倍長の整数は**器の `toString()` が正しい**。⚠ ただし**スケール前の整数**で、小数点は入らない
 *      ── 2026-10-17 に実エンジンで再測定(`SELECT 12.50` → 型 `Decimal[4e+2]` / `toString()` = `"1250"`)。
 *      直す前はこの fake が `"12.34"` を返していて、**実物と違う器**で緑だった
 *   ② 日付は**ただの数(ミリ秒)**で返る ── 型を見ないと見分けられない
 *   ③ 時差の扱いは型で決まる:壁時計の `TIMESTAMP` / `DATE` は UTC の getter、`TIMESTAMPTZ` は端末の時刻
 */
import { describe, expect, it } from 'vitest';
import { duckDbTable, limbsToBigInt, normalizeDuckDbValue } from '@features/query/duckdb-rows';
import { MAX_CELL_CHARS } from '@features/query/sql-cell';

/**
 * 実測どおりの多倍長の器 ── `[object Uint32Array]` だが `toString()` が **スケール前の整数**を 10 進で返す。
 * ⚠ `DECIMAL(4,2)` の 12.50 でも `toString()` は `"1250"`(小数点は入らない ── 実エンジンで測定)。
 */
function bignum(unscaled: string, limbs: number[]): Uint32Array {
  const v = new Uint32Array(limbs);
  // ⚠ 器の側が持つ `toString` を真似る(Arrow が実際にこうしている)
  Object.defineProperty(v, 'toString', { value: () => unscaled });
  return v;
}

/** 整数を 128bit の 2 の補数で 4 つの 32bit に割る(エンジンが返す並び)。 */
function limbs128(n: bigint): number[] {
  const m = BigInt.asUintN(128, n);
  return [0, 1, 2, 3].map((i) => Number((m >> BigInt(32 * i)) & 0xffffffffn));
}

/** `tz` の下で `fn` を回し、必ず元へ戻す(`stored-date.test.ts` と同じ作法)。 */
function withTZ<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

describe('DuckDB の返り値を揃える', () => {
  it('🔴 実測した 1 行がそのまま読める(2026-09-15 の probe)', () => {
    const raw = {
      columns: ['a', 'b', 'c', 'd', 'e', 'f', 'i', 'j', 'k'],
      types: ['Int8', 'Int64', 'Decimal[38e0]', 'Float64', 'Utf8', 'Bool', 'Date32<DAY>', 'Timestamp<MICROSECOND>', 'Int32'],
      rows: [[1, 10n, bignum('45', [45, 0, 0, 0]), 4.5, 'あ', true, 1789430400000, 1789434123000, null]],
    };
    const t = duckDbTable(raw);
    expect(t.rows[0]?.slice(0, 6)).toEqual([1, 10, 45, 4.5, 'あ', 'true']);
    // 🔴 日付・時刻 ── 揃えないと `1789430400000` がそのまま画面に出る
    expect(String(t.rows[0]?.[6])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(t.rows[0]?.[7])).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(t.rows[0]?.[8]).toBe(null);
    // ⚠ 空振り防止 ── 型を見ない実装なら、日付はただの数のまま通っていた
    expect(normalizeDuckDbValue(1789430400000, '')).toBe(1789430400000);
  });

  it('🔴 多倍長の整数は器の字を使う(HUGEINT の 30 桁が落ちない)', () => {
    // 実測:`HUGEINT` の 30 桁が 1 桁も落ちずに返る
    const huge = bignum('123456789012345678901234567890', [0, 0, 0, 0]);
    expect(normalizeDuckDbValue(huge, 'Decimal[38e0]')).toBe('123456789012345678901234567890');
    // ⚠ 空振り防止 ── 32bit を組み直すと 1234 になっていた
    expect(limbsToBigInt(new Uint32Array([1234, 0, 0, 0]))).toBe(1234n);
  });

  it('🔴 DECIMAL はスケール前の整数に、型の字の scale で小数点を入れる(実エンジンの値 2026-10-17)', () => {
    // `SELECT 12.50` → 型 `Decimal[4e+2]`、器の toString() は "1250"(小数点なし)
    expect(normalizeDuckDbValue(bignum('1250', limbs128(1250n)), 'Decimal[4e+2]')).toBe('12.50');
    // `SELECT 0.1+0.2` → `Decimal[3e+1]`、"3"。直す前は `3`(10 倍)と出た
    expect(normalizeDuckDbValue(bignum('3', limbs128(3n)), 'Decimal[3e+1]')).toBe('0.3');
    // 先頭の 0 を補う(0.05)/ 負(符号は頭に 1 つ)/ 負で 1 より小さい
    expect(normalizeDuckDbValue(bignum('5', limbs128(5n)), 'Decimal[10e+2]')).toBe('0.05');
    expect(normalizeDuckDbValue(bignum('-725', limbs128(-725n)), 'Decimal[38e+2]')).toBe('-7.25');
    expect(normalizeDuckDbValue(bignum('-5', limbs128(-5n)), 'Decimal[38e+2]')).toBe('-0.05');
    expect(normalizeDuckDbValue(bignum('0', limbs128(0n)), 'Decimal[4e+2]')).toBe('0.00');
    // 桁を落とさない(17 桁を超えても Number を経由しない)
    expect(normalizeDuckDbValue(bignum('1234567890123456789012', limbs128(1234567890123456789012n)), 'Decimal[38e+2]')).toBe(
      '12345678901234567890.12',
    );
    // scale 0 は今までどおり整数(右寄せ・数として扱える)
    expect(normalizeDuckDbValue(bignum('45', limbs128(45n)), 'Decimal[38e0]')).toBe(45);
    // 器が組んでいない素の並びでも、scale は入る
    expect(normalizeDuckDbValue(new Uint32Array(limbs128(1250n)), 'Decimal[4e+2]')).toBe('12.50');
    expect(normalizeDuckDbValue(new Uint32Array(limbs128(-725n)), 'Decimal[38e+2]')).toBe('-7.25');
  });

  it('器が何も組んでいない型付き配列は、32bit を並べて読む', () => {
    // ⚠ 素の `Uint32Array` の `toString()` は `,` で繋ぐ ── そこで組み直しへ落ちる
    expect(String(new Uint32Array([5, 0, 0, 0]))).toBe('5,0,0,0');
    expect(normalizeDuckDbValue(new Uint32Array([5, 0, 0, 0]))).toBe(5);
    // 🔴 上位 bit が立っていれば負(忘れると、負の合計が巨大な正の数になる)
    expect(limbsToBigInt(new Uint32Array([0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff]))).toBe(-1n);
    expect(limbsToBigInt(new Uint32Array([0xfffffff6, 0xffffffff, 0xffffffff, 0xffffffff]))).toBe(-10n);
  });

  it('postMessage を跨いで素の object になった多倍長も読む', () => {
    // 実測の log に出た字そのもの(`sum(k)` が 4 つに割れた形)
    expect(normalizeDuckDbValue({ 0: 49950000, 1: 0, 2: 0, 3: 0 })).toBe(49950000);
    // ⚠ 空振り防止 ── 揃えずに字にすると読めない字だった
    expect(String({ 0: 49950000, 1: 0, 2: 0, 3: 0 })).toBe('[object Object]');
  });

  it('🔴 桁が落ちる整数は字にする(静かに化けさせない)', () => {
    expect(normalizeDuckDbValue(9007199254740991n)).toBe(9007199254740991);
    expect(normalizeDuckDbValue(9007199254740993n)).toBe('9007199254740993');
    // ⚠ 空振り防止 ── `Number` に潰していたら、この 2 つは同じ値になっていた
    expect(Number(9007199254740993n)).toBe(9007199254740992);
  });

  it('🔴 BLOB と多倍長を取り違えない', () => {
    expect(normalizeDuckDbValue(new Uint8Array([1, 2, 3]))).toBe('(バイナリ 3 byte)');
    expect(normalizeDuckDbValue(new Uint32Array([5, 0, 0, 0]))).toBe(5);
  });

  it('LIST / STRUCT は器が組んだ字を使う', () => {
    // 実測:`String(v)` が `"[1,2]"` / `'{"x": 1}'` を返す(Arrow の器)
    const list = { toString: () => '[1,2]' };
    expect(normalizeDuckDbValue(list)).toBe('[1,2]');
    // ⚠ 器が何も組んでいなければ、自前の JSON へ落ちる
    expect(normalizeDuckDbValue({ x: 1 })).toBe('{"x":1}');
    // ⚠ 素の `JSON.stringify` は BigInt で投げる(書き出しが落ちる形)
    expect(() => JSON.stringify([1n])).toThrow();
    expect(normalizeDuckDbValue([1n])).toBe('["1"]');
  });

  it('数でない数(NaN / Infinity)は字にする', () => {
    expect(normalizeDuckDbValue(Number.NaN)).toBe('NaN');
    expect(normalizeDuckDbValue(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(normalizeDuckDbValue(1.5)).toBe(1.5);
    // ⚠ 日付の列に数でない数が来ても落とさない
    expect(normalizeDuckDbValue(Number.NaN, 'Date32<DAY>')).toBe('NaN');
  });

  it('🔴 0 行でも列が消えない(schema から採るので)', () => {
    const t = duckDbTable({ columns: ['a', 'b'], types: ['Utf8', 'Int32'], rows: [] });
    expect(t.columns).toEqual(['a', 'b']);
    expect(t.rows).toEqual([]);
  });

  it('行の長さは列に揃う(足りない升は null)', () => {
    const t = duckDbTable({ columns: ['a', 'b', 'c'], types: [], rows: [[1]] });
    expect(t.rows[0]).toEqual([1, null, null]);
  });
});

/**
 * 🔴 **長い字は畳む**(#682 段④d の着地後レビュー D2)── 内蔵の sqlite の道(storage worker の `cellForWire`)と
 *   **同じ上限・同じ書き方**。直す前は素通しで、同じ `.sqlite` の同じ 1 行が engine を替えただけで画面を埋めた。
 */
describe('🔴 DuckDB の答えの升は、内蔵の sqlite と同じ上限で畳む', () => {
  it('🔴 上限を超えた字は 2000 字で切り、全部で何字あったかを言う', () => {
    const long = 'あ'.repeat(5000);
    const t = duckDbTable({ columns: ['t'], types: ['Utf8'], rows: [[long]] });
    expect(t.rows[0]?.[0]).toBe(`${'あ'.repeat(MAX_CELL_CHARS)}…(全 5000 字)`);
    expect(MAX_CELL_CHARS, '内蔵の sqlite と同じ上限').toBe(2000);
  });

  it('🔴 BLOB(base64 の字で入る)も同じ。1 MB の BLOB が 1.3 MB の字のまま画面へ渡らない', () => {
    const base64 = 'QUJD'.repeat(350_000);
    const t = duckDbTable({ columns: ['b'], types: ['Utf8'], rows: [[base64]] });
    const cell = String(t.rows[0]?.[0]);
    expect(cell.length, '畳まれていない').toBeLessThan(2100);
    expect(cell).toContain(`…(全 ${String(base64.length)} 字)`);
  });

  it('対照群:ちょうど上限は切らない / 数や null は触らない / 器が組んだ長い字(LIST)も畳む', () => {
    const exact = 'x'.repeat(MAX_CELL_CHARS);
    const t = duckDbTable({
      columns: ['a', 'b', 'c', 'd'],
      types: ['Utf8', 'Int32', 'Utf8', ''],
      rows: [[exact, 5, null, { toString: () => `[${'1,'.repeat(3000)}]` }]],
    });
    expect(t.rows[0]?.[0]).toBe(exact);
    expect(t.rows[0]?.[1]).toBe(5);
    expect(t.rows[0]?.[2]).toBeNull();
    expect(String(t.rows[0]?.[3]), '器が組んだ字が畳まれていない').toContain('…(全 ');
  });
});

describe('🔴 日付・時刻は型で時差の扱いが決まる(2026-10-17、実エンジンの値)', () => {
  // `TIMESTAMP '2026-01-01 10:00:00'` は壁時計の 10:00 が UTC の ms で返る(実エンジン)
  const wall = Date.UTC(2026, 0, 1, 10, 0, 0);

  it('⚠ 対照群 ── TZ の切り替えが効いていること(効いていなければ以下は空振り)', () => {
    expect(withTZ('Asia/Tokyo', () => new Date(wall).getHours())).toBe(19);
    expect(withTZ('UTC', () => new Date(wall).getHours())).toBe(10);
  });

  it('🔴 TIMESTAMP(タイムゾーン無し)は端末の時差に関係なく壁時計のまま', () => {
    for (const tz of ['Asia/Tokyo', 'UTC', 'America/Los_Angeles']) {
      withTZ(tz, () => {
        expect(normalizeDuckDbValue(wall, 'Timestamp<MICROSECOND>'), tz).toBe('2026-01-01 10:00:00');
      });
    }
  });

  it('🔴 DATE は西側の時差でも前の日にならない', () => {
    withTZ('America/Los_Angeles', () => {
      expect(normalizeDuckDbValue(Date.UTC(2026, 0, 1), 'Date32<DAY>')).toBe('2026-01-01');
    });
    withTZ('Asia/Tokyo', () => {
      expect(normalizeDuckDbValue(Date.UTC(2026, 0, 1), 'Date32<DAY>')).toBe('2026-01-01');
    });
  });

  it('TIMESTAMPTZ(型の字に ", UTC" が付く)は本物の時刻なので端末の時刻で見せる', () => {
    withTZ('Asia/Tokyo', () => {
      expect(normalizeDuckDbValue(wall, 'Timestamp<MICROSECOND, UTC>')).toBe('2026-01-01 19:00:00');
    });
    withTZ('UTC', () => {
      expect(normalizeDuckDbValue(wall, 'Timestamp<MICROSECOND, UTC>')).toBe('2026-01-01 10:00:00');
    });
  });
});

describe('🔴 TIME と INTERVAL は読める字にする(2026-10-17、実エンジンの値)', () => {
  it('TIME は µs の整数で返る ── HH:MM:SS(端数があれば .ffffff)', () => {
    expect(normalizeDuckDbValue(36000000000, 'Time64<MICROSECOND>')).toBe('10:00:00');
    expect(normalizeDuckDbValue(36000123456, 'Time64<MICROSECOND>')).toBe('10:00:00.123456');
    expect(normalizeDuckDbValue(0, 'Time64<MICROSECOND>')).toBe('00:00:00');
    expect(normalizeDuckDbValue(86399999999n, 'Time64<MICROSECOND>')).toBe('23:59:59.999999');
    // ⚠ 空振り防止 ── 型を見ない実装なら数のまま
    expect(normalizeDuckDbValue(36000000000, '')).toBe(36000000000);
  });

  it('INTERVAL は [月, 日, ns 下位, ns 上位] を読める字にする', () => {
    const t = 'Interval<MONTH_DAY_NANO>';
    expect(normalizeDuckDbValue(Int32Array.from([5, 0, 0, 0]), t)).toBe('5 months');
    expect(normalizeDuckDbValue(Int32Array.from([0, 3, 1634811904, 1676]), t)).toBe('3 days 02:00:00');
    expect(normalizeDuckDbValue(Int32Array.from([14, 3, 531978496, 3424]), t)).toBe('1 year 2 months 3 days 04:05:06.500000');
    expect(normalizeDuckDbValue(Int32Array.from([0, -1, 0, 0]), t)).toBe('-1 day');
    expect(normalizeDuckDbValue(Int32Array.from([0, 0, 0, 0]), t)).toBe('00:00:00');
    // 読めない形は数字を作らず、安全な字にする(多倍長として読まない)
    expect(normalizeDuckDbValue(Int32Array.from([0, 0]), t)).toBe('(読み取れない間隔)');
  });
});
