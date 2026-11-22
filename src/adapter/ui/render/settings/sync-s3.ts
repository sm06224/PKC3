/**
 * 🔴 **S3 互換の保管先**(#2000 段 4a-4。user 裁定 2026-11-22)── 同期フォルダの節のすぐ下。
 *
 * AWS S3 / Cloudflare R2 / MinIO などの保管先を、同期フォルダの代わりに使う(回の中身は同期フォルダと同じ)。
 * - 揃える物(user 必須ガード): `<user>.github.io` の注意(独自ドメイン推奨)/ いまの画面の場所を埋めた CORS の設定の例 /
 *   「接続の確認」/「接続を外す(認証情報を消す)」。
 * - 🔴 認証情報の欄は押したときに読み、接続できたら空にする(画面にも設定にも残さない)。欄の字は設定の保存(`settings`)に入れない。
 * - 📌 `file://` では選べない(欄とボタンを止め、「HTTPS で開いたときだけ使えます」と言う)。
 * - ⚠ 設定「端末間の同期」がオフの間は押せない(同期フォルダと同じ)。
 */
import { s3CorsTemplate, sharedOriginHost } from '@features/sync/s3-cors';
import type { SyncFolderViewSource } from '../sync-folder-view';
import type { SyncEnabledStore } from '../sync-enabled';
import type { SettingsSection } from './section';
import { buildSettingsNote } from './note';

export const SYNC_S3_LABEL = 'S3 互換の保管先';
export const SYNC_S3_DISCONNECT_LABEL = '接続を外す(認証情報を消す)';
export const SYNC_S3_SHARED_ORIGIN_NOTE =
  'この画面は github.io の下で開いています。同じ持ち主の別のページは、この画面と同じ保存領域を使えるため、保存した認証情報を使えてしまいます。独自ドメインで開くことをおすすめします。';

/** 欄の定義(画面の並び)。`secret` = 接続できたら空にする欄。 */
const FIELDS: readonly { key: string; label: string; placeholder: string; secret?: boolean; title: string }[] = [
  { key: 'endpoint', label: 'エンドポイント', placeholder: 'https://<アカウント ID>.r2.cloudflarestorage.com', title: 'https:// で始まるホスト名まで(パスは付けません)。AWS S3 なら https://s3.<リージョン>.amazonaws.com' },
  { key: 'bucket', label: 'バケット', placeholder: 'my-notes', title: '保管先のバケットの名前' },
  { key: 'region', label: 'リージョン', placeholder: 'auto', title: 'R2 は auto のまま。AWS S3 は us-east-1 などのリージョン名' },
  { key: 'prefix', label: '置き場', placeholder: 'pkc3/', title: 'バケットの中のフォルダの名前(空ならバケットの直下)。ワークスペースごとに分けると混ざりません' },
  { key: 'access-key-id', label: 'アクセスキー ID', placeholder: '', secret: true, title: 'この保管先だけを読み書きできる、権限を絞ったアクセスキーをおすすめします' },
  { key: 'secret', label: 'シークレットアクセスキー', placeholder: '', secret: true, title: 'この端末にだけ、暗号化して保存します(画面・バックアップ・設定ファイルには残りません)' },
];

function button(action: string, label: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('data-pkc-action', action);
  b.textContent = label;
  b.title = title;
  return b;
}

export interface SyncS3Env {
  /** いまの画面の場所(CORS の設定の例に埋める)。 */
  origin(): string;
  hostname(): string;
}

const windowEnv: SyncS3Env = {
  origin: () => globalThis.location?.origin ?? '',
  hostname: () => globalThis.location?.hostname ?? '',
};

export function createSyncS3Section(region: HTMLElement, source: SyncFolderViewSource, enabled: SyncEnabledStore, env: SyncS3Env = windowEnv): SettingsSection {
  return {
    id: 'sync-s3',
    group: 'persist',
    build(): Node[] {
      const dt = document.createElement('dt');
      dt.textContent = SYNC_S3_LABEL;
      const dd = document.createElement('dd');
      dd.setAttribute('data-pkc-region', 'settings-sync-s3');
      const status = document.createElement('p');
      status.setAttribute('data-pkc-field', 'sync-s3-status');
      dd.append(status);
      // 🔴 github.io の注意(user 裁定)── 該当するときだけ、注意の色で出す
      if (sharedOriginHost(env.hostname())) {
        const warn = document.createElement('p');
        warn.setAttribute('data-pkc-field', 'sync-s3-shared-origin');
        warn.setAttribute('data-pkc-state', 'caution');
        warn.textContent = SYNC_S3_SHARED_ORIGIN_NOTE;
        dd.append(warn);
      }
      const grid = document.createElement('div');
      grid.setAttribute('data-pkc-field', 'sync-s3-fields');
      for (const f of FIELDS) {
        const label = document.createElement('label');
        const span = document.createElement('span');
        span.textContent = f.label;
        const input = document.createElement('input');
        input.type = f.key === 'secret' ? 'password' : 'text';
        input.setAttribute('data-pkc-field', `sync-s3-${f.key}`);
        input.placeholder = f.placeholder;
        input.title = f.title;
        input.spellcheck = false;
        input.autocomplete = f.secret === true ? 'off' : 'on';
        if (f.key === 'prefix') input.value = 'pkc3/';
        label.append(span, input);
        grid.append(label);
      }
      const bar = document.createElement('div');
      bar.append(
        button('test-sync-s3', '接続の確認', '保存せずに、保管先の一覧を読んでみます(書き込めるかは、接続したあとの最初の同期で確かめます)'),
        button('connect-sync-s3', '接続する', '確かめてから、認証情報をこの端末に暗号化して保存し、保管先と同期し始めます。同期フォルダを使っていたら、そちらはやめます'),
        button('sync-folder-now', '今すぐ同期', '保管先と、いますぐ同期します。初めての端末があれば、ここで確認します'),
        button('disconnect-sync-s3', SYNC_S3_DISCONNECT_LABEL, 'この端末で保管先を使うのをやめ、保存した認証情報を消します(保管先の中のファイルは消しません)'),
      );
      const result = document.createElement('p');
      result.setAttribute('data-pkc-field', 'sync-s3-result');
      result.setAttribute('aria-live', 'polite');
      // 🔴 CORS の設定の例(いまの画面の場所を埋める)
      const corsHead = document.createElement('p');
      corsHead.setAttribute('data-pkc-field', 'sync-s3-cors-head');
      corsHead.textContent = '保管先の CORS の設定(この画面の場所を入れてあります):';
      const cors = document.createElement('pre');
      cors.setAttribute('data-pkc-field', 'sync-s3-cors');
      cors.textContent = s3CorsTemplate(env.origin());
      const copy = button('copy-sync-s3-cors', 'CORS の設定をコピー', '上の CORS の設定をコピーします。保管先の画面(R2 なら「設定 → CORS ポリシー」)に貼ってください');
      const notes: Node[] = [];
      for (const t of [
        '端末ごとのファイルを保管先に置き、ほかの端末のファイルを取り込みます(同期フォルダと同じ仕組み)。',
        '認証情報は、この端末にだけ暗号化して保存します。バックアップや設定ファイルには入りません。',
        '条件付き書き込みに対応した保管先(AWS S3・Cloudflare R2・MinIO など)で使えます。',
      ]) notes.push(buildSettingsNote(t));
      dd.append(grid, bar, result, corsHead, cors, copy, ...notes);
      return [dt, dd];
    },
    sync(): void {
      const dd = region.querySelector<HTMLElement>('[data-pkc-region="settings-sync-s3"]');
      if (dd === null) return;
      const v = source.view();
      const on = enabled.enabled();
      const unavailable = v?.remoteUnavailable ?? null;
      const connected = v?.kind === 's3';
      const usable = on && unavailable === null && v !== null;
      let text: string;
      if (unavailable !== null) text = unavailable;
      else if (!on) text = '設定の「端末間の同期」をオンにすると使えます';
      else if (!connected) text = v?.kind === 'folder' ? '使っていません(いまは同期フォルダと同期しています)' : '使っていません';
      else {
        const phase = v?.phase;
        const state =
          phase === 'running' ? '同期しています…' : phase === 'stopped' ? '止まっています' : v?.lastAt != null ? `最終同期 ${v.lastAt}(${v.lastText ?? ''})` : '同期を待っています';
        text = `「${v?.folderName ?? ''}」: ${state}${v?.message != null ? `。${v.message}` : ''}`;
      }
      const status = dd.querySelector<HTMLElement>('[data-pkc-field="sync-s3-status"]');
      if (status !== null && status.textContent !== text) status.textContent = text;
      for (const input of dd.querySelectorAll<HTMLInputElement>('[data-pkc-field="sync-s3-fields"] input')) input.disabled = !usable;
      // 接続しているときは、接続先(秘密でない物)を欄に戻す ── 入れ直しは認証情報だけで済む
      const cfg = v?.remoteConfig ?? null;
      if (cfg !== null && dd.getAttribute('data-pkc-s3-filled') !== `${cfg.endpoint}|${cfg.bucket}|${cfg.region}|${cfg.prefix}`) {
        for (const [k, val] of [['endpoint', cfg.endpoint], ['bucket', cfg.bucket], ['region', cfg.region], ['prefix', cfg.prefix]] as const) {
          const el = dd.querySelector<HTMLInputElement>(`[data-pkc-field="sync-s3-${k}"]`);
          if (el !== null) el.value = val;
        }
        dd.setAttribute('data-pkc-s3-filled', `${cfg.endpoint}|${cfg.bucket}|${cfg.region}|${cfg.prefix}`);
      }
      const q = (a: string): HTMLButtonElement | null => dd.querySelector<HTMLButtonElement>(`[data-pkc-action="${a}"]`);
      const test = q('test-sync-s3');
      const connect = q('connect-sync-s3');
      const now = q('sync-folder-now');
      const disconnect = q('disconnect-sync-s3');
      if (test !== null) test.disabled = !usable;
      if (connect !== null) {
        connect.disabled = !usable;
        connect.textContent = connected ? '接続し直す' : '接続する';
      }
      if (now !== null) {
        now.hidden = !connected;
        now.disabled = !usable || v?.phase === 'running';
      }
      if (disconnect !== null) disconnect.hidden = !connected;
      const copy = q('copy-sync-s3-cors');
      if (copy !== null) copy.disabled = unavailable !== null;
    },
  };
}
