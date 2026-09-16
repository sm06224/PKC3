/**
 * 🔴 **「持ち歩ける 1 枚」が、大きさで詰まったときに言うこと**(#971 段④の残り)。
 *
 * ## 何が起きるか
 *
 * 1 枚に焼くには **DB を丸ごと 1 本の配列**にする必要がある
 * (`sqlite3_js_db_export`)。⚠ wasm は 32bit なので、数 GB は確保できない ──
 * user の保存領域が 4GB を超えたとき、ここは**必ず失敗する**。
 *
 * ## ⚠ 「大きすぎると思うので断る」を、測っていない数でやらない
 *
 * 🔑 確保できる上限は**この箱では測れない**(wasm の設定・端末の空きメモリ・
 *   他のタブの取り分で変わる)。だから**先回りして断らない** ── 試して、
 *   失敗したときに**何が起きたか**と**代わりに何を押せばよいか**を言う。
 * ⚠ 測っていない閾値で断ると、**通ったはずの端末で通らなくなる**
 *   (CLAUDE.md「未確認は assert ではなく診断で出す」と同じ向き)。
 *
 * ## 🔑 行き止まりにしない ── 代わりの道を必ず書く
 *
 * 1 枚が焼けなくても、**一式の書き出し(`.pkc3.zip`)は通る**
 * (2026-09-16 から 4GB の壁が無い)。断り文はそこへ送る。
 */
import { humanBytes } from '../human-bytes';

/**
 * 1 枚に焼けなかったときの字。
 *
 * @param bytes 測れた DB の大きさ(⚠ 測れなければ `null` ── **0 と書かない**)
 */
export function imageTooBigMessage(bytes: number | null): string {
  const size =
    bytes === null || !Number.isFinite(bytes) || bytes <= 0
      ? 'いまの中身'
      : `いまの中身(${humanBytes(bytes)})`;
  return (
    `${size}は大きすぎて「持ち歩ける 1 枚」にできませんでした。` +
    '1 枚に焼くときだけ、保存されている中身を丸ごと 1 つの塊にする必要があり、' +
    'そこが確保できませんでした。' +
    '代わりに 一式を書き出す(.pkc3.zip)をお使いください ── ' +
    'こちらは大きさで止まりません。取り込み直すこともできます。'
  );
}

/**
 * 確保に失敗した種類の error か。
 *
 * ⚠ **何でも「大きすぎる」と言わない** ── 別の理由(DB が壊れている等)まで
 *   この字で覆うと、user は**在りもしない原因**を追うことになる。
 * 🔑 sqlite-wasm は確保の失敗を `WasmAllocError` と名乗り、JS 側の確保は
 *   `RangeError`(配列が大きすぎる)になる ── その 2 つだけを拾う。
 */
export function looksOutOfMemory(err: unknown): boolean {
  if (err instanceof RangeError) return true;
  const name = err instanceof Error ? err.name : '';
  const text = err instanceof Error ? err.message : String(err);
  return (
    name === 'WasmAllocError' ||
    /WasmAllocError|out of memory|Out of memory|Array buffer allocation failed|Invalid (array buffer|typed array) length/.test(
      text,
    )
  );
}
