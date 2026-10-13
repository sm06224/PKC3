/**
 * Date/Time format helpers for input-assistance shortcuts.
 *
 * Pure functions. Uses Intl.DateTimeFormat (ECMA-402 standard) for
 * locale-aware day-of-week abbreviation.
 * All formatters accept an optional Date for testability (default: now).
 */

/**
 * Zero-pad a number to 2 digits (e.g. 5 → "05", 12 → "12").
 * Used across modules that format month / day / hour / minute /
 * second components. Exported so the features/adapter layers can
 * share a single canonical implementation instead of re-declaring
 * their own inline `pad` helpers.
 */
export function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

/** yyyy/MM/dd */
export function formatDate(d: Date = new Date()): string {
  return `${pad4(d.getFullYear())}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/**
 * 🔴 **ビルドの刻印**(`M/D HH:mm`。#789)。⚠ 月日は 0 詰めしない ── 版の字に
 * 添える短い印なので、`09/08` より `9/8` のほうが読みやすい。
 *
 * 🔑 **ここに置く理由**:`help.ts` に自前で組んだら
 * `tests/features/elapsed-text.test.ts` の「時刻を組み立てる場所は 1 か所」に当たった
 * ── 日時の組み立ては**この file に寄せる**(CLAUDE.md §7)。
 */
export function formatBuildStamp(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

