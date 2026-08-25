/**
 * 🔴 **見出しで畳む ── ただし DOM を組み替えない**(#396 / PKC2 領域 6 の移植)。
 *
 * ## user がやりたいこと
 *
 * 長いノートで**見出しを畳んで**全体を見渡したい。記法は要らない ──
 * 普通の `# 見出し` を書くだけで畳めるのが PKC2 の形だった
 * (`features/markdown/heading-fold.ts`、flag 無しで 4 surface 全部に配線済み)。
 *
 * ## 🔴 PKC2 の実装形は**持ち込めない**(実際に読んで分かった)
 *
 * PKC2 は見出しと配下を **`<details>` へ入れ子に組み替えて**いた。
 * ⚠ PKC3 でそれをやると**ライブエディタが死ぬ**:
 *
 * ```js
 * // adapter/ui/render/row-swap.ts:394
 * while (cur !== null && cur.parentNode !== this.host) cur = cur.parentNode;
 * ```
 *
 * 塊の特定は「**host の直下である**」ことを前提にしており、`view.nodes` は
 * 描画直後の**上端の節点**を持っている。`<details>` へ入れ子にすると、
 * 上りきった先が `<details>`(= `view.nodes` に居ない)になるので `null` が返り、
 * **押しても編集に入れなくなる**。⚠ しかも**無言**である。
 *
 * 🔑 だから PKC3 は **節点を 1 つも動かさない** ── 畳むのは
 * 「その見出しの配下を `hidden` にする」だけにする。
 * ⚠ 副産物として PKC2 より良い点がある:**畳んだまま行を編集できる**
 * (`<details>` は閉じると中の textarea へ到達できない)。
 *
 * 🔑 **ここは pure**(DOM を知らない)── 「どの見出しがどこまでか」だけを返す。
 * 器への当て方は `adapter/ui/render/heading-fold.ts`。
 */

/** 見出しの段(`h1`〜`h6` = 1〜6)。見出しでない塊は 0。 */
export type HeadingLevels = readonly number[];

/** 1 つの見出しが持つ範囲。⚠ `from` は**見出しの次**(見出し自身は畳まない)。 */
export interface FoldSpan {
  /** 見出しそのものの位置。 */
  readonly heading: number;
  /** 畳む範囲の先頭(見出しの次)。 */
  readonly from: number;
  /** 畳む範囲の終端(**含まない**)。 */
  readonly to: number;
}

/**
 * 見出しごとに「次の同段以上の見出しの手前まで」を返す。
 *
 * ⚠ **入れ子は範囲の重なりで表す**(木を組まない)── 器の側は
 * 「重なっている外側を畳めば内側も消える」で足りるので、木は要らない。
 * 🔑 木を組むと、器の側が**その木のとおりに DOM を組み替えたくなる** ──
 * それが PKC2 の形であり、PKC3 では踏めない道である。
 *
 * @param levels 塊ごとの見出しの段(見出しでなければ 0)
 */
export function foldSpans(levels: HeadingLevels): readonly FoldSpan[] {
  const out: FoldSpan[] = [];
  for (let i = 0; i < levels.length; i += 1) {
    const lvl = levels[i]!;
    if (lvl === 0) continue;
    let to = i + 1;
    // ⚠ **同じ段も閉じる** ── `##` の次の `##` は別の節である
    while (to < levels.length) {
      const next = levels[to]!;
      if (next > 0 && next <= lvl) break;
      to += 1;
    }
    // ⚠ 配下が 1 つも無い見出しは畳む物が無い ── 器の側が押す口を出さないで済む
    if (to > i + 1) out.push({ heading: i, from: i + 1, to });
  }
  return out;
}

/**
 * 🔴 **畳んでいる見出しの集合から、隠れる塊を出す**。
 *
 * ⚠ 「押したら配下を `hidden` にする」を直に書くと**入れ子で壊れる**:
 *   外側を畳む → 内側も隠れる → 外側を開く → **内側の畳みまで開いてしまう**
 *   (`hidden` を直に消すので、内側が畳んでいた事実が失われる)。
 * 🔑 だから**状態は「どの見出しを畳んでいるか」だけ**を持ち、
 *   見えるかどうかは**毎回ここで計算し直す**(2 つ目の真実を作らない)。
 *
 * @param folded 畳んでいる見出しの位置(`FoldSpan.heading`)
 * @returns 隠す塊の位置
 */
export function hiddenByFolds(levels: HeadingLevels, folded: ReadonlySet<number>): Set<number> {
  const hidden = new Set<number>();
  for (const span of foldSpans(levels)) {
    if (!folded.has(span.heading)) continue;
    for (let i = span.from; i < span.to; i += 1) hidden.add(i);
  }
  return hidden;
}
