/**
 * Table of Contents extraction — pure helper for TEXT / TEXTLOG bodies.
 *
 * Features layer — no browser APIs.
 *
 * Slice 3 of `PKC2: docs/development/textlog-viewer-and-linkability-redesign.md`
 * replaces the old flat h1–h3 list with a **time-driven** TOC for
 * TEXTLOG:
 *
 *   TEXT    → heading-driven (unchanged)
 *              level-1 heading, level-2 heading, …
 *   TEXTLOG → day / log / heading (3-layer)
 *              2026-04-10
 *                ├─ 10:00:00 first-line-preview
 *                │    ├─ # Morning notes
 *                │    └─ ## Details
 *                └─ 11:15:00 follow-up
 *                     └─ # Plan
 *              2026-04-09
 *                └─ 16:00:00 older entry
 *
 * The returned `TocNode[]` is a linearized tree (parents appear before
 * their children) — callers that render a flat list can rely on the
 * `level` (indent depth) without having to reconstruct the hierarchy.
 */
// PKC3: PKC2 の Container モデル(record.ts)は持ち込まない ── 必要面だけの構造的型
export interface TocEntryLike {
  lid: string;
  title: string;
  archetype: string;
  body: string;
}
type Entry = TocEntryLike;
import { buildTextlogDoc, type TextlogOrder } from '../textlog/textlog-doc';
import { parseFrontmatter, extractVars } from './frontmatter';

export type TocLevel = 1 | 2 | 3;

/**
 * Visual depth of a TOC node, 1-based. For TEXT this equals the
 * heading level (`<h1>` → 1, `<h2>` → 2, `<h3>` → 3). For TEXTLOG the
 * scale starts at `day=1, log=2` and headings are shifted by +2
 * (`<h1>` inside a log → 3, `<h2>` → 4, `<h3>` → 5). Anything beyond
 * 5 is not produced by the extractor; renderers should still handle
 * it gracefully (treat as "deepest" indent).
 */
export type TocDepth = 1 | 2 | 3 | 4 | 5;

export interface TocHeadingNode {
  kind: 'heading';
  /** Visual depth — see `TocDepth`. */
  level: TocDepth;
  /** Heading text, as written. */
  text: string;
  /** URL-/id-friendly slug matching the renderer output. */
  slug: string;
  /**
   * Present for TEXTLOG headings so the click handler can scope the
   * scroll target to the owning `<article data-pkc-log-id="...">`.
   */
  logId?: string;
}

export interface TocDayNode {
  kind: 'day';
  /** `yyyy-mm-dd` (local), or `''` for the undated bucket. */
  dateKey: string;
  /** Display label — mirrors the day section heading in the viewer. */
  text: string;
  /** Visual depth — always `1`. */
  level: 1;
  /**
   * DOM id of the scroll target. `day-<yyyy-mm-dd>` or `day-undated`.
   */
  targetId: string;
}

export interface TocLogNode {
  kind: 'log';
  /** Opaque log-entry id (ULID or legacy). */
  logId: string;
  /** Short label — time + first-line preview. */
  text: string;
  /** Visual depth — always `2`. */
  level: 2;
  /** DOM id of the scroll target. `log-<logId>`. */
  targetId: string;
  /** Date this log falls under (for diagnostics / parent lookup). */
  dateKey: string;
}

export type TocNode = TocHeadingNode | TocDayNode | TocLogNode;

// ── backward-compat alias ──
// Older code may still import `TocHeading`. The shape is now a subset
// of `TocHeadingNode` minus the `kind` tag; keeping the alias lets us
// migrate call sites incrementally without a module-wide churn.
export type TocHeading = Omit<TocHeadingNode, 'kind'> & { kind?: 'heading' };

/**
 * Slugify a heading text into a URL-/id-friendly token.
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Create a slug generator that tracks collisions within a single render.
 */
export function makeSlugCounter(): (text: string) => string {
  const counter = new Map<string, number>();
  return (text: string) => {
    const base = slugifyHeading(text) || 'heading';
    const n = counter.get(base) ?? 0;
    counter.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

/**
 * Extract h1–h3 headings from a raw markdown string.
 *
 * Intentionally ignores fenced code blocks (``` … ```).
 */
export function extractHeadingsFromMarkdown(markdown: string): TocHeading[] {
  if (!markdown) return [];
  const headings: TocHeading[] = [];
  const slugOf = makeSlugCounter();
  // 2026-05-09 hotfix(user バグレポ):TOC は **render と同じ前処理** を経たうえで
  // heading を抽出する必要がある。具体的には:
  //   1. frontmatter strip(YAML lines を heading として誤検出しない)
  //   2. `{{vars.x}}` 展開(`# {{vars.site}} …` を resolved value で表示)
  //   3. `:::if{format=X}` mismatch 時 content strip(html target で出ない見出しは TOC からも除く)
  // markdown-render.ts は同等の preprocess を実行するが、循環 import を避けるため
  // ここに最小実装を inline する(`processIfBlocks` の lineMap は不要、heading 抽出
  // 用途では line index 不変)。
  const fm = parseFrontmatter(markdown);
  let body = fm.body;
  const vars = extractVars(markdown);
  if (vars) {
    body = body.replace(/\{\{\s*vars\.([A-Za-z_][\w-]*)\s*\}\}/g, (_m, key: string) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : `{{vars.${key}}}`,
    );
  }
  body = stripMismatchedIfBlocks(body, 'html');

  const lines = body.split(/\r?\n/);
  let inFence = false;
  for (const line of lines) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^ {0,3}(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const level = m[1]!.length as TocLevel;
    const text = m[2]!.trim();
    if (!text) continue;
    headings.push({ level: level as TocDepth, text, slug: slugOf(text) });
  }
  return headings;
}

/**
 * `:::if{format=X}` で format が targetFormat と一致しない block の content を
 * strip(空行で置換、line count は維持)。fenced code 内 marker は無視。nested
 * directive は depth tracking で handle。markdown-render.ts processIfBlocks の
 * 軽量版(TOC 抽出専用、lineMap 不要)。
 */
function stripMismatchedIfBlocks(source: string, targetFormat: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  let i = 0;
  let inFence = false;
  const fenceRe = /^\s{0,3}(?:```|~~~)/;
  const ifOpenRe = /^:::if(?:\{([^}]*)\})?\s*$/;
  const closeRe = /^\s*:::\s*$/;
  const directiveOpenRe = /^:::([A-Za-z_][\w-]*)(?:\{[^}]*\})?\s*$/;
  while (i < lines.length) {
    const line = lines[i]!;
    if (fenceRe.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (inFence) {
      out.push(line);
      i++;
      continue;
    }
    const m = ifOpenRe.exec(line);
    if (!m) {
      out.push(line);
      i++;
      continue;
    }
    const attrs = m[1] ?? '';
    const fmtMatch = /\bformat\s*=\s*"?([\w-]+)"?/.exec(attrs);
    const fmt = fmtMatch?.[1];
    const match = fmt ? fmt === targetFormat : true;
    i++;
    let depth = 1;
    let innerFence = false;
    while (i < lines.length && depth > 0) {
      const inner = lines[i]!;
      if (fenceRe.test(inner)) {
        innerFence = !innerFence;
        if (match) out.push(inner);
        else out.push('');
        i++;
        continue;
      }
      if (innerFence) {
        if (match) out.push(inner);
        else out.push('');
        i++;
        continue;
      }
      if (closeRe.test(inner)) {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
        if (match) out.push(inner);
        else out.push('');
        i++;
        continue;
      }
      if (directiveOpenRe.test(inner)) depth++;
      if (match) out.push(inner);
      else out.push('');
      i++;
    }
  }
  return out.join('\n');
}

/**
 * Extract a linearized TOC for an entry.
 *
 *   TEXT     → heading nodes derived from `entry.body`.
 *   TEXTLOG  → day / log / heading tree derived from
 *              `buildTextlogDoc(entry, { order })`. The `order`
 *              parameter governs whether the top of the TOC is the
 *              newest day (live viewer / sidebar default) or the
 *              oldest day (rendered viewer / detached entry-window).
 *              Pass the same order the caller uses for content so
 *              the TOC's top entry corresponds to the visible top of
 *              the rendered document.
 *   other    → empty.
 *
 * For TEXTLOG, the returned array is the pre-order traversal of the
 * tree: every `day` is immediately followed by its `log` children, and
 * every `log` is immediately followed by its `heading` children. Days
 * with no logs are still emitted — useful mainly for diagnostics /
 * future empty-day styling — but in practice every day produced by
 * `buildTextlogDoc` has at least one log.
 *
 * Slug counters are reset per-log-entry for TEXTLOG so the emitted ids
 * match the renderer (each log article is a fresh slug scope).
 */
export function extractTocFromEntry(
  entry: Entry,
  options: { order?: TextlogOrder } = {},
): TocNode[] {
  if (entry.archetype === 'text' || entry.archetype === 'generic') {
    const headings = extractHeadingsFromMarkdown(entry.body);
    return headings.map((h) => ({
      kind: 'heading',
      level: h.level,
      text: h.text,
      slug: h.slug,
    }));
  }
  if (entry.archetype === 'textlog') {
    // Default 'desc' preserves the live viewer / sidebar pre-2026-05-03
    // behavior. Callers that render content in chronological ascending
    // order (rendered viewer, detached entry-window) MUST pass
    // `{ order: 'asc' }` so the TOC matches their content. The bug
    // before this parameter existed: TOC was always desc, which left
    // the rendered viewer / entry-window with TOC-vs-content mismatch.
    const doc = buildTextlogDoc(entry, { order: options.order ?? 'desc' });
    const out: TocNode[] = [];
    for (const section of doc.sections) {
      out.push({
        kind: 'day',
        dateKey: section.dateKey,
        text: section.dateKey === '' ? 'Undated' : section.dateKey,
        level: 1,
        targetId: section.dateKey === '' ? 'day-undated' : `day-${section.dateKey}`,
      });
      for (const log of section.logs) {
        out.push({
          kind: 'log',
          logId: log.id,
          text: makeLogLabel(log.createdAt, log.bodySource),
          level: 2,
          targetId: `log-${log.id}`,
          dateKey: section.dateKey,
        });
        const headings = extractHeadingsFromMarkdown(log.bodySource);
        for (const h of headings) {
          out.push({
            kind: 'heading',
            // Shift headings down by +2 so they live below day (1) and
            // log (2). An `<h1>` inside a log becomes depth 3; deeper
            // headings follow. The max produced value is 5 (h3 + 2).
            level: (h.level + 2) as TocDepth,
            text: h.text,
            slug: h.slug,
            logId: log.id,
          });
        }
      }
    }
    return out;
  }
  return [];
}

/**
 * Render a TocNode list as a self-contained static HTML string for
 * standalone preview surfaces (entry-window popped preview, exported
 * rendered-viewer HTML). Callers that already build DOM (the main-app
 * center pane) keep using `renderTocSection` in the renderer.
 *
 * Every item is a native `<a href="#target">` so scroll works without
 * any inline JS. Jump targets:
 *
 *   - `heading` → `#<slug>` — stamped on h1/h2/h3 by markdown-render.
 *   - `day`     → `#day-<dateKey>` (or `#day-undated`) — emitted on
 *                 `<section class="pkc-textlog-day">` by the textlog
 *                 document builders.
 *   - `log`     → `#log-<id>` — emitted on `<article class="pkc-textlog-log">`.
 *
 * Returns `''` when `nodes` is empty so callers can conditionally
 * include the section with a truthiness check.
 */
export function renderStaticTocHtml(nodes: readonly TocNode[]): string {
  if (nodes.length === 0) return '';
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const items = nodes
    .map((n) => {
      const href = n.kind === 'heading' ? `#${n.slug}` : `#${n.targetId}`;
      return (
        `<li class="pkc-toc-item" data-pkc-toc-kind="${n.kind}"` +
        ` data-pkc-toc-level="${n.level}">` +
        `<a class="pkc-toc-link" href="${esc(href)}">${esc(n.text)}</a>` +
        `</li>`
      );
    })
    .join('');
  return (
    `<nav class="pkc-toc pkc-toc-preview" data-pkc-region="toc">` +
    `<span class="pkc-toc-label">Contents</span>` +
    `<ul class="pkc-toc-list">${items}</ul>` +
    `</nav>`
  );
}

/**
 * Build the short label shown for a `log` node in the TOC.
 *
 * Uses the first non-empty line of the log body (trimmed and truncated
 * to ~60 chars) preceded by a compact `HH:mm:ss` time. Falls back to
 * the time alone when the body is empty, and to the raw ISO when the
 * timestamp is unparseable.
 */
export function makeLogLabel(createdAt: string, body: string): string {
  const time = formatLocalTime(createdAt);
  const firstLine = firstNonEmptyLine(body);
  if (firstLine === '') return time;
  const preview = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
  return `${time}  ${preview}`;
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '') continue;
    // Skip ATX heading lines (`# …`) because their content already
    // appears as a separate heading child row in the TOC. This keeps
    // the `log` row's preview informative without duplicating the
    // heading text.
    if (/^#{1,6}\s/.test(t) || /^#{1,6}$/.test(t)) continue;
    return t;
  }
  return '';
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
