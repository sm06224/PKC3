/**
 * Markdown プレビュー内のインラインコード（`code`）ワンクリックコピー (Issue #1148).
 *
 * コマンドや識別子、設定値など、本文中のインラインコードをクリックして
 * 即座にクリップボードへコピーできるようにする。
 *
 * 規律:
 * - `pre > code` (コードブロック) は `copy-md-block` があるため対象外。
 * - `a > code` (リンク内) はリンク遷移を妨げないため対象外。
 * - テキスト選択中のクリックは誤爆防止のためコピーしない。
 * - 冪等性: 何度呼んでも二重にリスナーを張らない。
 */
import { copyPlainText } from '@adapter/platform/clipboard';
import { flashCopied } from '../actions/copy-md-block';

export const INLINE_CODE_ATTR = 'data-pkc-inline-code';

/**
 * プレビュー画面内のインラインコードにワンクリックコピー機能を適用する。
 */
export function applyInlineCodeCopy(root: HTMLElement): void {
  const codes = root.querySelectorAll<HTMLElement>('code');
  for (const code of codes) {
    // 既存の装飾済みならスキップ (冪等性)
    if (code.hasAttribute(INLINE_CODE_ATTR)) continue;

    // コードブロック内 (`pre > code`) は除外 (ブロック側で copy-md-block を持つ)
    if (code.closest('pre') !== null) continue;

    // リンク内 (`a > code`) は除外 (リンク遷移優先)
    if (code.closest('a') !== null) continue;

    const text = code.textContent?.trim() ?? '';
    if (text === '') continue;

    code.setAttribute(INLINE_CODE_ATTR, 'true');
    code.setAttribute('title', 'クリックでコピー');

    code.addEventListener('click', (ev) => {
      // テキスト選択中(ドラッグによる文字列選択)の場合はコピーを抑止
      const selection = window.getSelection();
      if (selection && selection.toString().trim().length > 0) return;

      const raw = code.textContent ?? '';
      if (raw === '') return;

      ev.preventDefault();
      ev.stopPropagation();

      void copyPlainText(raw).then((ok) => {
        if (ok) flashCopied(code);
      });
    });
  }
}
