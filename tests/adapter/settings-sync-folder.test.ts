/** @vitest-environment happy-dom */
/**
 * 設定の「同期フォルダ」の節(#2000 段 3)。画面に出る物が、同期フォルダのいまの姿に追随するか。
 * 空振り防止: 同じ節を、姿だけ変えて sync し直し、ボタンの出し入れ・字が変わることを見る(対照群は前の姿)。
 */
import { describe, expect, it } from 'vitest';
import { createSyncFolderSection } from '../../src/adapter/ui/render/settings/sync-folder';
import { SyncFolderViewSource } from '../../src/adapter/ui/render/sync-folder-view';
import { SyncEnabledStore } from '../../src/adapter/ui/render/sync-enabled';
import type { SyncFolderView } from '../../src/adapter/platform/sync-folder';
import { initialState } from '../../src/adapter/state/app-state';

function setup(on: boolean) {
  const region = document.createElement('div');
  document.body.replaceChildren(region);
  const source = new SyncFolderViewSource();
  const store = new SyncEnabledStore(null);
  store.setEnabled(on);
  const section = createSyncFolderSection(region, source, store);
  const dl = document.createElement('dl');
  dl.append(...(section.build() as Node[]));
  region.append(dl);
  section.sync(initialState);
  const btn = (a: string) => region.querySelector<HTMLButtonElement>(`[data-pkc-action="${a}"]`)!;
  const status = () => region.querySelector('[data-pkc-field="sync-folder-status"]')!.textContent ?? '';
  return { region, source, store, section, btn, status };
}

const view = (over: Partial<SyncFolderView>): SyncFolderView => ({
  version: 1,
  phase: 'idle',
  folderName: 'クラウド',
  kind: 'folder',
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

describe('設定の「同期フォルダ」', () => {
  it('端末間の同期がオフの間は押せず、オンにする場所を言う', () => {
    const s = setup(false);
    expect(s.btn('pick-sync-folder').disabled).toBe(true);
    expect(s.status()).toContain('「端末間の同期」をオン');
    s.store.setEnabled(true);
    s.section.sync(initialState);
    expect(s.btn('pick-sync-folder').disabled, '対照群: オンなら押せる').toBe(false);
    expect(s.status()).toBe('まだ選んでいません');
    expect(s.btn('stop-sync-folder').hidden, '選ぶ前は「やめる」を出さない').toBe(true);
    expect(s.btn('sync-folder-now').hidden).toBe(true);
  });

  it('選んだ後: 最終同期・やめる・今すぐ同期が出る。許可が切れたら「許可を出し直す」だけを出す', () => {
    const s = setup(true);
    s.source.attach(() => view({ lastAt: '09:30', lastText: '取り込み 2 件' }));
    s.section.sync(initialState);
    expect(s.status()).toBe('「クラウド」: 最終同期 09:30(取り込み 2 件)');
    expect(s.btn('stop-sync-folder').hidden).toBe(false);
    expect(s.btn('sync-folder-now').hidden).toBe(false);
    expect(s.btn('reconnect-sync-folder').hidden).toBe(true);
    expect(s.btn('pick-sync-folder').textContent).toBe('別のフォルダを選ぶ…');
    s.source.attach(() => view({ phase: 'permission', message: '許可が切れています。押してください' }));
    s.section.sync(initialState);
    expect(s.btn('reconnect-sync-folder').hidden).toBe(false);
    expect(s.btn('sync-folder-now').hidden).toBe(true);
    expect(s.status()).toContain('許可が切れています');
  });

  it('選んでいない状態でも、理由があれば言う(読み込みの見張りが handle を捨てた等)', () => {
    const s = setup(true);
    s.source.attach(() => view({ phase: 'none', folderName: null, message: '保存しないようにしました' }));
    s.section.sync(initialState);
    expect(s.status()).toBe('まだ選んでいません。保存しないようにしました');
  });

  it('選べないブラウザでは理由を言い、押せない', () => {
    const s = setup(true);
    s.source.attach(() => view({ phase: 'unsupported', folderName: null, message: 'このブラウザでは同期フォルダを選べません' }));
    s.section.sync(initialState);
    expect(s.btn('pick-sync-folder').disabled).toBe(true);
    expect(s.status()).toContain('選べません');
  });

  it('間隔の選択は、いまの間隔を映す', () => {
    const s = setup(true);
    s.source.attach(() => view({ minutes: 15 }));
    s.section.sync(initialState);
    const sel = s.region.querySelector<HTMLSelectElement>('[data-pkc-field="sync-folder-minutes"]')!;
    expect(sel.value).toBe('15');
    expect(sel.disabled).toBe(false);
    expect(sel.getAttribute('data-pkc-action')).toBe('set-sync-folder-minutes');
  });
});
