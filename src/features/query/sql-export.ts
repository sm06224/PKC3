/**
 * 🔴 **SQL の答えを file へ書き出す**(#918 段④。user 要望 2026-09-14
 *   「`copy to` 使えないし」)。
 *
 * ## なぜ切り出したか
 *
 * ⚠ いままで答えの持ち帰り方は「**ノートへ**」の 1 本だけだった ── 表計算や
 * 別の道具へ渡したい人は、**画面から手で写す**しかなかった。
 * 🔑 判断(逃げの規則・null の出し方・名前の付け方)を描画器へ書き散らさないため、
 * ここに寄せる(§7)。
 *
 * ## 🔴 表示の字と、書き出す字は**別物である**
 *
 * ⚠ 画面では `null` を **`(なし)`** と描く(「空の字」と「値が無い」を見分けるため)。
 * ⚠ ところが**それを file に出すと、`(なし)` という 5 文字のデータになる** ──
 * 受け取った表計算では、それが本当に打たれた字なのか区別が付かない。
 * 🔑 だから file では `csv` / `tsv` は**空**、`json` は **`null`** にする。
 */
import { csvEscapeField } from '../markdown/csv-table';

/** 書き出せる形。⚠ 増やすときは `SQL_EXPORT_KINDS` にも足す(一覧が正本)。 */
export type SqlExportKind = 'csv' | 'tsv' | 'json';

/**
 * 🔴 **並べる順が、画面の並びの正本**(#918 段④)。
 * ⚠ 手で 2 か所に並べない ── 画面の項目も、受け口の検めも、この 1 本から採る。
 */
export const SQL_EXPORT_KINDS: readonly SqlExportKind[] = ['csv', 'tsv', 'json'];

/** 画面に出す字(拡張子ではなく、**何ができるか**で書く)。 */
export function sqlExportLabel(kind: SqlExportKind): string {
  if (kind === 'csv') return 'CSV(表計算で開く)';
  if (kind === 'tsv') return 'TSV(タブ区切り)';
  return 'JSON(プログラムで読む)';
}

/** 受け口で使う ── 読めない字は捨てる(器を作り直す前の押しが飛んでくる)。 */
export function asSqlExportKind(raw: string | null): SqlExportKind | null {
  return SQL_EXPORT_KINDS.find((k) => k === raw) ?? null;
}

/** file に付ける種別。⚠ `text/csv` を tsv に使い回さない(受け手が区切りを推測する)。 */
export function sqlExportMime(kind: SqlExportKind): string {
  if (kind === 'csv') return 'text/csv;charset=utf-8';
  if (kind === 'tsv') return 'text/tab-separated-values;charset=utf-8';
  return 'application/json;charset=utf-8';
}

type Cell = string | number | null;

/**
 * 🔴 **`.csv` は BOM 付きで渡す**(#708 段① と**同じ判断**)。
 *
 * ⚠ BOM が無いと、Windows の Excel は `.csv` を**その環境の既定の文字集合**で
 *   読むので、日本語の升が**そのまま文字化けする** ── ボタンに
 *   「**表計算で開く**」と書いてあるのに開けない、という形になる。
 * ⚠ BOM は表計算・エディタ・`pandas`(`utf-8-sig`)のいずれも読み飛ばす。
 * ⚠ **生バイトで書かない**(CLAUDE.md §9)── 見えない字なので、次に触る人が
 *   消したことに気づけない。
 *
 * 🔴 **付けるのは `csv` だけ**(前例 `copy-md-block.ts` と揃える):
 *
 * | 形 | BOM | なぜ |
 * |---|---|---|
 * | `csv` | **付ける** | 画面の字が「表計算で開く」= Excel が読む前提 |
 * | `tsv` | 付けない | 画面の字は「タブ区切り」= 道具が読む前提。`pandas` の既定
 *   (`encoding='utf-8'`)では BOM が**1 列目の名前に残る** |
 * | `json` | 🔴 **付けてはいけない** | `JSON.parse` は BOM 付きの字で**例外を投げる** |
 */
const BOM_BY_KIND: Readonly<Record<SqlExportKind, string>> = {
  csv: '\uFEFF',
  tsv: '',
  json: '',
};

/**
 * 🔴 **file に書く中身をまるごと組む**(#918 段④)。
 *
 * 🔑 **名前を「answer の字」ではなく「file の中身」にしてある** ── BOM を
 *   付けるかどうかの判断をここから外に出すと、呼び側が**付け忘れた日に
 *   黙って文字化けする**(§7「同じ判定が 2 か所」)。口はこの 1 本だけ。
 *
 * ⚠ `csv` / `tsv` の**1 行目は列の名前** ── 無いと、受け取った側で
 *   「1 行目がデータなのか見出しなのか」が決まらない。
 * ⚠ 改行は **`\r\n`** にする(RFC 4180。Excel が素直に開く)。
 *   🔑 升の**中**の改行は `csvEscapeField` が引用符で包むので、行の区切りと混ざらない。
 * ⚠ 逃げの規則は**書かない** ── `csvEscapeField` に任せる(§7。同じ規則を 2 つ持たない)。
 */
export function sqlExportFileText(
  columns: readonly string[],
  rows: readonly (readonly Cell[])[],
  kind: SqlExportKind,
): string {
  const bom = BOM_BY_KIND[kind];
  if (kind === 'json') {
    const out = rows.map((r) => {
      const o: Record<string, Cell> = {};
      // ⚠ **列の名前で組む** ── 添字で組むと、列の並びが変わった日に静かにずれる
      columns.forEach((c, i) => {
        o[c] = r[i] ?? null;
      });
      return o;
    });
    return `${bom}${JSON.stringify(out, null, 2)}\n`;
  }
  const delim = kind === 'csv' ? ',' : '\t';
  // ⚠ `null` は**空**(画面の `(なし)` を file へ出さない ── 上の注記)
  const cell = (v: Cell | undefined): string =>
    v === null || v === undefined ? '' : csvEscapeField(String(v), delim);
  const head = columns.map((c) => csvEscapeField(c, delim)).join(delim);
  const body = rows.map((r) => columns.map((_, i) => cell(r[i])).join(delim));
  return `${bom}${[head, ...body].join('\r\n')}\r\n`;
}

/** 2 桁に揃える(日付の見た目を揃えるだけ)。 */
function two(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * file の名前。⚠ **`/` と `:` を入れない**(OS が受けない)。
 * 🔑 調べた相手の名前を入れる ── 何日も経つと「どの DB の答えか」が分からなくなる。
 */
export function sqlExportFileName(
  now: Date,
  where: string | null,
  kind: SqlExportKind,
): string {
  const stamp = `${String(now.getFullYear())}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}${two(now.getMinutes())}`;
  const safe = (where ?? 'この PKC').replace(/[\\/:*?"<>|]/g, '_');
  return `SQL の答え ${safe} ${stamp}.${kind}`;
}
