/**
 * 🔴 **SQL 画面の並び(3 ペイン)の、画面に依らない決まり**(#1442 段②)。
 *
 * > user 裁定 2026-11-23:SQL 画面は pgAdmin / DBeaver / A5:SQL Mk-2 のような
 * > 「左にスキーマの木 / 右上に大きな SQL 欄 / 右下に結果」の 3 ペインにする。
 *
 * ⚠ ここは **pure** ── 保存も DOM も触らない(保存は `adapter/ui/render/sql-layout.ts`)。
 * 🔑 境目の割合・木の出し入れ・木から欄へ入れる字の組み方を 1 か所に集める(§7)。
 */
import { erQuote } from './er-sql';

/** 上(SQL 欄)が右の縦の何 % を占めるか。⚠ 下限・上限で結果の表も欄も**消えない**ようにする。 */
export const SQL_SPLIT_MIN = 15;
export const SQL_SPLIT_MAX = 85;
export const SQL_SPLIT_DEFAULT = 40;
/** 矢印キー 1 回ぶん / Shift を押しながらの 1 回ぶん(%)。 */
export const SQL_SPLIT_STEP = 2;
export const SQL_SPLIT_STEP_BIG = 10;

/** 割合を範囲へ丸める。⚠ 数でないもの(NaN)は既定へ。 */
export function clampSqlSplit(pct: number): number {
  if (!Number.isFinite(pct)) return SQL_SPLIT_DEFAULT;
  return Math.round(Math.min(SQL_SPLIT_MAX, Math.max(SQL_SPLIT_MIN, pct)));
}

/**
 * 掴んで動かした量から次の割合を決める。
 * @param startPct 掴んだときの割合
 * @param deltaPx 下へ動かした量(下が正)
 * @param areaPx 割合の 100 % にあたる高さ(右の縦の高さ)。⚠ 0 以下なら動かさない(測れない所で潰さない)
 */
export function splitFromDrag(startPct: number, deltaPx: number, areaPx: number): number {
  if (!(areaPx > 0)) return clampSqlSplit(startPct);
  return clampSqlSplit(startPct + (deltaPx / areaPx) * 100);
}

/**
 * 矢印キーで境目を動かす。⚠ ↓ は上の欄が**広がる**(境目が下へ動く)。`Home` / `End` は端まで。
 * @returns 次の割合。対象外のキーは `null`
 */
export function splitFromKey(cur: number, key: string, big: boolean): number | null {
  const step = big ? SQL_SPLIT_STEP_BIG : SQL_SPLIT_STEP;
  if (key === 'ArrowDown') return clampSqlSplit(cur + step);
  if (key === 'ArrowUp') return clampSqlSplit(cur - step);
  if (key === 'Home') return SQL_SPLIT_MIN;
  if (key === 'End') return SQL_SPLIT_MAX;
  return null;
}

/**
 * 端末に憶える並び。`tree` = 木を開いているか(`null` = まだ決めていない → 幅で決める)/ `split` = 上の割合(`null` = 既定)。
 * 保存の形は `<木 0|1|空>:<割合|空>`(例: `1:45` / `:` / `0:`)。
 */
export interface SqlLayout {
  readonly tree: boolean | null;
  readonly split: number | null;
}

const LAYOUT_RE = /^([01]?):(\d{0,3})$/;

/** 保存の形として読めるか(設定ファイルの下見もこれを使う)。 */
export function isSqlLayout(raw: string): boolean {
  const m = LAYOUT_RE.exec(raw);
  if (m === null) return false;
  if (m[2] === '') return true;
  const n = Number(m[2]);
  return n >= SQL_SPLIT_MIN && n <= SQL_SPLIT_MAX;
}

/** 読む。⚠ 読めない字は「何も決めていない」と同じに丸める(落とさない)。 */
export function decodeSqlLayout(raw: string | null): SqlLayout {
  if (raw === null || !isSqlLayout(raw)) return { tree: null, split: null };
  const m = LAYOUT_RE.exec(raw)!;
  return {
    tree: m[1] === '' ? null : m[1] === '1',
    split: m[2] === '' ? null : Number(m[2]),
  };
}

export function encodeSqlLayout(l: SqlLayout): string {
  const t = l.tree === null ? '' : l.tree ? '1' : '0';
  const s = l.split === null ? '' : String(clampSqlSplit(l.split));
  return `${t}:${s}`;
}

/** 木を最初から開くか。⚠ 決めていないときは**狭い所では畳む**(右の欄を潰さない)。 */
export const SQL_TREE_NARROW_PX = 720;
export function treeOpenInitially(saved: boolean | null, widthPx: number): boolean {
  if (saved !== null) return saved;
  return !(widthPx > 0 && widthPx < SQL_TREE_NARROW_PX);
}

/** 表を引く文(木の表をダブルクリック / Shift+Enter)。⚠ 名前は `erQuote` 1 か所(予約語・記号を正しく囲う)。 */
export const SQL_TREE_PREVIEW_LIMIT = 20;
export function selectFromTableSql(table: string): string {
  return `SELECT * FROM ${erQuote(table)} LIMIT ${String(SQL_TREE_PREVIEW_LIMIT)}`;
}

/** 名前そのものを入れる字。 */
export function treeNameText(name: string): string {
  return erQuote(name);
}

/**
 * 欄のキャレットの手前の字を見て、入れる字の前に足すものを決める。
 * - 名前: 手前が空白・`(`・`,`・`.` で終わるか空ならそのまま、それ以外なら半角の空白を 1 つ
 * - 文: 手前が空ならそのまま、改行で終わっていなければ改行を 1 つ(上の文と続けて書かない)
 */
export function insertionWithSpacing(before: string, text: string, kind: 'name' | 'statement'): string {
  if (before === '') return text;
  if (kind === 'statement') return before.endsWith('\n') ? text : `\n${text}`;
  return /[\s(,.]$/.test(before) ? text : ` ${text}`;
}
