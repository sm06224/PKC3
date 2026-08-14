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

/** 設定画面に出る一覧。⚠ label を変えたらマニュアルも直す(`docs-parity`)。 */
export const EDITOR_MODES = [
  { id: 'live', label: '1 面で編集(ライブ)' },
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
