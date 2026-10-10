/**
 * 🔴 **本文の `@日付` を押せる字にするか**(#1169)。
 *
 * ⚠ **既定は入**(電話番号と逆 ── `date-links.ts` の頭)。見え方が変わる
 *   (点線の下線が付く)ので、**切れる**ようにしてある。
 * ⚠ 説明は 1 行(`settings-notes.test.ts` の上限)── 詳しい動きは hover とマニュアルへ。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { DateLinksStore } from '../date-links';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import { syncRelativeDaysPrereq } from './relative-days';
import type { SettingsSection } from './section';

export function createDateLinksSection(region: HTMLElement, store: DateLinksStore): SettingsSection {
  return {
    id: 'date-links',
    group: 'edit',
    build(): Node[] {
      const row = buildCheckboxRow({
        term: '本文の日付',
        action: 'set-date-links',
        field: 'date-links',
        label: ' 本文の @日付 を押すと、その日のノートを開く',
        title:
          '@2026-10-15 のように書いた日付に点線の下線が付きます(字の色は変わりません)。' +
          '題名がその日付のノートが無ければ、作るかどうかを画面の下で聞きます。' +
          'オフにすると、日付はふつうの字のままです。',
        notes: ['押すと、題名がその日付のノートを開きます(無ければ作るか聞きます)。'],
      });
      /**
       * 🔴 **この設定を切ると、すぐ下の「日付までの日数」も出なくなる**(#1254 §2 欠陥 7。
       *   Gemini 裁定 = A)。⚠ 添え字は押せる日付(`.pkc-date-link`)にしか差さない
       *   (`relative-days.ts`)ので、**日数が入のままでも、日付が押せなければ何も出ない**。
       * 🔑 切り替えた瞬間に、日数の欄の説明が出入りする(`syncRelativeDaysPrereq`)。
       *   ⚠ checkbox の**押した後の値**を直に読む(binder が保存へ書くより先に来るため、
       *   保存を読むと 1 手遅れる)。
       */
      row.box.addEventListener('change', () => syncRelativeDaysPrereq(region));
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'date-links', () => store.enabled());
    },
  };
}
