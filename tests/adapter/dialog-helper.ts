/**
 * 🔴 **自前の確認ダイアログを test から押す**(#299 段②)。
 *
 * ⚠ **裏口ではない。** `window.confirm` を捨てたので「確認が無い環境」という
 *   状態そのものが無くなった ── test も実機も**同じように押す**。
 *   それがこの差し替えの目的である(確認の枝は、いままで unit から
 *   **1 度も実行されていなかった** ── CLAUDE.md §2)。
 *
 * ⚠ **答えは非同期に返る**ので、押したあと **microtask を 1 周**待つ。
 *   待たずに assert すると「押したのに何も起きない」と読み違える。
 */
import { expect } from 'vitest';
import { DIALOG_REGION } from '../../src/adapter/ui/render/app-dialog';

/**
 * いま開いている確認ダイアログ(無ければ `null`)。
 *
 * ⚠ **最初の 1 つを取らない。** test は器を作り直すので、前の it が残した
 *   **閉じたダイアログ**が document に居ることがある ── `querySelector` で
 *   先頭を取ると、そちらに当たって「開いていない」と読む(実際に踏んだ)。
 * 🔑 **開いているものを探す**。
 */
export function openDialog(doc: Document = document): HTMLDialogElement | null {
  const all = doc.querySelectorAll<HTMLDialogElement>(`[data-pkc-region="${DIALOG_REGION}"]`);
  return [...all].find((el) => el.open) ?? null;
}

/** 確認の本文(出ていなければ空文字)。⚠ **開いているもの**から取る。 */
export function dialogMessage(doc: Document = document): string {
  return openDialog(doc)?.querySelector('[data-pkc-field="dialog-body"]')?.textContent ?? '';
}

/**
 * 確認に答える。⚠ **開いていなければ落とす** ── 「確認が出ていない」ことを
 *   静かに通すと、確認を消す変異が生き延びる(空振り防止)。
 */
export async function answerDialog(
  answer: 'ok' | 'cancel',
  doc: Document = document,
): Promise<void> {
  const dialog = openDialog(doc);
  expect(dialog, '確認のダイアログが開いていない').not.toBeNull();
  const field = answer === 'ok' ? 'dialog-ok' : 'dialog-cancel';
  // ⚠ 押す口も**開いているダイアログの中**から取る(残骸を押さない)
  dialog?.querySelector<HTMLButtonElement>(`[data-pkc-field="${field}"]`)?.click();
  // ⚠ Promise の解決 → 続きの dispatch まで進める
  await Promise.resolve();
  await Promise.resolve();
}
