/**
 * 🔴 **編集中に刷っても、編集欄の中身を紙に全部出す**(#1163 依頼 71-2)。
 *
 * ⚠ 編集欄は `<textarea>` なので、そのまま刷ると**見えている 1 画面ぶんの箱**しか紙に出ない
 *   (本文が途中で切れる)。`Ctrl+P` はわざと奪っていない(`features/keymap.ts`)ので、
 *   編集中でも印刷の画面は開く ── 開いた以上は全部出す。
 * 🔑 刷る直前(`beforeprint`)に欄の字を**そのまま写した箱**を欄の後ろへ置き、紙では欄と
 *   プレビューを隠して箱だけを出す(`app.css` 末尾の `@media print`)。刷り終えたら(`afterprint`)外す。
 * ⚠ 写すのは**字だけ**(`textContent`)── HTML として読まない。
 */
import { foldSpans } from '@features/markdown/heading-fold';
import { headingLevel } from './heading-fold';
import { bodyBlocks } from './log-days';

export const EDITOR_PRINT_FIELD = 'editor-print';

/** 刷る直前: 開いている編集欄ごとに、全文の写しを置く。置いた数を返す。 */
export function prepareEditorPrint(doc: Document): number {
  clearEditorPrint(doc);
  let n = 0;
  for (const ta of doc.querySelectorAll<HTMLTextAreaElement>('textarea[data-pkc-field="editor-body"]')) {
    const copy = doc.createElement('div');
    copy.setAttribute('data-pkc-field', EDITOR_PRINT_FIELD);
    copy.textContent = ta.value;
    ta.after(copy);
    n++;
  }
  return n;
}

/** 刷り終えたら: 置いた写しを全部外す(画面には出さない物なので、残すと次の描き直しまで DOM に溜まる)。 */
export function clearEditorPrint(doc: Document): void {
  for (const el of doc.querySelectorAll(`[data-pkc-field="${EDITOR_PRINT_FIELD}"]`)) el.remove();
}

/**
 * 🔴 **畳んだ折りたたみ(`:::details`)も紙に出す**(#1087)。書き出した HTML(`pkc3-html.ts`)は
 * 刷る直前に開いて刷り終えたら戻すが、アプリで刷ると畳んだ中身が紙から消えていた。
 * ⚠ CSS では `<details>` をこじ開けられない。⚠ 畳んでいた人の状態は壊さない(開けた物だけ覚えて戻す)。
 */
let reclose: HTMLDetailsElement[] = [];

/** 刷る直前: 畳んである折りたたみを開く。開けた数を返す。 */
export function openDetailsForPrint(doc: Document): number {
  restoreDetailsAfterPrint();
  for (const d of doc.querySelectorAll<HTMLDetailsElement>('details.pkc-details:not([open])')) {
    d.open = true;
    reclose.push(d);
  }
  return reclose.length;
}

/** 刷り終えたら: 開けた物だけ畳み直す。 */
export function restoreDetailsAfterPrint(): void {
  for (const d of reclose) d.open = false;
  reclose = [];
}

/**
 * 🔴 **見出しで畳んだ章も紙に出す**(#1163 依頼 116-1。推薦 A = 畳んだ章も全部開いて紙に出す)。
 * 畳みは塊に `hidden` を付けているだけなので、刷る直前に外し、刷り終えたら**外した塊だけ**戻す。
 * ⚠ 画面の畳み方(`data-pkc-folded`)には触らない ── 刷り終えれば元の見え方に戻る。
 */
let rehide: HTMLElement[] = [];

/** 刷る直前: 見出しの畳みで隠れている塊を出す。出した数を返す。 */
export function openHeadingFoldsForPrint(doc: Document): number {
  restoreHeadingFoldsAfterPrint();
  const hosts = new Set<HTMLElement>();
  for (const h of doc.querySelectorAll('[data-pkc-folded]')) {
    if (h.parentElement !== null) hosts.add(h.parentElement);
  }
  for (const host of hosts) {
    const blocks = bodyBlocks(host);
    for (const s of foldSpans(blocks.map(headingLevel))) {
      for (let i = s.from; i < s.to; i += 1) {
        const el = blocks[i];
        if (el instanceof HTMLElement && el.hidden) {
          el.hidden = false;
          rehide.push(el);
        }
      }
    }
  }
  return rehide.length;
}

/** 刷り終えたら: 出した塊だけ隠し直す。 */
export function restoreHeadingFoldsAfterPrint(): void {
  for (const el of rehide) el.hidden = true;
  rehide = [];
}

/** 窓に張る。外す関数を返す。 */
export function installEditorPrint(win: Window): () => void {
  const before = (): void => {
    void prepareEditorPrint(win.document);
    openDetailsForPrint(win.document);
    openHeadingFoldsForPrint(win.document);
  };
  const after = (): void => {
    clearEditorPrint(win.document);
    restoreDetailsAfterPrint();
    restoreHeadingFoldsAfterPrint();
  };
  win.addEventListener('beforeprint', before);
  win.addEventListener('afterprint', after);
  return () => {
    win.removeEventListener('beforeprint', before);
    win.removeEventListener('afterprint', after);
  };
}
