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
 * 新しい順に並べたときの、件の**並びの順位**(前置き = 0、いちばん新しい件 = 1)。
 * ⚠ 「新しい」は**本文の後ろ**(追記は末尾に足すので、後ろの件ほど新しい)── 見出しの日時は読まない
 *   (日時を書き換えた記録・日時でない見出しでも、置いた順のまま裏返す)。
 */
export function descRank(seg: number, count: number): number {
  return seg === 0 ? 0 : count - seg + 1;
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
