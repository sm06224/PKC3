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
 * - **済んだ項目は数えない**。
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
): MissedItem[] {
  if (fromMs === null || fromMs >= toMs) return [];
  const lo = Math.max(fromMs, toMs - MISSED_LOOKBACK_DAYS * DAY_MS);
  const fromDate = localDateOf(lo);
  const toDate = localDateOf(toMs);
  const mates = materializedDates(cards);
  const out: MissedItem[] = [];
  for (const c of cards) {
    if (c.done) continue;
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
