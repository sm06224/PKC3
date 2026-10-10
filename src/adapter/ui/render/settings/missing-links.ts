/**
 * 🔴 **リンク先のノートが無いリンクを、点線で見せるか**(#1174 段①)。
 *
 * ⚠ **既定は入**(`phone-links` と逆)── 変わるのは下線の種類だけで、字の色は
 *   そのまま。出るのは**押すと必ず「見つかりません」になるリンク**だけである。
 *   見え方を変えたくない人のために切れる(user 指示 2026-08-28「変更はユーザーに委ねて欲しい」)。
 * ⚠ 字は「何が起きるか」で書く(「リンク切れ」は内部の言葉。使わない語は
 *   `ui-terms.ts` の BANNED_TERMS)。
 * ⚠ 説明は hover に置く ── visible の note を足すと「note は 24 段落」の数え直し
 *   (`settings-notes.test.ts` / 設計 doc)を動かす。1 行で足りる設定なので足さない。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { MissingLinksStore } from '../missing-links';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import type { SettingsSection } from './section';

export function createMissingLinksSection(
  region: HTMLElement,
  store: MissingLinksStore,
): SettingsSection {
  return {
    id: 'missing-links',
    group: 'edit',
    build(): Node[] {
      const row = buildCheckboxRow({
        term: 'リンク先が無いリンク',
        action: 'set-missing-links',
        field: 'missing-links',
        label: ' ノートが見つからないリンクを、薄い字と点線で見せる',
        title:
          '押すと「見つかりません」になるリンクに点線の下線を引きます(字の色は変わりません)。' +
          'ゴミ箱に入れた・取り込みで外れた・別の PKC3 から貼ったノートが対象で、' +
          '別の PKC3 を指すリンクは変わりません。',
      });
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'missing-links', () => store.enabled());
    },
  };
}
