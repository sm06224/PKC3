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

/**
 * 小さな月で「いま見ている所」に印を付ける日(#855。Gemini 裁定 = #1163 のコメント 6104130726 の 1 / 5)。
 *
 * | 見せ方 | 印 |
 * |---|---|
 * | 一覧 | 無し(見ている日が無い) |
 * | 日 | その日の升目 1 つ(`day`) |
 * | 週 | その週の 7 日(`week` ── 行ごと色を付ける) |
 *
 * 🔑 判断はここ 1 か所(描き手は呼ぶだけ)。`shown` は見ている日(`YYYY-MM-DD`)。
 */
export function viewedMarks(
  mode: 'list' | 'day' | 'week',
  shown: string,
  weekDays: readonly string[],
): { readonly day: string | null; readonly week: readonly string[] } {
  if (mode === 'day') return { day: shown, week: [] };
  if (mode === 'week') return { day: null, week: weekDays };
  return { day: null, week: [] };
}

/** YYYY-MM-DD の日付キー。 */
export function dateKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}
