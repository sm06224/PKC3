/**
 * 🔴 **書式の効く先の欄**(binder から取り出した ── #950 ①)。
 *
 * ⚠ 取り出した理由は 1 つ:**押したときに効く欄**(binder)と、**押す前に「選んでいるか」を
 *   読む欄**(帯の説明の切替 `render/format-wrap-hint.ts`)が**同じ欄を指さなければ**、
 *   説明は「囲みます」と言うのに押すと別の欄に効く、が静かに生まれる(CLAUDE.md §7)。
 */

/** いま画面に出ている編集欄(root にスコープする ── document 全域は他 root を拾う)。 */
export function editorBody(root: HTMLElement): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>(
    '[data-pkc-region="detail"] [data-pkc-field="editor-body"]',
  );
}

/**
 * 🔴 **書式の効く先**(2026-08-08)。2 列なら `editor-body`、live の 1 面なら
 * **活性の行の入力欄**(`row-source`)── 直す前は live 面で書式パネルと
 * Ctrl+B/I/K が `editor-body` を探して**無言 no-op** だった(押しても何も
 * 起きず、理由もどこにも出ない)。
 * ⚠ 2 つは同時には存在しない(live ↔ 2 列は排他。live の退避は `editor-body`)。
 * ⚠ `writeBack` の `value` 直代入は行の中の Ctrl+Z を捨てる ── 行は Escape で
 * 丸ごと戻せるので、2 列の editor と同じ理由で受け入れる。
 */
export function formatTarget(root: HTMLElement): HTMLTextAreaElement | null {
  return (
    root.querySelector<HTMLTextAreaElement>(
      '[data-pkc-region="detail"] [data-pkc-field="row-source"]',
    ) ?? editorBody(root)
  );
}
