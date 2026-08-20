/**
 * spreadsheet フレーバー: csv fence(render 指定)+ frontmatter(レイアウト・
 * グラフ・書式定義)。grid editor(P3-7)は fence 内容を編集する。
 */
import { serializeFrontmatter, type FrontmatterValue } from '../markdown/frontmatter';
import { type FlavorSpec } from './flavor-spec';
import { extractSchedule } from '../schedule/schedule-keys';

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
  // 「最初からセルが見えるべき」(PKC2 user direction 2026-06-02)── 5 列 × 3 行の空 grid
  seed: () => '```csv-render noheader\n,,,,\n,,,,\n,,,,\n```',
  /**
   * 🔴 **frontmatter の `date` / `status` は、アーキタイプによらず効く**
   * (2026-08-20。user 指示「カレンダーを利用するための導線が不足している」の調査で判明)。
   *
   * ⚠ 直す前は `NO_EXTRACT` を返しており、**書いても列に入らなかった**。
   *   #276 で `text` だけを `extractSchedule` へ直したときに、
   *   **同型の 4 つが取り残された**(CLAUDE.md「片側を直したら、対称の反対側を必ず疑う」)。
   * 🔴 症状は「効かない」で済まない ── カレンダーの日を押すと
   *   ①本文には `date` が入る ②カレンダーには出ない ③もう一度押すと
   *   **「本文が変わっているため反映できませんでした」という嘘の理由**が出る
   *   (列が `null` のままなので、トグルが毎回「付ける」側を送り、
   *   2 回目の splice が同値 = 変化なしになる)④外すこともできない。
   * 🔑 **founding 裁定 2026-07-30「アーキタイプ = フレーバー(見せ方・編集の仕方)」**
   *   に照らすと、`date` の意味が archetype で変わるほうが誤りである
   *   ── 見せ方が違うだけで、**書いた日付は日付**である。
   * ⚠ 鍵の名前と受理形は `schedule-keys.ts` の 1 か所(判定を増やさない)。
   * ⚠ `archived` はここでは写さない ── 理由は `extractSchedule` の docstring。
   */
  extract: (body) => ({ ...extractSchedule(body), archived: false }),
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
    // fence 長は内容の最長 backtick run + 1(最低 3)── セルに ``` があっても
    // fence が閉じない(review #2: fence 破壊でシートデータが fence 外に漏れ、
    // grid editor の再保存で欠落する S3 経路を塞ぐ)
    const longestRun = csv.match(/`+/g)?.reduce((n, s) => Math.max(n, s.length), 0) ?? 0;
    const tick = '`'.repeat(Math.max(3, longestRun + 1));
    const fence = csv === '' ? `${tick}${info}\n${tick}` : `${tick}${info}\n${csv}\n${tick}`;
    const fm = Object.keys(meta).length > 0 ? `${serializeFrontmatter(meta)}\n` : '';
    return `${fm}${fence}`;
  },
};
