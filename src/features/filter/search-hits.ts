/**
 * 🔴 **探すで当たった語の、本文の中での位置**(#1102 段①)。
 *
 * 「探す」の結果から本文へ飛ぶとき、**開いた本文の中で当たった所を数え、塗り、順に送る**。
 * 🔑 **pure module** ── 本文の text node から出現を数える規則だけをここに置く
 * (DOM を歩いて Range を作るのは `adapter/ui/render/search-jump.ts`。規則が DOM の中に
 * 埋もれると、誰も test できない)。
 *
 * ## 一致の規則は「探す」と同じ 1 本
 *
 * 語の割り方は `parseSearchTerms`(空白で AND / `"…"` はフレーズ / `-語` は除外)を**そのまま**使い、
 * 大小は区別しない(`excerptAround` = 探すの抜粋と同じ `toLowerCase`)。
 * ⚠ **全角と半角は同じ字として扱わない** ── 探す自身(FTS5 trigram / LIKE)が同じ字として
 *   引かないので、探すで当たっていない本文の位置を、ここだけ「当たり」と数えない。
 * ⚠ **除外の語(`-語`)は塗らない** ── 当たりの条件であって、探している物ではない。
 * ⚠ **text node をまたぐ語は数えない**(語の途中に太字・リンクが入る形)── 塗りは節点ごとに
 *   引くので、またぐ位置は指せない。当たりが 0 件のときは、そう言う(黙らない)。
 */
import { parseSearchTerms } from './search-query';

/** 運ぶ語の長さの上限(コードポイント)。⚠ 住所(断片)に載せるので、無限には持たない。 */
export const FIND_QUERY_MAX = 200;

/** 運ぶ語を整える。⚠ 空白だけ / 空は `''`(呼び側は「塗らない」と読む)。 */
export function normalizeFindQuery(raw: string): string {
  if (typeof raw !== 'string') return '';
  const t = raw.trim();
  if (t === '') return '';
  const cps = [...t];
  return cps.length > FIND_QUERY_MAX ? cps.slice(0, FIND_QUERY_MAX).join('') : t;
}

/**
 * 当たるべき語。⚠ 除外は含めない。重複は 1 つにする。
 * 🔑 返すのは**そのままの字**(大小は比べるときに畳む)── 呼び側が画面へ出せるように。
 */
export function findTerms(query: string): string[] {
  const { include } = parseSearchTerms(query);
  return [...new Set(include.filter((t) => t !== ''))];
}

/**
 * 大小を畳む。⚠ **長さを変えない** ── `'İ'.toLowerCase()` は 2 字になるので、そのまま使うと
 * 畳んだ字の添字が元の字の添字とずれ、塗る位置がずれる。長さが変わる字はそのまま残す。
 */
export function foldCase(s: string): string {
  let out = '';
  for (const ch of s) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

export interface HitSpan {
  /** UTF-16 の添字(`Range.setStart` が受ける物差し)。 */
  readonly start: number;
  readonly end: number;
}

/**
 * 1 つの字の並びの中の、当たりの位置(**重なる**所は 1 つに束ねる、昇順)。
 * ⚠ `terms` は `findTerms` の戻り。空の語は無視する(無限に当たってしまう)。
 */
export function findHitSpans(text: string, terms: readonly string[]): HitSpan[] {
  if (text === '' || terms.length === 0) return [];
  const hay = foldCase(text);
  const spans: HitSpan[] = [];
  for (const term of terms) {
    const needle = foldCase(term);
    if (needle === '') continue;
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      spans.push({ start: at, end: at + needle.length });
      from = at + needle.length;
    }
  }
  if (spans.length === 0) return [];
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: HitSpan[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    // ⚠ 重なるときだけ束ねる(隣り合うだけの当たりは別々に数える ── 2 語が続けて書かれた所)
    if (last !== undefined && s.start < last.end) {
      if (s.end > last.end) merged[merged.length - 1] = { start: last.start, end: s.end };
    } else {
      merged.push(s);
    }
  }
  return merged;
}

/**
 * 送りの位置を、当たりの数の中へ畳む(端で回る)。
 * 🔑 state は**進んだ回数**(`step`)だけを持つ ── 当たりの数は DOM を数えないと分からず、
 * reducer は DOM を知らない。数は描く側が持ち、ここで畳む。
 */
export function wrapHitIndex(step: number, total: number): number {
  if (!Number.isFinite(step) || total <= 0) return 0;
  return ((Math.trunc(step) % total) + total) % total;
}
