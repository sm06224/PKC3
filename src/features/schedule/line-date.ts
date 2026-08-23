/**
 * 🔴 **本文の行に書く日付**(`@2026-08-25` / `@2026-08-25 14:00`)。
 * #292 の裁定(user 指示 2026-08-23)。
 *
 * > 「**日付を入れたチェックリスト、これが予定として機能する。この発想はいいと思う。
 * > 日付の記法としては入力がめんどくさいから、日付と時刻を簡単に入力できるし、
 * > ついてくるツールとか用意されてもいいかも**」
 *
 * ```markdown
 * - [ ] 見積を送る @2026-08-25
 * - [ ] 打ち合わせ @2026-08-25 14:00
 * - [ ] これは体裁のチェックリスト(日付が無いので予定ではない)
 * ```
 *
 * ## 🔴 なぜ「広く拾ってから捨てる」形なのか
 *
 * 走査は **`@` の後ろの数字と記号の連なりを、行けるところまで取ってから**
 * `isScheduleDate` に当てる。⚠ **わざと取りすぎている** ──
 *
 * | 書いたもの | 取るもの | 判定 |
 * |---|---|---|
 * | `@2026-08-25` | `2026-08-25` | ✅ |
 * | `@2026-8-5` | `2026-8-5` | ❌ 桁が足りない |
 * | `@2026-08-251` | `2026-08-251` | ❌ ── 🔑 **取りすぎるから弾ける** |
 * | `@1,500`(単価) | `1` | ❌ |
 * | `@3`(個数) | `3` | ❌ |
 * | `@[card](entry:…)` | ── | 一致しない(`[` は数字ではない) |
 *
 * 🔑 **`@2026-08-251` が効く理由がここにある。** 貪欲に取らずに
 * 「先頭 10 字が日付なら採用」と書くと、**`@2026-08-251` の前半だけを日付と読む**
 * ── user は 1 つの語を書いたのに、こちらが勝手に切って読むことになる。
 *
 * ## ⚠ 形を決めるのはこの file ではない
 *
 * 「日付とは何か」は `schedule-date.ts` の `isScheduleDate` 1 つである
 * (frontmatter の `date:` と**同じ規則**でなければならない ── CLAUDE.md §7)。
 * ここが持つのは「**行のどこに在るか**」だけ。
 *
 * ## ⚠ `@` の前に境目を求めない
 *
 * `会議@2026-08-25` は通る。⚠ わざとである ── 日本語には語の切れ目に空白が無いので、
 * 境目を求めると**日本語で書いた人だけ書けない**。
 * 🔑 誤って拾う心配は**形の厳しさ**が受け持っている(`@1,500` は上の表のとおり落ちる)。
 *
 * 🔑 **pure module**。DOM も DB も知らない。
 */
import { isScheduleDate, isScheduleTime } from './schedule-date';

/**
 * 走査の網。⚠ **判定はしない**(取るだけ)── 判定は `isScheduleDate` /
 * `isScheduleTime` が持つ。
 * ⚠ 時刻の区切りは**空白か `T`**(`2026-08-25T14:00` と書く人が居るため)。
 */
const AT_DATE = /@([\d-]+)(?:[ T]([\d:]+))?/g;

/** 行に書かれた 1 つの日付。 */
export interface LineDate {
  /** `YYYY-MM-DD`。⚠ 実在しない日も通る(`schedule-date.ts` の頭を参照)。 */
  readonly date: string;
  /** `HH:MM`。書いていなければ `null`。 */
  readonly time: string | null;
  /** 記法そのものの範囲(`@` から)。⚠ **時刻が読めなかったときは日付までで終わる**。 */
  readonly start: number;
  readonly end: number;
}

/**
 * 行から日付を読む。無ければ `null`。
 *
 * 🔴 **見つけるのは最初の 1 つだけ。** ⚠ 1 行に 2 つ書かれていたら、後ろは無視する
 * ── 「その行の予定はいつか」に答えが 2 つあってはならない
 * (2 つ返すと、並べる側・画面に出す側が**それぞれ好きなほうを選ぶ**)。
 */
export function readLineDate(line: string): LineDate | null {
  AT_DATE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AT_DATE.exec(line)) !== null) {
    const date = m[1]!;
    if (!isScheduleDate(date)) continue;
    const rawTime = m[2];
    // ⚠ 時刻だけ読めないときは**日付を活かす** ── `@2026-08-25 10:000円` の
    //    `10:000円` は時刻ではないが、日付は user がちゃんと書いている
    const time = rawTime !== undefined && isScheduleTime(rawTime) ? rawTime : null;
    const start = m.index;
    const afterDate = start + 1 + date.length;
    return { date, time, start, end: time === null ? afterDate : afterDate + 1 + time.length };
  }
  return null;
}

/**
 * 記法を取り除いた**表示用**の字。
 *
 * ⚠ **本文を書き換えるのに使わない。** 継ぎ目の空白を畳むので、
 *   user が置いた空白と 1 対 1 で戻らない ── 画面に出す字を作るためだけの関数である
 *   (本文を書き換えるなら `start` / `end` で原文を splice すること)。
 */
export function stripLineDate(line: string): string {
  const found = readLineDate(line);
  if (found === null) return line;
  const before = line.slice(0, found.start).replace(/[ \t]+$/, '');
  const after = line.slice(found.end).replace(/^[ \t]+/, '');
  return (before === '' || after === '' ? before + after : `${before} ${after}`).trim();
}

/**
 * 記法を組み立てる。🔴 **書きはこの 1 本だけ**(読みは上のとおり少し広い)。
 * ⚠ 呼び側が字を組み立てないこと ── 組み立てが 2 か所に散ると、
 *   片方が区切りを `T` にした日に**読める形と書く形が食い違う**。
 */
export function formatLineDate(date: string, time?: string | null): string {
  return time !== undefined && time !== null && time !== '' ? `@${date} ${time}` : `@${date}`;
}
