/**
 * 🔴 **ノート 1 件の予定の「いつ」を読む・書く**(台帳 #344 の残り ── frontmatter の `date:` にも期間・繰り返し・終日)。
 *
 * ## 書き方 ── 行の記法と**同じ文法**(記法 1 つは動線 1 つ)
 *
 * ```yaml
 * date: 2026-10-20                       # ノート 1 件がその日の予定(これまでどおり)
 * date: 2026-10-20 14:00                 # 時刻つき(これまでどおり)
 * date: 2026-10-20..2026-10-22           # 期間(出張・休暇)
 * date: 2026-10-20 毎週                  # 繰り返し(定例)
 * date: 2026-10-20..2026-12-31 毎週      # 終わりまで毎週
 * date: 2026-10-20 14:00 毎週            # 毎週 14:00
 * date: 2026-10-20 終日                  # 終日(時刻未定とは別)
 * ```
 *
 * 行の `@2026-10-20..2026-10-22` / `@… 毎週` / `@… 終日`(`line-date.ts`)と**同じ読み手**を通す ──
 * 文法を 2 本持つと「行では書けるのに前書きでは書けない(その逆)」が生まれる(`schedule-keys.ts` の頭と同じ戒め)。
 *
 * ## ⚠ 保存の形は変えない
 *
 * 抽出列(`entries.date`)には**開始の日だけ**を置く(これまでどおり)。期間の終わり・刻み・終日・時刻は本文から読み、
 * 予定表の走査が運ぶ(`task-cards.ts` の `noteTimeOf`)── schema の移行は要らない。
 *
 * ## ⚠ 前書きには時刻の幅・振替を置かない
 *
 * `14:00..15:00` / `振替…` は読まない(これまでどおり「読めない値」)。
 */
import { addDays, daysBetween } from '@features/datetime/date-math';
import { formatLineDate, readLineDate } from './line-date';
import { shiftWeekdaysUnit, type RepeatUnit } from './repeat';
import { foldWideDateChars, parseFrontmatterWhen, withFrontmatterDate } from './schedule-date';

export interface ScheduleWhen {
  /** 開始の日(`YYYY-MM-DD`)。 */
  readonly date: string;
  /** 期間の終わり。期間でなければ `null`。 */
  readonly until: string | null;
  readonly time: string | null;
  readonly repeat: RepeatUnit | null;
  readonly allDay: boolean;
  /** 期間・刻み・終日のどれかを含む形か(これまでの `date:` / `date: … 14:00` だけなら `false`)。 */
  readonly extended: boolean;
}

/**
 * `date:` の値を読む。読めなければ `null`。
 *
 * - これまでの形(日付だけ / 日付 + 時刻)は `parseFrontmatterWhen` に任せる(読みを 1 バイトも変えない)。
 * - それ以外は行の文法(`readLineDate`)に `@` を付けて通し、**値の全体が記法として読めたときだけ**採る
 *   (後ろに余計な字が残る / 幅 / 振替が付く値は読まない)。
 */
export function parseScheduleWhen(raw: string): ScheduleWhen | null {
  const base = parseFrontmatterWhen(raw);
  if (base !== null) {
    return { date: base.date, until: null, time: base.time, repeat: null, allDay: false, extended: false };
  }
  const text = foldWideDateChars(raw.trim());
  if (text === '') return null;
  const line = `@${text}`;
  const found = readLineDate(line);
  if (found === null || found.start !== 0 || found.end !== line.length) return null;
  if (found.timeEnd !== null || found.substitutes !== null || found.strayEnd !== 0) return null;
  if (found.until === null && found.repeat === null && !found.allDay) return null;
  return {
    date: found.date,
    until: found.until,
    time: found.time,
    repeat: found.repeat,
    allDay: found.allDay,
    extended: true,
  };
}

/** `date:` の値の開始の日。 */
export function dateOfScheduleWhen(raw: string): string | null {
  return parseScheduleWhen(raw)?.date ?? null;
}

/**
 * 🔴 **`date:` の値の日付を替える**(予定表でノートを別の日へ動かす)。
 *
 * - これまでの形は `withFrontmatterDate` のまま(時刻は残す)。
 * - 期間・刻み・終日つきの値は、**形を保ったまま**動かす:期間の終わりも同じ日数だけ(長さを保つ)、曜日の列は一緒に回し、
 *   `終日` は残す。⚠ 黙って `毎週` や期間の終わりを落とさない(落とすと「頼んでいない変更」になる)。
 * - `time` を渡すと時刻も替える(期間のときは書かれない ── 期間に時刻は無い)。
 */
export function withScheduleDate(raw: string, newDate: string, time?: string | null): string {
  const when = parseScheduleWhen(raw);
  if (when === null || !when.extended) return withFrontmatterDate(raw, newDate, time);
  const delta = daysBetween(when.date, newDate) ?? 0;
  const until = when.until === null ? null : (addDays(when.until, delta) ?? when.until);
  const repeat = when.repeat === null ? null : shiftWeekdaysUnit(when.repeat, delta);
  const at = time === undefined ? when.time : time;
  return formatLineDate(newDate, at, until, repeat, undefined, null, when.allDay).slice(1);
}
