/**
 * Date/Time format helpers for input-assistance shortcuts.
 *
 * Pure functions. Uses Intl.DateTimeFormat (ECMA-402 standard) for
 * locale-aware day-of-week abbreviation.
 * All formatters accept an optional Date for testability (default: now).
 */

export interface FormatLocaleOptions {
  locale?: string;
  timeZone?: string;
}

function localizedDay(d: Date, opts?: FormatLocaleOptions): string {
  return new Intl.DateTimeFormat(opts?.locale, { weekday: 'short', timeZone: opts?.timeZone }).format(d);
}

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

/** HH:mm:ss */
export function formatTime(d: Date = new Date()): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** yyyy/MM/dd HH:mm:ss */
export function formatDateTime(d: Date = new Date()): string {
  return `${formatDate(d)} ${formatTime(d)}`;
}

/** yy/MM/dd ddd */
export function formatShortDate(d: Date = new Date(), opts?: FormatLocaleOptions): string {
  const yy = pad2(d.getFullYear() % 100);
  return `${yy}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${localizedDay(d, opts)}`;
}

/** yy/MM/dd ddd HH:mm:ss */
export function formatShortDateTime(d: Date = new Date(), opts?: FormatLocaleOptions): string {
  return `${formatShortDate(d, opts)} ${formatTime(d)}`;
}

/** ISO 8601: yyyy-MM-ddTHH:mm:ss±HH:mm */
export function formatISO8601(d: Date = new Date()): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absOffset = Math.abs(offset);
  const oh = pad2(Math.floor(absOffset / 60));
  const om = pad2(absOffset % 60);
  return `${pad4(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${formatTime(d)}${sign}${oh}:${om}`;
}
