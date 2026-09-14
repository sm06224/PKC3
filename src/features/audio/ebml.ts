/**
 * 🔴 **EBML の読み書き**(#683 段②a。設計 doc §4)。
 *
 * WebM(Matroska)は「id + 大きさ + 中身」の入れ子だけでできている。
 * ここはその**いちばん下の層**で、**音のことを 1 つも知らない** ──
 * 知っているのは `webm-opus.ts` である。
 *
 * ⚠ **`features/` 層なので browser API を持たない** ── `Buffer` も使わない
 * (node の物なので、そのまま書くと worker で落ちる)。扱うのは `Uint8Array` だけ。
 *
 * ## ⚠ 可変長整数(vint)の癖
 *
 * 先頭バイトの**立っている最上位ビットの位置**が長さを表す(`1xxxxxxx` なら 1 バイト、
 * `01xxxxxx` なら 2 バイト …)。⚠ **id と大きさで読み方が違う**:
 *
 * | | 長さの印 | 例 |
 * |---|---|---|
 * | **id** | **落とさない**(印ごと id の一部) | `0xa3` = SimpleBlock |
 * | **大きさ** | **落とす**(印は長さだけを表す) | `0x81` = 1 |
 *
 * ⚠ そして**大きさには「不明」が在る**(全ビット 1)── `MediaRecorder` は
 * 録りながら書くので、`Segment` の大きさを**不明のまま**出す。
 * 🔑 だから読む側は**入れ物(master)の大きさを使わない**(中へ降りるだけ)。
 */

/** 読んだ可変長整数。`length` は**読んだバイト数**(値ではない)。 */
export interface Vint {
  readonly value: number;
  readonly length: number;
}

/** vint の最大の長さ。⚠ これを超える先頭バイト(`0x00`)は EBML ではない。 */
const VINT_MAX_LEN = 8;

/**
 * 可変長整数を読む。⚠ **読めなければ `null`**(例外にしない ── 壊れた file は
 * 想定内で、断り文へ落とす)。
 *
 * @param stripMarker 長さの印を落とすか。**大きさなら `true`、id なら `false`**。
 */
export function readVint(bytes: Uint8Array, pos: number, stripMarker: boolean): Vint | null {
  if (pos < 0 || pos >= bytes.length) return null;
  const first = bytes[pos]!;
  if (first === 0) return null; // ⚠ 9 バイト以上の vint は無い
  let length = 1;
  for (let mask = 0x80; mask > 0 && (first & mask) === 0; mask >>= 1) length += 1;
  if (length > VINT_MAX_LEN || pos + length > bytes.length) return null;
  let value = stripMarker ? first & (0xff >> length) : first;
  for (let i = 1; i < length; i += 1) {
    // ⚠ `* 256` で伸ばす(`<<` は 32 ビットで折り返す)
    value = value * 256 + bytes[pos + i]!;
    if (!Number.isSafeInteger(value)) return null;
  }
  return { value, length };
}

/** 要素の id を 16 進の字で読む。⚠ **印を落とさない**(落とすと別の id になる)。 */
export function readId(bytes: Uint8Array, pos: number): { readonly id: string; readonly length: number } | null {
  const v = readVint(bytes, pos, false);
  if (v === null || v.length > 4) return null;
  let id = '';
  for (let i = 0; i < v.length; i += 1) id += bytes[pos + i]!.toString(16).padStart(2, '0');
  return { id, length: v.length };
}

/**
 * 要素の大きさ。⚠ **`value` が `null` = 「読めない大きさ」** ── 中身は 2 つある:
 *
 * | | いつ出るか |
 * |---|---|
 * | **不明**(全ビット 1) | `MediaRecorder` が**録りながら**書くとき。`Segment` の大きさが決まっていない |
 * | 大きすぎる | 7 バイトを超える値(この言語の整数の精度を超える) |
 *
 * 🔑 どちらも**入れ物(master)なら困らない**(中へ降りるだけで、大きさを使わない)。
 * ⚠ **中身の要素(leaf)で出たら読めない** ── 呼び側が断る。
 */
export interface ElementSize {
  readonly value: number | null;
  readonly length: number;
}

/**
 * 要素の大きさを読む。⚠ **読めない大きさを例外にしない**(上の表)──
 * `null` を返して、入れ物か中身かは**呼び側**に決めさせる。
 */
export function readSizeAt(bytes: Uint8Array, pos: number): ElementSize | null {
  if (pos < 0 || pos >= bytes.length) return null;
  const first = bytes[pos]!;
  if (first === 0) return null;
  let length = 1;
  for (let mask = 0x80; mask > 0 && (first & mask) === 0; mask >>= 1) length += 1;
  if (length > VINT_MAX_LEN || pos + length > bytes.length) return null;
  let value = first & (0xff >> length);
  let unknown = value === (0xff >> length);
  for (let i = 1; i < length; i += 1) {
    const b = bytes[pos + i]!;
    if (b !== 0xff) unknown = false;
    value = value * 256 + b;
  }
  if (unknown || !Number.isSafeInteger(value)) return { value: null, length };
  return { value, length };
}

/** 大きさを可変長整数で書く。⚠ **不明を表す値は使わない**(1 つ長い形へ逃がす)。 */
export function writeSize(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`書けない大きさ: ${n}`);
  for (let length = 1; length <= VINT_MAX_LEN; length += 1) {
    const max = 2 ** (7 * length) - 1;
    if (n < max) {
      const out = new Uint8Array(length);
      let v = BigInt(n) | (1n << BigInt(7 * length));
      for (let i = length - 1; i >= 0; i -= 1) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return out;
    }
  }
  throw new RangeError(`大きさが大きすぎる: ${n}`);
}

/** 16 進の字をバイト列にする(id 用)。 */
export function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** バイト列をつなぐ。 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 1 つの要素(id + 大きさ + 中身)を組む。 */
export function element(idHex: string, payload: Uint8Array): Uint8Array {
  return concatBytes([hexBytes(idHex), writeSize(payload.length), payload]);
}

/** 符号なし整数を**いちばん短いバイト数**で。⚠ 0 は 1 バイト(空にしない)。 */
export function uintBytes(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`書けない値: ${n}`);
  let hex = BigInt(n).toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return hexBytes(hex);
}

/**
 * 符号つき整数を**いちばん短いバイト数**で(2 の補数・上位から)。
 * ⚠ **正の値でも最上位ビットが立ったら 1 バイト足す** ── 足さないと
 * 読み手に**負の値**として届く(`DiscardPadding` が負になると、尻が削れず伸びる)。
 */
export function intBytes(n: number): Uint8Array {
  if (!Number.isSafeInteger(n)) throw new RangeError(`書けない値: ${n}`);
  for (let length = 1; length <= VINT_MAX_LEN; length += 1) {
    const bits = BigInt(length * 8 - 1);
    const min = -(2n ** bits);
    const max = 2n ** bits - 1n;
    const v = BigInt(n);
    if (v >= min && v <= max) {
      const out = new Uint8Array(length);
      let raw = v < 0n ? v + 2n ** BigInt(length * 8) : v;
      for (let i = length - 1; i >= 0; i -= 1) {
        out[i] = Number(raw & 0xffn);
        raw >>= 8n;
      }
      return out;
    }
  }
  throw new RangeError(`値が大きすぎる: ${n}`);
}

/** 16 ビットの符号つき整数(block の相対時刻。⚠ **必ず 2 バイト**)。 */
export function int16Bytes(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < -32768 || n > 32767) throw new RangeError(`block の時刻がはみ出た: ${n}`);
  const out = new Uint8Array(2);
  new DataView(out.buffer).setInt16(0, n, false);
  return out;
}

/** 倍精度の実数(`Duration` / `SamplingFrequency`)。 */
export function float64Bytes(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, n, false);
  return out;
}

/** ASCII の字(`DocType` / `CodecID`)。⚠ 非 ASCII は受けない。 */
export function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code > 0x7f) throw new RangeError(`ASCII ではない字: ${s}`);
    out[i] = code;
  }
  return out;
}

/** バイト列を ASCII の字として読む(末尾の `\0` は落とす)。 */
export function readAscii(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  let s = '';
  for (let i = 0; i < end; i += 1) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** バイト列を符号なし整数として読む。⚠ 精度を超えたら `null`。 */
export function readUint(bytes: Uint8Array): number | null {
  let v = 0;
  for (const b of bytes) {
    v = v * 256 + b;
    if (!Number.isSafeInteger(v)) return null;
  }
  return v;
}
