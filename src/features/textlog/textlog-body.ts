/**
 * TEXTLOG body helpers — pure functions for the textlog archetype.
 *
 * A textlog body is a JSON string containing an array of log entries,
 * each with an id, text, timestamp, and optional flags.
 *
 * No browser APIs — features layer.
 */

import { generateLogId as generateUlidLogId } from './log-id';

export type TextlogFlag = 'important';

export interface TextlogEntry {
  id: string;
  text: string;
  createdAt: string; // ISO 8601
  flags: TextlogFlag[];
  /**
   * 🔴 **元の記録に日時が無かった行**(台帳 #1852 I2 / 依頼 158)。`createdAt` には読んだ時刻が入る(他の読み手は
   * 日付を要るので)が、**PKC3 の本文へ変換するときは、その時刻を見出しに書かない**(`(日時なし)` と書く)。
   * ⚠ 日時のある行では付けない(`undefined`)。
   */
  undated?: true;
}

export interface TextlogBody {
  entries: TextlogEntry[];
}

/**
 * Read a textlog body as `{ entries: [...] }` or a bare array of entries.
 * Returns `null` when the string is not such JSON (so callers can tell
 * "no log" apart from "not a log"). Non-object items (`null` etc.) are skipped
 * — one bad item must not drop the valid ones (#1087).
 */
export function readTextlogEntries(body: string): TextlogBody | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null; // not valid JSON
  }
  const list: unknown = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object'
      ? (parsed as { entries?: unknown }).entries
      : undefined;
  if (!Array.isArray(list)) return null;
  return {
    entries: list
      .filter((e: unknown): e is Record<string, unknown> => e !== null && typeof e === 'object')
      .map((e) => ({
        id: typeof e.id === 'string' ? e.id : generateLogId(),
        text: typeof e.text === 'string' ? e.text : '',
        createdAt: typeof e.createdAt === 'string' && e.createdAt !== '' ? e.createdAt : new Date().toISOString(),
        flags: Array.isArray(e.flags) ? (e.flags.filter((f: unknown) => typeof f === 'string') as TextlogFlag[]) : [],
        // 🔴 日時が無い(文字列でない / 空)行に印を付ける。日時の書式が壊れている行は「日時あり」のまま(原文の字を残す)
        ...(typeof e.createdAt === 'string' && e.createdAt !== '' ? {} : { undated: true as const }),
      })),
  };
}

/**
 * Parse a textlog body string into a TextlogBody.
 * Returns an empty body for invalid/empty input.
 */
export function parseTextlogBody(body: string): TextlogBody {
  return readTextlogEntries(body) ?? { entries: [] };
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
