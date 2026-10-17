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
import { estimateReadingTime, type ReadingTimeEstimate } from '@features/markdown/reading-time';

/**
 * 🔴 **見た目の字数(書記素)で数える**(#1163 依頼 165 / 315。Gemini の裁定)。
 *
 * 直す前は UTF-16 の長さ(`length`)だったので、😀 や 𠮷 が 2 字、Windows の改行が 2 字、家族の絵文字のような
 * 合字が 7 字に数えられた。見える 1 字を 1 と数える。
 * 🔑 **ほとんどの本文は分割を要さない**(結合や絵文字の仕組みが 1 字も無い)── そのときは `length` を返す
 *   (40 万字を毎回 `Intl.Segmenter` で歩かない)。判定は 1 本の正規表現で、仕組みが 1 字でもあれば全文を歩く。
 * ⚠ `Intl.Segmenter` が無い環境ではコードポイントで数える(絵文字 1 つを 1 と数えるところまでは同じ)。
 */
const SEGMENTING_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // 結合用の記号
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0600, 0x06ff], // アラビア文字
  [0x0900, 0x0dff], // インド系の文字
  [0x1100, 0x11ff], // ハングルの字母
  [0x1ab0, 0x1aff],
  [0x200b, 0x200f], // 幅ゼロの接合子・方向
  [0x2028, 0x2029],
  [0x20d0, 0x20ff],
  [0x3099, 0x309a], // 濁点・半濁点(単独の結合文字)
  [0xa960, 0xa97f],
  [0xd7b0, 0xd7ff],
  [0xd800, 0xdfff], // サロゲート(絵文字・𠮷)
  [0xfe00, 0xfe0f], // 異体字セレクタ
  [0x000d, 0x000d], // CR(CRLF は 1 字)
];
const hex4 = (n: number): string => `\\u${n.toString(16).padStart(4, '0')}`;
// ⚠ 範囲は数で持って、実行時に字の集まりへ組む(結合文字をソースに直書きしない)
const NEEDS_SEGMENTING = new RegExp(`[${SEGMENTING_RANGES.map(([a, z]) => `${hex4(a)}-${hex4(z)}`).join('')}]`);
let segmenter: Intl.Segmenter | null | undefined;
/**
 * 分割を要さない本文だけ、その字数(`length`)を返す。要するなら `null`。
 * 🔑 打っている最中に毎回全文を歩かないための入口 ── 返せたときは常に最新、`null` のときは呼び手が前回の数を持ち越す。
 */
export function cheapGraphemeCount(text: string): number | null {
  return NEEDS_SEGMENTING.test(text) ? null : text.length;
}
export function countGraphemes(text: string): number {
  if (!NEEDS_SEGMENTING.test(text)) return text.length;
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter('ja', { granularity: 'grapheme' })
        : null;
  }
  let n = 0;
  if (segmenter === null) {
    // コードポイントで数える(サロゲート対は 1 字)
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) i += 1;
      n += 1;
    }
    return n;
  }
  const it = segmenter.segment(text)[Symbol.iterator]();
  while (!it.next().done) n += 1;
  return n;
}

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
  return formatBodyStatsFor(chars, body === null ? null : estimateReadingTime(body));
}

/**
 * `formatBodyStats` の字の組み立て(判定はここ 1 か所)。⚠ 分数の元(`estimateReadingTime`)は本文の
 * 全文を読むので、**打つたびに描き直す面は前回の見積りを持ち回れる**ようにこの口を分けてある(#1087)。
 * `estimate === null` は「本文が手元に無い」(分数を出さない)。
 */
export function formatBodyStatsFor(chars: number | null, estimate: ReadingTimeEstimate | null): string {
  if (chars === null) return '—';
  if (chars <= 0) return '0 文字';
  const formattedChars = chars.toLocaleString('ja-JP');
  if (estimate === null || estimate.label === null) return `${formattedChars} 文字`;
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
