/**
 * 🔴 ノートの文字数と読了目安時間の整形 (#1112 / 統一は #1087)。
 *
 * ## user がやりたいこと
 *
 * 情報ペイン（インスペクター）で、いま開いているノートの規模感
 * （文字数と読むのにかかる時間の目安）を一目で把握したい。
 *
 * ## 規律
 *
 * 1. 🔑 **pure module**: DOM やエディタを知らない。
 * 2. 🔑 **分数は題名の下と同じ 1 本の算出**(`estimateReadingTime`)── ここに第 2 の速度の定数を
 *    持たない。#1087 まで右の列は「空白・改行・先頭の設定行を含む生の長さ ÷ 500 字/分」、
 *    題名の下は「それらを除いた実質の字数、英語は 200 語/分、200 字未満は出さない」で、
 *    同じ本文で「約 10 分」と「約 5 分」が同時に見えていた(裁定 2026-10-01)。
 * 3. 🔑 **「N 文字」は生の長さのまま**(本文の長さとして意味がある)。分数だけを揃える。
 * 4. 🔑 **本文が手元に無いとき(`body === null`)は分数を出さない** ── 分数の算出は本文の字を
 *    読む(日本語と英語で速さが違う)ので、字数だけからは出せない。2 本目の算出で埋めない。
 */
import { estimateReadingTime } from '@features/markdown/reading-time';

/**
 * 情報ペイン等に表示する文字数と読了目安の文字列を組み立てる。
 *
 * @param chars 本文の長さ(生。空白・改行・先頭の設定行を含む)。`null` は「分からない」
 * @param body  読了目安の元にする本文。無い(閉じている)ときは分数を出さない
 *
 * 例:
 * - `chars === null` → `'—'`
 * - `chars === 0` → `'0 文字'`
 * - 実質 200 字未満の本文 / 本文が無い → `'450 文字'`(題名の下と同じく分数を出さない)
 * - 実質 2,500 字の日本語 → `'2,500 文字 (読了 約 5 分)'`
 */
export function formatBodyStats(chars: number | null, body: string | null = null): string {
  if (chars === null) return '—';
  if (chars <= 0) return '0 文字';
  const formattedChars = chars.toLocaleString('ja-JP');
  if (body === null) return `${formattedChars} 文字`;
  const estimate = estimateReadingTime(body);
  if (estimate.label === null) return `${formattedChars} 文字`;
  return `${formattedChars} 文字 (読了 約 ${estimate.minutes} 分)`;
}

/**
 * 🔴 **チェック項目の進み具合**(#1216)。右の列の「チェック項目」の行の字。
 *
 * ## user がやりたいこと
 *
 * 買い物リストや手順のノートを開いたまま、「あと何件か」を本文を数えずに知りたい。
 *
 * ## 規律
 *
 * 1. 🔑 **数えるのは呼ぶ側**(`listTaskItems` ── かんばんの札と同じ物)。ここは字を組むだけ。
 *    ⚠ `countTaskCandidates` は「多めに数える鍵」なので画面に出さない(task-count.ts の注記)。
 * 2. 🔴 **割合は切り捨て** ── 199/200 を「100%」と出すと、終わっていないのに終わって見える。
 * 3. 🔑 **0 件は `null`**(呼ぶ側が行ごと畳む)。「0 / 0 完了 (NaN%)」を出さない。
 *
 * 例: `(10, 4)` → `'4 / 10 完了 (40%)'` / `(0, 0)` → `null`
 */
export function formatTaskProgress(total: number, done: number): string | null {
  if (!(total > 0)) return null;
  const d = Math.min(Math.max(done, 0), total);
  const pct = Math.floor((d * 100) / total);
  return `${d} / ${total} 完了 (${pct}%)`;
}

/**
 * 🔴 **選んだ範囲の行数**(#1215)── 区切り(`\n`)の数 + 1。
 *
 * - 選んでいない(`end <= start`)→ `0`
 * - 🔑 **末尾の改行で選択が終わるときは次の行を数えない**(`indent-assist.ts` の `lastPos` と同じ判断
 *   ── 下の行の頭まで選んでいても、その行は巻き込まれていない)
 * - ⚠ **本文を切り出さない**(`slice` / `split` で O(n) のコピーを作らない)。`indexOf` で
 *   選んだ範囲の中だけを走る ── 5,000 行の全文編集でも、選択が動くたびに本文を複製しない。
 */
export function selectionLineCount(text: string, start: number, end: number): number {
  if (end <= start) return 0;
  const last = text.charCodeAt(end - 1) === 10 ? end - 1 : end;
  let n = 1;
  for (let i = text.indexOf('\n', start); i !== -1 && i < last; i = text.indexOf('\n', i + 1)) n += 1;
  return n;
}

/**
 * 🔴 **選んだ範囲の文字数と行数の整形**(#1215)。編集の帯の右端の枠に出す。
 *
 * - 字の単位は `formatBodyStats` と同じ「文字」(`toLocaleString('ja-JP')` も同じ)。
 *   数えるのは UTF-16 の長さ(`selectionEnd - selectionStart`)── 右の列の文字数と同じ規則。
 * - `chars <= 0`(選んでいない)は**空文字** ── 枠は残るが字は無い(版面が動かない)。
 */
export function formatSelectionStats(chars: number, lines: number): string {
  if (chars <= 0) return '';
  return `選択: ${chars.toLocaleString('ja-JP')} 文字(${Math.max(1, lines).toLocaleString('ja-JP')} 行)`;
}
