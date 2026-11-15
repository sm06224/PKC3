/**
 * spreadsheet フレーバー: csv fence(render 指定)+ frontmatter(レイアウト・
 * グラフ・書式定義)。grid editor(P3-7)は fence 内容を編集する。
 */
import { serializeFrontmatter, type FrontmatterValue } from '../markdown/frontmatter';
/**
 * 🔑 **逃げの規則は 1 つ**(#418 段①で寄せた)── ここには PKC2 由来の
 *   同じ関数が別に書かれていた。⚠ 2 本あると、**片方だけ直しても誰も気づかない**
 *   (CLAUDE.md §7「同じ問いに答える口を 2 つ作らない」)。
 */
import { csvEscapeField } from '../markdown/csv-table';
import { type FlavorSpec } from './flavor-spec';
import { extractSchedule } from '../schedule/schedule-keys';
import { resolveCap } from '../notation/caps';

/**
 * 🔴 **行の高さを、同じ高さが続くところはまとめて書く**(#1163 依頼 357、案 A)。
 *
 * ⚠ PKC2 の表計算は行の高さを**全部の行ぶん**持つ ── そのまま前書きに書くと、目安 4,000 行を超える表で
 *   前書きの上限(16KB)を超え、**列の幅・日付・状態・タグまで全部読めなくなっていた**。
 * 🔑 書き方: 「高さ*続く行数」を空白で区切った 1 つの字(`24*6000 30 24*12`)。1 行だけの高さは数だけ(`30`)。
 *   短い表(配列の上限 `arrayItems` 以内)は今までどおり数の並びで書く(読み手を増やさない)。
 */
export function packRowHeights(heights: readonly number[]): readonly number[] | string {
  if (heights.length <= resolveCap('frontmatter', 'arrayItems')) return heights;
  const runs: string[] = [];
  for (let i = 0; i < heights.length; ) {
    let j = i + 1;
    while (j < heights.length && heights[j] === heights[i]) j += 1;
    const n = j - i;
    runs.push(n === 1 ? String(heights[i]) : `${String(heights[i])}*${String(n)}`);
    i = j;
  }
  return runs.join(' ');
}

/** {@link packRowHeights} の逆(数の並びはそのまま)。読めない字が混ざれば `null`。 */
export function unpackRowHeights(value: unknown): number[] | null {
  if (Array.isArray(value)) return value.every((v) => typeof v === 'number') ? (value as number[]) : null;
  if (typeof value !== 'string') return null;
  const out: number[] = [];
  for (const run of value.trim().split(/\s+/)) {
    const m = /^(\d+(?:\.\d+)?)(?:\*(\d+))?$/.exec(run);
    if (m === null) return null;
    const h = Number(m[1]);
    const n = m[2] === undefined ? 1 : Number(m[2]);
    for (let k = 0; k < n; k += 1) out.push(h);
  }
  return out;
}

/**
 * 前書きに書ける大きさか(読み手の上限 = 前書きの総バイト・**全部の**字の値のバイト・**全部の**並びの数)。
 * ⚠ 行の高さだけを見ない(着地前レビュー ⚠4)── グラフ・列の書式の字が上限を超えるときも読めなくなる。
 */
function frontmatterFits(meta: Record<string, FrontmatterValue>): boolean {
  const enc = new TextEncoder();
  if (enc.encode(serializeFrontmatter(meta)).length > resolveCap('frontmatter', 'bytes')) return false;
  for (const v of Object.values(meta)) {
    if (typeof v === 'string' && enc.encode(v).length > resolveCap('frontmatter', 'stringValueBytes')) return false;
    if (Array.isArray(v) && v.length > resolveCap('frontmatter', 'arrayItems')) return false;
  }
  return true;
}

/**
 * 🔴 **まとめても前書きに収まらず、行の高さを書かなかった表か**(#1163 依頼 357)── 取り込みの報告に 1 行足すための問い。
 */
export function pkc2SheetRowHeightsDropped(body: string): boolean {
  const sheet = parsePkc2Spreadsheet(body);
  if (!sheet.rowHeights || sheet.rowHeights.length === 0) return false;
  // ⚠ 行の高さを外して収まるときだけ「行の高さのせい」と言う(他の項目で溢れる表を行の高さのせいにしない)
  return !frontmatterFits(sheetMeta(sheet, true)) && frontmatterFits(sheetMeta(sheet, false));
}

/** 表の設定を前書きの項目にする。`withRows` = 行の高さも入れるか。 */
function sheetMeta(sheet: ReturnType<typeof parsePkc2Spreadsheet>, withRows: boolean): Record<string, FrontmatterValue> {
  const meta: Record<string, FrontmatterValue> = {};
  if (sheet.colWidths) meta['sheet.colWidths'] = sheet.colWidths;
  if (withRows && sheet.rowHeights) meta['sheet.rowHeights'] = packRowHeights(sheet.rowHeights) as FrontmatterValue;
  // charts / columnFormats は object 配列 ── flat YAML に載らないため
  // JSON 文字列で保持(quoted scalar round-trip)。grid editor(P3-7)が解釈する
  if (sheet.charts) meta['sheet.charts'] = JSON.stringify(sheet.charts);
  if (sheet.columnFormats) meta['sheet.columnFormats'] = JSON.stringify(sheet.columnFormats);
  return meta;
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

/**
 * 🔴 **PKC2 の表が、PKC3 で画面に出ない設定(列の幅・行の高さ・グラフ・列の書式)を持っているか**
 * (台帳 #1852 N1 / 依頼 97-3 B。Gemini 回答 = 推薦どおり)。取り込みの報告に 1 行足すための問い。
 * ⚠ 値は frontmatter に保存されるが、画面には一切出ない ── PKC2 でグラフを作っていた人は「消えた」と探す。
 */
export function pkc2SheetHasHiddenLayout(body: string): boolean {
  const s = parsePkc2Spreadsheet(body);
  return (
    (s.colWidths?.length ?? 0) > 0 ||
    (s.rowHeights?.length ?? 0) > 0 ||
    (s.charts?.length ?? 0) > 0 ||
    (s.columnFormats?.length ?? 0) > 0
  );
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
    /**
     * 🔴 **まとめても前書きに収まらなければ、行の高さだけを書かない**(#1163 依頼 357)── 書くと前書きごと読めなくなり、
     *   列の幅・日付・状態・タグまで失う。書かなかったことは取り込みの報告が言う(`pkc2SheetRowHeightsDropped`)。
     */
    const full = sheetMeta(sheet, true);
    const meta = frontmatterFits(full) ? full : sheetMeta(sheet, false);

    // `csv-render` = レンダリング面のみ(ソーストグル無し)── シートは表が本体。
    // noheader は csv fence の既存オプション規約(csv-table.ts)をそのまま使う
    const info = sheet.noHeader ? 'csv-render noheader' : 'csv-render';
    const csv = sheet.rows.map((r) => r.map((c) => csvEscapeField(c, ',')).join(',')).join('\n');
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
