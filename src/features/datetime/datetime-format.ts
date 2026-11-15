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


/** HH:mm:ss */
export function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** yyyy/MM/dd HH:mm:ss */
export function formatDateTime(d: Date): string {
  return `${formatDate(d)} ${formatTime(d)}`;
}

/** 曜日の短い字(日本語: `日` `月` … `土`)。⚠ 画面の言葉は日本語なので `ja` で組む。 */
function weekdayShort(d: Date): string {
  return new Intl.DateTimeFormat('ja', { weekday: 'short' }).format(d);
}

/** yy/MM/dd ddd(例: `26/11/15 日`) */
export function formatShortDate(d: Date): string {
  return `${pad2(d.getFullYear() % 100)}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${weekdayShort(d)}`;
}

/** yy/MM/dd ddd HH:mm:ss */
export function formatShortDateTime(d: Date): string {
  return `${formatShortDate(d)} ${formatTime(d)}`;
}

/** ISO 8601(端末の時差つき): yyyy-MM-ddTHH:mm:ss±HH:mm */
export function formatISO8601(d: Date): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${pad4(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${formatTime(d)}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * 🔴 **いまの日時を 1 打鍵で入れる命令と、入れる字の形**(#1966 2-C。PKC2 の `Ctrl+:` / `Ctrl+Shift+;` / `Ctrl+D` などと同じ形)。
 * ⚠ 命令の綴り → 字の組み立ての表は**ここ 1 か所**(鍵・操作を探す・1 面の行の欄が同じ表を引く)。
 * ⚠ `Ctrl+;`(日付を入れる)は小さなウィンドウで選ぶ別の命令(予定に載る `@日付` を入れる)── ここには入れない。
 */
export const NOW_STAMP_COMMANDS: Readonly<Record<string, (d: Date) => string>> = {
  'insert-now-time': formatTime,
  'insert-now-datetime': formatDateTime,
  'insert-now-date-weekday': formatShortDate,
  'insert-now-datetime-weekday': formatShortDateTime,
  'insert-now-iso': formatISO8601,
};
