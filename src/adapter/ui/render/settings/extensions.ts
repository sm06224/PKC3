/**
 * 🔴 **目次を見せる許可の一覧**の節(#195 / C-5 段①)── 「許可」の h3 の中。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { ExtensionGrants } from '@adapter/platform/extension-grants';
import type { AppState } from '@adapter/state/app-state';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createExtensionsSection(grants: ExtensionGrants): SettingsSection {
  let extensionList: HTMLElement | null = null;

  return {
    id: 'extensions',
    group: 'permissions',
    /**
     * 🔴 **目次を見せる許可の一覧**(#195 / C-5 段①)。
     *
     * ⚠ 素のまま起動の隣に、**別の一覧として**置く ── 台帳が別なので、片方を
     *   消してももう片方は残る。1 つの一覧に混ぜると「どちらを取り消したのか」が
     *   user から見えなくなる。
     * 🔑 ここが**取り消しの唯一の出口**である ── 許可は期限なしで憶えるので、
     *   出口が無いと二度と外せない。
     */
    build(): HTMLElement {
      const wrap = document.createElement('section');
      wrap.setAttribute('data-pkc-region', 'settings-extensions');
      const h = document.createElement('h4');
      h.textContent = 'ノート一覧を見せているアプリ';
      // ⚠ **見えるものを書く**(「projection を渡す」では判断できない)。詳しくはマニュアル。
      const note = buildSettingsNote(
        'ノートの題名・種類・日付・状態の一覧を読めます(本文と添付は渡りません)。',
      );
      extensionList = document.createElement('ul');
      extensionList.setAttribute('data-pkc-field', 'extension-list');
      wrap.append(h, note, extensionList);
      return wrap;
    },
    /** ⚠ **毎回組み直す**(許可はこの面の外で増える ── `syncSameOrigin` と同じ理由)。 */
    sync(state: AppState): void {
      const list = extensionList;
      if (!list) return;
      const keys = grants.list();
      list.textContent = '';
      if (keys.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'まだノート一覧を見せているアプリはありません';
        list.append(li);
        return;
      }
      for (const key of keys) {
        const li = document.createElement('li');
        li.setAttribute('data-pkc-asset-key', key);
        const name = document.createElement('span');
        // ⚠ 題名は**いま並んでいるタイル**から引く(`syncSameOrigin` と同じ作法)
        const tile = state.launcherTiles?.find((t) => t.assetKey === key);
        name.textContent = tile?.title ?? `(一覧に無いアプリ ${key.slice(4, 12)}…)`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-pkc-action', 'revoke-extension');
        btn.setAttribute('data-pkc-asset-key', key);
        btn.textContent = '許可を取り消す';
        li.append(name, btn);
        list.append(li);
      }
    },
  };
}
