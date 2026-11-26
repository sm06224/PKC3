/**
 * 編集の仕方(Issue #104 第 2 弾。user 裁定 2026-08-08
 * 「既定でONかつ設定で2ペイン編集はできるようにする」)。
 *
 * ⚠ **flag ではない**(正規設定 ── user 指示 2026-07-30「正規設定と分離」)。
 *   flag `editor.live` はこの昇格で退役し、15 枠のうち 1 を返した。
 * ⚠ **URL パラメータも作らない**(user 指示 2026-08-07「クエリパラメータを
 *   抜け穴にしてはいけない」── `tests/features/flags.test.ts` の全数検査が落とす)。
 * ⚠ ここは純関数だけ(features 層)。保存と読みは
 *   `adapter/ui/render/editor-mode.ts`(`page-format.ts` と同じ分け方)。
 */

/**
 * 設定画面に出る一覧。⚠ label を変えたらマニュアルも直す(`docs-parity`)。
 *
 * 🔴 **`rich`(リッチ編集)は 2026-11-26 に flag `editor.rich` から昇格した**(v4.0 Phase 1 / PR-06。ビジョン 4-B)。
 *   1 画面編集の一種で、押したブロックが単純な段落・見出し・引用・リスト項目なら記号を隠して直接編集する
 *   (保存の正本はプレーンな PKC-Markdown のまま。表せない記法のブロックは自動で原文の編集になる)。
 *   flag は退役して 15 枠のうち 1 を返した(`editor.live` と同じ作法)。
 */
export const EDITOR_MODES = [
  { id: 'live', label: '1 画面で編集(ライブ)' },
  { id: 'rich', label: 'リッチ編集(記号を隠して編集)' },
  { id: 'split', label: '2 ペイン(原文とプレビュー)' },
] as const;

export type EditorMode = (typeof EDITOR_MODES)[number]['id'];

/**
 * 🔴 既定は **live**(user 裁定 2026-08-08「既定でON」)。
 * 前提だった「塊を跨ぐ取り消し」(S8)と操作 5 項目(#104 第 1 弾)は実装済み。
 */
export const DEFAULT_EDITOR_MODE: EditorMode = 'live';

/** ⚠ 引き当てられない値では**既定へ落ちる**(壊れた設定で編集不能にしない)。 */
export function isEditorMode(v: string): v is EditorMode {
  return EDITOR_MODES.some((m) => m.id === v);
}

/** 1 画面の編集(押したブロックをその場で開く)か。`live` と `rich` が当たる(`rich` は 1 画面編集の一種)。 */
export function isOnePaneEditorMode(mode: EditorMode): boolean {
  return mode === 'live' || mode === 'rich';
}

/** 押したブロックをリッチ編集のセルで開くか(`rich` だけ)。 */
export function isRichEditorMode(mode: EditorMode): boolean {
  return mode === 'rich';
}
