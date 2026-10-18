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
import { expandVarsInText, restoreUndefinedVars } from './var-expand';
import { fenceStep } from './list-renumber';
import { ifFormatMatches, ifFormatOf } from './if-format';

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
 * 🔴 **見出しの原文から、画面に見えている字を作る**(台帳 #1852 束 R1、依頼 255)。
 *
 * 飛び先の名前(`#docs`)は「画面に見えている見出しの字」から作る。以前は原文から記号を抜いただけだったので、
 * `# [Docs](http://a.com)` は `#docshttpacom` と書かないと飛べなかった。
 * ⚠ 名前を作るためだけの読み方 ── 記号は後段の `slugifyHeading` がどのみち落とすので、
 *   ここで要るのは「**字が消える / 字が増える**」物(リンク・画像・コード・ルビ・エスケープ・下線の強調)だけである。
 */
export function visibleHeadingText(raw: string): string {
  let s = raw;
  // エスケープ: `\_` は字の `_`(名前に残す)、ほかの `\記号` は名前に残らない記号なので落とす
  s = s.replace(/\\([!-/:-@[-`{-~])/g, (_m, ch: string) => (ch === '_' ? '\uE000' : ''));
  // 画像・リンク: 見える字だけ(入れ子の `()` は 1 段まで)
  s = s.replace(/!\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, '$1');
  s = s.replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, '$1');
  // ルビ・傍点: 本文の字だけ(ルビの読みは名前に入れない)
  s = s.replace(/\[\[ruby:([^|\]]*)\|[^\]]*\]\]/g, '$1');
  s = s.replace(/\[\[em:([^\]]*)\]\]/g, '$1');
  // コード: 中の字(中の `_` は強調ではない ── 先に退避して、最後に戻す)
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _q: string, inner: string) =>
    inner.replace(/_/g, '\uE000'),
  );
  // 下線の強調 `_x_` / `__x__`: 語の境目にあるものだけ(`snake_case` の `_` は字)
  s = s.replace(
    /(^|[^\p{L}\p{N}_])_{1,2}(?=\S)([^_]*?\S)_{1,2}(?![\p{L}\p{N}_])/gu,
    '$1$2',
  );
  return s.replace(/\uE000/g, '_');
}

/** 見出し番号(`1.` / `1.2` / `1.2.3`)の前置き。`preprocessHeadingNumbers` が手書き番号と見なすのと同じ形。 */
const HEADING_NUMBER_PREFIX = /^\d+(?:\.\d+)*\.?[ \t]+/;

/** 見出し番号が付く文書で、番号を除いた字(番号しか無ければそのまま)。 */
export function stripHeadingNumber(text: string): string {
  const stripped = text.replace(HEADING_NUMBER_PREFIX, '');
  return stripped.trim() === '' ? text : stripped;
}

/**
 * Slugify a heading text into a URL-/id-friendly token.
 * 🔴 見出しの**見えている字**から作る(`visibleHeadingText`)。`_` は字として残す(`snake_case` は `snake_case`)。
 */
export function slugifyHeading(text: string): string {
  return visibleHeadingText(text)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 🔴 **古い名前**(依頼 255 B / 279 / 351)── 見出しの原文から記号を抜いただけの綴り。
 * 既に書かれた `#docshttpacom` や、見出し番号つきの `entry:X#h/11-第一章-概要` を**読み続ける**ために残す。
 * ⚠ 新しく作るのには使わない(見出しに付く別名としてだけ出す)。
 */
export function legacySlugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function counterOf(slugify: (t: string) => string, pre?: (t: string) => string): (text: string) => string {
  const counter = new Map<string, number>();
  // 出した id の全部。⚠ `A, A, A-1` で 2 つ目が `a-1` を取ると、3 つ目の素の `a-1` とぶつかる
  const issued = new Set<string>();
  return (text: string) => {
    const base = slugify(pre ? pre(text) : text) || 'heading';
    let n = counter.get(base) ?? 0;
    let id = n === 0 ? base : `${base}-${n}`;
    while (issued.has(id)) {
      n += 1;
      id = `${base}-${n}`;
    }
    counter.set(base, n + 1);
    issued.add(id);
    return id;
  };
}

/**
 * Create a slug generator that tracks collisions within a single render.
 * @param opts.stripNumber 見出し番号(frontmatter `heading-number`)が付く文書では `true` ── 番号を除いた字から作る
 *   (番号は見せ方なので、章を足して番号がずれてもリンクの名前は変わらない。依頼 351)
 */
export function makeSlugCounter(opts?: { stripNumber?: boolean }): (text: string) => string {
  return counterOf(slugifyHeading, opts?.stripNumber ? stripHeadingNumber : undefined);
}

/** 古い名前(`legacySlugifyHeading`)の衝突つき発行器。見出し番号つきの字を渡すと、番号つきの古い名前になる。 */
export function makeLegacySlugCounter(): (text: string) => string {
  return counterOf(legacySlugifyHeading);
}

/**
 * 本文の目次(inspector の「目次」)を、**描かれた見出しに寄せる**ための追加の読み方(#1087)。
 * ⚠ 既定(省く)は従来どおり ── 他の呼び手(章の追記先など)の出力は変えない。
 */
export interface ExtractHeadingsOptions {
  /**
   * 描画が捨てる部分(`:::comment` / `%%%` / `%%…%%`)を先に落とす関数。
   * 🔑 注入にする ── 実体は markdown-render にあり、そこは本 file を import している(循環を避ける)
   */
  stripHidden?: (source: string) => string;
  /** setext(`===` / `---` の下線)と、引用・リストの中の `#` 見出しも拾う(描画は拾っている) */
  blockForms?: boolean;
  /**
   * 見出し番号(frontmatter `heading-number`)が付く文書であることの印(関数の中身は使わない)。
   * 🔴 台帳 #1852 束 R1(依頼 351): 本文の見出し id は**番号を除いた字**から作る(章を足して番号がずれても
   *   リンクが切れない)ので、目次の slug も番号を除いた字から作る。⚠ 目次に出す字(`text`)は番号なしのまま。
   */
  numberHeadings?: (source: string) => string;
}

/**
 * Extract h1–h3 headings from a raw markdown string.
 *
 * Intentionally ignores fenced code blocks (``` … ```).
 */
export function extractHeadingsFromMarkdown(
  markdown: string,
  opts?: ExtractHeadingsOptions,
): TocHeading[] {
  if (!markdown) return [];
  if (opts?.stripHidden) markdown = opts.stripHidden(markdown);
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
  // 🔑 展開は描画と**同じ関数**(escape `\{{…}}` ・未定義の扱いまで同じ。#1087)
  body = expandVarsInText(body, extractVars(markdown));
  body = stripMismatchedIfBlocks(body, 'html');

  // 🔴 見出し番号つきの文書は、番号を除いた字から名前を作る(本文の見出し id と同じ ── 依頼 351)。
  //   番号は本文を描くときの前置きなので、ここでは前置きせずに読み、`stripNumber` で手書きの番号も同じに揃える
  return scanHeadings(body, opts, opts?.numberHeadings !== undefined);
}

function scanHeadings(
  body: string,
  opts: ExtractHeadingsOptions | undefined,
  stripNumber: boolean,
): TocHeading[] {
  const headings: TocHeading[] = [];
  const slugOf = makeSlugCounter({ stripNumber });
  const lines = body.split(/\r?\n/);
  let fence = '';
  const blockForms = opts?.blockForms === true;
  // setext の本文候補(直前まで続く、記法を持たない行)
  let para: string[] = [];
  const headRe = blockForms
    ? /^ {0,3}(?:(?:>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+)[ \t]*)*(#{1,3})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/
    : /^ {0,3}(#{1,3})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
  for (const line of lines) {
    // 閉じは開きと同じ記号で同じ長さ以上(#1087、`advanceFence` が正本)
    const wasIn = fence !== '';
    const st = fenceStep(fence, line);
    fence = st.next;
    if (st.inside) {
      if (wasIn !== (fence !== '')) para = [];
      continue;
    }
    if (blockForms) {
      const u = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
      if (u && para.length > 0) {
        const text = para.join(' ').trim();
        para = [];
        if (text) {
          headings.push({ level: (u[1]![0] === '=' ? 1 : 2) as TocDepth, text: restoreUndefinedVars(text), slug: slugOf(text) });
        }
        continue;
      }
      // 段落の素の行だけを溜める(記法の行・空行で切る)
      if (line.trim() === '' || /^\s{0,3}(?:#|>|[-*+][ \t]|\d+[.)][ \t]|\||:::|%%|<)/.test(line)) para = [];
      else para.push(line.trim());
    }
    const m = headRe.exec(line);
    if (!m) continue;
    const level = m[1]!.length as TocLevel;
    const text = m[2]!.trim();
    if (!text) continue;
    headings.push({ level: level as TocDepth, text: restoreUndefinedVars(text), slug: slugOf(text) });
  }
  return headings;
}

/**
 * `:::if{format=X}` で format が targetFormat と一致しない block の content を
 * strip(空行で置換、中の行数は維持。開き・閉じの行は keepLines のときだけ空行で残す)。fenced code 内 marker は無視。nested
 * directive は depth tracking で handle。markdown-render.ts processIfBlocks の
 * 軽量版(TOC 抽出専用、lineMap 不要)。
 */
export function stripMismatchedIfBlocks(
  source: string,
  targetFormat: string,
  /** 🔑 `true` なら開き・閉じの行も空行で残す(行数が変わらない。添付の「行」を原文のまま返す側が使う) */
  keepLines = false,
): string {
  if (!source.includes(':::if')) return source;
  const lines = source.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  let fence = '';
  const ifOpenRe = /^:::if(?:\{([^}]*)\})?\s*$/;
  const closeRe = /^\s*:::\s*$/;
  const directiveOpenRe = /^:::([A-Za-z_][\w-]*)(?:\{[^}]*\})?\s*$/;
  while (i < lines.length) {
    const line = lines[i]!;
    // 開閉の判定は `advanceFence`(記号の種類と長さ。#1087)
    const outerStep = fenceStep(fence, line);
    fence = outerStep.next;
    if (outerStep.inside) {
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
    if (keepLines) out.push('');
    const attrs = m[1] ?? '';
    // 🔴 読み方は `if-format.ts` の 1 本(描画と同じ。#1163 依頼 282)
    const match = ifFormatMatches(ifFormatOf(attrs), targetFormat);
    i++;
    let depth = 1;
    let innerFence = '';
    while (i < lines.length && depth > 0) {
      const inner = lines[i]!;
      const innerStep = fenceStep(innerFence, inner);
      innerFence = innerStep.next;
      if (innerStep.inside) {
        if (match) out.push(inner);
        else out.push('');
        i++;
        continue;
      }
      if (closeRe.test(inner)) {
        depth--;
        if (depth === 0) {
          if (keepLines) out.push('');
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
    `<span class="pkc-toc-label">目次</span>` +
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
