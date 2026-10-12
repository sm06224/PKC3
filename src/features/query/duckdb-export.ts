/**
 * 🔴 **DuckDB の答えを Parquet の file にして書き出す**(#918 段⑥。「`COPY TO` も打てるようにしたい」の
 * 書き出し側。読み込み側は段④c の `read_parquet`)。
 *
 * ## ① 何を求められていたか
 *
 * 手持ちの file を DuckDB で引いた答えを、**列の型を保ったまま**別の道具(分析ツール・別の DuckDB)へ渡したい。
 * CSV / TSV / JSON は型が落ちる(日付も数も文字になる)。
 *
 * ## ② なぜ「user が `COPY` を打つ」形にしないか
 *
 * ⚠ `COPY … TO 'x'` を user の SQL へ通すと、**打った人が書き先の名前を決める**。器の中は使い捨てだが、
 *   書き先を打たせる口は作らない(`duckdb-guard.ts` が `copy` を断る ── **そのまま**)。
 * 🔑 代わりに**書き出しの操作そのもの**が、`COPY` を**こちらで組んで**打つ。書き先は**この file の
 *   固定の 1 つ**(`DUCKDB_EXPORT_FILE`)だけで、user の字は**問い合わせの本体**としてしか入らない。
 *
 * ## ③ 外を塞いだ後でも書けるのか(実測 2026-10-12、配っている engine を node で起こした)
 *
 * | 打ち方(塞いだ後) | 結果 |
 * |---|---|
 * | `COPY (…) TO 'x.parquet'` | 🔴 `Permission Error: … file system operations are disabled by configuration` |
 * | 🟢 塞ぐ**前**に `SET allowed_paths=['x.parquet','tmp_x.parquet']` を掛けておく | 🟢 その 2 つだけ書ける |
 * | 同じ器で、許した 2 つ**以外**へ `COPY` / 差し込んだ file の読み直し | 🔴 断られる(塞ぎは効いたまま) |
 *
 * 🔑 だから許す path は**この 2 つだけ**(`tmp_` は上流が書き込みの途中に使う名前)。**塞ぐ前**に掛ける
 *   (塞いだ後は変えられない)── 掛ける場所は器を起こす所(`duckdb-open.ts`)。
 *
 * ## ④ 包み方
 *
 * `COPY (SELECT * FROM (<user の字>\n)) TO …` ── 🔑 **`SELECT * FROM (…)` で包む**のは、`DESCRIBE` / `SUMMARIZE` が
 *   `COPY (…)` の直下には置けず(実測 `Parser Error`)、副問い合わせの中なら置けるため。`FROM t` / `PIVOT` /
 *   `WITH` / `VALUES` / `TABLE t` は包んでも同じに書ける。⚠ **`)` の前に改行を入れる** ── 末尾が `-- 注釈` だと
 *   閉じ括弧が注釈に呑まれる。⚠ `EXPLAIN` は包めない(書き出す値打ちも無いので、そもそも選ばせない)。
 */
import { stripDuckDbNoise, checkDuckDbSql } from './duckdb-guard';
import { duckDbWriteKind } from './duckdb-write';

/** 器の中で Parquet を書く path。⚠ **固定の 1 つ**(user に決めさせない ── このファイルの ②)。 */
export const DUCKDB_EXPORT_FILE = 'pkc-export.parquet';

/** 上流が書き込みの途中に使う名前(実測。`tmp_` + 書き先)。⚠ 許さないと `Permission Error` で書けない。 */
export const DUCKDB_EXPORT_TMP = 'tmp_pkc-export.parquet';

/**
 * 🔴 **塞ぐ前に、書いてよい path を 2 つに絞る**。⚠ **器を起こす所で、塞ぐより前に**打つ
 * (塞いだ後は変えられない ── 実測)。他の path は塞ぎのまま断られる。
 */
export const DUCKDB_ALLOW_EXPORT_SQL = `SET allowed_paths=['${DUCKDB_EXPORT_FILE}','${DUCKDB_EXPORT_TMP}']`;

/** 書き出し用に包んだ、器の中で打つ 1 文。 */
export type ParquetCopy =
  | { readonly ok: true; readonly statement: string }
  | { readonly ok: false; readonly why: string };

/** 末尾の `;` を 1 つだけ外す(注釈や文字列の中の `;` は塗り潰した字で見分ける)。 */
function dropTrailingSemicolon(sql: string): string {
  const bare = stripDuckDbNoise(sql);
  const at = bare.lastIndexOf(';');
  if (at < 0 || bare.slice(at + 1).trim() !== '') return sql;
  return sql.slice(0, at) + ' ' + sql.slice(at + 1);
}

/** 先頭の語(小文字)。⚠ 塗り潰した字から採る。 */
function headWord(sql: string): string {
  return /^[a-z]+/iu.exec(stripDuckDbNoise(sql).trim().replace(/^[\s(]+/u, ''))?.[0]?.toLowerCase() ?? '';
}

/**
 * 🔴 **この答えを Parquet にできるか**(画面の「Parquet」を出すか / 受け口が通すかの**共通の 1 本**。§7)。
 *
 * - 読む文であること(`checkDuckDbSql`)── 書き込みの文(`CREATE TABLE …`)の答えは「N 行が変更されました」の 1 行で、
 *   書き出す物ではない
 * - `EXPLAIN` ではないこと(包めない)
 */
export function parquetCopyOf(ranSql: string): ParquetCopy {
  if (ranSql.trim() === '') return { ok: false, why: 'SQL が空です' };
  if (duckDbWriteKind(ranSql) !== null) {
    return { ok: false, why: '書き込みの SQL の答えは Parquet に書き出せません(読む SQL の答えだけです)' };
  }
  // ⚠ 打ち直した後の字ではなく、**走らせた字**を検め直す(受け口の手前で書き換わっていても、ここで断る)
  const checked = checkDuckDbSql(ranSql);
  if (!checked.ok) return { ok: false, why: checked.why };
  if (headWord(checked.sql) === 'explain') {
    return { ok: false, why: 'EXPLAIN の答えは Parquet に書き出せません' };
  }
  const body = dropTrailingSemicolon(checked.sql);
  return {
    ok: true,
    statement: `COPY (SELECT * FROM (${body}\n)) TO '${DUCKDB_EXPORT_FILE}' (FORMAT PARQUET)`,
  };
}

/** 画面に出すか(`parquetCopyOf` の真偽だけ)。 */
export function canExportParquet(ranSql: string): boolean {
  return parquetCopyOf(ranSql).ok;
}
