/**
 * 🔴 **選んでいるときだけ、帯の 4 つの説明を「選んだ範囲を囲みます」にする**(#950 ①)。
 *
 * ## なぜ要るか
 *
 * 帯の「表 / 図を入れる / コードブロック / 数式」は、**選んだ範囲があるときは囲み**、
 * 無いときは空の雛形を差し込む(#950 ③)。ところが押す前にそれが読めない。
 * 帯の**字**を替える案は、帯が 54px → 81px(3 段)に伸びて本文の作業領域を奪うので
 * 取らない(#300)。**重ねたときの説明(`title`)だけ**を切り替える ── 帯の高さは動かない。
 *
 * ## 作り
 *
 * - **どの 4 つか**は `WRAPS_SELECTION_OPS`(text-ops。押したときの振る舞いと同じ集合)から引く。
 *   描く側(`format-bar.ts`)が印(`data-pkc-wraps-selection`)を付け、ここは**印を読むだけ**。
 * - **選んでいるか**は `formatTarget`(押したときに効く欄)に聞く ── 別の欄を見ると、
 *   説明は「囲みます」と言うのに押すと別の欄に効く(§7)。
 * - 観測は `document` の `selectionchange`。⚠ **編集中だけ**購読し、`watch…` が返す
 *   unsubscribe を**編集を終えるとき必ず呼ぶ**(`detail.ts` の `disposeLends`)。
 * - 🔑 **状態が変わったときだけ `title` を書く**(各ボタンの印で見る)── 打鍵や caret の移動の
 *   たびに DOM を書かない(長い本文でも long task を作らない)。
 */
import { formatTarget } from '../actions/format-target';
import { HINT_BASE, HINT_BLOCKED, HINT_COMMAND, HINT_WRAP_ON, WRAP_HINT, hintTitle } from './shortcut-hint';

/** 帯のボタンに付ける印(値は op)。⚠ 付けるのは `format-bar.ts`、読むのはここ。 */
export const WRAPS_SELECTION_ATTR = 'data-pkc-wraps-selection';
/** 切り替える前の説明(鍵の割当を持たないボタンだけ。持つものは土台から組み直す)。 */
const REST_TITLE = 'data-pkc-wrap-rest';

/** 編集欄に**選んだ範囲があるか**(押したときに効く欄 = `formatTarget` と同じ欄で見る)。 */
export function hasWrapSelection(region: HTMLElement): boolean {
  const ta = formatTarget(region);
  return ta !== null && ta.selectionStart !== ta.selectionEnd;
}

/**
 * 帯の 4 つの説明を切り替える。⚠ **すでにその状態のボタンには触らない**。
 * @returns 書き換えたボタンの数(test の空振り防止 ── 0 なら何も切り替わっていない)
 */
export function syncWrapHint(bar: ParentNode, on: boolean): number {
  let changed = 0;
  for (const el of bar.querySelectorAll<HTMLElement>(`[${WRAPS_SELECTION_ATTR}]`)) {
    if (el.hasAttribute(HINT_WRAP_ON) === on) continue;
    const id = el.getAttribute(HINT_COMMAND);
    const base = el.getAttribute(HINT_BASE);
    if (on) {
      // 鍵の割当を持たないボタンは、戻す字をここで預かる(持つものは土台から組み直せる)
      if (base === null || id === null) el.setAttribute(REST_TITLE, el.title);
      el.setAttribute(HINT_WRAP_ON, '');
      el.title = id === null ? WRAP_HINT : hintTitle(WRAP_HINT, id, undefined, el.getAttribute(HINT_BLOCKED));
    } else {
      el.removeAttribute(HINT_WRAP_ON);
      if (base !== null && id !== null) {
        el.title = hintTitle(base, id, undefined, el.getAttribute(HINT_BLOCKED));
      } else {
        el.title = el.getAttribute(REST_TITLE) ?? '';
        el.removeAttribute(REST_TITLE);
      }
    }
    changed += 1;
  }
  return changed;
}

/**
 * 編集中の間だけ `selectionchange` を購読する。
 * @returns **unsubscribe**。⚠ 編集を終えるとき必ず呼ぶ(呼ばないと、閉じた編集の帯を
 *   見張り続ける)。
 */
export function watchWrapHint(region: HTMLElement): () => void {
  const doc = region.ownerDocument;
  const sync = (): void => {
    const bar = region.querySelector<HTMLElement>('[data-pkc-region="format-bar"]');
    if (bar === null) return;
    syncWrapHint(bar, hasWrapSelection(region));
  };
  doc.addEventListener('selectionchange', sync);
  return () => doc.removeEventListener('selectionchange', sync);
}
