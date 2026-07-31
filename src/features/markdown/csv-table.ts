/**
 * CSV / TSV / PSV fenced block → HTML `<table>` renderer.
 *
 * USER_REQUEST_LEDGER S-16 (2026-04-14, B-1 promotion).
 * Spec: docs/development/markdown-extensions/markdown-csv-table-extension.md
 *
 * Features layer — pure function, no browser APIs.
 *
 * Goals:
 *   - Spreadsheet → CSV copy → fenced `csv` block → real `<table>`.
 *   - Same single-HTML / no-runtime-loader posture as B-2 (no
 *     external CSV library; the parser is ~70 lines).
 *   - Compose with B-2 syntax highlight by short-circuiting the
 *     fence renderer BEFORE the highlight hook runs (CSV blocks
 *     never hit the syntax-highlight pipeline).
 *
 * Supported info-string forms:
 *
 *   ```csv          → first row treated as header (<thead><th>)
 *   ```csv noheader → all rows are <tbody><td>
 *   ```tsv          → tab-separated, header on by default
 *   ```psv          → pipe-separated, header on by default
 *
 * Quote / escape handling:
 *   - RFC 4180 subset.
 *   - Cells may be wrapped in `"…"` to allow embedded delimiters
 *     and embedded newlines.
 *   - Doubled quote inside a quoted cell (`""`) is a literal `"`.
 *   - Lines outside quoted regions are split on `\n` (CRLF
 *     normalised).
 *
 * Non-goals (per spec §5):
 *   - Cell-level edit UI (C-4 spreadsheet-archetype's job)
 *   - Sort / filter UI
 *   - Markdown evaluation inside cells (cells stay literal text)
 *   - Virtual scrolling for huge tables
 *   - CSV dialect auto-detection
 *
 * Failure mode:
 *   - On any parse error or empty input, the renderer returns
 *     `null` so the caller can fall back to the default fence
 *     rendering (preserves the user's source visually).
 */

const HEADER_OFF_FLAG = 'noheader';

export type CsvFenceLang = 'csv' | 'tsv' | 'psv';

const DELIMITER: Readonly<Record<CsvFenceLang, string>> = {
  csv: ',',
  tsv: '\t',
  psv: '|',
};

/** Returns the canonical lang id when the info string declares one of csv/tsv/psv, else null. */
export function detectCsvLang(info: string | null | undefined): CsvFenceLang | null {
  if (!info) return null;
  const first = info.trim().split(/\s+/)[0]?.toLowerCase();
  if (first === 'csv' || first === 'tsv' || first === 'psv') return first;
  return null;
}

/** True when the info string carries the `noheader` flag (header row disabled). */
export function isHeaderDisabled(info: string | null | undefined): boolean {
  if (!info) return false;
  return info
    .trim()
    .split(/\s+/)
    .slice(1)
    .some((flag) => flag.toLowerCase() === HEADER_OFF_FLAG);
}

/**
 * Parse a CSV-like document into a 2D array of cell strings.
 * Returns `null` when the input is empty after normalisation, so the
 * caller can fall back to default fence rendering.
 */
export function parseCsv(src: string, delimiter: string): string[][] | null {
  // Normalise line endings so the row split is consistent.
  const normalised = src.replace(/\r\n?/g, '\n');
  if (normalised.trim() === '') return null;

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < normalised.length; i++) {
    const ch = normalised[i];
    if (inQuotes) {
      if (ch === '"') {
        if (normalised[i + 1] === '"') {
          // Escaped quote inside quoted cell → literal `"`.
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  // Flush the final cell / row (when input doesn't end with \n).
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  // Drop trailing empty rows that the trailing newline would have
  // produced. A row of `['']` (single empty cell) counts as empty.
  while (rows.length > 0) {
    const last = rows[rows.length - 1]!;
    if (last.length === 1 && last[0] === '') {
      rows.pop();
    } else {
      break;
    }
  }

  return rows.length > 0 ? rows : null;
}

/** HTML-escape a single cell. Mirror code-highlight's escapeHtml. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render parsed rows as an HTML `<table>`.
 *
 * - The `<table>` carries `class="pkc-md-rendered-csv"` so future
 *   CSS hooks can target CSV-derived tables specifically (current
 *   styling falls back to the existing `.pkc-md-rendered table`
 *   rule, which already covers borders / padding / theme colors).
 * - When `withHeader` is true, the first row becomes `<thead><th>`;
 *   otherwise every row goes into `<tbody><td>`.
 * - Short rows are padded with empty cells to the widest row's
 *   length so the table layout stays rectangular even when source
 *   CSV has trailing-comma irregularity.
 */
/**
 * Build the table HTML from parsed rows.
 *
 * - Width-padding: short rows are extended with empty cells.
 * - Header detection: when `withHeader` is true, the first row goes
 *   into `<thead><tr><th>`, otherwise everything goes into
 *   `<tbody><tr><td>`.
 * - Cell rendering: when `inlineRender` is provided(typically the
 *   markdown-it instance's `renderInline`), each cell text is parsed
 *   as inline markdown so users can embed `**bold**` / `==highlight==`
 *   / `:文字:bold,red:`(L-6 simple-inline) etc. inside cells. When
 *   omitted, cells are HTML-escaped only(legacy plain-text behavior、
 *   2026-05-08 以前)。
 */
export function rowsToHtml(
  rows: string[][],
  withHeader: boolean,
  inlineRender?: (text: string) => string,
): string {
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const pad = (r: string[]): string[] =>
    r.length === width ? r : r.concat(Array(width - r.length).fill(''));
  const renderCell = (cell: string): string =>
    inlineRender ? inlineRender(cell) : escapeHtml(cell);

  const parts: string[] = [];
  parts.push('<table class="pkc-md-rendered-csv">');
  let bodyStart = 0;
  if (withHeader && rows.length > 0) {
    parts.push('<thead><tr>');
    for (const cell of pad(rows[0]!)) {
      parts.push(`<th>${renderCell(cell)}</th>`);
    }
    parts.push('</tr></thead>');
    bodyStart = 1;
  }
  if (rows.length > bodyStart) {
    parts.push('<tbody>');
    for (let i = bodyStart; i < rows.length; i++) {
      parts.push('<tr>');
      for (const cell of pad(rows[i]!)) {
        parts.push(`<td>${renderCell(cell)}</td>`);
      }
      parts.push('</tr>');
    }
    parts.push('</tbody>');
  }
  parts.push('</table>');
  return parts.join('');
}

/**
 * Top-level convenience: take the raw fenced block content + its
 * info string, return either the rendered `<table>` HTML or `null`
 * to signal "fall back to default fence rendering".
 */
export function renderCsvFence(
  content: string,
  info: string | null | undefined,
  inlineRender?: (text: string) => string,
): string | null {
  const lang = detectCsvLang(info);
  if (!lang) return null;
  const rows = parseCsv(content, DELIMITER[lang]);
  if (!rows) return null;
  const withHeader = !isHeaderDisabled(info);
  return rowsToHtml(rows, withHeader, inlineRender);
}
