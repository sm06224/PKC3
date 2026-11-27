/** @vitest-environment happy-dom */
/**
 * 🔴 **添付 HTML ウィジェットの追加権限の一覧と取り消し**(#2090 ②)。
 *
 * ⚠ 許可は期限なしで憶える ── 外す出口がここに無いと二度と外せない(片道の操作を作らない)。
 * ⚠ 一覧は**この画面の外**(ウィジェットの「権限」)で増えるので、同じインスタンスで描き直す経路も見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { setWidgetPermissionGate } from '@adapter/ui/render/widget-bridge';
import { WidgetPermissionGate } from '@adapter/platform/widget-permission-grants';
import { bindActions } from '@adapter/ui/actions/binder';
import { Dispatcher } from '@adapter/state/dispatcher';
import { initialState, type AppState } from '@adapter/state/app-state';
import { DIALOG_REGION, resetAppDialogForTest } from '@adapter/ui/render/app-dialog';
import type { LauncherTile } from '@features/launcher/tiles';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const KEY_A = `ast-${'a'.repeat(64)}`;
const KEY_B = `ast-${'b'.repeat(64)}`;
const tile = (title: string, assetKey: string): LauncherTile => ({ lid: 'e1', title, group: '', kind: 'app', assetKey });
const stateWith = (tiles: LauncherTile[]): AppState => ({ ...initialState, launcherTiles: tiles });
const region = (host: HTMLElement): HTMLElement =>
  host.querySelector<HTMLElement>('[data-pkc-region="settings-widget-permissions"]')!;
const rows = (host: HTMLElement): HTMLElement[] => [
  ...region(host).querySelectorAll<HTMLElement>('[data-pkc-field="widget-permissions-list"] li'),
];
const allBtn = (host: HTMLElement): HTMLButtonElement =>
  region(host).querySelector<HTMLButtonElement>('[data-pkc-action="revoke-all-widget-permissions"]')!;

describe('設定 — 添付 HTML ウィジェットの追加権限(#2090 ②)', () => {
  let host: HTMLElement;
  let gate: WidgetPermissionGate;

  beforeEach(() => {
    document.body.textContent = '';
    resetAppDialogForTest();
    host = document.createElement('div');
    document.body.append(host);
    gate = new WidgetPermissionGate(fakeStorage());
    setWidgetPermissionGate(gate);
  });
  afterEach(() => setWidgetPermissionGate(null));

  it('「許可」の中に節があり、見出しと注記が出る', () => {
    new SettingsRenderer(host).render(stateWith([]));
    const r = region(host);
    expect(r, '節が無い').not.toBeNull();
    expect(r.querySelector('h4')!.textContent).toBe('添付 HTML ウィジェットの追加権限');
    expect(r.textContent).toContain('サンドボックス隔離は維持されるため');
  });

  it('0 件ならそう書き、「すべて取り消す」は出さない', () => {
    new SettingsRenderer(host).render(stateWith([]));
    expect(rows(host).map((li) => li.textContent)).toEqual(['まだ追加権限を許可したウィジェットはありません']);
    expect(allBtn(host).hidden).toBe(true);
  });

  it('🔴 許した鍵が権限の名前つきで並ぶ(題名が引けないものは鍵の頭)・同じインスタンスで描き直すと増える', () => {
    const r = new SettingsRenderer(host);
    const st = stateWith([tile('見積ツール', KEY_A)]);
    r.render(st);
    expect(rows(host)).toHaveLength(1);
    gate.set(KEY_A, 'external-scripts', true);
    gate.set(KEY_A, 'network', true);
    gate.set(KEY_B, 'network', true);
    r.render(st);
    const list = rows(host);
    expect(list).toHaveLength(2);
    expect(list[0]!.getAttribute('data-pkc-asset-key')).toBe(KEY_A);
    expect(list[0]!.textContent).toContain('見積ツール');
    expect([...list[0]!.querySelectorAll('[data-pkc-field="widget-permission-badge"]')].map((b) => b.textContent)).toEqual([
      '外部スクリプト・スタイルの読み込み',
      '外部への通信',
    ]);
    expect(list[1]!.textContent).toContain(KEY_B.slice(4, 12));
    expect(list[1]!.querySelector(`[data-pkc-action="revoke-widget-permission"][data-pkc-asset-key="${KEY_B}"]`)).not.toBeNull();
    expect(allBtn(host).hidden).toBe(false);
  });

  it('🔴 「許可を取り消す」でその鍵の services が呼ばれる', () => {
    gate.set(KEY_A, 'network', true);
    new SettingsRenderer(host).render(stateWith([]));
    const revokeWidgetPermission = vi.fn();
    bindActions(host, new Dispatcher(), { revokeWidgetPermission });
    region(host).querySelector<HTMLElement>('[data-pkc-action="revoke-widget-permission"]')!.click();
    expect(revokeWidgetPermission).toHaveBeenCalledWith(KEY_A);
  });

  it('🔴 「すべて取り消す」は確認してから(やめれば何もしない)', async () => {
    gate.set(KEY_A, 'network', true);
    new SettingsRenderer(host).render(stateWith([]));
    const revokeAllWidgetPermissions = vi.fn();
    bindActions(host, new Dispatcher(), { revokeAllWidgetPermissions });
    allBtn(host).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector<HTMLDialogElement>(`[data-pkc-region="${DIALOG_REGION}"]`)!.open).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-cancel"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(revokeAllWidgetPermissions).not.toHaveBeenCalled();
    allBtn(host).click();
    await new Promise((r) => setTimeout(r, 0));
    document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(revokeAllWidgetPermissions).toHaveBeenCalledTimes(1);
  });

  it('取り消した後に描き直すと一覧から消える(個別・一括)', () => {
    const r = new SettingsRenderer(host);
    gate.set(KEY_A, 'network', true);
    gate.set(KEY_B, 'external-scripts', true);
    r.render(stateWith([]));
    gate.revoke(KEY_A);
    r.render(stateWith([]));
    expect(rows(host).map((li) => li.getAttribute('data-pkc-asset-key'))).toEqual([KEY_B]);
    gate.revokeAll();
    r.render(stateWith([]));
    expect(rows(host).map((li) => li.textContent)).toEqual(['まだ追加権限を許可したウィジェットはありません']);
  });
});
