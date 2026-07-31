/**
 * calendar のデータ整形(PKC2 calendar-data の総合的見直し版)。
 * PKC3 は常駐 EntryMeta の抽出列(date / archived)だけで組む ── body は読まない。
 */
import type { EntryMeta } from '@core/model/entry-meta';
import { pad2 } from '../datetime/datetime-format';

/**
 * date(YYYY-MM-DD)を持つ todo を日付ごとにまとめる。
 * showArchived=false なら archived を除外(PKC2 と同じ意味論)。
 */
export function groupTodosByDate(
  metas: readonly EntryMeta[],
  showArchived: boolean,
): Record<string, EntryMeta[]> {
  const result: Record<string, EntryMeta[]> = {};
  for (const meta of metas) {
    if (meta.archetype !== 'todo') continue;
    if (!meta.date) continue;
    if (!showArchived && meta.archived) continue;
    (result[meta.date] ??= []).push(meta);
  }
  return result;
}

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
