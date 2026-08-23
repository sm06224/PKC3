/**
 * 月の格子(升目)を組む。
 *
 * ⚠ **面ではなく形だけ**を持つ ── 使うのは左の列の「予定」タブ
 *   (`ui/render/schedule.ts`)である。
 * 🔴 **`groupEntriesByDate` は #292 段⑤ で落とした**(2026-08-23)── 束ね方は
 *   `features/schedule/agenda.ts` が持つ(**行の予定とノートの予定の両方**を
 *   束ねるので、ノートだけを見る関数は答えが半分になる)。
 */
import { pad2 } from '../datetime/datetime-format';

/**
 * 年月の月間グリッド(週 × 曜日)。null = 月外セル。month は 1 始まり。
 */
export function getMonthGrid(year: number, month: number): (number | null)[][] {
  const firstDay = new Date(year, month - 1, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month, 0).getDate();

  const weeks: (number | null)[][] = [];
  let day = 1;
  for (let w = 0; w < 6; w++) {
    const week: (number | null)[] = [];
    for (let d = 0; d < 7; d++) {
      if (w === 0 && d < firstDay) {
        week.push(null);
      } else if (day > daysInMonth) {
        week.push(null);
      } else {
        week.push(day);
        day++;
      }
    }
    weeks.push(week);
    if (day > daysInMonth) break;
  }
  return weeks;
}

/** YYYY-MM-DD の日付キー。 */
export function dateKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}
