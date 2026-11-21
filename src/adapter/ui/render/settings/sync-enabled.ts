/**
 * 🔴 **端末間の同期**(#2000 段 2。user 裁定 2026-11-21: 任意の設定・既定は切)。
 * ⚠ **できることと、しないことを先に書く** ── 通信はしない(差分ファイルを自分で受け渡す)。オンにすると
 *   「差分を書き出す」が出て、ノートを消したときに「削除の記録」を残す(切の間は何も記録しない)。
 */
import type { SyncEnabledStore } from '../sync-enabled';
import { SYNC_SETTING_LABEL } from '@features/sync/sync-setting';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import type { SettingsSection } from './section';

export function createSyncEnabledSection(region: HTMLElement, store: SyncEnabledStore): SettingsSection {
  return {
    id: 'sync-enabled',
    group: 'persist',
    build(): Node[] {
      const row = buildCheckboxRow({
        term: SYNC_SETTING_LABEL,
        action: 'set-sync-enabled',
        field: 'sync-enabled',
        label: ' 別の端末と、差分ファイルで同期する',
        title:
          'オンにすると、コレクションの「書き出す ▾」に「差分を書き出す」が出て、別の端末が書き出した差分ファイル(.pkc3-diff.zip)を取り込めます。' +
          'オフのときは、同期のための記録を何も残しません。',
        notes: [
          '通信はしません。差分ファイルを USB やクラウドのフォルダで自分で受け渡します。',
          '両方で変えたノートは消さずに両方残し、競合の一覧に出します。別の端末で消えたノートは、ゴミ箱へ移します(戻せます)。',
          'オンにしたあとに消したノートから、削除の記録を残します(ゴミ箱を空にしても残ります)。',
        ],
      });
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'sync-enabled', () => store.enabled());
    },
  };
}
