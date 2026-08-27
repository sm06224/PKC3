/**
 * CSV / TSV / PSV fenced block → HTML `<table>` renderer.
 *
 * USER_REQUEST_LEDGER S-16 (2026-04-14, B-1 promotion).
 * Spec: PKC2: docs/development/markdown-extensions/markdown-csv-table-extension.md
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

import { displayCell } from './csv-formula';

const HEADER_OFF_FLAG = 'noheader';

export type CsvFenceLang = 'csv' | 'tsv' | 'psv';

/**
 * 🔴 **区切り字の表は 1 つ**(#418 段①で公開した)。
 * ⚠ 書き換える側(`body-rewrite.ts`)が自分で `,` を決め打つと、
 *   tsv / psv の表を**カンマで組み直して壊す**。
 */
export const DELIMITER: Readonly<Record<CsvFenceLang, string>> = {
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
/**
 * 🔴 **行とセルの位置**(#418 段①)。`parseCsv` に渡すと埋めてくれる。
 *
 * - `rowLines` … その行が**何行目から何行目まで**か(0 始まり。
 *   `start !== end` なら**引用の中の改行でまたがっている**)
 * - `cellSpans` … そのセルの**原文上の範囲**(引用符を含む外側)。
 *   ⚠ 行を組み直さずに**そのセルだけ**を差し替えるために使う ──
 *   組み直すと `"a"` が `a` になるなど、**触っていないセルの字が黙って変わる**。
 */
export interface CsvPositions {
  rowLines?: Array<{ start: number; end: number }>;
  cellSpans?: Array<Array<{ start: number; end: number }>>;
  /**
   * 🔴 **引用を閉じないまま終わったか**(`parseCsv` が書き込む)。
   *
   * ⚠ 読み手としての `parseCsv` は**寛容**でよい(`"あ` を `あ` として描く)が、
   *   **書き手はそれでは困る** ── その 1 行だけを渡したとき、
   *   「閉じていない = 次の行へ続いている」を見分ける印がないと、
   *   **またがった行の途中に字を差し込む**ことになる。
   */
  unterminated?: boolean;
}

/**
 * 🔴 **セル 1 つを CSV の字へ戻す**(#418 段①)。
 *
 * 🔑 **逃げの規則はここ 1 つ**(§7)── `spreadsheet-flavor.ts` に同じものが
 *   別で書かれていた。区切り字を受け取るので tsv / psv でも同じ規則で済む。
 * ⚠ 包むのは**区切り字 / 引用符 / 改行を含むときだけ** ── 余分に包むと、
 *   user が書いた字面が触るたびに太っていく。
 */
export function csvEscapeField(field: string, delimiter: string): string {
  if (field === '') return '';
  if (field.includes('"') || field.includes(delimiter) || /[\n\r]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

export function parseCsv(
  src: string,
  delimiter: string,
  /**
   * 🔴 **歩いたついでに位置も採る**(#418 段①)。
   *
   * 🔑 **数える側に数えさせる** ── 自前の `split('\n')` で行を数え直すと、
   *   引用の中の改行(`"あ\nい"`)で**読み手が 2 つに分かれる**。
   * ⚠ 渡さなければ 1 バイトも余分な仕事をしない(既存の呼び手はそのまま)。
   */
  out?: CsvPositions,
): string[][] | null {
  // Normalise line endings so the row split is consistent.
  const normalised = src.replace(/\r\n?/g, '\n');
  if (normalised.trim() === '') return null;

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  // ⚠ **行とセルの入り口**を覚えておく(引用符も含めた外側の位置)
  let rowStartLine = 0;
  let line = 0;
  let cellStart = 0;
  const spans: Array<Array<{ start: number; end: number }>> = [];
  let rowSpans: Array<{ start: number; end: number }> = [];
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
        if (ch === '\n') line++;
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
      rowSpans.push({ start: cellStart, end: i });
      cell = '';
      cellStart = i + 1;
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rowSpans.push({ start: cellStart, end: i });
      rows.push(row);
      spans.push(rowSpans);
      if (out) out.rowLines?.push({ start: rowStartLine, end: line });
      row = [];
      rowSpans = [];
      cell = '';
      line++;
      rowStartLine = line;
      cellStart = i + 1;
      continue;
    }
    cell += ch;
  }
  // Flush the final cell / row (when input doesn't end with \n).
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rowSpans.push({ start: cellStart, end: normalised.length });
    rows.push(row);
    spans.push(rowSpans);
    if (out) out.rowLines?.push({ start: rowStartLine, end: line });
  }

  // Drop trailing empty rows that the trailing newline would have
  // produced. A row of `['']` (single empty cell) counts as empty.
  while (rows.length > 0) {
    const last = rows[rows.length - 1]!;
    if (last.length === 1 && last[0] === '') {
      rows.pop();
      // ⚠ **位置の表も同じだけ短くする** ── さもないと行番号が 1 つずらして
      //   **別の行を書き換える**(いちばん静かなデータ破壊)
      spans.pop();
      out?.rowLines?.pop();
    } else {
      break;
    }
  }

  if (out?.cellSpans) out.cellSpans.push(...spans);
  if (out) out.unterminated = inQuotes;
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
/**
 * 🔴 **セルを押して打てるようにする指定**(#418 段①)。
 *
 * ⚠ **受け手が居る面だけ**が渡す(`interactiveTasks` と同じ作法)── 渡さなければ
 *   属性は 1 つも出ないので、書き出した HTML・印刷・goldens は 1 バイトも動かない。
 *   押せるのに本文が変わらないと、user から見て「打ったのに消えた」になる。
 */
export interface CsvCellEditing {
  /**
   * 表の r 行目が**原文の何行目**か。⚠ またがっている行では `null` を返すこと
   *   ── そこは書き換えられない(`body-rewrite.ts` が断る)ので、押させない。
   */
  readonly lineOf: (row: number) => number | null;
}

export function rowsToHtml(
  rows: string[][],
  withHeader: boolean,
  inlineRender?: (text: string) => string,
  editing?: CsvCellEditing,
): string {
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const pad = (r: string[]): string[] =>
    r.length === width ? r : r.concat(Array(width - r.length).fill(''));
  /**
   * 🔴 **式は描くときだけ評価する**(#418 段②)。
   *
   * 🔑 **正本は本文** ── 結果を本文へ書き戻さない(書き戻すと**式が消える**)。
   * ⚠ 押したときに出るのは**式のほう**である ── 原文は段① の
   *   `data-pkc-cell-raw` が持っているので、ここで結果に差し替えても
   *   打ち直しは式から始まる。
   * ⚠ 評価の入力は**升の原文**(`rows`)であって、描いた字ではない。
   */
  const renderCell = (cell: string): { html: string; why?: string } => {
    const shown = displayCell(cell, rows);
    return {
      html: inlineRender ? inlineRender(shown.text) : escapeHtml(shown.text),
      ...(shown.why !== undefined ? { why: shown.why } : {}),
    };
  };

  /**
   * 🔴 **誤りの理由を升に添える**(#418 段②)。
   *
   * ⚠ `#NAME?` の 5 文字だけでは**どの関数が駄目なのか**が分からない ──
   *   `title` に理由を置けば、指せば読める(#426 と同じ向き:
   *   「効かないなら**なぜ効かないか**を出す」)。
   * ⚠ 誤りのないときは 1 バイトも足さない(goldens が動かない)。
   */
  const cellHtml = (cell: string): { body: string; title: string } => {
    const r = renderCell(cell);
    return {
      body: r.html,
      title: r.why === undefined ? '' : ` title="${escapeHtml(r.why)}"`,
    };
  };

  /**
   * 🔴 **押す口はここで焼く**(#418 段①)。
   *
   * ⚠ 指すのは**原文の行番号**(索引ではない)── 数え方が描画側と原文側で
   *   1 つでもずれた瞬間に**別の行を書き換える**(`toggle-task` と同じ理由)。
   * ⚠ 行が**またがっている**(`lineOf` が `null`)なら押させない ── 書ける所だけ
   *   押せる形にする(押せるのに断られる口を作らない)。
   */
  const cellAttrs = (row: number, col: number, raw: string): string => {
    if (editing === undefined) return '';
    const line = editing.lineOf(row);
    if (line === null) return '';
    /**
     * 🔴 **原文を升に焼く**(#418 段①の 2 稿目で足した)。
     *
     * ⚠ 升の中身は**inline の markdown として描かれる** ── `**太字**` は
     *   `<strong>太字</strong>` になる。だから押したときに `textContent` を
     *   原文として読むと、**`**` が落ちたまま書き戻す**(静かなデータ破壊)。
     * ⚠ そのうえ升には**行・列のボタンも入っている**ので、`textContent` には
     *   `＋×` まで混ざる ── 実際そうなっていた。
     * 🔑 だから**描いた側が原文を渡す**。押す側は字を読み取らない。
     */
    return (
      ` data-pkc-action="edit-cell" data-pkc-cell-line="${line}" data-pkc-cell-col="${col}"` +
      ` data-pkc-cell-raw="${escapeHtml(raw)}"`
    );
  };

  /**
   * 🔴 **行・列を足す / 消す口**(#418 段①)。
   *
   * 🔑 **打てるだけでは動線が元に戻る** ── 5 列で足りなくなった瞬間に
   *   CSV の原文へ帰ることになる。⚠ そして足せるなら**消せる**
   *   (user 指示 2026-08-23「片道の操作を作らない」)。
   * ⚠ 出るのは**押せる面だけ**(`editing` を渡した面)── 書き出し・印刷には出ない。
   * ⚠ 印は表の**外**に置かない ── 「操作は対象の隣」(#401)。
   * 🔴 **印(`＋` / `×`)は CSS で出す。ボタンに字を入れない。**
   *   ⚠ 升の**中**に置くので、字を入れると `textContent` に混ざる ──
   *   コピーした TSV に `＋×` が入る(実際に入っていた。test で再現した)。
   *   🔑 同じ理由で見出しの畳みの印も CSS にしてある(`app.css`)。
   *   意味は `aria-label` / `title` が持つので、読み上げは落ちない。
   */
  const shapeBtn = (
    row: number,
    col: number,
    what: 'row' | 'col',
    mode: 'add' | 'remove',
    title: string,
  ): string => {
    if (editing === undefined) return '';
    const line = editing.lineOf(row);
    if (line === null) return '';
    return (
      `<button type="button" class="pkc-csv-shape" data-pkc-action="shape-cell"` +
      ` data-pkc-cell-line="${line}" data-pkc-cell-col="${col}"` +
      ` data-pkc-cell-what="${what}" data-pkc-cell-mode="${mode}"` +
      ` aria-label="${title}" title="${title}"></button>`
    );
  };

  const parts: string[] = [];
  parts.push('<table class="pkc-md-rendered-csv">');
  let bodyStart = 0;
  if (withHeader && rows.length > 0) {
    parts.push('<thead><tr>');
    pad(rows[0]!).forEach((cell, col) => {
      const c = cellHtml(cell);
      parts.push(
        `<th${cellAttrs(0, col, cell)}${c.title}>${c.body}` +
          shapeBtn(0, col, 'col', 'add', 'この列の右に列を足す') +
          shapeBtn(0, col, 'col', 'remove', 'この列を消す') +
          `</th>`,
      );
    });
    parts.push('</tr></thead>');
    bodyStart = 1;
  }
  if (rows.length > bodyStart) {
    parts.push('<tbody>');
    for (let i = bodyStart; i < rows.length; i++) {
      parts.push('<tr>');
      pad(rows[i]!).forEach((cell, col) => {
        /**
         * ⚠ 見出しが無い表(`noheader`)では**列の口が 1 行目に要る** ──
         *   `<thead>` が出ないので、そこへ置かないと**列を足す道が無くなる**。
         */
        const colBtns =
          !withHeader && i === bodyStart
            ? shapeBtn(i, col, 'col', 'add', 'この列の右に列を足す') +
              shapeBtn(i, col, 'col', 'remove', 'この列を消す')
            : '';
        const rowBtns =
          col === 0
            ? shapeBtn(i, col, 'row', 'add', 'この行の下に行を足す') +
              shapeBtn(i, col, 'row', 'remove', 'この行を消す')
            : '';
        const c = cellHtml(cell);
        parts.push(`<td${cellAttrs(i, col, cell)}${c.title}>${c.body}${rowBtns}${colBtns}</td>`);
      });
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
  /**
   * 🔴 **囲みの中身が原文の何行目から始まるか**(#418 段①)。
   * 渡さなければセルは押せないまま(既定)。
   */
  firstContentLine?: number,
): string | null {
  const lang = detectCsvLang(info);
  if (!lang) return null;
  const pos: CsvPositions | undefined =
    firstContentLine === undefined ? undefined : { rowLines: [] };
  const rows = parseCsv(content, DELIMITER[lang], pos);
  if (!rows) return null;
  const withHeader = !isHeaderDisabled(info);
  /**
   * 🔑 **行の位置は数えた側から取る** ── ここで `split('\n')` し直すと、
   *   引用の中の改行(`"あ\nい"`)で読み手が 2 つに割れる。
   * ⚠ またがっている行(`start !== end`)は `null` = 押せない。
   */
  const editing: CsvCellEditing | undefined =
    firstContentLine === undefined || pos === undefined
      ? undefined
      : {
          lineOf: (row) => {
            const at = pos.rowLines?.[row];
            if (at === undefined || at.start !== at.end) return null;
            return firstContentLine + at.start;
          },
        };
  return rowsToHtml(rows, withHeader, inlineRender, editing);
}
