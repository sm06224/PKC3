/**
 * 🔴 **試し用の `.parquet` を、その場で組む**(#682 段④c)。
 *
 * ## なぜ「拾ってくる」ではなく「組む」のか
 *
 * 🔑 `tests/features/xlsx-fixture.ts` と**同じ理由・同じ形**である ── 外から
 *   もらった binary を repo へ置くと、①由来と license を書き続けることになり
 *   ②**中身を変えたいときに作り直せない**。組めば、列も行も試す側が決められる。
 *
 * ⚠ **node では作れなかった**(実測 2026-09-16)。`@duckdb/duckdb-wasm` の node 版で
 *   `COPY … TO 'x.parquet'` を打つ道を試したが、`parquet` 拡張が
 *   **node の経路では読み込めない**(`INSTALL '<file>'` は通るのに `LOAD` が
 *   `need to see wasm magic number` で落ちる)── 段④b で測ったとおり、
 *   拡張が生きるのは**ブラウザで `custom_extension_repository` から取る道だけ**である。
 *   🔑 だから**自前で書く**。
 *
 * ## 組む範囲(必要十分)
 *
 * - 1 row group / 列ごとに **data page 1 枚**
 * - 符号化は **PLAIN**、圧縮は **無し**
 * - 列は root 直下の **REQUIRED** だけ ── だから定義レベルも繰り返しレベルも
 *   **1 バイトも書かない**(最大レベルが 0 のとき、parquet はレベルを持たない)
 * - 型は `INT32` と `BYTE_ARRAY`(UTF8)の 2 つ
 *
 * ⚠ **これは「読める最小の parquet」であって、書き出し器ではない** ── 統計・辞書・
 *   ページ索引・v2 ページは 1 つも書かない(読む側は全部 optional として扱う)。
 */

/** thrift compact の型番号(必要な物だけ)。 */
const TT = { I32: 5, I64: 6, BINARY: 8, LIST: 9, STRUCT: 12 } as const;

/** parquet の列の型。⚠ 値は thrift の enum そのもの。 */
const PHYS = { INT32: 1, BYTE_ARRAY: 6 } as const;
/** `BYTE_ARRAY` を「字」として読ませる印(ConvertedType.UTF8)。 */
const CONVERTED_UTF8 = 0;
/** FieldRepetitionType.REQUIRED。 */
const REQUIRED = 0;
/** Encoding.PLAIN / RLE。 */
const ENC_PLAIN = 0;
const ENC_RLE = 3;
/** CompressionCodec.UNCOMPRESSED / PageType.DATA_PAGE。 */
const UNCOMPRESSED = 0;
const DATA_PAGE = 0;

/**
 * thrift の compact protocol を書く。
 * ⚠ **field id は struct ごとに数え直す** ── 入れ子へ入ったら 0 から、出たら元へ戻す
 *   (ここを間違えると、読む側は**別の field として読む**ので、症状が遠くで出る)。
 */
class Compact {
  readonly out: number[] = [];
  private last = 0;
  private readonly stack: number[] = [];

  private uvarint(n: number): void {
    let v = n;
    while (v > 0x7f) {
      this.out.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    this.out.push(v & 0x7f);
  }

  /** zigzag(符号を下位ビットへ畳む)。⚠ 64bit も同じ規則で、`BigInt` で回す。 */
  private zigzag(n: number): void {
    let v = (BigInt(n) << 1n) ^ (BigInt(n) >> 63n);
    while (v > 0x7fn) {
      this.out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    this.out.push(Number(v));
  }

  /** ⚠ struct を値として持つ field は、呼び側がこれを打ってから `structStart()` する。 */
  header(id: number, type: number): void {
    const delta = id - this.last;
    if (delta > 0 && delta <= 15) this.out.push((delta << 4) | type);
    else {
      this.out.push(type);
      this.zigzag(id);
    }
    this.last = id;
  }

  structStart(): void {
    this.stack.push(this.last);
    this.last = 0;
  }

  structEnd(): void {
    this.out.push(0);
    this.last = this.stack.pop() ?? 0;
  }

  i32(id: number, v: number): void {
    this.header(id, TT.I32);
    this.zigzag(v);
  }

  i64(id: number, v: number): void {
    this.header(id, TT.I64);
    this.zigzag(v);
  }

  str(id: number, s: string): void {
    this.header(id, TT.BINARY);
    const b = new TextEncoder().encode(s);
    this.uvarint(b.length);
    for (const x of b) this.out.push(x);
  }

  listHeader(id: number, size: number, elemType: number): void {
    this.header(id, TT.LIST);
    if (size < 15) this.out.push((size << 4) | elemType);
    else {
      this.out.push(0xf0 | elemType);
      this.uvarint(size);
    }
  }

  /** list の中の要素は field header を持たない ── 値だけを並べる。 */
  listI32(v: number): void {
    this.zigzag(v);
  }

  listStr(s: string): void {
    const b = new TextEncoder().encode(s);
    this.uvarint(b.length);
    for (const x of b) this.out.push(x);
  }
}

/** 組みたい列 1 本。⚠ `values` の長さは全列で揃っていること。 */
export type ParquetColumn =
  | { readonly name: string; readonly type: 'int32'; readonly values: readonly number[] }
  | { readonly name: string; readonly type: 'utf8'; readonly values: readonly string[] };

function plainBytes(col: ParquetColumn): Uint8Array {
  const out: number[] = [];
  if (col.type === 'int32') {
    for (const v of col.values) {
      out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    }
    return new Uint8Array(out);
  }
  for (const v of col.values) {
    const b = new TextEncoder().encode(v);
    out.push(b.length & 0xff, (b.length >>> 8) & 0xff, (b.length >>> 16) & 0xff, (b.length >>> 24) & 0xff);
    for (const x of b) out.push(x);
  }
  return new Uint8Array(out);
}

/**
 * 🔴 **列を並べて `.parquet` の bytes にする。**
 *
 * @throws 列が 0 本 / 行数が揃っていないとき(**黙って壊れた file を作らない** ──
 *   読む側で落ちると、原因が「fixture か製品か」分からなくなる)。
 */
export function buildParquet(columns: readonly ParquetColumn[]): Uint8Array {
  const first = columns[0];
  if (first === undefined) throw new Error('parquet-fixture: 列が 1 本もありません');
  const numRows = first.values.length;
  for (const c of columns) {
    if (c.values.length !== numRows) {
      throw new Error(`parquet-fixture: ${c.name} の行数が揃っていません`);
    }
  }

  const body: number[] = [];
  const push = (b: Uint8Array | number[]): void => {
    for (const x of b) body.push(x);
  };
  // "PAR1"
  push([0x50, 0x41, 0x52, 0x31]);

  /** 列ごとに「page header の始まり」と「中身の大きさ」を控える(footer が指す)。 */
  const chunks: { offset: number; size: number }[] = [];
  for (const col of columns) {
    const data = plainBytes(col);
    const ph = new Compact();
    ph.structStart();
    ph.i32(1, DATA_PAGE);
    ph.i32(2, data.byteLength); // uncompressed_page_size
    ph.i32(3, data.byteLength); // compressed_page_size(無圧縮なので同じ)
    ph.header(5, TT.STRUCT); // data_page_header
    ph.structStart();
    ph.i32(1, numRows);
    ph.i32(2, ENC_PLAIN);
    // ⚠ レベルは 1 バイトも書かないが、**符号化の名前は required** なので埋める
    ph.i32(3, ENC_RLE);
    ph.i32(4, ENC_RLE);
    ph.structEnd();
    ph.structEnd();
    const offset = body.length;
    push(ph.out);
    push(data);
    chunks.push({ offset, size: body.length - offset });
  }

  const m = new Compact();
  m.structStart();
  m.i32(1, 1); // version
  // --- schema: root + 列(root は type を持たず、num_children だけ)
  m.listHeader(2, columns.length + 1, TT.STRUCT);
  m.structStart();
  m.str(4, 'pkc');
  m.i32(5, columns.length);
  m.structEnd();
  for (const col of columns) {
    m.structStart();
    m.i32(1, col.type === 'int32' ? PHYS.INT32 : PHYS.BYTE_ARRAY);
    m.i32(3, REQUIRED);
    m.str(4, col.name);
    if (col.type === 'utf8') m.i32(6, CONVERTED_UTF8);
    m.structEnd();
  }
  m.i64(3, numRows);
  // --- row group 1 つ
  m.listHeader(4, 1, TT.STRUCT);
  m.structStart();
  m.listHeader(1, columns.length, TT.STRUCT);
  for (const [i, col] of columns.entries()) {
    const ch = chunks[i];
    if (ch === undefined) throw new Error('parquet-fixture: 列と塊の数が合いません');
    m.structStart();
    m.i64(2, ch.offset); // file_offset
    m.header(3, TT.STRUCT); // meta_data
    m.structStart();
    m.i32(1, col.type === 'int32' ? PHYS.INT32 : PHYS.BYTE_ARRAY);
    m.listHeader(2, 1, TT.I32);
    m.listI32(ENC_PLAIN);
    m.listHeader(3, 1, TT.BINARY);
    m.listStr(col.name);
    m.i32(4, UNCOMPRESSED);
    m.i64(5, numRows);
    m.i64(6, ch.size);
    m.i64(7, ch.size);
    m.i64(9, ch.offset); // data_page_offset
    m.structEnd();
    m.structEnd();
  }
  m.i64(2, chunks.reduce((a, c) => a + c.size, 0)); // total_byte_size
  m.i64(3, numRows);
  m.structEnd();
  m.str(6, 'pkc3-test-fixture');
  m.structEnd();

  push(m.out);
  const len = m.out.length;
  push([len & 0xff, (len >>> 8) & 0xff, (len >>> 16) & 0xff, (len >>> 24) & 0xff]);
  push([0x50, 0x41, 0x52, 0x31]);
  return new Uint8Array(body);
}
