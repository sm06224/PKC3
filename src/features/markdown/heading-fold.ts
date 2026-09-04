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
    if (levels[i] === 0) continue;
    const to = sectionEnd(levels, i);
    // ⚠ 配下が 1 つも無い見出しは畳む物が無い ── 器の側が押す口を出さないで済む
    if (to > i + 1) out.push({ heading: i, from: i + 1, to });
  }
  return out;
}

/**
 * 見出し `i` の節が終わる位置(**含まない**)= 次の同段以上の見出し。無ければ末尾。
 * 🔑 畳み(`foldSpans`)と章のコピー(`chapterSpan`)が**同じ 1 本**を引く ──
 *   「どこまでが章か」を 2 か所で数えると、畳んだ範囲と写した範囲が食い違う日が来る。
 */
function sectionEnd(levels: HeadingLevels, i: number): number {
  const lvl = levels[i]!;
  let to = i + 1;
  // ⚠ **同じ段も閉じる** ── `##` の次の `##` は別の節である
  while (to < levels.length) {
    const next = levels[to]!;
    if (next > 0 && next <= lvl) break;
    to += 1;
  }
  return to;
}

/** 章の原文の行範囲(0 始まり・**両端含む**)。 */
export interface ChapterSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * 🔴 **章の原文の行範囲**(#677。右クリック「この章をコピー」の材料)。
 *
 * 見出しの行から、**次の同段以上の見出しの直前の行**まで。次が無ければ本文の末尾まで。
 *
 * ⚠ **終端を「配下の塊の `data-pkc-source-end` の最大」で取ってはいけない** ──
 *   `:::` の囲みは開き行にしか刻印を持たない(閉じ側は属性を捨てる)ので、
 *   章の最後が `:::` の塊だと**中身と閉じの `:::` が丸ごと落ちる**。
 *   🔑 だから終端は**次の見出しの行 − 1**(見出しは必ず刻印を持つ)で取る。
 * ⚠ 見出しの行は**その見出し自身の刻印**から取る(setext の `===` は `-end` 側に居るが、
 *   次の見出しの `-line` − 1 で自然に含まれる)。
 *
 * @param levels 塊ごとの見出しの段(`foldSpans` と同じ配列)
 * @param lines 塊ごとの原文の開き行(`data-pkc-source-line`。無い塊は `null`)
 * @param heading 章にする見出しの位置
 * @param lineCount 原文の総行数(末尾の章はここまで)
 * @returns 見出しでない / 行が読めない位置なら `null`(当てずっぽうで写さない)
 */
export function chapterSpan(
  levels: HeadingLevels,
  lines: readonly (number | null)[],
  heading: number,
  lineCount: number,
): ChapterSpan | null {
  const lvl = levels[heading];
  if (lvl === undefined || lvl === 0) return null;
  const start = lines[heading];
  if (start === null || start === undefined) return null;
  const to = sectionEnd(levels, heading);
  if (to >= levels.length) return start < lineCount ? { start, end: lineCount - 1 } : null;
  const nextLine = lines[to];
  if (nextLine === null || nextLine === undefined || nextLine <= start) return null;
  return { start, end: nextLine - 1 };
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
