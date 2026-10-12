/**
 * 🔴 **DB を 1 本の画像にする**(#1416 ── 可搬単一 HTML の保存でメモリが山になる件)。
 *
 * 保存のたびに DB 全体を 1 本の配列にする。大きい DB(150MB 級)では、ここで作る**画像の
 * 複製の数**がそのまま常駐メモリの山になる(実測は設計 doc `f2-portable-single-html` §7-4e)。
 *
 * ## 何を 1 つ減らしているか
 *
 * 上流の `sqlite3_js_db_export` は ① sqlite が **wasm heap へ画像の複製を作り**(`sqlite3_serialize`)
 * ② それを JS の配列へもう 1 度写し ③ wasm 側を解放する。⚠ ③で返しても **wasm heap は縮まない**
 * (一度広げた線形メモリは小さくならない)ので、①は**保存のたびに画像 1 枚ぶんの常駐を増やした**。
 *
 * 🔑 `:memory:` に画像を流し込んだ DB(可搬版の DB は全部これ)は、**DB 自身が 1 本の連続した
 * バッファ**を持つ。`SQLITE_SERIALIZE_NOCOPY` を付けるとその**バッファの場所だけ**が返るので、
 * ①の複製が要らない ── JS の配列へ写す②だけが残る(これは worker の外へ渡すために要る)。
 * ⚠ **memdb でない DB**(OPFS / 流し込んでいない `:memory:`)は NOCOPY だと何も返らない ──
 *   そのときは今までの道(複製を作る)へ戻る。**失敗ではない**。
 */

/** `SQLITE_SERIALIZE_NOCOPY`。 */
const NOCOPY = 1;

/** sqlite-wasm のうち、ここが触る面だけ(test が本物にも偽物にも差せるように絞る)。 */
export interface ImageExportApi {
  capi: { sqlite3_js_db_export: unknown };
  wasm: {
    exports: Record<string, unknown>;
    heap8u(): Uint8Array;
    scopedAllocPush(): unknown;
    scopedAllocPop(scope: unknown): void;
    scopedAlloc(n: number): number;
    peekPtr(p: number): number;
    peek(p: number, type: string): number | bigint;
    ptr: { size: number; add(p: number, n: number): number };
  };
}

/**
 * 複製を作らずに、DB が持つバッファの**場所と大きさ**を借りる。memdb でなければ `null`。
 * ⚠ 借りている間(`use` の中)は **DB に書かない・解放しない**。次の書込でバッファが動く。
 */
function withNoCopyBuffer<T>(
  api: ImageExportApi,
  dbPointer: unknown,
  use: (heap: Uint8Array, start: number, size: number) => T,
): T | null {
  const { wasm } = api;
  const serialize = wasm.exports['sqlite3__wasm_db_serialize'] as
    | ((db: unknown, schema: number, ppOut: number, pSize: number, flags: number) => number)
    | undefined;
  if (typeof serialize !== 'function') return null;
  const scope = wasm.scopedAllocPush();
  try {
    const pSize = wasm.scopedAlloc(8 + wasm.ptr.size);
    // ⚠ 上流の注意: pSize を先に置く(8 バイト境界)── 逆にすると大きさが壊れて読める
    const ppOut = wasm.ptr.add(pSize, 8);
    const rc = serialize(dbPointer, 0, ppOut, pSize, NOCOPY);
    if (rc !== 0) return null;
    const pOut = wasm.peekPtr(ppOut);
    // memdb でない DB は NOCOPY だと pOut が 0 ── 今までの道へ
    if (!pOut) return null;
    const n = Number(wasm.peek(pSize, 'i64'));
    if (!Number.isFinite(n) || n <= 0) return null;
    // ⚠ ここで解放しない ── pOut は **DB が持つバッファそのもの**(解放すると DB が壊れる)
    return use(wasm.heap8u(), pOut, n);
  } finally {
    wasm.scopedAllocPop(scope);
  }
}

/**
 * 複製を作らずに画像を出す。memdb でなければ `null`(= 呼び側が今までの道へ戻る)。
 *
 * ⚠ 返す配列は **wasm heap から写した別の buffer**(`slice`)。⚠ `subarray` にしない ──
 *   wasm の buffer は transfer できず、しかも次の書込で中身が動く。
 */
export function exportImageNoCopy(api: ImageExportApi, dbPointer: unknown): Uint8Array | null {
  return withNoCopyBuffer(api, dbPointer, (heap, start, n) => heap.slice(start, start + n));
}

/** 今までの道(sqlite が複製を作って写す)。 */
export function exportImageCopy(api: ImageExportApi, dbPointer: unknown): Uint8Array {
  return (api.capi.sqlite3_js_db_export as (p: unknown) => Uint8Array)(dbPointer);
}

/** 画像を出す。⚠ 出し方の選び方はここ 1 か所(worker の `exportImage` はこれを呼ぶだけ)。 */
export function exportDbImage(api: ImageExportApi, dbPointer: unknown): Uint8Array {
  return exportImageNoCopy(api, dbPointer) ?? exportImageCopy(api, dbPointer);
}
