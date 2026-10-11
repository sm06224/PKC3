/**
 * 🔴 **日付の右に「あと3日」「5日前」を薄く添えるか**(#1225)。
 *
 * ⚠ **既定は入**(`date-links` と同じ ── 見え方が変わるので切れる)。
 * ⚠ 説明は hover に置く(visible の note を足すと `settings-notes.test.ts` の段落数を動かす)。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { RelativeDaysStore } from '../relative-days';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

/**
 * 🔴 **日付を押せる設定が切のときだけ、日数の欄に前提を添える**(#1254 §2 欠陥 7)。
 * ⚠ 入のときは**説明ごと取り除く**(出し入れは要素の有無 ── 隠すだけだと、字を読む検査が
 *   常に満たされる)。⚠ 日数の checkbox の入切は見ない(裁定は「日付を押せる設定が切のとき」の
 *   1 条件。日数を入にし直した瞬間に読み返しても分かるよう、前提は常に添える)。
 * ⚠ 「本文の日付」の節(`date-links.ts`)も、チェックを切り替えた瞬間にこれを呼ぶ。
 */
export function syncRelativeDaysPrereq(region: ParentNode): void {
  const rd = region.querySelector<HTMLInputElement>('[data-pkc-field="relative-days"]');
  const dl = region.querySelector<HTMLInputElement>('[data-pkc-field="date-links"]');
  const dd = rd?.closest('dd') ?? null;
  if (dd === null || dl === null) return;
  const mark = '[data-pkc-region="relative-days-prereq"]';
  const existing = dd.querySelector(mark);
  if (dl.checked) {
    existing?.remove();
    return;
  }
  if (existing !== null) return;
  const note = buildSettingsNote('日付を押せるようにすると出ます(上の「本文の日付」をオンにしてください)');
  note.setAttribute('data-pkc-region', 'relative-days-prereq');
  dd.append(note);
}

export function createRelativeDaysSection(
  region: HTMLElement,
  store: RelativeDaysStore,
): SettingsSection {
  return {
    id: 'relative-days',
    group: 'edit',
    build(): Node[] {
      const row = buildCheckboxRow({
        term: '日付までの日数',
        action: 'set-relative-days',
        field: 'relative-days',
        label: ' 本文の @日付 の右に、今日からの日数を薄く添える',
        title:
          '「今日」「明日」「あと3日」「5日前」のように添えます(日付そのものは変わらず、コピーにも入りません)。' +
          'チェックを付けた項目、期間(@日付..日付)、繰り返す予定には添えません。',
      });
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'relative-days', () => store.enabled());
      syncRelativeDaysPrereq(region);
    },
  };
}
