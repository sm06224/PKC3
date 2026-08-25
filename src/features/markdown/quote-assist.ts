/**
 * 🔴 **引用(`>`)を書き続けられるようにする**(#396、PKC2 領域 6 の移植)。
 *
 * ## user がやりたいこと
 *
 * `> 引用` の行末で Enter を押したら、**次の行も `> ` から始まってほしい**。
 * ⚠ いまは毎回手で `> ` を打ち足すことになる ── 3 行の引用で 2 回、
 * 10 行なら 9 回である。
 *
 * ## ⚠ 抜け道も要る(片道の操作を作らない)
 *
 * 続けられるだけだと、**引用から出られない**。
 * 🔑 **空の `> ` で Enter を押したら引用を抜ける**(その行の `> ` を消す)──
 * これは「置けるなら外せる」(user 指示 2026-08-23)の入力版である。
 *
 * ## 🔑 PKC3 では**両方の編集形で効く**
 *
 * 2 列の全文欄(`editor-body`)でも、ライブの行ごとの欄(`row-source`)でも、
 * Enter は**その欄の中で改行する**(`row-swap.ts` に Enter の特別扱いは無い)──
 * だから同じ規則がそのまま載る。
 *
 * 🔑 **pure module**。DOM も窓も知らない ── 欄の値と caret だけを見る。
 */

/** Enter を押したとき、呼び側が何をすればよいか。 */
export type QuoteAssist =
  /** 何もしない(普通の改行)。 */
  | { readonly kind: 'none' }
  /** caret の位置に `insert` を入れる(引用を続ける)。 */
  | { readonly kind: 'continue'; readonly insert: string }
  /**
   * 引用から抜ける ── `from`〜`to` を `text` で置き換える。
   * ⚠ 置き換えたあとの caret は `from + text.length` に置く。
   */
  | { readonly kind: 'exit'; readonly from: number; readonly to: number; readonly text: string };

/** caret が居る行の範囲(終端は含まない)。 */
function lineRange(value: string, caret: number): { start: number; end: number } {
  const start = value.lastIndexOf('\n', caret - 1) + 1;
  const nl = value.indexOf('\n', caret);
  return { start, end: nl === -1 ? value.length : nl };
}

/**
 * `> ` の連なりを読む。⚠ **入れ子(`> > `)も数える** ── 深さを保って続けたい。
 *
 * @returns 記号の部分(`'> > '` など)と、その後ろの中身。引用でなければ `null`
 */
function readQuote(line: string): { readonly marks: string; readonly rest: string } | null {
  const m = /^((?:\s*>)+\s?)(.*)$/.exec(line);
  if (m === null) return null;
  return { marks: m[1]!, rest: m[2]! };
}

/**
 * Enter を押したときにどうするかを決める。
 *
 * ⚠ **行末でなくても続ける**(PKC2 は行末だけだった)── 行の途中で Enter を
 *   押すのは「ここで割る」ことであり、割った先も引用のままであってほしい。
 *   🔑 これは PKC2 より**動線が増える**側の変更である。
 */
export function quoteOnEnter(value: string, caret: number): QuoteAssist {
  if (caret < 0 || caret > value.length) return { kind: 'none' };
  const { start, end } = lineRange(value, caret);
  const line = value.slice(start, end);
  const q = readQuote(line);
  if (q === null) return { kind: 'none' };

  // ⚠ 空の `> ` で Enter ── **抜ける**(記号を消して、普通の改行にする)
  if (q.rest.trim() === '') return { kind: 'exit', from: start, to: end, text: '' };

  return { kind: 'continue', insert: `\n${q.marks}` };
}
