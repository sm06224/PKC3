/**
 * `entry:` scheme parser / formatter.
 *
 * See `PKC2: docs/development/textlog-viewer-and-linkability-redesign.md`
 * §4.5 and §6.5 for the full grammar. Short form:
 *
 *   entry:<lid>
 *   entry:<lid>#log/<id>
 *   entry:<lid>#log/<a>..<b>
 *   entry:<lid>#day/<yyyy-mm-dd>
 *   entry:<lid>#log/<id>/<slug>
 *   entry:<lid>#h/<heading-id>        (#579 ── 本文の見出し。id は描画が刻む物と同じ)
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
  /**
   * 🔴 **本文の見出しを指す**(#579)。`id` は描画が刻む見出しの id(`makeSlugCounter` の
   * 出力)そのままで、**日本語を含みうる** ── textlog 用の `heading`(ASCII の slug)とは別の形。
   */
  | { kind: 'section'; lid: string; id: string }
  | { kind: 'legacy'; lid: string; logId: string }
  | { kind: 'invalid'; raw: string };

/** ⚠ **綴りはここ 1 か所**(#427 段①で書く側も同じものを引くようにした)。 */
export const SCHEME = 'entry:';
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const SLUG_RE = /^[A-Za-z0-9-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 見出しを指す断片の頭(#579)。⚠ `log/` / `day/` と同じ作法で 1 語で見分ける。 */
const SECTION_PREFIX = 'h/';

/**
 * 🔴 **見出しを指す断片を解く**(#579)── `h/<見出しの id>` → id。
 *
 * ⚠ id は `SLUG_RE`(ASCII の textlog 用)とは**別の規則** ── 描画(`makeSlugCounter`)が
 *   刻む id は日本語を含みうるので、「`/` と空白以外」を受ける。
 * ⚠ **URL では percent-encode されて来る**(markdown-it が href を正規化するので、
 *   `#h/見出し` と書いた本文は DOM では `#h/%E8%A6%8B…` になる)── decode してから検める。
 *   読めない `%` の並びは**そのまま**受ける(捨てると、user が手で書いた id が消える)。
 * 🔑 判定はここ 1 か所 ── `parseEntryRef` の 2 経路(`entry:` 付き / 断片だけ)と
 *   `link-target.ts`(`pkc://` の断片)が同じ関数を呼ぶ(§7)。
 *
 * @param frag `#` を含んでも含まなくてもよい
 * @returns 見出しの id。`h/` で始まらない / 空 / `/` や空白を含むなら `null`
 */
export function parseSectionFragment(frag: string): string | null {
  const f = frag.startsWith('#') ? frag.slice(1) : frag;
  if (!f.startsWith(SECTION_PREFIX)) return null;
  const raw = f.slice(SECTION_PREFIX.length);
  if (raw === '') return null;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // 読めない % の並び ── 手で書いた字として、そのまま受ける
  }
  if (id === '' || /[\s/]/.test(id)) return null;
  return id;
}

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

  // h/<見出しの id>(#579)
  if (frag.startsWith(SECTION_PREFIX)) {
    const id = parseSectionFragment(frag);
    return id === null ? invalid(raw) : { kind: 'section', lid, id };
  }

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
  // h/<見出しの id>(#579)── `entry:` 付きの経路と同じ 1 本で解く
  if (frag.startsWith(SECTION_PREFIX)) {
    const id = parseSectionFragment(frag);
    return id === null ? invalid(raw) : { kind: 'section', lid, id };
  }
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
    // ⚠ id は**生のまま**書く(`entry:abc#h/見出し`)── 本文で読める形が正本。
    //    URL へ載るときは markdown-it が percent-encode し、読む側が decode する(往復する)
    case 'section':
      return `${SCHEME}${ref.lid}#${SECTION_PREFIX}${ref.id}`;
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
