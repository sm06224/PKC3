/**
 * 📣 **お知らせを出すか**(P11 段⑤)と、その下の **これまでのお知らせ**(#1017 段③-2)。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { NoticeStore } from '@adapter/platform/notice-store';
import {
  NOTICE_READABLE_TEXT,
  noticeDate,
  recentNotices,
  type Notice,
} from '@features/notice/notice-log';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import type { SettingsSection } from './section';

/**
 * 📣 **お知らせを出すか**(P11 段⑤)。
 *
 * 🔑 **ここが「今後は出さない」の戻し道である。** 帯にしか導線が無いと、
 * 一度消した user は二度と戻せない ── 「戻せない導線は作らない」。
 * ⚠ **flag ではない**(正規設定)。開放先は user で、畳む予定も無い。
 *
 * 🔴 **2026-09-21(#1017 段③-1)に「表示」から「お知らせ」の h3 へ移した**
 *   (`ui-total-design-2026-09.md` §3.2「お知らせは system 領域」)。
 *   ⚠ 表示の `dl` には**足さない** ── 自分の `dl`(group `notice`)に入る。
 *
 * ⚠ 画面の値を**いまのお知らせ設定に合わせる**(P11)。
 * 🔴 帯の「今後は出さない」は**この画面を開かずに**設定を変える ── 映さないと、
 * 次に設定を開いたとき「出す」のまま見える(CLAUDE.md「設定画面の値の同期」)。
 */
export function createNoticesSection(region: HTMLElement, store: NoticeStore): SettingsSection {
  return {
    id: 'notices',
    group: 'notice',
    build(): Node[] {
      const row = buildCheckboxRow({
        term: 'お知らせ',
        action: 'set-notices-enabled',
        field: 'notices-enabled',
        label: ' 起動したときに新しいお知らせを出す',
        // ⚠ 「いつでも」と書かない ── 並ぶのは上限までである(2026-09-08)
        // ⚠ **数は書かない、組み立てる**(#751 ── 同じ字が 5 か所に散っていた)
        // 🔴 **「ヘルプから」ではなく自己参照**(#1017 段③-2)── 一覧はこのすぐ下
        //   (「これまでのお知らせ」)に移した。
        notes: [
          `出さなくても、過去のお知らせはこの下の「これまでのお知らせ」で${NOTICE_READABLE_TEXT}が読めます。`,
        ],
      });
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'notices-enabled', () => store.enabled());
    },
  };
}

/**
 * 🔴 **これまでのお知らせ**(#1017 段③-2。裁定 2026-09-20 6 巡目「お知らせの
 *   入口はシステムへ移す。ヘルプにもリンク 1 行を残す」)。
 *
 * ⚠ **ヘルプから移した** ── 属性名は変えていない(`data-pkc-region="help-notices"` /
 *   `data-pkc-help-notice` / `notice-title`)。名前を変えると、この画面と
 *   ヘルプの両方を数える検査が片方だけ拾う形になる(CLAUDE.md「id らしく
 *   見える名前は id として扱われる」)。
 * ⚠ **件数を切るのは `recentNotices` だけ**(面ごとに slice を書かない)。
 * ⚠ **`<details>` を使う** ── `tests/docs-parity.test.ts:410-432` の
 *   「主要な導線を畳まない」は `buildShell()` の shell 全体と
 *   `buildSettingsCommands()` だけを見ており、この画面(`SettingsRenderer`)全体は
 *   その走査に入らない(同 file:500-534 の `<details>=0` も collection-pane
 *   だけを見ている)。ここは shell の主要導線ではなく**読み物**である
 *   ── ヘルプに在ったときと同じ前例(#719 案 A)。
 * ⚠ 状態に依らない固定の節(映すものは無い)。
 */
export function createNoticeListSection(noticeList: readonly Notice[]): SettingsSection {
  return {
    id: 'notice-list',
    group: 'notice-list',
    build(): Node[] {
      const h2 = document.createElement('h4');
      h2.textContent = 'これまでのお知らせ';
      const list = document.createElement('div');
      list.setAttribute('data-pkc-region', 'help-notices');
      for (const n of recentNotices(noticeList)) {
        const item = document.createElement('details');
        item.setAttribute('data-pkc-help-notice', n.id);
        const t = document.createElement('summary');
        t.setAttribute('data-pkc-field', 'notice-title');
        // ⚠ 日付は id から引く(field を二重に持たない)
        t.textContent = `${noticeDate(n.id)} ${n.title}`;
        const ul = document.createElement('ul');
        for (const line of n.items) {
          const li = document.createElement('li');
          // ⚠ **素のテキスト**として出す(記法は書かない決まり。test が守る)
          li.textContent = line;
          ul.append(li);
        }
        item.append(t, ul);
        list.append(item);
      }
      return [h2, list];
    },
    sync(): void {
      // 状態に依らない固定の節(映すものは無い)
    },
  };
}
