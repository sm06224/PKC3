/**
 * 🔴 **SQL の画面で開ける添付の一覧**(#854 / #682 段④c)と、**このノートは SQL で開けるか**(#1966 3-3)。
 *
 * 選び所に並べる相手(`sql.ts` の `paintSource`)と、右の列の「アプリで開く ▾」の「SQL で開く」が出すかどうかを、
 * **同じ 1 本**で決める(§7 ── 選び所に出ない添付を「SQL で開く」で開こうとして断られる、を作らない)。
 * 並び: `.sqlite` → `.csv` / `.tsv` → `.xlsx` → DuckDB でしか読めない相手(`.parquet` / `.json` …)。
 */
import { csvAttachmentSourcesOf } from './csv-attachment';
import { duckDbOnlySourcesOf } from './sql-guest-source';
import { sqlSourcesOf } from './sqlite-attachment';
import { xlsxAttachmentSourcesOf } from './xlsx-attachment';

type MetaLike = { readonly lid: string; readonly title: string; readonly archetype: string };

/** SQL の画面の選び所に並べる添付(並び順は上の注記)。 */
export function attachedSqlSourcesOf(metas: Iterable<MetaLike>): Array<{ lid: string; name: string }> {
  const all = [...metas];
  return [...sqlSourcesOf(all), ...csvAttachmentSourcesOf(all), ...xlsxAttachmentSourcesOf(all), ...duckDbOnlySourcesOf(all)];
}

/** そのノートが SQL で開ける添付なら、選び所の相手(`SET_SQL_SOURCE` に渡す形)。開けなければ `null`。 */
export function sqlSourceOfNote(meta: MetaLike | undefined): { lid: string; name: string } | null {
  if (meta === undefined) return null;
  return attachedSqlSourcesOf([meta])[0] ?? null;
}
