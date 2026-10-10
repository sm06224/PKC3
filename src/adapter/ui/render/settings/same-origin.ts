/**
 * 🔴 **素のまま起動を許したアプリの一覧**の節(#301)── 「許可」の h3 の中。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { SameOriginGrants } from '@adapter/platform/same-origin-grants';
import type { AppState } from '@adapter/state/app-state';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createSameOriginSection(grants: SameOriginGrants): SettingsSection {
  let sameOriginList: HTMLElement | null = null;

  return {
    id: 'same-origin',
    group: 'permissions',
    /**
     * 🔴 **素のまま起動を許したアプリの一覧**(#301。user 裁定 2026-08-21)。
     *
     * > 「**同じハッシュのアプリ登録済みの URL もしくは HTML に関しては永続化
     * > (文字通りの永続化、期間とかない)**」
     *
     * ⚠ **期限が無い以上、取り消す場所が要る。** 永続化そのものは user の裁定だが、
     *   「一度許したら二度と外せない」は裁定に含まれていない ── 出口を作る。
     * ⚠ 一覧に**限界も併記する** ── 素のままのアプリはこの一覧自体を書き換えられる。
     *   隠すと「一覧があるから安全」と読まれるので、**実際より安全に見せない**
     *   (`same-origin-grants.ts` 冒頭の判断と同じ向き)。
     * ⚠ 「表示」には入れない ── 見た目の好みではなく**外へ何を渡すか**の判断である。
     */
    build(): HTMLElement {
      const wrap = document.createElement('section');
      wrap.setAttribute('data-pkc-region', 'settings-same-origin');
      const h = document.createElement('h4');
      h.textContent = 'ノートを渡して開くことを許したアプリ';
      // ⚠ この 1 行の警告は落とさない(不可侵指示「不可逆は必ず言う」に準じる ──
      //   このアプリは一覧そのものも書き換えられるので、hover やマニュアルへ逃がさない)。
      const note = buildSettingsNote(
        'ノート・添付・設定を読み書きできます(この一覧も書き換えられるので注意してください)。',
      );
      sameOriginList = document.createElement('ul');
      sameOriginList.setAttribute('data-pkc-field', 'same-origin-list');
      wrap.append(h, note, sameOriginList);
      return wrap;
    },
    /**
     * ⚠ **毎回組み直す** ── 許可はこの面の外(添付の起動)で増えるので、
     *   「開いている間に変わらない」という前提が成り立たない(P8 段⑩ と同じ理由で、
     *   隠れている間の変化を取りこぼすと**画面が嘘をつく**)。
     */
    sync(state: AppState): void {
      const list = sameOriginList;
      if (!list) return;
      const keys = grants.list();
      list.textContent = '';
      if (keys.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'まだ許可したアプリはありません';
        list.append(li);
        return;
      }
      for (const key of keys) {
        const li = document.createElement('li');
        li.setAttribute('data-pkc-asset-key', key);
        const name = document.createElement('span');
        // ⚠ 題名は**いま並んでいるタイル**から引く ── 引けないものは消えた / 登録を
        //    外した添付なので、**鍵の頭だけ**を出す(空欄にすると取り消しようがない)
        const tile = state.launcherTiles?.find((t) => t.assetKey === key);
        name.textContent = tile?.title ?? `(一覧に無いアプリ ${key.slice(4, 12)}…)`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-pkc-action', 'revoke-same-origin');
        btn.setAttribute('data-pkc-asset-key', key);
        btn.textContent = '許可を取り消す';
        li.append(name, btn);
        list.append(li);
      }
    },
  };
}
