/**
 * 🔴 **SQL の仮想ビューの定義を読む**(#2115 Phase 1 / PR-2)。
 *
 * ````
 * ```sql view=地域別
 * SELECT 地域, sum(金額) AS 合計 FROM 売上 GROUP BY 地域
 * ```
 * ````
 *
 * と書くと、同じノートの別の SQL から `SELECT * FROM 地域別` で引ける名前になる(評価は PR-3 の adapter 層)。
 *
 * ## 綴り(語は大小を問わない・語順は先頭の `sql` だけ固定)
 *
 * | 見出し | 読み |
 * |---|---|
 * | ` ```sql view=名前 ` | ビューの定義(本文には SQL の字だけ) |
 * | ` ```sql view=名前 embed ` / ` ```sql embed view=名前 ` | 定義 + 結果の表も本文に出す |
 * | ` ```sql ` / ` ```sql embed ` | ⚠ **ここは何もしない**(`null`)── 既存の色づけ / 埋め込みのまま |
 *
 * ⚠ 本文の描き方(`markdown-render.ts`)はこの PR では変えない。`isSqlEmbedInfo` は 2 語目が `embed` の形だけを
 *   埋め込みと読むので、` ```sql embed view=x ` はいまも埋め込み、` ```sql view=x embed ` はいまは色づけだけ
 *   (ノート内のデータセットを引けるのは PR-3 の評価器が入ってから ── そこで描き方をそろえる)。
 *   この食い違いは `tests/features/dataflow/sql-views.test.ts` が名指しで pin している。
 *
 * ## 中身は読み取り専用の門を必ず通す
 *
 * `checkReadOnlySql`(SQL を打つ面・` ```sql embed ` と同じ 1 本)を通らない SQL(DDL / DML / 複数文)は
 * ビューにしない。理由は `why` のまま診断に出す。
 *
 * ⚠ pure module。
 */
import {
  csvTableNameWhy,
  fenceText,
} from '@features/query/csv-tables';
import { checkReadOnlySql, stripSqlNoise } from '@features/query/sql-guard';
import { fenceInfo, quoteLead, splitLines } from '@features/markdown/source-blocks';
import { fencesBelowFrontmatter } from '@features/markdown/table-convert';
import { NameBook } from './names';
import type { DataflowDiagnostic, NoteSqlViewDef } from './types';

/** 見出しの `view=` の前置き。 */
const VIEW_PREFIX = 'view=';

/** ビューの見出しの読み。 */
export interface SqlViewInfo {
  /** 書かれたままの名前(使えるかは見ない ── 断る理由を言うため)。 */
  readonly name: string;
  readonly embed: boolean;
}

/**
 * 囲みの見出しがビューの定義か。
 * @returns 先頭語が `sql` で、2 語目以降に `view=` があれば読み。無ければ `null`(既存の ` ```sql ` には触れない)。
 * ⚠ `view=` が 2 つあれば先の方を読む。
 */
export function parseSqlViewInfo(info: string | null | undefined): SqlViewInfo | null {
  if (typeof info !== 'string') return null;
  const words = info.trim().split(/\s+/);
  if (words[0]?.toLowerCase() !== 'sql') return null;
  const rest = words.slice(1);
  const view = rest.find((w) => w.toLowerCase().startsWith(VIEW_PREFIX));
  if (view === undefined) return null;
  return {
    name: view.slice(VIEW_PREFIX.length),
    embed: rest.some((w) => w.toLowerCase() === 'embed'),
  };
}

/**
 * 末尾の `;` を落とす(注釈や文字列の中の `;` は触らない)。⚠ 門は末尾の `;` を許すが、
 * ビューは別の SQL の中に組み込まれるので、末尾の区切りは要らない。
 */
function dropTrailingSemicolon(sql: string): string {
  const mask = stripSqlNoise(sql).trimEnd();
  if (!mask.endsWith(';')) return sql;
  return (sql.slice(0, mask.length - 1) + sql.slice(mask.length)).trim();
}

export interface NoteSqlViewExtraction {
  /** 有効なビューの定義(定義順)。 */
  readonly views: readonly NoteSqlViewDef[];
  readonly diagnostics: readonly DataflowDiagnostic[];
}

/**
 * 🔴 **本文からビューの定義を全部拾う**。
 * @param taken 先に名乗った名前(このノートのデータセット)。⚠ 同じ名前のビューは断る(データセットが先)。
 */
export function extractNoteSqlViews(body: string, taken: Iterable<string> = []): NoteSqlViewExtraction {
  const lines = splitLines(body);
  const takenBook = new NameBook();
  for (const t of taken) takenBook.claim(t);
  const book = new NameBook();
  const views: NoteSqlViewDef[] = [];
  const diagnostics: DataflowDiagnostic[] = [];
  for (const span of fencesBelowFrontmatter(body)) {
    const openRaw = lines[span.start] ?? '';
    const openLead = quoteLead(openRaw, span.quote);
    const info = parseSqlViewInfo(fenceInfo(openLead === null ? openRaw : openRaw.slice(openLead)));
    if (info === null) continue;
    const { name, embed } = info;
    const line = span.start;
    const why = csvTableNameWhy(name);
    if (why !== '') {
      diagnostics.push({ kind: 'invalid-name', name, line, why });
      continue;
    }
    const dataset = takenBook.owner(name);
    if (dataset !== undefined) {
      diagnostics.push({
        kind: 'duplicate-name',
        name,
        line,
        why: `ビューの名前「${name}」は、このノートのデータセット「${dataset}」と同じです。別の名前にしてください`,
      });
      continue;
    }
    const earlier = book.owner(name);
    if (earlier !== undefined) {
      diagnostics.push({
        kind: 'duplicate-name',
        name,
        line,
        why: `ビューの名前「${name}」はこのノートで既に使われています(「${earlier}」)。後の方は使いません。別の名前にしてください`,
      });
      continue;
    }
    const check = checkReadOnlySql(fenceText(lines, span));
    if (!check.ok) {
      diagnostics.push({ kind: 'not-read-only', name, line, why: `ビュー「${name}」の SQL は使えません: ${check.why}` });
      continue;
    }
    book.claim(name);
    views.push({ name, line, sql: dropTrailingSemicolon(check.sql.trim()), embed });
  }
  return { views, diagnostics };
}
