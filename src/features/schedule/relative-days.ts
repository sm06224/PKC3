/**
 * 🔴 **本文の `@2026-10-15` の右に添える「あと3日」「5日前」の字**(#1225)。
 *
 * > user の物語:予定に `@日付` と書いて読み返す ── **今日から何日先か**を、
 * > 暦を数えずに知りたい(カレンダーの面は「今日 / 明日」と言うのに、本文は日付しか言わない)。
 *
 * ## 決めたこと(Gemini 裁定 2026-10-01)
 *
 * - 今日は「今日」、明日は「明日」、それ以外は **「あとN日」「N日前」**
 *   (昨日も「1日前」── 「昨日」とは言わない)。1 年以上先・前もそのまま日数
 * - ⚠ 字は**その場で作る物**で、本文にも描画結果にも**書かない**(日が変わると嘘になる)
 *
 * ⚠ **「今日」は呼び側が渡す** ── この層は現在時刻を読まない(pure 層の規律)。
 * ⚠ 読めない日付は `null`(**字を出さない**。読めなかったことを「あと0日」で隠さない)。
 */
import { daysBetween } from '@features/datetime/date-math';

export function relativeDayLabel(date: string, today: string): string | null {
  const diff = daysBetween(today, date);
  if (diff === null) return null;
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  return diff > 1 ? `あと${diff}日` : `${-diff}日前`;
}
