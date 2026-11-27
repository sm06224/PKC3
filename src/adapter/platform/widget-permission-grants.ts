/**
 * 🔴 **添付 HTML ウィジェットに許した追加権限を憶える台帳**(#2090 ②。v4.1 Phase 1 / PR-3)。
 *
 * ## 機構は `asset-grants.ts` の 1 本
 *
 * 「どの中身を許したか」を憶える形は素のまま起動(#301)・拡張(#195)と同じ ── 2 本目の `localStorage` 検証を書かない。
 * 🔑 権限ごとに**別の鍵**の `AssetGrants` を持つ(混ぜると、片方を取り消したら両方消える)。
 *
 * ## 🔴 鍵は lid ではなく中身の SHA-256(`ast-<sha256>`)
 *
 * 1 バイトでも中身が変われば別の鍵になり、許可は**自動で外れる**。
 * ⚠ 採番 key(`!isContentKey`)は永続化しない ── 中身を指していないので「同じ中身」を名乗れない。
 *   その場合は**このタブを開いている間だけ**(セッション限定)憶える。
 *
 * ## 🔴 ノート本体・container へは入れない
 *
 * この端末の `localStorage` の判断である ── ノートを配った相手の権限は開かない。
 */
import { AssetGrants } from '@adapter/platform/asset-grants';
import { isContentKey } from '@adapter/platform/storage/asset-key';
import {
  DEFAULT_WIDGET_PERMISSIONS,
  WIDGET_PERMISSIONS,
  widgetPermissionSetOf,
  type WidgetPermission,
  type WidgetPermissionSet,
} from '@features/markdown/widget-permissions';

/** 権限ごとの保存の鍵(test / 設定の面が名指しできるように出す)。 */
export const WIDGET_GRANT_KEYS: Readonly<Record<WidgetPermission, string>> = {
  'external-scripts': 'pkc3.widget-grants.external-scripts',
  network: 'pkc3.widget-grants.network',
};

type Store = ConstructorParameters<typeof AssetGrants>[1];

export interface WidgetPermissionEntry {
  readonly assetKey: string;
  readonly permissions: readonly WidgetPermission[];
  /** `true` = このタブを開いている間だけ(採番 key)。 */
  readonly session: boolean;
}

export class WidgetPermissionGate {
  private readonly grants: Readonly<Record<WidgetPermission, AssetGrants>>;
  /** 採番 key の許可(`perm\0assetKey`)。⚠ 保存しない。 */
  private readonly session = new Set<string>();
  private readonly listeners = new Set<() => void>();

  private static sessionKey(perm: WidgetPermission, assetKey: string): string {
    return `${perm}\u0000${assetKey}`;
  }

  /** @param storage 省略時は `localStorage`(test では注入する。`null` = 保存できない環境) */
  constructor(storage?: Store) {
    const make = (key: string): AssetGrants =>
      storage === undefined ? new AssetGrants(key) : new AssetGrants(key, storage);
    this.grants = {
      'external-scripts': make(WIDGET_GRANT_KEYS['external-scripts']),
      network: make(WIDGET_GRANT_KEYS.network),
    };
  }

  /**
   * いま許されている権限。⚠ 鍵が空なら常に全部オフ(fail-closed)。
   * 🔑 毎回保存を読む(別のタブでの取り消しがそのまま効く)。
   */
  get(assetKey: string | null | undefined): WidgetPermissionSet {
    if (assetKey === null || assetKey === undefined || assetKey === '') return DEFAULT_WIDGET_PERMISSIONS;
    return widgetPermissionSetOf(WIDGET_PERMISSIONS.filter((p) => this.has(assetKey, p)));
  }

  private has(assetKey: string, perm: WidgetPermission): boolean {
    // 🔑 セッション側も見る(採番 key と、保存できなかった内容ハッシュの鍵はここに居る)
    if (this.session.has(WidgetPermissionGate.sessionKey(perm, assetKey))) return true;
    return isContentKey(assetKey) && this.grants[perm].isGranted(assetKey);
  }

  /**
   * 許す / 外す。戻り値は憶えた先(`'hash'` = この端末にずっと / `'session'` = このタブの間だけ / `'revoked'` = 外した)。
   * ⚠ 内容ハッシュの鍵でも保存に失敗した(`localStorage` が使えない)ときは `'session'` に落ちる(黙って許したことにしない)。
   */
  set(assetKey: string, perm: WidgetPermission, allow: boolean): 'hash' | 'session' | 'revoked' {
    let out: 'hash' | 'session' | 'revoked';
    if (!allow) {
      this.grants[perm].revoke(assetKey);
      this.session.delete(WidgetPermissionGate.sessionKey(perm, assetKey));
      out = 'revoked';
    } else if (assetKey === '') {
      // 鍵の無い器には何も許さない(fail-closed)
      return 'revoked';
    } else if (isContentKey(assetKey) && this.grants[perm].grant(assetKey) && this.grants[perm].isGranted(assetKey)) {
      out = 'hash';
    } else {
      this.session.add(WidgetPermissionGate.sessionKey(perm, assetKey));
      out = 'session';
    }
    this.emit();
    return out;
  }

  /** 設定画面の一覧(鍵ごとに束ねる。並びは憶えた順)。 */
  listEntries(): readonly WidgetPermissionEntry[] {
    const byKey = new Map<string, { perms: Set<WidgetPermission>; session: boolean }>();
    const add = (key: string, perm: WidgetPermission, session: boolean): void => {
      const cur = byKey.get(key) ?? { perms: new Set<WidgetPermission>(), session };
      cur.perms.add(perm);
      byKey.set(key, cur);
    };
    for (const perm of WIDGET_PERMISSIONS) for (const key of this.grants[perm].list()) add(key, perm, false);
    for (const sk of this.session) {
      const [perm, key] = sk.split('\u0000') as [WidgetPermission, string];
      add(key, perm, true);
    }
    return [...byKey].map(([assetKey, v]) => ({
      assetKey,
      permissions: WIDGET_PERMISSIONS.filter((p) => v.perms.has(p)),
      session: v.session,
    }));
  }

  /** 1 件(権限を省くとその鍵の全権限)を外す。 */
  revoke(assetKey: string, perm?: WidgetPermission): void {
    for (const p of perm === undefined ? WIDGET_PERMISSIONS : [perm]) {
      this.grants[p].revoke(assetKey);
      this.session.delete(WidgetPermissionGate.sessionKey(p, assetKey));
    }
    this.emit();
  }

  /** 全部外す。 */
  revokeAll(): void {
    for (const p of WIDGET_PERMISSIONS) this.grants[p].revokeAll();
    this.session.clear();
    this.emit();
  }

  /** 変わったとき(同じタブの中)。@returns 外す関数 */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // 1 つの受け手の失敗で他を止めない
      }
    }
  }
}

/** アプリの既定の台帳(test は `new WidgetPermissionGate(store)` を注入する)。 */
export const appWidgetPermissions = new WidgetPermissionGate();
