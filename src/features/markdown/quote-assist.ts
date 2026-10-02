import { lineStart } from './line-start';
import { LIST_LEAD, THEMATIC_BREAK, advanceFence } from './list-renumber';

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
 * ## 🔴 リストも同じ規則で続ける(#1167)
 *
 * `- 牛乳` の行末で Enter を押したら、次の行も `- ` から始まってほしい。
 * ⚠ 引用と**同じ「続ける / 抜ける」の 2 択**なので、**同じ関数**が決める
 *   (別の関数にすると、`> - 牛乳` で 2 つの規則が取り合う ── §7)。
 *
 * - 記号は `- ` `* ` `+ ` / `1. ` `1) ` / `- [ ] ` `- [x] `。
 *   ⚠ チェックリストは続きを **`- [ ] `(未完了)** で始める ── 完了の印を引き継ぐと、
 *   書くたびに外す手間が出る。
 * - 番号は **+1** で続ける(`9.` の次は `10.`)。
 * - 字下げは保つ。引用の中のリスト(`> - 牛乳`)は `> - ` で続く。
 * - 🔴 **fenced code の中は触らない**(コードの中の `- ` はコードである)。
 * - 空の記号(`- ` / `- [ ] ` / `3. `)で Enter ── 記号を消して**リストから抜ける**
 *   (引用の中なら `> ` は残す)。
 * - ⚠ 記号より**手前**に caret が在るとき(行頭で Enter など)は続けない ──
 *   続けると `- - 牛乳` になる。
 * - `---` / `* * *` のような**水平線**は記号と読まない。
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
  const start = lineStart(value, caret);
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

/** リストの記号を読んだ結果。`next` は次の行の頭に置く物(字下げ + 記号 + 空白 + 印)。 */
interface ListMarker {
  /** 続きの行の頭(`'  - [ ] '` / `'10. '` など)。 */
  readonly next: string;
  /** 元の行で、記号(と印の後ろの空白)までの長さ。caret がこれより手前なら続けない。 */
  readonly width: number;
  /** 記号の後ろに中身が無い(= 抜ける合図)。 */
  readonly empty: boolean;
}

/**
 * 行頭(引用の記号を除いた残り)からリストの記号を読む。リストでなければ `null`。
 *
 * ⚠ **水平線は除く**(`* * *` は `*` + 空白 + 中身に見えるが、記号ではない)。
 */
function readListMarker(rest: string): ListMarker | null {
  if (THEMATIC_BREAK.test(rest)) return null;
  // ⚠ 記号の後ろの空白は**必須**(`-` や `1.` だけを打っている途中で Enter を押しても、
  //   それは記号ではない ── 消したり続けたりしない)
  const m = LIST_LEAD.exec(rest);
  if (m === null) return null;
  const indent = m[1]!;
  const mark = m[2]!;
  const gap = m[3]!;
  let width = m[0].length;
  let body = rest.slice(m[0].length);
  // チェックリスト ── 続きは**未完了**で始める
  let box = '';
  const cb = /^(\[[ xX]\])(\s+|$)/.exec(body);
  if (cb !== null) {
    box = `[ ]${cb[2]! === '' ? ' ' : cb[2]!}`;
    width += cb[0].length;
    body = body.slice(cb[0].length);
  }
  const num = /^(\d+)([.)])$/.exec(mark);
  const next = num === null ? mark : `${Number(num[1]) + 1}${num[2]!}`;
  return { next: `${indent}${next}${gap}${box}`, width, empty: body.trim() === '' };
}

/** `lineStart` より前が fenced code の中か(行ごとに開閉を追う)。 */
function insideFence(value: string, lineStart: number): boolean {
  let fence = '';
  for (const l of value.slice(0, lineStart).split('\n')) fence = advanceFence(fence, l);
  return fence !== '';
}

/**
 * Enter を押したときにどうするかを決める(引用 + リスト)。
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
  const marks = q === null ? '' : q.marks;

  // 🔴 リスト(#1167)── 引用の記号を除いた残りで読む。⚠ コードの中は読まない
  const list = readListMarker(q === null ? line : q.rest);
  if (list !== null && !insideFence(value, start)) {
    // ⚠ 空の記号で Enter ── **抜ける**(記号を消す。引用の中なら `> ` は残す)
    if (list.empty) return { kind: 'exit', from: start + marks.length, to: end, text: '' };
    // ⚠ 記号より手前で押したら続けない(`- - 牛乳` になる)。引用なら引用の規則へ
    if (caret >= start + marks.length + list.width) {
      return { kind: 'continue', insert: `\n${marks}${list.next}` };
    }
  }

  if (q === null) return { kind: 'none' };

  // ⚠ 空の `> ` で Enter ── **抜ける**(記号を消して、普通の改行にする)
  if (q.rest.trim() === '') return { kind: 'exit', from: start, to: end, text: '' };

  return { kind: 'continue', insert: `\n${q.marks}` };
}
