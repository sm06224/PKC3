/**
 * 🔴 **ZIP64 の 8 バイトの数**(#971 段④)。書く側と読む側が**同じ 1 つ**を使う。
 *
 * ## なぜ分けたか
 *
 * ⚠ **ここは、この変更でいちばん静かに壊れる場所である。**
 * JavaScript のビット演算(`<<` / `>>>` / `|`)は **32bit へ丸める**ので、
 * 素直に `hi << 32 | lo` と書くと **4GB を超えた値が 0 付近へ化ける** ──
 * 型は `number` のままで、tsc も lint も 1 件も鳴らない。
 *
 * 🔑 だから**掛け算と余り**で上下に割る。`Number.MAX_SAFE_INTEGER`(約 9PB)まで
 *   正確で、ZIP の実用範囲を丸ごと覆う。
 *
 * ⚠ そして**書く側と読む側で 2 回書かない**(CLAUDE.md §7)── 片方だけ直すと、
 *   往復できているように見えて**片道で化ける**。
 */

/** 4 バイト(小さい方が先)。⚠ `v` は 2^32 未満であること。 */
export function u32bytes(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/**
 * 8 バイト(小さい方が先)にする。
 *
 * @throws 正確に表せない値(負 / 小数 / `MAX_SAFE_INTEGER` 超)は**断る** ──
 *   ⚠ そのまま書くと、読み直したとき別の数になる(黙ってずれる)。
 */
export function u64bytes(v: number): number[] {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new RangeError(`ZIP64 に書けない長さです: ${String(v)}`);
  }
  const lo = v % 0x100000000;
  const hi = Math.floor(v / 0x100000000);
  return [...u32bytes(lo), ...u32bytes(hi)];
}

/**
 * 8 バイトを数にする。
 *
 * @throws 正確に表せない大きさは**断る** ── ⚠ そこから先は足し算の精度が落ちるので、
 *   位置がずれても誰も気づけない(「読めた」の顔で中身が入れ替わる)。
 */
export function readU64(view: DataView, at: number): number {
  const lo = view.getUint32(at, true);
  const hi = view.getUint32(at + 4, true);
  const v = hi * 0x100000000 + lo;
  if (!Number.isSafeInteger(v)) {
    throw new RangeError('ZIP の中の長さが大きすぎて正確に読めません');
  }
  return v;
}
