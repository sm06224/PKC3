/**
 * TEXTLOG body helpers — pure functions for the textlog archetype.
 *
 * A textlog body is a JSON string containing an array of log entries,
 * each with an id, text, timestamp, and optional flags.
 *
 * No browser APIs — features layer.
 */

import { formatDate, pad2 } from '../datetime/datetime-format';
import { generateLogId as generateUlidLogId } from './log-id';

export type TextlogFlag = 'important';

export interface TextlogEntry {
  id: string;
  text: string;
  createdAt: string; // ISO 8601
  flags: TextlogFlag[];
}

export interface TextlogBody {
  entries: TextlogEntry[];
}

/**
 * Parse a textlog body string into a TextlogBody.
 * Returns an empty body for invalid/empty input.
 */
export function parseTextlogBody(body: string): TextlogBody {
  if (!body) return { entries: [] };
  try {
    const parsed = JSON.parse(body);
    if (parsed && Array.isArray(parsed.entries)) {
      return {
        entries: parsed.entries.map((e: Record<string, unknown>) => ({
          id: typeof e.id === 'string' ? e.id : generateLogId(),
          text: typeof e.text === 'string' ? e.text : '',
          createdAt: typeof e.createdAt === 'string' ? e.createdAt : new Date().toISOString(),
          flags: Array.isArray(e.flags) ? e.flags.filter((f: unknown) => typeof f === 'string') : [],
        })),
      };
    }
  } catch {
    // not valid JSON
  }
  return { entries: [] };
}

/**
 * Serialize a TextlogBody to a JSON string.
 */
export function serializeTextlogBody(body: TextlogBody): string {
  return JSON.stringify(body);
}

/**
 * Append a new log entry with auto-generated id and timestamp.
 */
export function appendLogEntry(body: TextlogBody, text: string, now: Date = new Date()): TextlogBody {
  const entry: TextlogEntry = {
    id: generateLogId(),
    text,
    createdAt: now.toISOString(),
    flags: [],
  };
  return { entries: [...body.entries, entry] };
}

/**
 * Toggle a flag on a log entry.
 */
export function toggleLogFlag(body: TextlogBody, entryId: string, flag: TextlogFlag): TextlogBody {
  return {
    entries: body.entries.map((e) => {
      if (e.id !== entryId) return e;
      const has = e.flags.includes(flag);
      return {
        ...e,
        flags: has ? e.flags.filter((f) => f !== flag) : [...e.flags, flag],
      };
    }),
  };
}

/**
 * Delete a log entry by id.
 */
export function deleteLogEntry(body: TextlogBody, entryId: string): TextlogBody {
  return {
    entries: body.entries.filter((e) => e.id !== entryId),
  };
}

/**
 * Format a timestamp for UI display.
 *
 * Shows date + localized weekday + HH:mm:ss. The date portion is produced
 * by the shared `formatDate` helper so log timestamps match the rest of
 * the app's date formatting conventions.
 *
 * Seconds are included so high-frequency log entries are visually
 * distinguishable (see `docs/development/textlog-readability-hardening.md`).
 *
 * **Scope**: this formatter is for **UI display only**. Export / copy
 * paths (CSV `timestamp_display`, Copy Reference labels) emit the raw
 * ISO timestamp instead, so millisecond fidelity is preserved when the
 * log leaves the app.
 */
export function formatLogTimestampWithSeconds(iso: string, locale?: string, timeZone?: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const day = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone }).format(d);
  return `${formatDate(d)} ${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// Slice 4-B (TEXTLOG Viewer & Linkability Redesign): the legacy
// `serializeTextlogAsMarkdown` flatten helper (`## <ISO>` heading per
// log row) has been removed. Rendered viewer / print / HTML download
// all drive off `buildTextlogDoc` (features/textlog/textlog-doc.ts)
// now, so there is no second render path to keep in sync. Copy-MD for
// TEXTLOG is also removed from the action bar; TEXT copy-MD remains
// and reads `entry.body` directly.

/**
 * Internal ID generator for newly-created log entries.
 *
 * Slice 1 of `textlog-viewer-and-linkability-redesign.md` switched
 * this from the legacy `log-<ts>-<n>` counter format to ULID.
 * Existing IDs parsed from stored bodies are **never** rewritten —
 * `parseTextlogBody` preserves whatever id string the entry already
 * carries, and the resolver treats both formats as equally valid
 * opaque tokens.
 */
function generateLogId(): string {
  return generateUlidLogId();
}
