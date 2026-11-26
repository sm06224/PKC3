/**
 * 🔴 **選択同期の一覧の印**(#2066 段 5-B)── 左の列(`filer.ts`)と 2 ペイン(`dual-filer.ts`)が同じ 1 つを使う。
 * ⚠ 出す / 出さないの判定は `selectiveActive` 1 つ(同期が切・ワークスペース全体なら何も付けない)。
 */
import type { AppState } from '@adapter/state/app-state';
import { SELECTIVE_REASON_HINTS, SELECTIVE_REASON_LABELS, selectiveActive } from '@features/sync/selective-view';
import type { SelectiveReason } from '@features/sync/selective-sync';
/** 🔴 選択同期の理由(#2066 段 5-B)。効いていない(同期が切・ワークスペース全体)・対象外は `undefined`。 */
export function syncReasonOf(state: Pick<AppState, 'syncScope'>, lid: string): SelectiveReason | undefined {
  const view = state.syncScope;
  return selectiveActive(view) ? view.reasons.get(lid) : undefined;
}

/**
 * 🔴 **選択同期の印**(#2066 段 5-B)── 題名の右の小さな無彩色の印。形で理由を分ける(CSS。色は使わない)。
 * ⚠ 字は持たない(題名の文字列・読み上げを汚さない)── 理由は `title` と `aria-label` で読む。
 */
export function syncScopeMark(reason: SelectiveReason): HTMLSpanElement {
  const mark = document.createElement('span');
  mark.setAttribute('data-pkc-field', 'sync-scope-mark');
  mark.setAttribute('data-pkc-sync-scope', reason);
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', SELECTIVE_REASON_LABELS[reason]);
  mark.title = `${SELECTIVE_REASON_LABELS[reason]}: ${SELECTIVE_REASON_HINTS[reason]}`;
  return mark;
}
