/**
 * 🔴 **予定の知らせ ── 閉じている間は鳴らせないので、2 つの形で補う**(#855。
 * Gemini 裁定 = #1163 の依頼 20-C「両方」、コメント 6125362939)。
 *
 * ① 書き出す `.ics` に**アラーム(VALARM)**を入れる ── 外の予定表が鳴らす(`ics.ts`)
 * ② **次に開いたとき**、閉じている間に始まった予定の件数を 1 行で言う(ここ)
 *
 * ## 数える物の決め
 *
 * - 🔴 **時刻のある予定だけ**。終日(日付だけ)の予定は**数えない** ── 「いつ始まったか」の
 *   瞬間が無く、`.ics` でも鳴らさない(①と②で同じ向き)。`dueAlarms`(開いている間の知らせ)と同じ。
 * - **済んだ項目は数えない**。**片付けたノートの予定も数えない**(#1087)。
 * - 区間は `(前に開いていた時刻, いま]`(`dueAlarms` と同じ左開・右閉)。
 * - 🔑 **遡るのは最大 31 日まで** ── 久しぶりに開いた日に、繰り返しの予定で何百件も出さない。
 * - 繰り返しは**回ごとに 1 件**(規則の行 1 つを 1 件と数えると、毎日の予定を 3 週間空けても 1 件に見える)。
 *
 * ⚠ **pure module**。時計は持たない(呼び側が渡す)。
 */
import type { TaskCard } from './task-cards';
import { alarmAtMs, alarmKey } from '../alarm/alarm-due';
import { expandRepeat, materializedDates, repeatMateKey } from './repeat';
import { pad2 } from '../datetime/datetime-format';
import { addDays } from '../datetime/date-math';

/** 「知らせる時間」の選べる値(分)。`0` = なし。 */
export const SCHEDULE_LEAD_OPTIONS: readonly number[] = [0, 5, 15, 30, 60];
/** 既定は 15 分前。 */
export const SCHEDULE_LEAD_DEFAULT = 15;

/** 画面の字(「なし」「5分前」…「1時間前」)。 */
export function leadLabel(minutes: number): string {
  if (minutes === 0) return 'なし';
  if (minutes === 60) return '1時間前';
  return `${minutes}分前`;
}

/** 壊れた値・選べない値は既定へ丸める(黙って 0 = なし にしない)。 */
export function normalizeLead(n: number): number {
  return SCHEDULE_LEAD_OPTIONS.includes(n) ? n : SCHEDULE_LEAD_DEFAULT;
}

/** 遡る日数の上限。 */
export const MISSED_LOOKBACK_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MissedItem {
  readonly key: string;
  readonly lid: string;
  readonly line: number;
  readonly at: number;
}

function localDateOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * `(fromMs, toMs]` に始まった、済んでいない時刻つきの予定。時刻の早い順。
 * 🔑 `fromMs` が `null`(この端末でこのコレクションを開くのが初めて)なら**何も返さない**。
 */
export function missedItems(
  cards: readonly TaskCard[],
  fromMs: number | null,
  toMs: number,
  archived: ReadonlySet<string> = new Set(),
): MissedItem[] {
  if (fromMs === null || fromMs >= toMs) return [];
  const lo = Math.max(fromMs, toMs - MISSED_LOOKBACK_DAYS * DAY_MS);
  const fromDate = localDateOf(lo);
  const toDate = localDateOf(toMs);
  const mates = materializedDates(cards);
  const out: MissedItem[] = [];
  for (const c of cards) {
    if (c.done || archived.has(c.lid)) continue;
    // ⚠ この行は型を絞っているだけで、門ではない(`alarm-due.ts` と同じ)── 形の判定は `alarmAtMs` が 1 本で持つ。
    //   終日(`time` が null)を外すのも、そちらが null を返すから(変異試験で確かめた)
    if (c.date === null || c.time === null) continue;
    const time = c.time;
    let dates: readonly string[];
    if (c.repeat === null) {
      dates = [c.date];
    } else {
      const skip = mates.get(repeatMateKey(c.lid, c.text));
      dates = expandRepeat({
        anchor: c.date,
        unit: c.repeat,
        until: c.until,
        from: fromDate,
        to: toDate,
        ...(skip === undefined ? {} : { skip }),
      }).days;
    }
    for (const date of dates) {
      const at = alarmAtMs(date, time);
      if (at === null || at <= lo || at > toMs) continue;
      out.push({ key: alarmKey(c, date, time), lid: c.lid, line: c.line, at });
    }
  }
  return out.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
}

/** 帯の 1 行。 */
export function missedLabel(count: number): string {
  return `見逃した予定が ${count} 件あります`;
}

/**
 * 🔴 **起動したときの「今日と明日の予定」の件数**(台帳 #1852 束 E1。Gemini 裁定 = #1163 の依頼 57 の 1 = A)。
 *
 * 日付だけの予定(時刻が無い)は、音も「見逃した予定」も出ない ── 気づけるのは予定表を開いたときだけだった。
 * 開いたとき 1 行で「今日の予定 2 件 / 明日の予定 1 件」と言う。
 * - 数えるのは**済んでいない予定**(時刻つきも含める ── 字が「今日の予定」なので、日付だけに絞ると偽になる)。
 *   片付けたノート・予定表の「出すもの」で外したノートは数えない(`archived` に入れて渡す)。
 * - 繰り返しは、その日に出る回だけ。期間は、その日が期間の内なら数える。
 * - 🔑 件数が 0 の日は言わない。両方 0 なら `null`(何も言わない)。
 */
export function upcomingCounts(
  cards: readonly TaskCard[],
  today: string,
  archived: ReadonlySet<string> = new Set(),
): { readonly today: number; readonly tomorrow: number } {
  const tomorrow = addDays(today, 1);
  const mates = materializedDates(cards);
  const hit = (c: TaskCard, day: string): boolean => {
    if (c.date === null) return false;
    if (c.repeat !== null) {
      const skip = mates.get(repeatMateKey(c.lid, c.text));
      return (
        expandRepeat({
          anchor: c.date,
          unit: c.repeat,
          until: c.until,
          from: day,
          to: day,
          ...(skip === undefined ? {} : { skip }),
        }).days.length > 0
      );
    }
    return c.date <= day && day <= (c.until ?? c.date);
  };
  let t = 0;
  let n = 0;
  for (const c of cards) {
    if (c.done || archived.has(c.lid)) continue;
    if (hit(c, today)) t += 1;
    if (tomorrow !== null && hit(c, tomorrow)) n += 1;
  }
  return { today: t, tomorrow: n };
}

/** 起動したときの 1 行(`今日の予定 2 件 / 明日の予定 1 件`)。両方 0 なら `null`。 */
export function upcomingLabel(counts: { readonly today: number; readonly tomorrow: number }): string | null {
  const parts: string[] = [];
  if (counts.today > 0) parts.push(`今日の予定 ${counts.today} 件`);
  if (counts.tomorrow > 0) parts.push(`明日の予定 ${counts.tomorrow} 件`);
  return parts.length === 0 ? null : parts.join(' / ');
}

/** その瞬間の「その端末の日付」(`YYYY-MM-DD`)。 */
export function localDateOfMs(ms: number): string {
  return localDateOf(ms);
}
