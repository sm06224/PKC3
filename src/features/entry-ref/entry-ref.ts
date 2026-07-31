/**
 * `entry:` scheme parser / formatter.
 *
 * See `docs/development/textlog-viewer-and-linkability-redesign.md`
 * §4.5 and §6.5 for the full grammar. Short form:
 *
 *   entry:<lid>
 *   entry:<lid>#log/<id>
 *   entry:<lid>#log/<a>..<b>
 *   entry:<lid>#day/<yyyy-mm-dd>
 *   entry:<lid>#log/<id>/<slug>
 *   entry:<lid>#<legacy-log-id>       (legacy, accepted but not emitted)
 *
 * Invariants:
 * - The parser never throws. Unrecognized input produces
 *   `{ kind: 'invalid', raw }` so downstream code (link renderer,
 *   navigator) can fall back to a broken-ref placeholder.
 * - `lid` and `logId` are treated as opaque tokens matching
 *   `[A-Za-z0-9_-]+`. The parser deliberately does **not** check
 *   ULID shape — legacy IDs must continue to resolve.
 * - `formatEntryRef` emits the *canonical* form (always with the
 *   `log/` prefix for log references). Round-tripping a `legacy`
 *   parse still produces `entry:<lid>#<id>` so callers that copied
 *   old links do not have their strings silently rewritten.
 *
 * Features layer — no DOM access.
 */

export type ParsedEntryRef =
  | { kind: 'entry'; lid: string }
  | { kind: 'log'; lid: string; logId: string }
  | { kind: 'range'; lid: string; fromId: string; toId: string }
  | { kind: 'day'; lid: string; dateKey: string }
  | { kind: 'heading'; lid: string; logId: string; slug: string }
  | { kind: 'legacy'; lid: string; logId: string }
  | { kind: 'invalid'; raw: string };

const SCHEME = 'entry:';
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const SLUG_RE = /^[A-Za-z0-9-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse an `entry:` reference string.
 *
 * PR-V17(2026-05-14、U1 TEXTLOG Phase 1 §4.5 context-relative):`opts.currentLid`
 * を渡すと、`#log/<id>` / `#day/<yyyy-mm-dd>` / `#log/<id>/<slug>` 等の **
 * fragment-only ref**(`entry:` prefix 無し)を「同 entry 内 ref」として
 * 受理する。spec §4.5 行 142-143 で「context-relative `#log/<id>` 等の単独形
 * は同一 entry 内の描画コンテキストに限り有効」と規定されていたが、Slice 1
 * では `reserved for future extension` として未実装だった。本 PR で着地。
 */
export interface ParseEntryRefOptions {
  /**
   * 描画 context の lid。指定すると `#log/...` / `#day/...` の fragment-only
   * ref が `entry:<currentLid>#...` 同等として parse される。
   */
  currentLid?: string;
}

export function parseEntryRef(raw: string, opts: ParseEntryRefOptions = {}): ParsedEntryRef {
  if (typeof raw !== 'string') {
    return invalid(typeof raw === 'string' ? raw : String(raw));
  }
  // PR-V17:context-relative fragment-only path
  if (raw.startsWith('#') && opts.currentLid && TOKEN_RE.test(opts.currentLid)) {
    return parseFragmentWithLid(raw.slice(1), opts.currentLid, raw);
  }
  if (!raw.startsWith(SCHEME)) {
    return invalid(raw);
  }
  const rest = raw.slice(SCHEME.length);
  const hashIdx = rest.indexOf('#');
  const lid = hashIdx === -1 ? rest : rest.slice(0, hashIdx);
  const frag = hashIdx === -1 ? null : rest.slice(hashIdx + 1);

  if (!TOKEN_RE.test(lid)) return invalid(raw);
  if (frag === null) return { kind: 'entry', lid };
  if (frag === '') return invalid(raw);

  // day/<yyyy-mm-dd>
  if (frag.startsWith('day/')) {
    const dateKey = frag.slice('day/'.length);
    if (!DATE_RE.test(dateKey) || !isRealDate(dateKey)) return invalid(raw);
    return { kind: 'day', lid, dateKey };
  }

  // log/...
  if (frag.startsWith('log/')) {
    const after = frag.slice('log/'.length);
    if (after === '') return invalid(raw);

    // range: log/<a>..<b>
    const rangeIdx = after.indexOf('..');
    if (rangeIdx !== -1) {
      const fromId = after.slice(0, rangeIdx);
      const toId = after.slice(rangeIdx + 2);
      if (!TOKEN_RE.test(fromId) || !TOKEN_RE.test(toId)) return invalid(raw);
      return { kind: 'range', lid, fromId, toId };
    }

    // heading: log/<id>/<slug>
    const slashIdx = after.indexOf('/');
    if (slashIdx !== -1) {
      const logId = after.slice(0, slashIdx);
      const slug = after.slice(slashIdx + 1);
      if (!TOKEN_RE.test(logId) || !SLUG_RE.test(slug)) return invalid(raw);
      return { kind: 'heading', lid, logId, slug };
    }

    // log/<id>
    if (!TOKEN_RE.test(after)) return invalid(raw);
    return { kind: 'log', lid, logId: after };
  }

  // legacy form: bare opaque id after '#'
  if (TOKEN_RE.test(frag)) {
    return { kind: 'legacy', lid, logId: frag };
  }

  return invalid(raw);
}

/**
 * PR-V17:fragment-only ref(`#log/...` / `#day/...` 等、`entry:` prefix 無し)
 * を context lid 経由で parse。spec §4.5 「context-relative」path 用。
 *
 * 渡される `frag` は `#` を取り除いた fragment string、`raw` は元の文字列
 * (invalid 時の echo 用)。
 */
function parseFragmentWithLid(frag: string, lid: string, raw: string): ParsedEntryRef {
  if (frag === '') return invalid(raw);
  if (frag.startsWith('day/')) {
    const dateKey = frag.slice('day/'.length);
    if (!DATE_RE.test(dateKey) || !isRealDate(dateKey)) return invalid(raw);
    return { kind: 'day', lid, dateKey };
  }
  if (frag.startsWith('log/')) {
    const after = frag.slice('log/'.length);
    if (after === '') return invalid(raw);
    const rangeIdx = after.indexOf('..');
    if (rangeIdx !== -1) {
      const fromId = after.slice(0, rangeIdx);
      const toId = after.slice(rangeIdx + 2);
      if (!TOKEN_RE.test(fromId) || !TOKEN_RE.test(toId)) return invalid(raw);
      return { kind: 'range', lid, fromId, toId };
    }
    const slashIdx = after.indexOf('/');
    if (slashIdx !== -1) {
      const logId = after.slice(0, slashIdx);
      const slug = after.slice(slashIdx + 1);
      if (!TOKEN_RE.test(logId) || !SLUG_RE.test(slug)) return invalid(raw);
      return { kind: 'heading', lid, logId, slug };
    }
    if (!TOKEN_RE.test(after)) return invalid(raw);
    return { kind: 'log', lid, logId: after };
  }
  if (TOKEN_RE.test(frag)) {
    return { kind: 'legacy', lid, logId: frag };
  }
  return invalid(raw);
}

/**
 * Format a parsed reference back into its canonical string form.
 *
 * - `entry` / `log` / `range` / `day` / `heading` round-trip to
 *   their canonical `log/` or `day/` prefixed form.
 * - `legacy` round-trips to its **legacy** form (`entry:<lid>#<id>`)
 *   intentionally. Callers that want to promote a legacy ref to
 *   canonical should construct a fresh `{ kind: 'log', ... }` value
 *   — this module does not silently rewrite user-visible strings.
 * - `invalid` echoes the original raw string so the formatter is a
 *   total function.
 */
export function formatEntryRef(ref: ParsedEntryRef): string {
  switch (ref.kind) {
    case 'entry':
      return `${SCHEME}${ref.lid}`;
    case 'log':
      return `${SCHEME}${ref.lid}#log/${ref.logId}`;
    case 'range':
      return `${SCHEME}${ref.lid}#log/${ref.fromId}..${ref.toId}`;
    case 'day':
      return `${SCHEME}${ref.lid}#day/${ref.dateKey}`;
    case 'heading':
      return `${SCHEME}${ref.lid}#log/${ref.logId}/${ref.slug}`;
    case 'legacy':
      return `${SCHEME}${ref.lid}#${ref.logId}`;
    case 'invalid':
      return ref.raw;
  }
}

/** True when `raw` is a syntactically valid (non-`invalid`) reference. */
export function isValidEntryRef(raw: string): boolean {
  return parseEntryRef(raw).kind !== 'invalid';
}

function invalid(raw: string): ParsedEntryRef {
  return { kind: 'invalid', raw: typeof raw === 'string' ? raw : '' };
}

/**
 * Guard against syntactically valid but non-existent dates
 * (`2026-02-30`, `2026-13-01`, …). We reconstruct the date from its
 * components and compare round-tripped key equality so month / day
 * overflow is rejected.
 */
function isRealDate(key: string): boolean {
  const [y, m, d] = key.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return (
    dt.getFullYear() === y &&
    dt.getMonth() === m - 1 &&
    dt.getDate() === d
  );
}
