/**
 * 🔴 **端末間の同期**(#2000 段 2。user 裁定 2026-11-21: 任意の設定・既定は切)。
 * ⚠ **できることと、しないことを先に書く** ── 通信はしない(差分ファイルを自分で受け渡す)。オンにすると
 *   「差分を書き出す」が出て、ノートを消したときに「削除の記録」を残す(切の間は何も記録しない)。
 */
import type { SyncEnabledStore } from '../sync-enabled';
import { appSyncFolderView, type SyncFolderViewHolder } from '../sync-folder-view';
import { SYNC_FORGET_LABEL, SYNC_SETTING_LABEL } from '@features/sync/sync-setting';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import type { SettingsSection } from './section';

export function createSyncEnabledSection(region: HTMLElement, store: SyncEnabledStore, folderView: SyncFolderViewHolder = appSyncFolderView): SettingsSection {
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
      // 🔴 フォルダで同期する(全データ。段 3)── オンのときだけ出す。状態と押す物は `sync()` が映す
      const box = document.createElement('div');
      box.setAttribute('data-pkc-field', 'sync-folder');
      box.hidden = true;
      const head = document.createElement('p');
      head.setAttribute('data-pkc-field', 'sync-folder-head');
      head.textContent = 'フォルダで同期する(クラウドのフォルダなどを、複数の端末で選びます)';
      const note = document.createElement('p');
      note.setAttribute('data-pkc-field', 'sync-folder-note');
      note.textContent =
        '各端末が自分のファイル(<端末 ID>.pkc3-diff.zip)をフォルダの「pkc3-sync」に置き、他の端末のファイルを取り込みます。ノート・つながり・添付・色ラベル・ピン留めを運びます。1 分ごと・開き直したとき・「今すぐ同期」で同期します。色ラベルが両方で違う色になったときは、色の番号が大きい方にそろえます。';
      const status = document.createElement('p');
      status.setAttribute('data-pkc-field', 'sync-folder-status');
      const btn = (action: string, label: string, title: string): HTMLButtonElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('data-pkc-action', action);
        b.textContent = label;
        b.title = title;
        return b;
      };
      const pick = btn('sync-folder-pick', 'フォルダを選ぶ…', '同期するフォルダを選びます。選んだフォルダは次に開いたときも覚えています(許可が切れていれば、もう一度許可を求めます)');
      const grant = btn('sync-folder-grant', '許可する', '保存してあるフォルダへのアクセスを、もう一度許可します');
      const now = btn('sync-folder-now', '今すぐ同期', 'いま 1 回、他の端末のファイルを取り込み、この端末の変更を書き出します');
      const release = btn('sync-folder-release', 'フォルダの設定を外す', '保存したフォルダの設定を外します(フォルダの中のファイルとノートには何もしません。もう一度「フォルダを選ぶ…」で選べます)');
      box.append(head, note, status, pick, grant, now, release);
      row.dd.append(box);
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'sync-enabled', () => store.enabled());
      const box = region.querySelector<HTMLElement>('[data-pkc-field="sync-folder"]');
      if (box === null) return;
      const v = folderView.view();
      box.hidden = !store.enabled() || v === null;
      if (box.hidden || v === null) return;
      const show = (action: string, on: boolean): void => {
        const b = box.querySelector<HTMLButtonElement>(`[data-pkc-action="${action}"]`);
        if (b !== null) b.hidden = !on;
      };
      const unsupported = v.phase === 'unsupported';
      const has = v.folderName !== null;
      show('sync-folder-pick', !unsupported);
      show('sync-folder-grant', v.phase === 'needs-permission');
      show('sync-folder-now', has && (v.phase === 'idle' || v.phase === 'running'));
      show('sync-folder-release', has);
      const pickBtn = box.querySelector<HTMLButtonElement>('[data-pkc-action="sync-folder-pick"]');
      if (pickBtn !== null) pickBtn.textContent = has ? 'フォルダを選び直す…' : 'フォルダを選ぶ…';
      const lines: string[] = [];
      if (has) lines.push(`フォルダ: ${v.folderName ?? ''}`);
      if (v.lastText !== null) lines.push(`${v.lastAt ?? ''} ${v.lastText}`.trim());
      if (v.message !== null) lines.push(v.message);
      if (v.pendingPeers.length > 0) lines.push(`確認が要る相手: ${v.pendingPeers.map((d) => d.slice(0, 4)).join(' / ')}(「今すぐ同期」で確認します)`);
      const status = box.querySelector<HTMLElement>('[data-pkc-field="sync-folder-status"]');
      if (status !== null) status.textContent = lines.join(' / ');
    },
  };
}
