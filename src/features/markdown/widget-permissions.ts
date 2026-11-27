/**
 * 🔴 **添付 HTML ウィジェットの追加権限 ── 種別・文言・CSP の組み立ての正本**(#2090 ②。v4.1 Phase 1 / PR-3)。
 *
 * ## 何を開けるのか
 *
 * 箱(sandbox iframe)の CSP は既定で外へ出る口を塞いでいる(外部の script / style / font 不可・`connect-src 'none'`)。
 * 添付した HTML のウィジェット(`data-pkc-widget-asset` を持つ器)に限り、user が明示的に許した権限だけ CSP を開ける。
 *
 * ## 🔴 開けないもの(どの権限を許しても変わらない)
 *
 * - `sandbox="allow-scripts"` のみ ── `allow-same-origin` は付けない(PKC3 の IndexedDB / localStorage / 他のノートへは届かない)
 * - `frame-src 'none'` / `object-src 'none'` / `base-uri 'none'`
 * - `'unsafe-eval'`
 * - 本文に直書きした ` ```html ` の箱(`buildHtmlSandboxIframe`)── 呼び側は常に既定値(全部オフ)を渡す
 *
 * ⚠ **既定(全部オフ)の CSP は、この PR の前の CSP と 1 文字も違わない**(test で完全一致を pin)。
 * ⚠ DOM を持たない純関数(`html-sandbox.ts` と adapter の両方が使う ── 同じ判定を 2 か所に書かない)。
 */
import { imgSrcDirective } from './external-images';

/** 権限の種別(並びは表示順・`blockedWidgetPermissions` の返す順)。 */
export const WIDGET_PERMISSIONS = ['external-scripts', 'network'] as const;
export type WidgetPermission = (typeof WIDGET_PERMISSIONS)[number];

export interface WidgetPermissionSet {
  readonly externalScripts: boolean;
  readonly network: boolean;
}

/** 既定は全部オフ(fail-closed)。 */
export const DEFAULT_WIDGET_PERMISSIONS: WidgetPermissionSet = Object.freeze({
  externalScripts: false,
  network: false,
});

/** 権限の表示名と説明(標準の日本語 IT 用語)。 */
export const WIDGET_PERMISSION_LABELS: Readonly<
  Record<WidgetPermission, { readonly label: string; readonly description: string }>
> = {
  'external-scripts': {
    label: '外部スクリプト・スタイルの読み込み',
    description: 'CDN などの外部 URL から JavaScript・CSS・フォントを読み込みます(読み込み先へアクセスが発生します)',
  },
  network: {
    label: '外部への通信',
    description: '外部のサーバーへ fetch 等で通信します(ウィジェット内の情報が外部へ送られる可能性があります)',
  },
};

/** 権限ダイアログ・設定画面に添える安全の注記(2 か所で同じ字を使う)。 */
export const WIDGET_PERMISSION_SAFETY_NOTES: readonly string[] = [
  'サンドボックス隔離は維持され、他のノートや保存領域へはアクセスできません',
  'ファイルの中身が変わると許可は自動で外れます',
];

/** 権限の集合 → 種別の一覧(定義順)。 */
export function grantedWidgetPermissions(set: WidgetPermissionSet): WidgetPermission[] {
  return WIDGET_PERMISSIONS.filter((p) => hasWidgetPermission(set, p));
}

export function hasWidgetPermission(set: WidgetPermissionSet, perm: WidgetPermission): boolean {
  return perm === 'external-scripts' ? set.externalScripts === true : set.network === true;
}

/** 種別の一覧 → 権限の集合。 */
export function widgetPermissionSetOf(perms: readonly WidgetPermission[]): WidgetPermissionSet {
  return { externalScripts: perms.includes('external-scripts'), network: perms.includes('network') };
}

/**
 * 🔴 **箱の CSP を組む 1 本**(`buildHtmlSandboxDoc` が呼ぶ)。
 * ⚠ 既定の並び・綴りを変えない ── 既定の CSP は前と完全一致でなければならない。
 */
export function buildSandboxCsp(
  allowExternalImages: boolean,
  permissions: WidgetPermissionSet = DEFAULT_WIDGET_PERMISSIONS,
): string {
  const ext = permissions.externalScripts === true;
  const net = permissions.network === true;
  return (
    "default-src 'self' data: blob:; " +
    `img-src ${imgSrcDirective(allowExternalImages)}; ` +
    (ext ? "style-src 'self' 'unsafe-inline' https: http:; " : "style-src 'self' 'unsafe-inline'; ") +
    // ⚠ 'unsafe-eval' は開けない(許可しても文字列から関数を作らせない)
    (ext ? "script-src 'unsafe-inline' https: http:; " : "script-src 'unsafe-inline'; ") +
    (ext ? "font-src 'self' data: blob: https: http:; " : '') +
    (net ? 'connect-src https: http: wss: ws:; ' : "connect-src 'none'; ") +
    "frame-src 'none'; " +
    "object-src 'none'; " +
    "base-uri 'none'"
  );
}

/**
 * CSP が止めた項目名(箱が申告してきた生の綴り)→ 許せば通る権限。
 * ⚠ どの権限でも開かない項目(`frame-src` 等)は返さない ── 押しても効かない案内を出さない。
 */
export function blockedWidgetPermissions(kinds: readonly string[]): WidgetPermission[] {
  const hit = new Set<WidgetPermission>();
  for (const raw of kinds) {
    const d = String(raw).toLowerCase().trim();
    if (
      d === 'script-src' ||
      d === 'script-src-elem' ||
      d === 'style-src' ||
      d === 'style-src-elem' ||
      d === 'font-src'
    )
      hit.add('external-scripts');
    else if (d === 'connect-src') hit.add('network');
  }
  return WIDGET_PERMISSIONS.filter((p) => hit.has(p));
}

/** 案内帯の 1 行(足りない権限から組む)。 */
export function widgetPermissionNoticeText(missing: readonly WidgetPermission[]): string {
  const what = missing.map((p) => (p === 'external-scripts' ? '外部スクリプトの読み込み' : '外部への通信')).join('・');
  return `${what}を止めました(信頼できるツールなら「権限」から許可できます)`;
}
