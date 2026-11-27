/**
 * 🔴 **添付 HTML ウィジェットの追加権限の一覧**の節(#2090 ②)── 「許可」の h3 の中。
 *
 * ウィジェットの操作バーの「権限」で許したもの(外部スクリプト・スタイルの読み込み / 外部への通信)を一覧にし、
 * 1 件ずつ・すべてを取り消せるようにする(⚠ 許可は期限なしで憶えるので、外す出口が要る ── 片道の操作を作らない)。
 * 構造とトーンは `same-origin.ts` と揃える。
 */
import type { WidgetPermissionGate } from '@adapter/platform/widget-permission-grants';
import type { AppState } from '@adapter/state/app-state';
import { WIDGET_PERMISSION_LABELS } from '@features/markdown/widget-permissions';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createWidgetPermissionsSection(
  grants: WidgetPermissionGate | (() => WidgetPermissionGate),
  /** 鍵 → 表示名(このタブで置いたウィジェットのノート題名。引けなければ `null`)。 */
  labelOf: (assetKey: string) => string | null = () => null,
): SettingsSection {
  const gate = (): WidgetPermissionGate => (typeof grants === 'function' ? grants() : grants);
  let list: HTMLElement | null = null;
  let all: HTMLButtonElement | null = null;

  return {
    id: 'widget-permissions',
    group: 'permissions',
    build(): HTMLElement {
      const wrap = document.createElement('section');
      wrap.setAttribute('data-pkc-region', 'settings-widget-permissions');
      const h = document.createElement('h4');
      h.textContent = '添付 HTML ウィジェットの追加権限';
      // ⚠ 説明は 1 行ずつ(設定の説明の規則 ── #1017 §6.1 規則 3)。2 文を 2 つの注記に分ける(字は変えない)
      const note = buildSettingsNote('添付した HTML ウィジェットに許可した外部スクリプトや外部通信の一覧です。');
      const safety = buildSettingsNote('サンドボックス隔離は維持されるため、他のノートや保存領域へはアクセスできません。');
      list = document.createElement('ul');
      list.setAttribute('data-pkc-field', 'widget-permissions-list');
      all = document.createElement('button');
      all.type = 'button';
      all.setAttribute('data-pkc-action', 'revoke-all-widget-permissions');
      all.textContent = 'すべて取り消す';
      all.hidden = true;
      wrap.append(h, note, safety, list, all);
      return wrap;
    },
    /** ⚠ 毎回組み直す ── 許可はこの画面の外(ウィジェットの「権限」)で増える。 */
    sync(state: AppState): void {
      const ul = list;
      if (!ul) return;
      const entries = gate().listEntries();
      ul.textContent = '';
      if (all) all.hidden = entries.length === 0;
      if (entries.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'まだ追加権限を許可したウィジェットはありません';
        ul.append(li);
        return;
      }
      for (const e of entries) {
        const li = document.createElement('li');
        li.setAttribute('data-pkc-asset-key', e.assetKey);
        const name = document.createElement('span');
        name.setAttribute('data-pkc-field', 'widget-permission-name');
        const tile = state.launcherTiles?.find((t) => t.assetKey === e.assetKey);
        const label = tile?.title ?? labelOf(e.assetKey);
        name.textContent = label ?? `(添付 HTML ${e.assetKey.slice(4, 12)}…)`;
        li.append(name);
        for (const p of e.permissions) {
          const badge = document.createElement('span');
          badge.className = 'pkc-widget-permission-badge';
          badge.setAttribute('data-pkc-field', 'widget-permission-badge');
          badge.setAttribute('data-pkc-permission', p);
          badge.textContent = WIDGET_PERMISSION_LABELS[p].label;
          li.append(document.createTextNode(' '), badge);
        }
        if (e.session) {
          const s = document.createElement('small');
          s.textContent = '(このタブを開いている間だけ)';
          li.append(document.createTextNode(' '), s);
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-pkc-action', 'revoke-widget-permission');
        btn.setAttribute('data-pkc-asset-key', e.assetKey);
        btn.textContent = '許可を取り消す';
        li.append(document.createTextNode(' '), btn);
        ul.append(li);
      }
    },
  };
}
