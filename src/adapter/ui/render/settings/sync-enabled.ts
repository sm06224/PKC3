/**
 * 🔴 **端末間の同期**(#2000 段 2。user 裁定 2026-11-21: 任意の設定・既定は切)。
 * ⚠ **できることと、しないことを先に書く** ── 通信するのは保管先(S3 互換。段 4a-4)を選んだときだけ(それ以外は差分ファイルを自分で受け渡す)。オンにすると
 *   「差分を書き出す」が出て、ノートを消したときに「削除の記録」を残す(切の間は何も記録しない)。
 */
import type { SyncEnabledStore } from '../sync-enabled';
import { SYNC_FORGET_LABEL, SYNC_SETTING_LABEL } from '@features/sync/sync-setting';
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
          '保管先を選んだときだけ通信します。それ以外は、差分ファイルを USB やクラウドのフォルダで自分で受け渡します。',
          '両方で変えたノートは消さずに両方残します。残したノートは、題名の末尾に「(同期の競合 日付)」が付いた別のノートになります(専用の一覧はありません。取り込み結果の「競合のノートを一覧する」ボタンか、検索で「同期の競合」を探すと出ます)。見比べて、不要な方をゴミ箱へ移し、残す方の題名から「(同期の競合 日付)」の部分を消してください。',
          '別の端末で消えたノートは、ゴミ箱へ移します(戻せます)。',
          'オンにしたあとに消したノートから、削除の記録を残します(ゴミ箱を空にしても残ります)。オフの間に消したノートは相手へ伝わらず、あとで同期するとそのノートが相手から戻ることがあります。',
        ],
      });
      // 🔴 相手との対応づけ(ワークスペースの対応)は取り消せる ── 片道にしない
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.setAttribute('data-pkc-action', 'forget-sync-records');
      forget.textContent = SYNC_FORGET_LABEL;
      forget.title = '端末の ID・相手との対応・前回の同期の記録・削除の記録を、すべてのワークスペースぶん消します(ノートは消えません)。次の同期は初回の同期からになります。';
      row.dd.append(forget);
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'sync-enabled', () => store.enabled());
    },
  };
}
