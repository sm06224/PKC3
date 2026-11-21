/**
 * 🔴 **同期フォルダ**(#2000 段 3)── 端末間の同期の節のすぐ下。
 *
 * クラウドドライブの中のフォルダを選ぶと、そこを通して他の端末と自動で同期する(人がファイルを運ばない)。
 * ⚠ 設定「端末間の同期」がオフの間は押せない(何も保存しない・何も回らない)。
 * ⚠ 選べないブラウザ(Safari・Firefox・スマホ)では理由を言い、差分ファイルの手渡しを案内する。
 * 🔴 選んだら「やめる」で戻せる(片道にしない)。許可が切れたら「許可を出し直す」を出す。
 */
import { SYNC_FOLDER_MINUTES } from '@features/sync/sync-folder';
import type { SyncFolderViewSource } from '../sync-folder-view';
import type { SyncEnabledStore } from '../sync-enabled';
import type { SettingsSection } from './section';
import { buildSettingsNote } from './note';

export const SYNC_FOLDER_LABEL = '同期フォルダ';

function button(action: string, label: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('data-pkc-action', action);
  b.textContent = label;
  b.title = title;
  return b;
}

export function createSyncFolderSection(region: HTMLElement, source: SyncFolderViewSource, enabled: SyncEnabledStore): SettingsSection {
  return {
    id: 'sync-folder',
    group: 'persist',
    build(): Node[] {
      const dt = document.createElement('dt');
      dt.textContent = SYNC_FOLDER_LABEL;
      const dd = document.createElement('dd');
      dd.setAttribute('data-pkc-region', 'settings-sync-folder');
      const status = document.createElement('p');
      status.setAttribute('data-pkc-field', 'sync-folder-status');
      const bar = document.createElement('div');
      const pick = button(
        'pick-sync-folder',
        '同期フォルダを選ぶ…',
        'クラウドドライブ(OneDrive・Google ドライブ・Dropbox などのパソコン版)が同期しているフォルダを選びます。空のフォルダを 1 つ作って選ぶのがおすすめです',
      );
      const now = button('sync-folder-now', '今すぐ同期', '同期フォルダと、いますぐ同期します。初めての端末があれば、ここで確認します');
      const reconnect = button('reconnect-sync-folder', '許可を出し直す', 'ブラウザを開き直すと、フォルダを読み書きする許可が切れることがあります。押すと許可を求めます');
      const stop = button('stop-sync-folder', '同期フォルダをやめる', 'この端末で同期フォルダを使うのをやめます(フォルダの中のファイルは消しません)');
      const label = document.createElement('label');
      label.textContent = '間隔 ';
      const select = document.createElement('select');
      select.setAttribute('data-pkc-action', 'set-sync-folder-minutes');
      select.setAttribute('data-pkc-field', 'sync-folder-minutes');
      select.title = 'この画面を開いている間、この間隔で同期します(隠れている間は同期しません。画面に戻ったときに、間隔を過ぎていれば同期します)';
      for (const m of SYNC_FOLDER_MINUTES) {
        const o = document.createElement('option');
        o.value = String(m);
        o.textContent = `${m} 分ごと`;
        select.append(o);
      }
      label.append(select);
      bar.append(pick, now, reconnect, stop, label);
      const notes: Node[] = [];
      for (const t of [
        'クラウドドライブのフォルダを選ぶと、端末ごとに 1 つのファイル(pkc3-<端末の ID>.pkc3-diff.zip)を置き、ほかの端末のファイルを取り込みます。ファイルを自分で運ぶ必要はありません。',
        'ノートの本文・題名・フォルダの置き場所・つながり・添付・色ラベル・ピン留め・削除を運びます。両方で変えたノートは、両方残します(差分ファイルと同じ)。',
        'この画面を開いている間だけ同期します。初めての端末と同期するときは、どちらかの端末で 1 度だけ確認します。',
        'パソコンの Chrome・Edge で使えます。スマホや Safari・Firefox では、差分ファイルの書き出しと取り込みを使ってください。',
      ]) notes.push(buildSettingsNote(t));
      dd.append(status, bar, ...notes);
      return [dt, dd];
    },
    sync(): void {
      const dd = region.querySelector<HTMLElement>('[data-pkc-region="settings-sync-folder"]');
      if (dd === null) return;
      const v = source.view();
      const on = enabled.enabled();
      const phase = v?.phase ?? (on ? 'none' : 'off');
      const status = dd.querySelector<HTMLElement>('[data-pkc-field="sync-folder-status"]');
      const q = (a: string): HTMLButtonElement | null => dd.querySelector<HTMLButtonElement>(`[data-pkc-action="${a}"]`);
      const pick = q('pick-sync-folder');
      const now = q('sync-folder-now');
      const reconnect = q('reconnect-sync-folder');
      const stop = q('stop-sync-folder');
      const select = dd.querySelector<HTMLSelectElement>('[data-pkc-field="sync-folder-minutes"]');
      const hasFolder = v?.folderName != null;
      let text: string;
      if (phase === 'unsupported') text = v?.message ?? '';
      else if (!on) text = '設定の「端末間の同期」をオンにすると使えます';
      // ⚠ 選んでいない状態にも理由がありうる(読み込みの見張りが handle を捨てた等)── 言わずに「まだ」とだけ出さない
      else if (!hasFolder) text = v?.message != null ? `まだ選んでいません。${v.message}` : 'まだ選んでいません';
      else {
        const head = `「${v?.folderName}」`;
        const state =
          phase === 'running'
            ? '同期しています…'
            : phase === 'permission'
              ? '許可が切れています'
              : phase === 'stopped'
                ? '止まっています'
                : v?.lastAt != null
                  ? `最終同期 ${v.lastAt}(${v.lastText ?? ''})`
                  : '同期を待っています';
        text = `${head}: ${state}${v?.message != null ? `。${v.message}` : ''}`;
      }
      if (status !== null && status.textContent !== text) status.textContent = text;
      const usable = on && phase !== 'unsupported';
      if (pick !== null) {
        pick.disabled = !usable;
        pick.textContent = hasFolder ? '別のフォルダを選ぶ…' : '同期フォルダを選ぶ…';
      }
      if (now !== null) {
        now.hidden = !hasFolder || phase === 'permission';
        now.disabled = !usable || phase === 'running';
      }
      if (reconnect !== null) reconnect.hidden = !(hasFolder && phase === 'permission' && on);
      if (stop !== null) stop.hidden = !hasFolder;
      if (select !== null) {
        select.disabled = !usable || !hasFolder;
        const want = String(v?.minutes ?? 5);
        if (select.value !== want) select.value = want;
      }
    },
  };
}
