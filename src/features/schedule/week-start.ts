/**
 * 🔴 **週の始まり**(#1163 の依頼 191。Gemini の裁定:月曜始まりを選べる設定を足す)。
 *
 * 予定表の「週」と「月」と小さな月の升目は、これまで日曜始まりで固定だった。ここは**どの曜日から並べるか**の
 * 判断だけを持つ(好みの保存は `adapter/ui/render/schedule-week-start.ts`)。
 *
 * ⚠ 既定は**日曜始まり**(いままでの見え方。選ばない人の画面は 1 ドットも変わらない)。
 * ⚠ 並びが変わるだけで、日付・予定・繰り返し・書き出しの `.ics` には触れない。
 */
export type WeekStart = 0 | 1;

export const WEEK_START_DEFAULT: WeekStart = 0;

/** 選べる値(設定ファイルの検査と選択肢の元)。0 = 日曜始まり / 1 = 月曜始まり。 */
export const WEEK_START_OPTIONS: readonly WeekStart[] = [0, 1];

export function weekStartLabel(ws: WeekStart): string {
  return ws === 1 ? '月曜始まり' : '日曜始まり';
}

/** 読んだ値を選べる値へ丸める。⚠ 読めない字は既定(日曜始まり)へ倒す。 */
export function normalizeWeekStart(raw: unknown): WeekStart {
  return raw === 1 || raw === '1' ? 1 : WEEK_START_DEFAULT;
}

const NAMES = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** 見出しの 7 曜日。`dow` は `Date#getDay` の値(0 = 日曜)── 土日の印はこの値で決める(並びの位置ではない)。 */
export function weekdayHeads(ws: WeekStart): { readonly label: string; readonly dow: number }[] {
  return Array.from({ length: 7 }, (_, i) => {
    const dow = (i + ws) % 7;
    return { label: NAMES[dow]!, dow };
  });
}

/** その曜日(0 = 日曜)が週の何番目か(0 始まり)。 */
export function columnOf(dow: number, ws: WeekStart): number {
  return (dow - ws + 7) % 7;
}
