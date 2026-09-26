/**
 * 「章の保存を待つ」(#1044 段2 3巡目の修理、S1)。
 *
 * 🔴 **保存は effect が disk から読み直すので、結果は非同期でしか分からない**
 * (`SAVE_SECTION_DRAFT` の docstring 参照)。⚠ 直す前の binder は
 * `dispatcher.dispatch({ type: 'SAVE_SECTION_DRAFT', text }); if
 * (dispatcher.getState().sectionDraft === null) { … }` という**同期の判定**で
 * 「保存して移る」を実装していた ── 保存が effect 化された今、この判定は
 * **常に「まだ保存中」を読む**(ack はまだ届いていない)ので、成功しても
 * 移らない・断られても移ってしまう、の両方に壊れる。
 *
 * 🔑 だから「保存して移る」系の呼び手は、dispatch のあと**ここを await**する。
 */
import type { Dispatcher } from './dispatcher';

export type SectionSaveOutcome = 'saved' | 'failed';

/**
 * `SAVE_SECTION_DRAFT` を dispatch した**直後**に呼ぶ。
 *
 * - `sectionDraft === null`(既に成功して閉じている)→ 即 `'saved'`
 * - `sectionDraft.saving === false`(reducer が同期で断った ── phase 不正 /
 *   meta 不明 / 二重押しなど)→ 即 `'failed'`
 * - `sectionDraft.saving === true` → **ack まで待つ**(`SECTION_SAVED` で
 *   `sectionDraft` が `null` になるか、`SECTION_SAVE_FAILED` で
 *   `saving` が `false` に戻るまで)
 *
 * ⚠ 購読は必ず解く(`onState` は unsubscribe を返す ── 短命購読の規約)。
 */
export function waitSectionSaveSettled(dispatcher: Dispatcher): Promise<SectionSaveOutcome> {
  const st0 = dispatcher.getState();
  if (st0.sectionDraft === null) return Promise.resolve('saved');
  if (!st0.sectionDraft.saving) return Promise.resolve('failed');
  return new Promise((resolve) => {
    const off = dispatcher.onState((state) => {
      if (state.sectionDraft === null) {
        off();
        resolve('saved');
      } else if (!state.sectionDraft.saving) {
        off();
        resolve('failed');
      }
    });
  });
}
