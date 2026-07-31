/**
 * Common render representation for TEXTLOG — `TextlogDoc`.
 *
 * This module is the source of truth for every TEXTLOG surface:
 * live viewer, rendered viewer, print, HTML download, and
 * transclusion all derive from `buildTextlogDoc()` (see
 * `docs/development/textlog-viewer-and-linkability-redesign.md`).
 *
 * Slice 1 scope:
 * - Types only (no DOM).
 * - Day grouping derived at render time from `createdAt` (local
 *   timezone). Storage order is the source of truth for the
 *   relative ordering of logs **within** a day.
 * - `order` is the universal ordering rule: both `sections` (days)
 *   and `logs` within a day follow the same `order`. A builder that
 *   returned sections asc but logs desc (or vice versa) would break
 *   the contract that all 5 surfaces share a single representation.
 *
 * Later slices will add builder options (`embedded`, `resolveRefs`,
 * `idScope`) as they become meaningful; keeping them out of Slice 1
 * avoids committing to behavior that is not yet exercised.
 *
 * Features layer — no browser APIs.
 */

// PKC3: PKC2 の Container モデル(record.ts)は持ち込まない ── 必要面だけの構造的型
export interface TextlogEntryLike {
  lid: string;
  title: string;
  archetype: string;
  body: string;
}
type Entry = TextlogEntryLike;
import { parseTextlogBody, type TextlogFlag } from './textlog-body';

export type TextlogOrder = 'asc' | 'desc';

export interface LogArticle {
  /** Opaque log-entry id. ULID for new entries, legacy for old. */
  id: string;
  /** Raw ISO timestamp (never reformatted here). */
  createdAt: string;
  flags: TextlogFlag[];
  /**
   * Raw markdown source for the log entry's body. Asset / entry
   * references are **not** resolved at this layer — resolution is
   * deferred to DOM-builder time so the representation itself
   * remains pure data.
   */
  bodySource: string;
}

export interface DaySection {
  /** `yyyy-mm-dd` in local time. */
  dateKey: string;
  /**
   * Logs that fall inside this day. Ordered according to the
   * document's `order` (see contract note above).
   */
  logs: LogArticle[];
}

export interface TextlogDoc {
  /** Source entry lid — needed so downstream can build canonical anchors. */
  sourceLid: string;
  order: TextlogOrder;
  sections: DaySection[];
}

export interface BuildTextlogDocOptions {
  /**
   * Controls the display order of both `sections` (days) and `logs`
   * within each day. Default `'asc'` — chronological, natural
   * document order. Live viewer passes `'desc'` for the append-recent
   * UX; rendered / printed / exported surfaces use `'asc'`.
   */
  order?: TextlogOrder;
}

/**
 * Build the common render representation for a TEXTLOG entry.
 *
 * Day buckets are derived from each log's `createdAt` in the local
 * timezone. Entries with an unparseable timestamp are placed in a
 * dedicated `''` date bucket which sorts to the front under `'asc'`
 * and to the back under `'desc'` — callers should treat this bucket
 * as "undated" (likely a data corruption signal).
 *
 * Non-textlog entries yield an empty document (`sections: []`) so
 * callers can invoke the builder without archetype-switching.
 */
export function buildTextlogDoc(
  entry: Entry,
  options: BuildTextlogDocOptions = {},
): TextlogDoc {
  const order: TextlogOrder = options.order ?? 'asc';
  const doc: TextlogDoc = {
    sourceLid: entry.lid,
    order,
    sections: [],
  };
  if (entry.archetype !== 'textlog') return doc;

  const body = parseTextlogBody(entry.body);
  if (body.entries.length === 0) return doc;

  // Group by local-date key. Storage order is preserved by using a
  // Map (insertion-ordered) and pushing in append order.
  const buckets = new Map<string, LogArticle[]>();
  for (const e of body.entries) {
    const key = toLocalDateKey(e.createdAt);
    const list = buckets.get(key) ?? [];
    list.push({
      id: e.id,
      createdAt: e.createdAt,
      flags: [...e.flags],
      bodySource: e.text,
    });
    buckets.set(key, list);
  }

  // Day ordering: chronological by dateKey string (ISO yyyy-mm-dd
  // is lexicographically sortable). Undated bucket (`''`) sorts to
  // the front under 'asc'.
  const keys = [...buckets.keys()].sort();
  const orderedKeys = order === 'asc' ? keys : [...keys].reverse();

  for (const key of orderedKeys) {
    const rawLogs = buckets.get(key)!;
    const logs = order === 'asc' ? rawLogs : [...rawLogs].reverse();
    doc.sections.push({ dateKey: key, logs });
  }

  return doc;
}

/**
 * Convert an ISO timestamp to a local-time `yyyy-mm-dd` date key.
 *
 * Returns the empty string for an unparseable input so callers can
 * distinguish "undated" from a real date without throwing.
 */
export function toLocalDateKey(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
