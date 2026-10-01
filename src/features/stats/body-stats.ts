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
