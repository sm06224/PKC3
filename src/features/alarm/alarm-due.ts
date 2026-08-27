/**
 * 🔴 **アラート ── どの予定が「いま」来たか**(#280。user 指示 2026-08-19
 * 「…連絡先、タイマー、**アラート**は組み込みアプリでリリースしたい」)。
 *
 * ## 🔑 新しい記法を足していない
 *
 * 時刻は**もう書けます** ── `- [ ] 打ち合わせ @2026-08-27 14:00`。
 * ⚠ 着手前に `schedule-keys.ts` の docstring を読んで「時刻も繰り返しも無い」と
 *   **一度誤って書きました**(#280 のコメントで訂正済み)── あの記述が古く、
 *   `line-date.ts` は `isScheduleTime` を実際に読んでいます。
 * 🔑 だからここは **`TaskCard` を読むだけ**で、鍵も形も 1 つも増やしません。
 *
 * ## ⚠ frontmatter の `date:` は鳴りません
 *
 * あちらは「**ノート 1 件が丸ごとその日**」の意味で、時刻の置き場がありません。
 * ⚠ **これは実装の穴ではなく、意味の違い**です ── 締切に時刻が要るなら
 *   行に書けます(そちらが鳴ります)。
 *
 * ⚠ **pure module**。⚠ 時計を読まない(呼び側が渡す)。
 */
import type { TaskCard } from '../schedule/task-cards';
import { isScheduleDate, isScheduleTime } from '../schedule/schedule-date';
import { storedDateParts } from '../datetime/stored-date';

/** 鳴る 1 件。⚠ `TaskCard` そのものは運ばない(必要なのはこの 4 つだけ)。 */
export interface AlarmDue {
  /** 同じ回を 2 度鳴らさないための鍵。⚠ **日付と時刻まで含める**(繰り返しがある)。 */
  readonly key: string;
  readonly lid: string;
  readonly line: number;
  readonly text: string;
  readonly time: string;
}

/**
 * 予定の「いつ」を epoch ms にする。読めない形は `null`。
 *
 * ⚠ **その端末の地方時**で読む(`new Date(y, m, d, hh, mm)`)── user が書いた
 *   `14:00` は**手元の 14 時**であって UTC ではない。
 * ⚠ **実在しない日は通す**(`2026-02-30`)── `schedule-date.ts` の裁定と同じ向きで、
 *   `Date` が寄せた日に鳴るだけである(黙って消すよりよい)。
 */
export function alarmAtMs(date: string, time: string): number | null {
  /**
   * 🔑 **日付の切り方は `stored-date.ts` の 1 本**、**時刻の形は
   *   `schedule-date.ts` の 1 本**(CLAUDE.md §7)。
   * ⚠ 1 稿目はここに正規表現を 2 つ書いており、`tests/features/stored-date.test.ts`
   *   の全数検査が落として教えた ── **検査のほうが正しい**。
   */
  if (!isScheduleDate(date) || !isScheduleTime(time)) return null;
  const d = storedDateParts(date);
  if (d === null) return null;
  const ms = new Date(
    Number(d.year),
    Number(d.month) - 1,
    Number(d.day),
    Number(time.slice(0, 2)),
    Number(time.slice(3, 5)),
    0,
    0,
  ).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** 鳴らす 1 件の鍵。⚠ **行だけでは足りない**(繰り返しは同じ行が何度も来る)。 */
export function alarmKey(card: { lid: string; line: number }, date: string, time: string): string {
  return `${card.lid} ${card.line} ${date} ${time}`;
}

/**
 * 🔴 **`(from, to]` に来た予定を返す**(左は開・右は閉)。
 *
 * ⚠ **区間で採る**(「いまと同じ分か」で採らない)── 刻みは背面のタブで
 *   間引かれるので、1 分ぴったりに見に来られる保証が無い。
 *   ⚠ 「同じ分か」で書くと、**間引かれた回はまるごと鳴らない**。
 * ⚠ 左を開区間にするのは、**同じ回を 2 度鳴らさない**ため(前回の右端 = 今回の左端)。
 *
 * 落とすもの:
 * - 🔴 **済んだ項目**(`done`)── 終わった用事で鳴らさない
 * - 時刻の無い項目(日付だけの予定は「その日」であって「その時刻」ではない)
 * - 期間(`until`)── `line-date.ts` が「期間に時刻は付けない」と決めている
 */
export function dueAlarms(
  cards: readonly TaskCard[],
  fromMs: number,
  toMs: number,
): AlarmDue[] {
  const out: AlarmDue[] = [];
  for (const c of cards) {
    if (c.done) continue;
    /**
     * ⚠ **この行は型を絞っているだけで、門ではない** ── 形の判定は
     *   `alarmAtMs`(`isScheduleDate` / `isScheduleTime`)が 1 本で持つ。
     * 🔴 変異試験 A5 が「外しても test が緑」で SURVIVED に見えたが、
     *   **外すと tsc が通らない**(vitest は型を見ないので緑に見えていた)。
     *   ⚠ **`NOT-APPLIED` の 4 つ目の顔**である ── 「当たったのに効かない」
     *   ではなく「**そもそも書けない変異**」。
     */
    if (c.date === null || c.time === null) continue;
    const at = alarmAtMs(c.date, c.time);
    if (at === null) continue;
    if (at <= fromMs || at > toMs) continue;
    out.push({ key: alarmKey(c, c.date, c.time), lid: c.lid, line: c.line, text: c.text, time: c.time });
  }
  // ⚠ **時刻の早い順**(同じ回に 2 件来たら、先の用事を上に出す)
  return out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.key < b.key ? -1 : 1));
}

/** 帯に出す 1 行(`14:00 打ち合わせ`)。⚠ 時刻を先に出す ── 探すのは時刻である。 */
export function alarmEntryText(due: AlarmDue): string {
  return `${due.time} ${due.text}`;
}

/** 帯の見出し。⚠ 本数を出す(1 件しか見えていないのか分かる)。 */
export function alarmBarLabel(count: number): string {
  return count === 1 ? '時間になりました' : `${count} 件 時間になりました`;
}
