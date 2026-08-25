/**
 * 🔴 **見出しの畳みを器へ当てる**(#396)。規則は
 * `features/markdown/heading-fold.ts`(pure)── ここは**当てるだけ**。
 *
 * ## 🔴 節点を 1 つも動かさない
 *
 * PKC2 は `<details>` へ**入れ子に組み替えて**いたが、PKC3 では踏めない ──
 * `row-swap.ts:394` の塊の特定が「**host の直下である**」ことを前提にしており、
 * 入れ子にすると**押しても編集に入れなくなる**(しかも無言)。
 * 🔑 だから畳みは **`hidden` の付け外しだけ**にする。
 * ⚠ 副産物として PKC2 より良い:**畳んだまま、見えている行を編集できる**。
 *
 * ## ⚠ 畳んでいる事実は DOM に置く(state に持たない)
 *
 * 畳みは**その場の見え方**であって、ノートの中身でも設定でもない ──
 * 再描画で戻ってよい(PKC2 も同じ)。🔑 state に載せると、
 * 「どのノートのどの見出しか」を持つ羽目になり、選択が動くたびに掃除が要る。
 *
 * ## ⚠ 塊の差分とは喧嘩しない
 *
 * `applyBlocks` は**描画 HTML どうし**を比べる(`apply-blocks.ts:152`)ので、
 * ここで生の DOM に足すボタンは差分に影響しない。
 * ⚠ ただし塊が差し替わるとボタンは消えるので、**描画のたびに呼び直す**。
 */

import { foldSpans, hiddenByFolds } from '@features/markdown/heading-fold';

/** 畳んでいる印。⚠ 見出しそのものに付ける(配下ではない)。 */
const FOLDED = 'data-pkc-folded';

function headingLevel(el: Element): number {
  const m = /^H([1-6])$/.exec(el.tagName);
  return m === null ? 0 : Number(m[1]);
}

/**
 * 押す口を 1 つだけ置く(冪等)。
 * ⚠ `<button>` にするのは見た目のためではない ── `row-swap.ts:413` が
 *   `button` を編集の対象から**外している**ので、押しても編集に落ちない。
 */
function ensureToggle(heading: Element, folded: boolean): void {
  let btn = heading.querySelector<HTMLButtonElement>('[data-pkc-field="heading-fold"]');
  if (btn === null) {
    btn = heading.ownerDocument.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-field', 'heading-fold');
    // 🔑 押しの振り分けは**既存の作法**(`data-pkc-action`)に乗せる ──
    //    ここで独自に `addEventListener` すると、描画のたびに増える
    btn.setAttribute('data-pkc-action', 'toggle-heading-fold');
    // ⚠ 見出しの**頭**に置く(字の後ろだと、長い見出しで行末へ飛ぶ)
    heading.prepend(btn);
  }
  btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
  /**
   * 🔴 **字を `textContent` に入れない**(2026-08-25 に実際に落ちた)。
   *
   * ⚠ 最初は `btn.textContent = '▾'` と書いたが、見出しの中に置く以上
   *   **`h1.textContent` に `▾` が混ざる** ── 写し・読み上げ・見出しの
   *   アンカー・目次が**全部汚れる**(既存の検査が 1 件それで落ちた)。
   * 🔑 印は **CSS の `::before`** で出し、名前は `aria-label` で持つ。
   */
  btn.textContent = '';
  const label = folded ? 'この見出しの中身を出します' : 'この見出しの中身を畳みます';
  // ⚠ 文言は**起きること**で書く(user 指示 2026-08-21)
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

/**
 * 描画済みの本文に、見出しの畳みを当てる。⚠ **描画のたびに呼ぶ**(冪等)。
 *
 * @returns 押す口を出した見出しの数(0 = 畳める見出しが無い)
 */
export function applyHeadingFold(host: HTMLElement): number {
  const blocks = [...host.children];
  const levels = blocks.map(headingLevel);
  const spans = foldSpans(levels);
  if (spans.length === 0) return 0;

  const folded = new Set<number>();
  for (const s of spans) if (blocks[s.heading]!.hasAttribute(FOLDED)) folded.add(s.heading);
  for (const s of spans) ensureToggle(blocks[s.heading]!, folded.has(s.heading));

  /**
   * ⚠ **畳みうる塊だけを触る** ── 全部に `hidden` を代入すると、
   *   別の理由で畳まれている物(将来の誰か)を勝手に開くことになる。
   */
  const managed = new Set<number>();
  for (const s of spans) for (let i = s.from; i < s.to; i += 1) managed.add(i);
  const hidden = hiddenByFolds(levels, folded);
  for (const i of managed) {
    const el = blocks[i];
    if (el instanceof HTMLElement) el.hidden = hidden.has(i);
  }
  return spans.length;
}

/**
 * 畳み方を反転して当て直す。
 *
 * 🔑 **印を反転するだけ** ── 見え方は `applyHeadingFold` が計算し直す。
 * ⚠ ここで `hidden` を直に触ると、**入れ子の畳みが開いてしまう**
 *   (外側を開いた瞬間、内側が畳んでいた事実が失われる)。
 */
export function toggleHeadingFold(heading: Element): void {
  const host = heading.parentElement;
  if (host === null) return;
  if (heading.hasAttribute(FOLDED)) heading.removeAttribute(FOLDED);
  else heading.setAttribute(FOLDED, '');
  applyHeadingFold(host);
}
