/**
 * 🔴 **同期の範囲(選択同期)**(#2066 段 5-B)── 端末間の同期の節のすぐ下。
 *
 * - **同期がオンのときだけ出す**(オフの間は見出しごと隠す。何も読まない)。
 * - 範囲: 「コレクション全体(既定)」/「選んだエントリだけ同期(選択同期)」。
 * - 選択同期のときだけ、関連エントリの自動同伴・対象の件数・「選択をすべて外す」・注記を出す。
 * ⚠ 正本は storage の行(`syncSetSelectiveScope`)、画面は `state.syncScope`(写し)を読む。押した瞬間の見かけは
 *   `buildChoiceRow` が自分で移し、正本を読み直した写しで `sync` が上書きする。
 */
import type { AppState } from '@adapter/state/app-state';
import { selectiveActive, selectiveSummaryText, SELECTIVE_CLEAR_LABEL } from '@features/sync/selective-view';
import type { SyncEnabledStore } from '../sync-enabled';
import { buildChoiceRow, syncChoiceRow } from '../choice-buttons';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export const SYNC_SCOPE_LABEL = '同期の範囲';
export const SYNC_RELATED_LABEL = '関連項目も自動で同期';
export const SYNC_SCOPE_MODE_ATTR = 'data-pkc-sync-scope-mode';
export const SYNC_SCOPE_RELATED_ATTR = 'data-pkc-sync-scope-related';
export const SYNC_SCOPE_MODE_FIELD = 'sync-scope-mode';
export const SYNC_SCOPE_RELATED_FIELD = 'sync-scope-related';
export const SYNC_SELECTIVE_NOTE =
  '同期対象から外しても、他の端末からノートは削除されません。相手端末から届いた新しいノートは同期対象へ自動的に加わります。';

export function createSyncSelectiveSection(region: HTMLElement, enabled: SyncEnabledStore): SettingsSection {
  return {
    id: 'sync-selective',
    group: 'persist',
    build(): Node[] {
      const dt = document.createElement('dt');
      dt.setAttribute('data-pkc-field', 'sync-selective-term');
      dt.textContent = SYNC_SCOPE_LABEL;
      const dd = document.createElement('dd');
      dd.setAttribute('data-pkc-region', 'settings-sync-selective');
      const mode = buildChoiceRow({
        field: SYNC_SCOPE_MODE_FIELD,
        ariaLabel: SYNC_SCOPE_LABEL,
        action: 'set-sync-scope-mode',
        dataAttr: SYNC_SCOPE_MODE_ATTR,
        choices: [
          { id: 'all', label: 'コレクション全体(既定)' },
          { id: 'selective', label: '選んだエントリだけ同期(選択同期)' },
        ],
        currentId: '',
      });
      mode.title = '他の端末と同期するエントリの範囲です。選択同期では、選んだエントリ(フォルダなら配下も)だけを運び、それ以外はこの端末だけに残します';
      const detail = document.createElement('div');
      detail.setAttribute('data-pkc-field', 'sync-selective-detail');
      const relatedHead = document.createElement('p');
      relatedHead.setAttribute('data-pkc-field', 'sync-selective-related-label');
      relatedHead.textContent = SYNC_RELATED_LABEL;
      const related = buildChoiceRow({
        field: SYNC_SCOPE_RELATED_FIELD,
        ariaLabel: SYNC_RELATED_LABEL,
        action: 'set-sync-scope-related',
        dataAttr: SYNC_SCOPE_RELATED_ATTR,
        choices: [
          { id: 'off', label: '含めない' },
          { id: '1hop', label: '直接の関連まで(1 段階・既定)' },
          { id: 'recursive', label: '関連先を再帰的に含める' },
        ],
        currentId: '',
      });
      related.title = '同期対象のエントリとつながっているエントリ(つながり・本文のリンク)も一緒に同期するかを選びます';
      const summary = document.createElement('p');
      summary.setAttribute('data-pkc-field', 'sync-selective-summary');
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.setAttribute('data-pkc-action', 'clear-sync-selection');
      clear.textContent = SELECTIVE_CLEAR_LABEL;
      clear.title = '直接指定した同期対象を、すべて外します(押すと確認します)。ノート自体は消えません';
      detail.append(relatedHead, related, summary, clear, buildSettingsNote(SYNC_SELECTIVE_NOTE));
      dd.append(mode, detail);
      return [dt, dd];
    },
    sync(state: AppState): void {
      const dd = region.querySelector<HTMLElement>('[data-pkc-region="settings-sync-selective"]');
      const dt = region.querySelector<HTMLElement>('[data-pkc-field="sync-selective-term"]');
      if (dd === null) return;
      // 🔴 同期がオフの間は見出しごと隠す
      const on = enabled.enabled();
      const view = state.syncScope;
      if (dd.hidden !== !on) dd.hidden = !on;
      if (dt !== null && dt.hidden !== !on) dt.hidden = !on;
      if (!on) return;
      syncChoiceRow(dd, SYNC_SCOPE_MODE_FIELD, SYNC_SCOPE_MODE_ATTR, view?.mode ?? '');
      const detail = dd.querySelector<HTMLElement>('[data-pkc-field="sync-selective-detail"]');
      const active = selectiveActive(view);
      if (detail !== null && detail.hidden !== !active) detail.hidden = !active;
      if (!active) return;
      syncChoiceRow(dd, SYNC_SCOPE_RELATED_FIELD, SYNC_SCOPE_RELATED_ATTR, view.related);
      const summary = dd.querySelector<HTMLElement>('[data-pkc-field="sync-selective-summary"]');
      const text = selectiveSummaryText(view.counts);
      if (summary !== null && summary.textContent !== text) summary.textContent = text;
      const clear = dd.querySelector<HTMLButtonElement>('[data-pkc-action="clear-sync-selection"]');
      if (clear !== null) clear.disabled = view.directLids.size === 0;
    },
  };
}
