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

/** 窓に張る。外す関数を返す。 */
export function installEditorPrint(win: Window): () => void {
  const before = (): void => void prepareEditorPrint(win.document);
  const after = (): void => clearEditorPrint(win.document);
  win.addEventListener('beforeprint', before);
  win.addEventListener('afterprint', after);
  return () => {
    win.removeEventListener('beforeprint', before);
    win.removeEventListener('afterprint', after);
  };
}
