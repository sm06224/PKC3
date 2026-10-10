/**
 * 🔴 **狭い画面の断り書き**(#687 E-1、user 裁定 2026-09-04)。
 *
 * 🔑 **ここが帯の「OK」の戻し道である。** OK は端末に憶えるので、帯にしか
 *   導線が無いと一度押した user は二度と戻せない(お知らせと同じ形)。
 * ⚠ **flag ではない**(正規設定)。開放先は user で、畳む予定も無い。
 *
 * 🔴 **2026-09-21(#1017 段③-1)に「表示」から「記録」の h4 へ移した**
 *   (`ui-total-design-2026-09.md` §3.2「記録 = この端末の行動の事実」)。
 *   ⚠ 表示の `dl` には**足さない** ── 自分の `dl`(group `too-narrow`)に入る。
 *
 * ⚠ 帯の「OK」は**この画面を開かずに**設定を切る(#687 E-1)── 映さないと、
 *   次に設定を開いたとき「出す」のまま見える(CLAUDE.md「設定画面の値の同期」)。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { TooNarrowOkStore } from '../too-narrow';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import type { SettingsSection } from './section';

export function createTooNarrowSection(
  region: HTMLElement,
  store: TooNarrowOkStore,
): SettingsSection {
  return {
    id: 'too-narrow',
    group: 'too-narrow',
    build(): Node[] {
      const row = buildCheckboxRow({
        term: '狭い画面の断り書き',
        action: 'set-too-narrow-enabled',
        field: 'too-narrow-enabled',
        label: ' 狭い画面のときに断り書きを出す',
        title:
          '幅が 360px より狭いと出ます。「OK」を押すと切れます。ここで戻せます。',
        notes: [
          '幅が狭いときに「表示が崩れることがあります」と出します。',
        ],
      });
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'too-narrow-enabled', () => store.enabled());
    },
  };
}
