/**
 * 🔴 **DuckDB のときだけ「書く」文を通す門**(#918 段⑧。user 要望 2026-09-16
 * =「読むだけでなく、`COPY TO` と `CREATE TABLE` も打てるようにしたい」)。
 *
 * ## ① user が何を求めていたのか
 *
 * 手持ちの `.csv` / `.parquet` / `.json` を DuckDB で開いているとき、**打った SQL で
 * 表を作り、行を足し、書き換え、消せる**ようにしたい(集計の途中結果を表に置いて、
 * 次の問い合わせで使う、など)。
 *
 * ## ② 何を守るか ── 🔴 sqlite 側は 1 バイトも触らない
 *
 * `sql-guard.ts` の `checkReadOnlySql` は**そのまま**である ── この PKC のノートの DB に
 * 書く道を作らない(1 行で全ノートを消せる口になる)。ここは **DuckDB 専用の門**で、
 * `app-state.ts` の `RUN_SQL` が**engine が DuckDB のときだけ**呼ぶ。
 *
 * ## ③ ⚠ ここは**境ではない**(`duckdb-guard.ts` の冒頭と同じ)
 *
 * 書いても壊れるのは**畳めば消える使い捨ての入れ物**だけである:
 * - DuckDB の器は**空の memory DB**で、渡すのは**選んだ相手の bytes 1 つ**だけ
 *   (ノートの正本へは 1 バイトも繋がっていない)
 * - **元の file も、この PKC のノートも書き換わらない**(file へ書く `COPY` は断る)
 * - 外への口は `SET enable_external_access=false` で**engine が塞いでいる**
 *   (`duckdb-runner.ts` の冒頭の実測表)── `CREATE TABLE … AS SELECT * FROM 'https://…'` も
 *   `Permission Error` で断られる(`tests/duckdb-write.test.ts` が実物で見る)
 * 🔑 だから字の門の役目は「**打った人に読める理由を返す**」ことと、
 *   **知らない書き方を通さない**(白名簿)ことに絞る。
 *
 * ## ④ 通す形は 5 つだけ(白名簿。⚠ 黒名簿にしない)
 *
 * | 通す | 通さない(例) |
 * |---|---|
 * | `CREATE [OR REPLACE] [TEMP] TABLE …` | `CREATE VIEW` / `CREATE MACRO` / `CREATE SECRET` / `ALTER` |
 * | `INSERT [OR REPLACE\|IGNORE] INTO …` | `WITH … INSERT`(文の頭でだけ) |
 * | `UPDATE … SET …` | `UPDATE EXTENSIONS`(外から取りに行く) |
 * | `DELETE FROM …` | `TRUNCATE` |
 * | `DROP TABLE …` | `DROP VIEW` / `DROP SCHEMA` / `DROP DATABASE` |
 *
 * ⚠ **語の走査(`set` / `load` …)を書き込みの文には当てない** ── `UPDATE t SET …` に
 *   `set` が在り、列の名前に `comment` / `load` を使うのも普通なので、当てると
 *   **書けるはずの文が断られる**。🔑 当てなくても抜けないのは、`INSTALL` / `LOAD` /
 *   `SET` / `COPY` が**文の頭でしか文として成り立たない**からで、頭は白名簿で
 *   決めてあり、**2 文目は `;` で断る**(同じ作法)。
 */
import {
  normalizeOutsideMask,
  type SqlCheck,
} from './sql-guard';
import { checkDuckDbSql, stripDuckDbNoise } from './duckdb-guard';

/** 書き込みの種類。 */
export type DuckDbWriteKind = 'create' | 'insert' | 'update' | 'delete' | 'drop';

/**
 * 通す形(白名簿)。⚠ **塗り潰した後の小文字の字**に当てる。
 * 🔑 `kind` と形を 1 つの表に置く ── 種類を足した日に、形を書き忘れられない。
 */
const SHAPES: Readonly<Record<DuckDbWriteKind, RegExp>> = {
  create: /^create\s+(?:or\s+replace\s+)?(?:(?:temp|temporary)\s+)?table\b/u,
  insert: /^insert\s+(?:or\s+(?:replace|ignore)\s+)?into\b/u,
  // ⚠ `UPDATE EXTENSIONS` は外から拡張を取りに行く文 ── `UPDATE extensions SET …`(表の更新)は通す
  update: /^update\s+(?!extensions\s*(?:\(|$))/u,
  delete: /^delete\s+from\b/u,
  drop: /^drop\s+table\b/u,
};

/** 文の頭の語から種類を引く(頭の語が書き込みの 5 語のどれかのとき)。 */
const WRITE_HEADS: readonly DuckDbWriteKind[] = ['create', 'insert', 'update', 'delete', 'drop'];

/** 断り文に並べる「書き込みで打てる形」。🔑 `SHAPES` と同じ 5 つ(画面の字)。 */
export const DUCKDB_WRITE_FORMS = 'CREATE TABLE / INSERT INTO / UPDATE / DELETE FROM / DROP TABLE';

/**
 * 🔴 **作った表の寿命**(画面に出す字)。
 * ⚠ **字を 1 か所で持つ** ── 案内文と、`CREATE TABLE` が通った直後の知らせの
 *   両方が同じ字を言う(2 か所に書くと、片方だけ直した日に食い違う。§7)。
 */
export const DUCKDB_TABLE_LIFETIME = '作った表はウィンドウを閉じると消えます';

/** 頭の語(小文字)。⚠ `bare` は塗り潰し済み。 */
function headOf(bare: string): string {
  return /^[a-z]+/iu.exec(bare.trim())?.[0]?.toLowerCase() ?? '';
}

/**
 * 塗り潰した字から、書き込みの種類を言う。⚠ **形まで合っていたときだけ**返す
 * (`CREATE VIEW` は `null`)。
 */
function kindOfBare(bare: string): DuckDbWriteKind | null {
  const text = bare.trim().toLowerCase();
  return WRITE_HEADS.find((k) => SHAPES[k].test(text)) ?? null;
}

/**
 * その字は書き込みか(種類を返す)。⚠ **門を通った字**に当てる前提だが、
 * 通っていない字を渡しても害は無い(読むだけの字は `null`)。
 *
 * 🔑 画面の側も同じ 1 本を使う(「N 行に効きました」を言うか、表を描くか)──
 *   判定を 2 つにしない(§7)。
 */
export function duckDbWriteKind(sql: string): DuckDbWriteKind | null {
  return kindOfBare(stripDuckDbNoise(sql));
}

/**
 * 書き込みの結果の 1 行(`Count` の列)から、効いた行数を読む。
 * ⚠ 実測(2026-10-01、配っている engine を node で起こした):`INSERT` / `UPDATE` /
 *   `DELETE` / `CREATE TABLE … AS` は **`Count`(Int64)1 行**、`CREATE TABLE`(`AS` なし)は
 *   **0 行**、`DROP TABLE` は **`Success` の列**を返す。
 * 🔑 だから「無ければ `null`」(= 件数を言わず「実行しました」)。
 */
function countOf(columns: readonly string[], rows: readonly (readonly (string | number | null)[])[]): number | null {
  if (columns.length !== 1 || columns[0] !== 'Count' || rows.length !== 1) return null;
  const n = rows[0]?.[0];
  return typeof n === 'number' ? n : null;
}

/**
 * 書き込みが通った直後に出す 1 行(件数 + 一言)。
 *
 * - 🔑 件数は **DuckDB が返した値**から言う(`N 行に効きました`)。無ければ「実行しました」
 * - 🔴 **`CREATE TABLE` には、作った表の寿命を添える**(閉じると消える。黙って消さない)
 * - `INSERT` / `UPDATE` / `DELETE` には「元の file は書き換わりません」を添える
 *   (`DELETE FROM csv` を打った人が最初に心配することである)
 */
export function duckDbWriteNote(
  kind: DuckDbWriteKind,
  columns: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): string {
  const n = countOf(columns, rows);
  const done = n === null ? '実行しました' : `${String(n)} 行に効きました`;
  if (kind === 'create') return `${done} ── ${DUCKDB_TABLE_LIFETIME}`;
  if (kind === 'drop') return done;
  return `${done} ── 元の file は書き換わりません`;
}

/** 1 文だけ。⚠ 字は `sql-guard.ts` の `checkReadOnlySql` と同じにする(`tests/features/duckdb-write.test.ts` が突き合わせる)。 */
const ONE_STATEMENT_WHY = '1 度に打てるのは 1 文だけです(セミコロンで区切って 2 文は打てません)';

/**
 * 読むだけの門(`checkDuckDbSql`)の断り文を、**書ける世界の字へ直す**。
 *
 * ⚠ 読むだけの門は「読み取り専用です ── DROP は打てません(ここは読むだけです)」と言う ──
 *   書き込みを通すようになった画面では**嘘**になる(「ここは読むだけ」ではない)。
 * 🔑 直すのは**断り文の字だけ**で、通す / 断るの判定は 1 つも動かさない。
 * ⚠ 書き方が変わった日に**黙って素通りしない**よう、見つけた字は `tests/features/duckdb-write.test.ts`
 *   が実際の断り文で pin する。
 */
function rewriteRefusal(r: SqlCheck): SqlCheck {
  if (r.ok) return r;
  const readonly = /^読み取り専用です ── (\S+) は打てません/u.exec(r.why);
  if (readonly !== null) {
    const word = readonly[1] ?? '';
    return {
      ...r,
      why: WRITE_HEADS.includes(word.toLowerCase() as DuckDbWriteKind)
        ? `${word} は文の頭でだけ打てます(WITH や FROM の後ろには書けません)`
        : `${word} は打てません(DuckDB で書き込めるのは ${DUCKDB_WRITE_FORMS} の形だけです)`,
    };
  }
  // 「X では始められません(DuckDB では … のどれかで始めます)」── 書き込みの形も挙げる
  if (/では始められません/u.test(r.why)) {
    const head = r.why.split('(')[0] ?? '';
    const reads = /DuckDB では (.+) のどれかで始めます/u.exec(r.why)?.[1];
    return {
      ...r,
      why:
        reads === undefined
          ? r.why
          : `${head}(DuckDB では ${reads} のどれか、または ${DUCKDB_WRITE_FORMS} の形で始めます)`,
    };
  }
  return r;
}

/**
 * 🔴 **DuckDB で走らせてよい字か**(読む + 書く)。
 *
 * 1. 頭の語が書き込みの 5 語のどれかなら、**形が白名簿に合うか**を見る(1 文だけ)
 * 2. それ以外は `checkDuckDbSql`(読むだけの門)へ渡す ── ⚠ **判定の本体は 1 つ**
 *   (§7)。書き込みの語を除いた**読む側の規律は、1 バイトも写していない**
 *
 * ⚠ 返す `sql` は**全角を直した後の字**(`checkDuckDbSql` と同じ約束)。
 */
export function checkDuckDbRunSql(input: string): SqlCheck {
  const sql = normalizeOutsideMask(input, stripDuckDbNoise(input));
  const bare = stripDuckDbNoise(sql).trim();
  const head = headOf(bare);
  if (!WRITE_HEADS.includes(head as DuckDbWriteKind)) return rewriteRefusal(checkDuckDbSql(input));

  // ⚠ 末尾の `;` は許す(打ち慣れた人が付ける)── 中に残れば 2 文目
  if (bare.replace(/;$/u, '').includes(';')) return { ok: false, why: ONE_STATEMENT_WHY, sql };
  if (kindOfBare(bare.replace(/;$/u, '')) === null) {
    return {
      ok: false,
      why: `${head.toUpperCase()} はこの書き方では打てません(書き込みは ${DUCKDB_WRITE_FORMS} の形だけです)`,
      sql,
    };
  }
  return { ok: true, why: '', sql };
}
