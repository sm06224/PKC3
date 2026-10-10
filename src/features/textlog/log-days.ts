/**
 * 🔴 **ログの「日」を束ねる**(#1441 案 b)── どの時刻見出しが、どの日の何番目の連なりか。
 *
 * ## user がやりたいこと
 *
 * 追記が何百件も溜まったログは、時刻の見出しが縦に並ぶだけで**日の単位が見えない**。
 * 日ごとの薄い行を挟み、押すとその日の追記をまとめて畳める(時刻の見出しの畳みは今までどおり残る)。
 *
 * ## 🔑 pure(DOM を知らない)
 *
 * 材料は「塊ごとの見出しの段」と「塊ごとの見出しの字」だけ。器への当て方は
 * `adapter/ui/render/log-days.ts`。本文は 1 バイトも変えない。
 *
 * ## ⚠ 時刻見出しの日付は**端末の暦日のまま**読む
 *
 * 追記が書く見出しは `formatHeadingTimestamp`(端末のローカル時刻)なので、
 * `storedDateParts` へ「日付+時刻」を渡すと UTC と読んで**日がずれる**。
 * 日付の 10 字だけを切って渡す(日付だけの値はずらさない ── `stored-date.ts` の規則)。
 */
import { storedDateParts } from '../datetime/stored-date';
import { isRealCalendarDate } from '../schedule/schedule-date';

/** 時刻見出しは `YYYY-MM-DD HH:mm(:ss)`。⚠ 見出しの頭だけを見る(`★` などが後ろに付く)。 */
const TIMESTAMP_HEAD = /^(\d{4}-\d{2}-\d{2})[ T]\d{2}:\d{2}/;

/** 追記が書く見出しの段(`## `)。⚠ 入れ子の `###` は時刻見出しとして数えない。 */
export const LOG_ENTRY_LEVEL = 2;

/**
 * 見出しの字から、その時刻見出しの**日**(`YYYY-MM-DD`)を取る。
 * 時刻見出しでない / 実在しない日は `null`(当てずっぽうで日を作らない)。
 */
export function logDayOfHeading(text: string): string | null {
  const m = TIMESTAMP_HEAD.exec(text.trim());
  if (m === null) return null;
  const date = m[1]!;
  if (!isRealCalendarDate(date)) return null;
  const p = storedDateParts(date);
  return p === null ? null : `${p.year}-${p.month}-${p.day}`;
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** 行に出す字(`2026-10-10(金)`)。⚠ 曜日は端末の暦で数える(UTC に通さない)。 */
export function formatLogDay(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  const w = new Date(y, m - 1, d).getDay();
  return `${day}(${WEEKDAYS[w]})`;
}

/** 日の連なり 1 つ。`start`〜`end` は塊の添字(`end` は含まない)。 */
export interface LogDayRun {
  readonly day: string;
  readonly start: number;
  readonly end: number;
}

/**
 * 日が変わる所ごとに 1 つ、連なりを返す(最初の日も 1 つ)。
 *
 * - 連なりは「同じ日の時刻見出し(段 2)が**途切れず**続く範囲」。次の段 1〜2 の見出しまでが 1 件の追記。
 * - 時刻見出しでない `##` が挟まったら連なりは切れる(その節は日の外 = 畳まれない)。
 * - ⚠ 同じ日が離れて 2 度出たら**別の連なり**(間の物を畳みに巻き込まない)。
 *
 * @param levels 塊ごとの見出しの段(見出しでなければ 0)
 * @param days 塊ごとの時刻見出しの日(時刻見出しでなければ `null`)
 */
export function logDayRuns(
  levels: readonly number[],
  days: readonly (string | null)[],
): readonly LogDayRun[] {
  const out: LogDayRun[] = [];
  let i = 0;
  while (i < levels.length) {
    const day = levels[i] === LOG_ENTRY_LEVEL ? (days[i] ?? null) : null;
    if (day === null) {
      i += 1;
      continue;
    }
    const start = i;
    let at = i;
    // 同じ日の時刻見出しが途切れず続く間、1 件ぶん(次の段 1〜2 の見出しまで)ずつ進む
    for (;;) {
      let next = at + 1;
      while (next < levels.length && !(levels[next]! > 0 && levels[next]! <= LOG_ENTRY_LEVEL)) {
        next += 1;
      }
      at = next;
      if (at >= levels.length || levels[at] !== LOG_ENTRY_LEVEL || days[at] !== day) break;
    }
    out.push({ day, start, end: at });
    i = at;
  }
  return out;
}
