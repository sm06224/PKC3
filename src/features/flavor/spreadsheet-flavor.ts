/**
 * spreadsheet フレーバー: csv fence(render 指定)+ frontmatter(レイアウト・
 * グラフ・書式定義)。grid editor(P3-7)は fence 内容を編集する。
 */
import { serializeFrontmatter, type FrontmatterValue } from '../markdown/frontmatter';
import { NO_EXTRACT, type FlavorSpec } from './flavor-spec';

/** PKC2 spreadsheet-body.ts の csvEscapeField と同一規則。 */
function csvEscapeField(field: string): string {
  if (field === '') return '';
  if (/[",\n\r]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

interface Pkc2Spreadsheet {
  rows: string[][];
  colWidths?: number[];
  rowHeights?: number[];
  charts?: unknown[];
  noHeader?: boolean;
  columnFormats?: unknown[];
}

/** PKC2 parseSpreadsheetBody と同趣旨の寛容 parse(不正は空シート)。 */
function parsePkc2Spreadsheet(body: string): Pkc2Spreadsheet {
  try {
    const p = JSON.parse(body) as Record<string, unknown>;
    if (!p || !Array.isArray(p.rows)) return { rows: [] };
    const rows = p.rows.map((r) =>
      Array.isArray(r) ? r.map((c) => (typeof c === 'string' ? c : String(c ?? ''))) : [],
    );
    const numArray = (v: unknown): number[] | undefined =>
      Array.isArray(v) && v.every((n) => typeof n === 'number')
        ? (v as number[])
        : undefined;
    return {
      rows,
      colWidths: numArray(p.colWidths),
      rowHeights: numArray(p.rowHeights),
      charts: Array.isArray(p.charts) && p.charts.length > 0 ? p.charts : undefined,
      noHeader: p.noHeader === true ? true : undefined,
      columnFormats:
        Array.isArray(p.columnFormats) && p.columnFormats.length > 0
          ? p.columnFormats
          : undefined,
    };
  } catch {
    return { rows: [] };
  }
}

export const spreadsheetFlavor: FlavorSpec = {
  archetype: 'spreadsheet',
  extract: () => NO_EXTRACT,
  fromPkc2(body) {
    const sheet = parsePkc2Spreadsheet(body);
    const meta: Record<string, FrontmatterValue> = {};
    if (sheet.colWidths) meta['sheet.colWidths'] = sheet.colWidths;
    if (sheet.rowHeights) meta['sheet.rowHeights'] = sheet.rowHeights;
    // charts / columnFormats は object 配列 ── flat YAML に載らないため
    // JSON 文字列で保持(quoted scalar round-trip)。grid editor(P3-7)が解釈する
    if (sheet.charts) meta['sheet.charts'] = JSON.stringify(sheet.charts);
    if (sheet.columnFormats)
      meta['sheet.columnFormats'] = JSON.stringify(sheet.columnFormats);

    // `csv-render` = レンダリング面のみ(ソーストグル無し)── シートは表が本体。
    // noheader は csv fence の既存オプション規約(csv-table.ts)をそのまま使う
    const info = sheet.noHeader ? 'csv-render noheader' : 'csv-render';
    const csv = sheet.rows.map((r) => r.map(csvEscapeField).join(',')).join('\n');
    const fence = csv === '' ? `\`\`\`${info}\n\`\`\`` : `\`\`\`${info}\n${csv}\n\`\`\``;
    const fm = Object.keys(meta).length > 0 ? `${serializeFrontmatter(meta)}\n` : '';
    return `${fm}${fence}`;
  },
};
