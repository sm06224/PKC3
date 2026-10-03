/**
 * 🔴 **DuckDB の器の中の構造を、構造ノート・つながり図が読む形へ採る**(#918。🟣 Gemini 裁定 2026-10-02 = A)。
 *
 * ## ① user が何を求めていたのか
 *
 * `.parquet` / `.json` を選んだとき、また **2 つ以上の file を並べたとき**にも、構造ノートと
 * つながり図(ER)が出てほしい(いままでは「まだ出せません(DuckDB で引く相手です)」と断られていた)。
 *
 * ## ② なぜ断っていたのか
 *
 * 構造を採る 3 本(`schema-digest.ts` の `SCHEMA_*_SQL`)は **sqlite 専用**(`sqlite_master` /
 * `pragma_table_info` / `pragma_foreign_key_list`)で、DuckDB の器には打てない。
 *
 * ## ③ どう採るか(描く側は 1 バイトも触らない ── §7「判定・描画は 1 か所」)
 *
 * DuckDB の `duckdb_columns()` / `duckdb_views()` / `duckdb_constraints()` から、**構造ノートが使うのと
 * 同じ形**(`SchemaDigestInput` の `columns` / `fks` の 2 枚)へ採る。行数は `countsSql`(`select count(*)`
 * を表ごと)を**そのまま**使う。`schemaModel` / `renderSchemaDigest` / ER の layout はこの 2 枚を読むだけ。
 *
 * ## ④ 🔴 器だけでは足りない物 ── 重ねる
 *
 * `.sqlite` を器へ写すとき(`createTableSql`)は**型を 3 つへ潰し、主キーも空を許さない印も外部キーも
 * 作らない**(付けると、sqlite では通っていた行の INSERT が落ちる)。だから器へ聞くだけでは
 * **元の型・主キー・外部キーが消える**。storage worker が宣言のまま運んだ物(`SqliteColumnShape` /
 * `SqliteExportFk`)を、器の答えに**重ねる**(`mergeDuckDbSchema`)。
 * 🔑 重ねるのは**器に実在する表・列だけ**(user が `DROP` した表の線を残さない / 断った表を出さない)。
 * 🔴 **列の形が写した形と一致する表だけ**(#682 段④d の着地後レビュー):user が `DROP TABLE 売上` の後に同じ名前で
 *   `CREATE TABLE 売上 (…)` し直した表へ、元の `.sqlite` の型・主キー・外部キーを重ねると**user が作っていない
 *   宣言を、user の表の構造として出す**(嘘)。名前だけでなく**列の名前の並び**が写した表と同じときだけ重ねる。
 *
 * ⚠ 持ち込んだ file(csv / parquet / json)には外部キーが無い → **線 0 本 = 四角だけの図**(それでよい)。
 */
import type { Cell, Grid } from './schema-digest';
import type { SqliteColumnShape, SqliteExportFk } from './sqlite-ndjson';

/**
 * 表と列を 1 回で採る(`SCHEMA_COLUMNS_SQL` と**同じ列名・同じ並び**)。
 *
 * ⚠ `duckdb_columns()` は表とビューの列を**どちらも**返す ── 種類は `duckdb_views()` と突き合わせて決める。
 * ⚠ **`internal` は外す**(DuckDB 自身の表。user の構造ではない)/ **`current_database()` の `main` だけ**
 *   (system 側の表と混ぜない)。
 * ⚠ `pk` は `duckdb_constraints()` の `PRIMARY KEY` の列に含まれるか。⚠ 写した `.sqlite` の表には
 *   主キーを作らない(上の ④)ので、そちらは `mergeDuckDbSchema` が重ねる。
 * ⚠ `column_index` は **1 始まり**(sqlite の `cid` は 0 始まり)── 揃える。
 */
export const DUCKDB_SCHEMA_COLUMNS_SQL = [
  "select case when v.view_name is null then 'table' else 'view' end as kind,",
  '       c.table_name as tbl, c.column_index - 1 as cid, c.column_name as col,',
  '       c.data_type as typ, case when c.is_nullable then 0 else 1 end as nn,',
  '       case when exists (select 1 from duckdb_constraints() k',
  '                          where k.database_name = c.database_name and k.schema_name = c.schema_name',
  '                            and k.table_name = c.table_name and k.constraint_type = \'PRIMARY KEY\'',
  '                            and list_contains(k.constraint_column_names, c.column_name))',
  '            then 1 else 0 end as pk',
  '  from duckdb_columns() c',
  '  left join duckdb_views() v on v.database_name = c.database_name and v.schema_name = c.schema_name',
  '                            and v.view_name = c.table_name and not v.internal',
  " where c.database_name = current_database() and c.schema_name = 'main' and not c.internal",
  ' order by kind, tbl, cid',
].join('\n');

/**
 * 表どうしの繋がり(`SCHEMA_FK_SQL` と同じ列名)。⚠ 無い器では 0 行が返る(それでよい)。
 * ⚠ 列が複数の外部キーは**列ごとに 1 行**へ開く(並べた 2 つの `unnest` は同じ位置どうしで組になる)。
 */
export const DUCKDB_SCHEMA_FK_SQL = [
  'select k.table_name as tbl, k.referenced_table as ref,',
  '       unnest(k.constraint_column_names) as col, unnest(k.referenced_column_names) as refcol',
  '  from duckdb_constraints() k',
  " where k.database_name = current_database() and k.schema_name = 'main'",
  "   and k.constraint_type = 'FOREIGN KEY'",
  ' order by tbl',
].join('\n');

/**
 * 器へ写した `.sqlite` の表 1 枚ぶんの「元の姿」。⚠ 表の名前は**器での名前**
 * (2 件以上なら `ファイル名_表名`)で引く。外部キーの相手の名前も**器での名前**へ直してある。
 */
export interface DuckDbTableMeta {
  readonly columns: readonly SqliteColumnShape[];
  readonly fks: readonly SqliteExportFk[];
}

/**
 * 🔴 **写した表の「元の姿」を組む**(外部キーの相手の名前を、器での名前へ直す)。**pure**。
 *
 * @param finalOf **小文字にした元の名前 → 器での名前**。⚠ この file の**表の全部**を入れる(写せなかった表も)。
 *
 * ⚠ **相手がこの file の表に無い外部キーは捨てる**(#682 段④d の着地後レビュー)。直す前は
 *   `finalOf.get(f.toTable) ?? f.toTable` で**元の名前へ落とし**、器に**同じ名前の別の表**(並べた csv など)が在れば
 *   `mergeDuckDbSchema` の「器に在る表」の検査を**通って偽の線**になった。
 * ⚠ **名前は大文字小文字を区別せず引く**(sqlite の `REFERENCES Customers` と `CREATE TABLE customers` は同じ表)。
 *   直す前は完全一致だったので、この線は**黙って落ちて**いた。
 */
export function duckDbMetaOf(
  columns: readonly SqliteColumnShape[],
  fks: readonly SqliteExportFk[],
  finalOf: ReadonlyMap<string, string>,
): DuckDbTableMeta {
  const kept: SqliteExportFk[] = [];
  for (const f of fks) {
    const to = finalOf.get(f.toTable.toLowerCase());
    if (to === undefined) continue;
    kept.push({ fromColumn: f.fromColumn, toTable: to, toColumn: f.toColumn });
  }
  return { columns, fks: kept };
}

const cellText = (v: Cell | undefined): string => (v === null || v === undefined ? '' : String(v));

/** 器の列の名前の並びが、写した表の列の並びと同じか(⚠ 集合ではなく**並びも**見る ── 写しは宣言の順に作る)。 */
function sameColumnNames(raw: readonly string[], meta: readonly SqliteColumnShape[]): boolean {
  return raw.length === meta.length && raw.every((n, i) => n === meta[i]?.name);
}

/**
 * 器が答えた 2 枚に、`.sqlite` の元の姿を重ねる。
 *
 * - 列:器に在る表・列だけ、**型 / 空を許さない / 主キー**を元の宣言で置き換える(並びと `cid` は器のまま)。
 *   🔴 **列の名前の並びが写した形と同じ表だけ**(user が同名で作り直した表には重ねない ── 上の ④)
 * - 外部キー:器の `FOREIGN KEY`(user が作った表)+ `.sqlite` の宣言。⚠ **両端の表が器に在る線だけ**
 *   (写せなかった表を指す線を残すと、箱の無い線になる)。重複は 1 本へ。**表の名前順**(同じ表の中は宣言順)
 *   ── `SCHEMA_FK_SQL` の `order by m.name, f.id, f.seq` と同じ並び。
 */
export function mergeDuckDbSchema(
  raw: { readonly columns: Grid; readonly fks: Grid },
  meta: ReadonlyMap<string, DuckDbTableMeta>,
): { columns: Grid; fks: Grid } {
  const ci = (g: Grid, name: string): number => g.columns.indexOf(name);
  const tblAt = ci(raw.columns, 'tbl');
  const colAt = ci(raw.columns, 'col');
  const typAt = ci(raw.columns, 'typ');
  const nnAt = ci(raw.columns, 'nn');
  const pkAt = ci(raw.columns, 'pk');

  // 器に在る表と、その列の名前(並びのまま)
  const namesOf = new Map<string, string[]>();
  for (const r of raw.columns.rows) {
    const t = cellText(r[tblAt]);
    const list = namesOf.get(t) ?? [];
    list.push(cellText(r[colAt]));
    namesOf.set(t, list);
  }
  const exists = new Set<string>(namesOf.keys());
  // 🔴 重ねてよい表だけ(列の形が写した形と同じ)。⚠ 落とした表の線は出さない(下の外部キーも `usable` だけを読む)
  const usable = new Map<string, DuckDbTableMeta>();
  for (const [t, m] of meta) {
    const names = namesOf.get(t);
    if (names !== undefined && sameColumnNames(names, m.columns)) usable.set(t, m);
  }

  const columnRows = raw.columns.rows.map((r) => {
    const m = usable.get(cellText(r[tblAt]))?.columns.find((c) => c.name === cellText(r[colAt]));
    if (m === undefined) return r;
    const out: Cell[] = [...r];
    out[typAt] = m.type;
    out[nnAt] = m.notNull ? 1 : 0;
    out[pkAt] = m.primaryKey ? 1 : 0;
    return out;
  });

  const fkRows: (readonly Cell[])[] = [...raw.fks.rows];
  const tAt = ci(raw.fks, 'tbl');
  const rAt = ci(raw.fks, 'ref');
  const cAt = ci(raw.fks, 'col');
  const rcAt = ci(raw.fks, 'refcol');
  const arity = raw.fks.columns.length;
  const key = (tbl: string, ref: string, col: string, refcol: string): string =>
    [tbl, ref, col, refcol].join('\u0000');
  const seen = new Set<string>(
    fkRows.map((r) => key(cellText(r[tAt]), cellText(r[rAt]), cellText(r[cAt]), cellText(r[rcAt]))),
  );
  for (const [tbl, m] of usable) {
    for (const f of m.fks) {
      if (!exists.has(f.toTable)) continue;
      const k = key(tbl, f.toTable, f.fromColumn, f.toColumn);
      if (seen.has(k)) continue;
      seen.add(k);
      const row: Cell[] = new Array<Cell>(arity).fill(null);
      row[tAt] = tbl;
      row[rAt] = f.toTable;
      row[cAt] = f.fromColumn;
      row[rcAt] = f.toColumn;
      fkRows.push(row);
    }
  }
  // ⚠ `sort` は安定 ── 同じ表の中は「器の線 → 宣言の線」の並びのまま残る
  fkRows.sort((a, b) => {
    const x = cellText(a[tAt]);
    const y = cellText(b[tAt]);
    return x < y ? -1 : x > y ? 1 : 0;
  });

  return {
    columns: { columns: raw.columns.columns, rows: columnRows },
    fks: { columns: raw.fks.columns, rows: fkRows },
  };
}
