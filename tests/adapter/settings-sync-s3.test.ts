/** @vitest-environment happy-dom */
/**
 * 設定の「S3 互換の保管先」の節(#2000 段 4a-4。user 必須ガード)。
 * - `<user>.github.io` の注意(独自ドメイン推奨)は該当するときだけ出る(対照群: 独自ドメイン)
 * - CORS の設定の例に、いまの画面の場所が入る
 * - 「接続の確認」「接続を外す(認証情報を消す)」が在り、押すと受け手に届く(dead click でない)
 * - 🔴 認証情報の欄は接続できたら空にする / 接続できなければ残す(入れ直しを強いない)
 * - 📌 `file://` では欄とボタンが止まり、「HTTPS で開いたときだけ使えます」と言う
 */
import { describe, expect, it, vi } from 'vitest';
import { createSyncS3Section, SYNC_S3_DISCONNECT_LABEL, SYNC_S3_SHARED_ORIGIN_NOTE } from '../../src/adapter/ui/render/settings/sync-s3';
import { SyncFolderViewSource } from '../../src/adapter/ui/render/sync-folder-view';
import { SyncEnabledStore } from '../../src/adapter/ui/render/sync-enabled';
import { SYNC_REMOTE_HTTPS_ONLY, type SyncFolderView, type SyncRemoteForm } from '../../src/adapter/platform/sync-folder';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState } from '../../src/adapter/state/app-state';

const view = (over: Partial<SyncFolderView>): SyncFolderView => ({
  version: 1,
  phase: 'none',
  folderName: null,
  kind: null,
  folderSupported: true,
  remoteUnavailable: null,
  remoteConfig: null,
  minutes: 5,
  lastAt: null,
  lastText: null,
  message: null,
  pending: 0,
  persist: true,
  ...over,
});

function setup(opts: { host?: string; origin?: string; v?: Partial<SyncFolderView>; on?: boolean } = {}) {
  const region = document.createElement('div');
  document.body.replaceChildren(region);
  const source = new SyncFolderViewSource();
  let v = view(opts.v ?? {});
  source.attach(() => v);
  const store = new SyncEnabledStore(null);
  store.setEnabled(opts.on ?? true);
  const section = createSyncS3Section(region, source, store, { origin: () => opts.origin ?? 'https://notes.example.org', hostname: () => opts.host ?? 'notes.example.org' });
  const dl = document.createElement('dl');
  dl.append(...(section.build() as Node[]));
  region.append(dl);
  section.sync(initialState);
  const q = <T extends HTMLElement>(sel: string) => region.querySelector<T>(sel);
  const btn = (a: string) => q<HTMLButtonElement>(`[data-pkc-action="${a}"]`)!;
  const field = (f: string) => q<HTMLInputElement>(`[data-pkc-field="sync-s3-${f}"]`)!;
  const status = () => q('[data-pkc-field="sync-s3-status"]')!.textContent ?? '';
  const resync = (over: Partial<SyncFolderView>) => {
    v = view(over);
    section.sync(initialState);
  };
  return { region, btn, field, status, resync, q };
}

describe('設定: S3 互換の保管先', () => {
  it('🔴 github.io のときだけ注意を出す(独自ドメイン推奨)', () => {
    const gh = setup({ host: 'someone.github.io', origin: 'https://someone.github.io' });
    const warn = gh.q('[data-pkc-field="sync-s3-shared-origin"]');
    expect(warn?.textContent).toBe(SYNC_S3_SHARED_ORIGIN_NOTE);
    expect(warn?.getAttribute('data-pkc-state')).toBe('caution');
    expect(SYNC_S3_SHARED_ORIGIN_NOTE).toContain('独自ドメイン');
    const own = setup({ host: 'notes.example.org' });
    expect(own.q('[data-pkc-field="sync-s3-shared-origin"]'), '独自ドメインでは出さない').toBeNull();
  });

  it('🔴 CORS の設定の例に、いまの画面の場所が入り、ETag を見せる', () => {
    const { q } = setup({ origin: 'https://pkc.example.net' });
    const tpl = JSON.parse(q('[data-pkc-field="sync-s3-cors"]')!.textContent ?? '') as { AllowedOrigins: string[]; ExposeHeaders: string[] }[];
    expect(tpl[0]!.AllowedOrigins).toEqual(['https://pkc.example.net']);
    expect(tpl[0]!.ExposeHeaders).toEqual(['ETag']);
  });

  it('接続していない / 接続している で、出すボタンと字が変わる(対照群は前の姿)', () => {
    const s = setup();
    expect(s.status()).toBe('使っていません');
    expect(s.btn('disconnect-sync-s3').hidden).toBe(true);
    expect(s.btn('sync-folder-now').hidden).toBe(true);
    expect(s.btn('connect-sync-s3').textContent).toBe('接続する');
    s.resync({ kind: 's3', phase: 'idle', folderName: 'my-notes/pkc3', lastAt: '09:30', lastText: '取り込み 2 件', remoteConfig: { kind: 's3', endpoint: 'https://r2.example', bucket: 'my-notes', region: 'auto', prefix: 'pkc3/' } });
    expect(s.status()).toBe('「my-notes/pkc3」: 最終同期 09:30(取り込み 2 件)');
    expect(s.btn('disconnect-sync-s3').hidden).toBe(false);
    expect(s.btn('disconnect-sync-s3').textContent).toBe(SYNC_S3_DISCONNECT_LABEL);
    expect(s.btn('sync-folder-now').hidden).toBe(false);
    expect(s.btn('connect-sync-s3').textContent).toBe('接続し直す');
    expect([s.field('endpoint').value, s.field('bucket').value, s.field('prefix').value], '接続先(秘密でない物)を欄に戻す').toEqual(['https://r2.example', 'my-notes', 'pkc3/']);
    expect(s.field('secret').value, '秘密は欄に戻さない').toBe('');
    expect(s.field('secret').type).toBe('password');
    s.resync({ kind: 'folder', phase: 'idle', folderName: 'クラウド' });
    expect(s.status()).toContain('同期フォルダと同期しています');
  });

  it('📌 file:// では欄とボタンが止まり、理由を言う / 設定がオフでも止まる', () => {
    const s = setup({ v: { remoteUnavailable: SYNC_REMOTE_HTTPS_ONLY } });
    expect(s.status()).toBe(SYNC_REMOTE_HTTPS_ONLY);
    expect(s.field('endpoint').disabled).toBe(true);
    expect(s.field('secret').disabled).toBe(true);
    expect(s.btn('test-sync-s3').disabled).toBe(true);
    expect(s.btn('connect-sync-s3').disabled).toBe(true);
    s.resync({});
    expect(s.field('endpoint').disabled, '対照群: 使えるときは入れられる').toBe(false);
    expect(s.btn('connect-sync-s3').disabled).toBe(false);
    const off = setup({ on: false });
    expect(off.status()).toContain('端末間の同期');
    expect(off.btn('connect-sync-s3').disabled).toBe(true);
  });

  it('🔴 押すと受け手に届く(欄の字を渡す)/ 接続できたら認証情報の欄を空にし、できなければ残す', async () => {
    const s = setup();
    const testRemote = vi.fn(async () => ({ ok: true, text: '保管先に接続できました' }));
    let ok = false;
    const connectRemote = vi.fn(async () => ok);
    const stop = vi.fn();
    const copyText = vi.fn();
    bindActions(s.region, { dispatch: vi.fn(), getState: () => initialState } as unknown as Dispatcher, {
      syncFolder: { pick: vi.fn(), syncNow: vi.fn(), reconnect: vi.fn(), stop, setMinutes: vi.fn(), allowPersist: vi.fn(), testRemote, connectRemote },
      copyText,
    });
    s.field('endpoint').value = 'https://r2.example';
    s.field('bucket').value = 'my-notes';
    s.field('access-key-id').value = 'ID-1';
    s.field('secret').value = 'SEC-1';
    s.btn('test-sync-s3').click();
    await Promise.resolve();
    const want: SyncRemoteForm = { endpoint: 'https://r2.example', bucket: 'my-notes', region: '', prefix: 'pkc3/', accessKeyId: 'ID-1', secretAccessKey: 'SEC-1' };
    expect(testRemote).toHaveBeenCalledWith(want);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.q('[data-pkc-field="sync-s3-result"]')!.textContent).toBe('保管先に接続できました');
    // 接続できない ── 欄は残す
    s.btn('connect-sync-s3').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(connectRemote).toHaveBeenCalledWith(want);
    expect([s.field('access-key-id').value, s.field('secret').value]).toEqual(['ID-1', 'SEC-1']);
    // 接続できた ── 認証情報の欄を空にする(接続先は残す)
    ok = true;
    s.btn('connect-sync-s3').click();
    await new Promise((r) => setTimeout(r, 0));
    expect([s.field('access-key-id').value, s.field('secret').value]).toEqual(['', '']);
    expect(s.field('endpoint').value).toBe('https://r2.example');
    s.resync({ kind: 's3', phase: 'idle', folderName: 'my-notes/pkc3' });
    s.btn('disconnect-sync-s3').click();
    expect(stop).toHaveBeenCalledTimes(1);
    s.btn('copy-sync-s3-cors').click();
    expect(copyText).toHaveBeenCalledWith(expect.stringContaining('"AllowedOrigins"'), 'CORS の設定をコピーしました');
  });
});
