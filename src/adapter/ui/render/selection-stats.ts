/**
 * 🔴 **編集中、選んでいる範囲の文字数と行数を、帯の右端の枠に出す**(#1215)。
 *
 * ## 何が起きるか
 *
 * 編集中に入力欄で字を選ぶと、編集の帯(`detail-toolbar`)の右端に「選択: 142 文字(3 行)」。
 * 選びが無く caret が表の行に在るときは「Tab で次のセル」(#1451。選びが勝つ)。
 * 選びを外すと枠は空になる(枠は残る ── 版面は動かない)。
 * 効く欄は `formatTarget` が引く 3 つ(2 列の `editor-body` / 1 画面の行の欄 `row-source` /
 * 「全文を編集」の欄)。追記欄・章の欄・別窓・読む面には出さない。
 *
 * ## 作り(`format-wrap-hint.ts` と同じ形)
 *
 * - 観測は `document` の `selectionchange` と `focusin` / `focusout`(別の入力欄へ焦点が移ったら空にする。
 *   書式ボタンへ移る間は残す ── #1264 §1)。⚠ **編集中だけ**購読し、`watch…` が返す
 *   unsubscribe を**編集を終えるとき必ず呼ぶ**(`detail.ts` の `disposeLends`)。
 * - **どの欄か**は `formatTarget`(押したときに効く欄)に聞く ── 別の欄を見ると、数えた欄と
 *   書式が効く欄が食い違う(§7)。
 * - 🔑 **字が変わったときだけ書く**(打鍵や caret の移動のたびに DOM を書かない)。
 * - 🔑 **選びが止まってから読む**(`SELECTION_STATS_DELAY_MS` の trailing debounce)。
 *   ⚠ 最初は「1 フレームに畳む(rAF)」で書いたが、**実測で外した**:`selectionStart` /
 *   `selectionEnd` を読むと、ブラウザは**その場で layout を確定**する(読むだけで効く)。
 *   選びが動いている最中(= layout が汚れている)に毎フレーム読むと、数 MB の本文の欄で
 *   **50ms 超の long task が積み増しになった**(同じ操作で、枠を外した対照群の 3〜4 倍)。
 *   動きが止まって layout が落ち着いてから 1 度だけ読めば、読むのは安い。
 * - 🔑 **本文を複製しない**。選んでいないとき(caret だけ)は、caret の行が表かを引くために本文を 1 度読む(#1451。字は作らない)。
 *   選んでいるときも `indexOf` で選んだ範囲だけを走る(`selectionLineCount`)。
 * - 🔑 **IME の変換中は書かない**(変換中の選びは確定前の字で、数えても意味が無い)。
 *   `compositionend` で 1 度合わせ直す。
 */
import { formatSelectionStats, selectionLineCount } from '@features/stats/body-stats';
import { caretInTableRow } from '@features/markdown/table-assist';
import { formatTarget } from '../actions/format-target';

/**
 * 最後の `selectionchange` からこれだけ静かなら読む(ms)。
 * ⚠ 短すぎると連打の最中に読んで上の積み増しが戻る / 長すぎると選んだのに字が遅れる。
 */
export const SELECTION_STATS_DELAY_MS = 120;

/** 枠の `data-pkc-field`(描くのは `detail.ts`、書くのはここ)。 */
export const SELECTION_STATS_FIELD = 'selection-stats';

/**
 * 🔴 **caret が表の行に在るとき、同じ枠へ出す案内**(#1451)。選んでいる間は選択の数が勝つ。
 * Tab が実際にセルを移す欄(`editor-body` / `row-source` = `formatTarget`)と同じ欄でだけ出る。
 * 枠は同じ `<span>` を使い回す ── 帯の高さは動かない。
 */
export const TABLE_TAB_HINT = 'Tab で次のセル';

/** 字を打つ欄ではない `<input>`(ここへ焦点が在っても、選んだ字の数は残してよい)。 */
const NON_TEXT_INPUT = new Set([
  'button',
  'checkbox',
  'radio',
  'submit',
  'reset',
  'image',
  'file',
  'color',
  'range',
]);

/**
 * 🔴 **焦点が「別の入力欄」に移っているか**(#1264 §1)。
 *
 * ⚠ 直す前は本文の欄の選びだけを読み、焦点を見なかった ── 本文で字を選んでから題名の欄へ
 *   移っても「選択: N 文字」が残り、**いま選んでいない字の数**を言い続けた。
 * ⚠ **書式のボタン(`<button>`)へ移るときは残す**(意図どおり。`format-target.ts` の
 *   「押したときに効く欄」── 書式を押す間も選びは本文の欄に在る)。
 * ⚠ 本文の欄そのもの(`ta`)は別の欄ではない。
 */
function focusOnOtherField(region: HTMLElement, ta: HTMLTextAreaElement | null): boolean {
  // 🔴 global の `HTMLElement` / `HTMLInputElement` を **読まない**(2026-10-02)── `tagName` で見る。
  //    trailing debounce の読みは test の後始末(happy-dom の teardown)の**後**に走ることがあり、
  //    `instanceof HTMLElement` だと `ReferenceError: HTMLElement is not defined` が unhandled で出て、
  //    負荷しだいで全量 unit が赤くなっていた(#1268 で足した直後に 2 度観測)。
  //    ⚠ vitest の happy-dom では `document.defaultView === globalThis` なので「窓から引く」でも同じ ──
  //    型の名前に依らない判定にするのが唯一の形である。
  const active = region.ownerDocument.activeElement;
  if (active === null || active === ta) return false;
  if (active.tagName === 'TEXTAREA') return true;
  if (active.tagName === 'INPUT') return !NON_TEXT_INPUT.has((active as HTMLInputElement).type);
  const ce = active.getAttribute('contenteditable');
  return (active as HTMLElement).isContentEditable === true || (ce !== null && ce !== 'false');
}

/**
 * 枠へ**いまの選び**を合わせる。⚠ すでに同じ字なら書かない。
 * @returns 書いたら `true`(test の空振り防止 ── 書かなかったのか枠が無いのか区別する)
 */
export function syncSelectionStats(region: HTMLElement): boolean {
  const slot = region.querySelector<HTMLElement>(`[data-pkc-field="${SELECTION_STATS_FIELD}"]`);
  if (slot === null) return false;
  const ta = formatTarget(region);
  let text = '';
  if (ta !== null && !focusOnOtherField(region, ta)) {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (end > start) text = formatSelectionStats(end - start, selectionLineCount(ta.value, start, end));
    // 選びが無く、caret が表の行に在るときだけ案内(1 行ぶんだけ読む。debounce 後の 1 回)
    else if (caretInTableRow(ta.value, start)) text = TABLE_TAB_HINT;
  }
  if (slot.textContent === text) return false;
  slot.textContent = text;
  return true;
}

/**
 * 編集中の間だけ `selectionchange` を購読する。
 * @returns **unsubscribe**。⚠ 編集を終えるとき必ず呼ぶ(待っている 1 回の読みも捨てる)。
 */
export function watchSelectionStats(region: HTMLElement): () => void {
  const doc = region.ownerDocument;
  let composing = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = (): void => {
    timer = null;
    if (composing) return;
    syncSelectionStats(region);
  };
  /** 🔑 trailing debounce ── 動いている間は何も読まず、止まって 1 度だけ読む。 */
  const schedule = (): void => {
    if (composing) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, SELECTION_STATS_DELAY_MS);
  };
  const onStart = (): void => {
    composing = true;
  };
  const onEnd = (): void => {
    composing = false;
    schedule();
  };

  doc.addEventListener('selectionchange', schedule);
  // 🔴 焦点が動いたときも合わせ直す(#1264 §1)── 本文の欄の選びは、焦点が移っても動かない
  //    (selectionchange が来ない)ので、題名の欄へ移ったときに数が残っていた
  doc.addEventListener('focusin', schedule);
  doc.addEventListener('focusout', schedule);
  // composition は bubble する ── 編集の面(region)で受ければ 3 つの欄を全部拾える
  region.addEventListener('compositionstart', onStart, true);
  region.addEventListener('compositionend', onEnd, true);
  return () => {
    doc.removeEventListener('selectionchange', schedule);
    doc.removeEventListener('focusin', schedule);
    doc.removeEventListener('focusout', schedule);
    region.removeEventListener('compositionstart', onStart, true);
    region.removeEventListener('compositionend', onEnd, true);
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
