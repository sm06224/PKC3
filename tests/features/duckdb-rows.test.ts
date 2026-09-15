/**
 * 🔴 **DuckDB の返り値を揃える**(#682 段②)。
 *
 * ⚠ 台は**実測した形**から組む(2026-09-15、実ブラウザの probe)── 想像した形で
 *   組むと、実物が別の形で来た日に**通っているのに化ける**。
 * 🔑 実測で分かった「自分の初稿が間違っていた」2 つを、名指しで守る:
 *   ① 多倍長は**器の `toString()` が正しい**(自分で 32bit を組むと scale を落とす)
 *   ② 日付は**ただの数(ミリ秒)**で返る ── 型を見ないと見分けられない
 */
import { describe, expect, it } from 'vitest';
import { duckDbTable, limbsToBigInt, normalizeDuckDbValue } from '@features/query/duckdb-rows';

/** 実測どおりの多倍長の器 ── `[object Uint32Array]` だが `toString()` が 10 進を返す。 */
function bignum(decimal: string, limbs: number[]): Uint32Array {
  const v = new Uint32Array(limbs);
  // ⚠ 器の側が持つ `toString` を真似る(Arrow が実際にこうしている)
  Object.defineProperty(v, 'toString', { value: () => decimal });
  return v;
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

  it('🔴 多倍長は器の字を使う ── 自分で組み直すと小数点を落とす', () => {
    // 実測:`HUGEINT` の 30 桁が 1 桁も落ちずに返る
    const huge = bignum('123456789012345678901234567890', [0, 0, 0, 0]);
    expect(normalizeDuckDbValue(huge)).toBe('123456789012345678901234567890');
    // 🔴 `DECIMAL(n, s)` ── 器は小数点を知っている。組み直す実装はここで化ける
    const money = bignum('12.34', [1234, 0, 0, 0]);
    expect(normalizeDuckDbValue(money)).toBe(12.34);
    // ⚠ 空振り防止 ── 32bit を組み直すと 1234 になっていた
    expect(limbsToBigInt(new Uint32Array([1234, 0, 0, 0]))).toBe(1234n);
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
