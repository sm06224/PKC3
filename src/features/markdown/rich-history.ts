/**
 * 🔴 **リッチ編集のセルの中の取り消し / やり直し**(v4.0 Phase 1 / PR-06。PR-05 の既知の課題)。
 *
 * セルは書式を当てるたびに中身を組み直す(`RichCell.reload`)ので、**ブラウザ自前の取り消しの履歴は切れる**
 * (書式を当てた直後の `Ctrl+Z` が効かない)。ここがセル 1 つぶんの履歴を持つ。
 *
 * ## 粒度
 * - 開いた時の形が最初の 1 件。
 * - 書式(帯・ショートカット)を当てる**前後**で 1 件ずつ。
 * - 打った字は**区切りごとに 1 件**(変換の確定・打つ手が止まったとき)── 呼び側が決めて `pushRich` する。
 *   ⚠ 変換中は呼び側が一切記録しない(DOM も読まない)。
 * - 中身が同じなら新しい 1 件を作らず、選択だけ差し替える(空の取り消しを積まない)。
 *
 * ## 先頭まで戻ったら
 * `undoRich` は `null` を返す ── 呼び側はブロックを跨ぐ取り消し(`edit-journal`)へ譲る。
 *
 * ⚠ pure module。⚠ 上限を持つ(常駐メモリを編集回数で増やさない)。
 */

/** セルの 1 状態(ブロックの原文と、その中の選択)。 */
export interface RichSnap {
  readonly markdown: string;
  readonly start: number;
  readonly end: number;
}

export interface RichHistory {
  readonly past: readonly RichSnap[];
  readonly present: RichSnap;
  readonly future: readonly RichSnap[];
}

/** 取り消せる手の上限。 */
export const RICH_HISTORY_LIMIT = 100;

export function createRichHistory(initial: RichSnap): RichHistory {
  return { past: [], present: initial, future: [] };
}

/**
 * 1 件記録する。⚠ 中身が同じなら選択だけ差し替える。⚠ やり直しの先は捨てる(分岐した歴史を持たない)。
 */
export function pushRich(h: RichHistory, snap: RichSnap, limit = RICH_HISTORY_LIMIT): RichHistory {
  if (snap.markdown === h.present.markdown) {
    if (snap.start === h.present.start && snap.end === h.present.end) return h;
    return { past: h.past, present: snap, future: h.future };
  }
  const past = [...h.past, h.present];
  while (past.length > limit) past.shift();
  return { past, present: snap, future: [] };
}

/** 1 つ戻す。戻せなければ `null`(呼び側はブロックを跨ぐ取り消しへ譲る)。 */
export function undoRich(h: RichHistory): { history: RichHistory; snap: RichSnap } | null {
  const prev = h.past[h.past.length - 1];
  if (prev === undefined) return null;
  return {
    history: { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] },
    snap: prev,
  };
}

/** 1 つやり直す。やり直せなければ `null`。 */
export function redoRich(h: RichHistory): { history: RichHistory; snap: RichSnap } | null {
  const next = h.future[0];
  if (next === undefined) return null;
  return {
    history: { past: [...h.past, h.present], present: next, future: h.future.slice(1) },
    snap: next,
  };
}
