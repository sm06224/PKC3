/**
 * 添付 HTML ウィジェットの追加権限の台帳(#2090 ②)。
 *
 * 🔴 守る主張:
 * 1. 鍵は中身の SHA-256(`ast-<64hex>`)── 永続化され、別のインスタンス(= 開き直し・別のタブ)からも読める
 * 2. 1 字違う鍵では偽(中身が変わったら許可は自動で外れる)
 * 3. 採番 key は `localStorage` へ書かない(このタブの間だけ)
 * 4. 2 つの権限は独立に許す / 外す。`revokeAll` で全部消える
 * 5. 壊れた保存・不正な鍵があっても落ちず、全部オフ(fail-closed)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  WIDGET_GRANT_KEYS,
  WidgetPermissionGate,
} from '../../src/adapter/platform/widget-permission-grants';
import { DEFAULT_WIDGET_PERMISSIONS } from '../../src/features/markdown/widget-permissions';

function memStore(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
  } as Storage & { data: Map<string, string> };
}

const KEY_A = `ast-${'a'.repeat(64)}`;
const KEY_A2 = `ast-${'a'.repeat(63)}b`; // 1 字違い
const KEY_B = `ast-${'b'.repeat(64)}`;
const NUMBERED = 'ast-123'; // 採番 key(中身を指していない)

describe('WidgetPermissionGate', () => {
  it('🔴 内容ハッシュの鍵は永続化され、別のインスタンスからも読める', () => {
    const st = memStore();
    const g = new WidgetPermissionGate(st);
    expect(g.set(KEY_A, 'external-scripts', true)).toBe('hash');
    expect(JSON.parse(st.getItem(WIDGET_GRANT_KEYS['external-scripts'])!)).toEqual([KEY_A]);
    expect(st.getItem(WIDGET_GRANT_KEYS.network)).toBeNull();
    const again = new WidgetPermissionGate(st);
    expect(again.get(KEY_A)).toEqual({ externalScripts: true, network: false });
  });

  it('🔴 1 字違う鍵(中身が変わった)では許されていない', () => {
    const g = new WidgetPermissionGate(memStore());
    g.set(KEY_A, 'external-scripts', true);
    g.set(KEY_A, 'network', true);
    expect(g.get(KEY_A2)).toEqual(DEFAULT_WIDGET_PERMISSIONS);
  });

  it('🔴 採番 key は保存へ書かず、このタブの間だけ(別のインスタンスでは偽)', () => {
    const st = memStore();
    const g = new WidgetPermissionGate(st);
    expect(g.set(NUMBERED, 'network', true)).toBe('session');
    expect(st.data.size).toBe(0);
    expect(g.get(NUMBERED)).toEqual({ externalScripts: false, network: true });
    expect(new WidgetPermissionGate(st).get(NUMBERED)).toEqual(DEFAULT_WIDGET_PERMISSIONS);
    expect(g.listEntries()).toEqual([{ assetKey: NUMBERED, permissions: ['network'], session: true }]);
    g.set(NUMBERED, 'network', false);
    expect(g.get(NUMBERED)).toEqual(DEFAULT_WIDGET_PERMISSIONS);
  });

  it('保存が使えない環境では内容ハッシュの鍵もこのタブの間だけ(黙って許したことにしない)', () => {
    const g = new WidgetPermissionGate(null);
    expect(g.set(KEY_A, 'network', true)).toBe('session');
    expect(g.get(KEY_A).network).toBe(true);
  });

  it('2 つの権限は独立に許す / 外す', () => {
    const g = new WidgetPermissionGate(memStore());
    g.set(KEY_A, 'external-scripts', true);
    g.set(KEY_A, 'network', true);
    expect(g.set(KEY_A, 'external-scripts', false)).toBe('revoked');
    expect(g.get(KEY_A)).toEqual({ externalScripts: false, network: true });
    g.revoke(KEY_A, 'network');
    expect(g.get(KEY_A)).toEqual(DEFAULT_WIDGET_PERMISSIONS);
  });

  it('一覧は鍵ごとに束ねる・1 件まとめて外す・revokeAll で全部消える', () => {
    const st = memStore();
    const g = new WidgetPermissionGate(st);
    g.set(KEY_A, 'network', true);
    g.set(KEY_A, 'external-scripts', true);
    g.set(KEY_B, 'network', true);
    g.set(NUMBERED, 'external-scripts', true);
    expect(g.listEntries()).toEqual([
      { assetKey: KEY_A, permissions: ['external-scripts', 'network'], session: false },
      { assetKey: KEY_B, permissions: ['network'], session: false },
      { assetKey: NUMBERED, permissions: ['external-scripts'], session: true },
    ]);
    g.revoke(KEY_A);
    expect(g.get(KEY_A)).toEqual(DEFAULT_WIDGET_PERMISSIONS);
    expect(g.get(KEY_B).network).toBe(true);
    g.revokeAll();
    expect(g.listEntries()).toEqual([]);
    expect(st.data.size).toBe(0);
    expect(g.get(NUMBERED)).toEqual(DEFAULT_WIDGET_PERMISSIONS);
  });

  it('🔴 壊れた保存・不正な鍵・空の鍵でも落ちず、全部オフ', () => {
    const st = memStore();
    st.setItem(WIDGET_GRANT_KEYS['external-scripts'], '{not json');
    st.setItem(WIDGET_GRANT_KEYS.network, JSON.stringify(['ast-xyz', 42, KEY_B.toUpperCase(), null]));
    const g = new WidgetPermissionGate(st);
    expect(g.get(KEY_B)).toEqual(DEFAULT_WIDGET_PERMISSIONS);
    expect(g.get('')).toEqual(DEFAULT_WIDGET_PERMISSIONS);
    expect(g.get(null)).toEqual(DEFAULT_WIDGET_PERMISSIONS);
    expect(g.get(undefined)).toEqual(DEFAULT_WIDGET_PERMISSIONS);
    expect(g.listEntries()).toEqual([]);
    expect(g.set('', 'network', true)).toBe('revoked');
    expect(g.get('').network).toBe(false);
  });

  it('毎回保存を読む(別のタブでの取り消しがそのまま効く)', () => {
    const st = memStore();
    const g = new WidgetPermissionGate(st);
    g.set(KEY_A, 'network', true);
    new WidgetPermissionGate(st).revokeAll();
    expect(g.get(KEY_A).network).toBe(false);
  });

  it('変わったら知らせる(受け手の失敗で他を止めない)', () => {
    const g = new WidgetPermissionGate(memStore());
    const bad = vi.fn(() => {
      throw new Error('x');
    });
    const good = vi.fn();
    g.onChange(bad);
    const off = g.onChange(good);
    g.set(KEY_A, 'network', true);
    expect(good).toHaveBeenCalledTimes(1);
    off();
    g.revokeAll();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
