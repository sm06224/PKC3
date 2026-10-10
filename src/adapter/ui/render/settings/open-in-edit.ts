/**
 * 🔴 **「開く」で編集に入るか**(user 裁定 2026-08-18
 * 「**Enter は閲覧を開始、インライン編集で常に開くは設定でトグル可能にすること**」)。
 * ⚠ **flag ではない**(正規設定)── 開放先は user で、畳む予定も無い。
 * ⚠ 「編集の仕方」の**すぐ下**に置く ── 同じ「編集の入り方」の話である。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { OpenInEditStore } from '../open-in-edit';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import type { SettingsSection } from './section';

export function createOpenInEditSection(
  region: HTMLElement,
  store: OpenInEditStore,
): SettingsSection {
  return {
    id: 'open-in-edit',
    group: 'edit',
    build(): Node[] {
      // ⚠ **どの操作に効くか**を書く ── 書かないと「行を押しても編集にならない」と読まれる
      const row = buildCheckboxRow({
        term: '開いたときの状態',
        action: 'set-open-in-edit',
        field: 'open-in-edit',
        label: ' 開いたら、そのまま編集に入る',
        title:
          '行を 1 回押して選んだだけでは編集に入りません(それは「選ぶ」で、「開く」ではありません)。',
        notes: [
          '既定は「読む」状態で開き、オンにすると開いた時点で編集に入ります。',
        ],
      });
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'open-in-edit', () => store.enabled());
    },
  };
}
