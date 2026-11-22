import { logDayOfHeading } from './log-days';

/**
 * 🔴 **ログを新しい順に並べる規則**(#2018 1。user 裁定 2026-11-22)── pure。DOM は `render/log-days.ts` が当てる。
 *
 * ## 1 件の単位
 *
 * 段 1〜2 の見出しから、次の段 1〜2 の見出しの手前までを **1 件**(親の記録 `##` + 配下の `###` 以下の追いログ)とする
 * ── 日の連なり(`logDayRuns`)の「次の段 1〜2 の見出しまでが 1 件」と同じ数え方。入れ子の追いログは親と一緒に動く。
 * 最初の段 1〜2 の見出しより前(前置き)は件に数えず、**いつも先頭**に置く。
 *
 * ## ⚠ 原文は変えない
 *
 * 並べ替えは読む面の見た目(CSS の `order`)だけで行う。本文の原文・DOM の並び(差分描画・刻印・畳みの数え方)は変えない。
 */

/** 塊ごとの「何件目か」(0 = 前置き、1 から件の番号)と件の数。 */
export interface LogSegments {
  readonly seg: readonly number[];
  readonly count: number;
}

/** @param levels 塊ごとの見出しの段(見出しでなければ 0) */
export function logSegments(levels: readonly number[]): LogSegments {
  const seg: number[] = [];
  let cur = 0;
  for (const lv of levels) {
    if (lv === 1 || lv === 2) cur += 1;
    seg.push(cur);
  }
  return { seg, count: cur };
}

/**
 * 新しい順に並べたときの、件の**並びの順位**(前置き = 0、いちばん新しい件 = 1)── 日時を読まない並べ方(本文の後ろほど新しい)。
 * ⚠ 見出しに日時が在るログは `descRanks` を使う(こちらは日時の無い記録の並び・テストの基準)。
 */
export function descRank(seg: number, count: number): number {
  return seg === 0 ? 0 : count - seg + 1;
}

/** 記録の見出しの日時(`YYYY-MM-DD HH:mm(:ss)`)。⚠ 見出しの頭だけを見る(後ろに `★` などが付く)。 */
const RECORD_STAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * 見出しの字から、並べるための日時の鍵(`YYYY-MM-DD HH:mm:ss`。秒が無ければ `:00`)を取る。日時でなければ `null`。
 * 字の大小で比べられる形にそろえる。暦の妥当性は日の行と同じ `logDayOfHeading`。
 */
export function recordStampKey(text: string): string | null {
  // ⚠ 日が実在するかは日の行と**同じ 1 つの判定**(`logDayOfHeading`)で見る(着地前レビュー ⚠4 ── `2026-13-45` を
  //   並びだけ日時ありと読み、日の行の無い記録が飛ぶのを防ぐ)
  if (logDayOfHeading(text) === null) return null;
  const m = RECORD_STAMP.exec(text.trim());
  if (m === null) return null;
  return `${m[1]!} ${m[2]!}:${m[3]!}:${m[4] ?? '00'}`;
}

/**
 * 🔴 **新しい順の順位を、見出しの日時で決める**(#2018 実機の崩れ。user 指示 2026-11-22)── 同じ日の中で
 *   `22:47:20 → 06:18:53 → 15:25:46` と前後した(本文の並びを裏返しただけだったため。追記の順と見出しの日時が
 *   食い違う記録 = 手で書き足した・別の端末から取り込んだ記録で起きる)。
 *
 * - 日時の見出しを持つ記録どうしは**日時の降順**。同じ日時なら本文の後ろの方を上に
 * - 日時の無い記録は、本文で**直前の日時を持つ記録と同じ日時**として扱う(置いた場所の近くに留まる。前に日時が無ければいちばん古い)
 * - ⚠ 本文の原文・DOM の並びは変えない(順位は CSS の `order` に入るだけ)
 *
 * @param keys 件ごとの日時の鍵(`keys[k - 1]` が k 件目。日時でなければ `null`)
 * @returns `ranks[k - 1]` = k 件目の順位(いちばん新しい件 = 1)
 */
export function descRanks(keys: readonly (string | null)[]): number[] {
  let last = '';
  const eff = keys.map((k) => (k === null ? last : (last = k)));
  const idx = eff.map((_, i) => i);
  idx.sort((a, b) => (eff[a]! > eff[b]! ? -1 : eff[a]! < eff[b]! ? 1 : b - a));
  const ranks = new Array<number>(keys.length);
  idx.forEach((segIndex, pos) => {
    ranks[segIndex] = pos + 1;
  });
  return ranks;
}

/** CSS の `order` に入れる値(順位 × 幅 + 件の中の位置)。件の中の位置は 0 から(月の行 0・日の行 1・塊 2〜)。 */
export const ORDER_STRIDE = 100_000;
export function orderValue(rank: number, local: number): number {
  return rank * ORDER_STRIDE + local;
}

/**
 * 🔴 **入れ子の深さ**(#2018 8。見た目の 3 段 = 日の行 / 親の記録 `##` / 入れ子の追いログ `###`〜)。
 * 塊ごとに 0(親の記録の見出しと中身・前置き)/ 1〜4(`###` = 1 … `######` = 4、とその中身)を返す。
 * - 段 1〜2 の見出しで 0 に戻る。段 3 以上の見出しはその段 − 2、続く中身は同じ深さ
 * - ⚠ 最初の段 1〜2 の見出しより前(前置き)は記録の外なので、段 3 以上の見出しがあっても 0
 * @param levels 塊ごとの見出しの段(見出しでなければ 0)
 */
export function logDepths(levels: readonly number[]): number[] {
  const out: number[] = [];
  let inRecord = false;
  let cur = 0;
  for (const lv of levels) {
    if (lv === 1 || lv === 2) {
      inRecord = true;
      cur = 0;
    } else if (lv >= 3 && inRecord) {
      cur = Math.min(lv, 6) - 2;
    }
    out.push(cur);
  }
  return out;
}
