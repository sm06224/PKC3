/** @vitest-environment node */
/**
 * 🔴 user が打つ `COPY (…) TO 'ファイル名'` を通し、書いたファイルをダウンロードにする(#918)。
 *
 * 守る主張:
 * 1. 通す形(問い合わせ / 表の名前、拡張子と FORMAT で形式が決まる)で、器の中の書き先は**固定の名前**へ書き換わる
 * 2. user の打った名前はダウンロードの名前にだけなる(`../` や絶対 path や URL は断る)
 * 3. 危ない形(COPY FROM / 書き込みの問い合わせ / 許していないオプション / 2 文目)は断る
 * 4. 字の門(checkDuckDbRunSql)も同じ判定(通る / 通らないが一致)
 * 5. COPY でない字は `null`(今までの門へ渡る)
 */
import { describe, expect, it } from 'vitest';
import { DUCKDB_EXPORT_FILES, userCopyOf } from '../../src/features/query/duckdb-copy';
import { checkDuckDbRunSql } from '../../src/features/query/duckdb-write';
import { DUCKDB_ALLOW_EXPORT_SQL } from '../../src/features/query/duckdb-export';

const ok = (sql: string) => {
  const r = userCopyOf(sql);
  if (r === null || !r.ok) throw new Error('通るはずが断られた: ' + sql + ' / ' + (r === null ? 'null' : r.why));
  return r;
};
const why = (sql: string): string => {
  const r = userCopyOf(sql);
  if (r === null || r.ok) throw new Error('断られるはずが通った: ' + sql);
  return r.why;
};

describe('通す形', () => {
  it('🔴 CSV: 拡張子で決まり、書き先は固定の名前・名前はダウンロード用。見出し行が付く', () => {
    const r = ok("COPY (SELECT a, b FROM t) TO 'out.csv'");
    expect(r.format).toBe('csv');
    expect(r.fileName).toBe('out.csv');
    expect(r.file).toBe(DUCKDB_EXPORT_FILES.csv);
    expect(r.mime).toBe('text/csv');
    expect(r.statement).toBe(
      `COPY (SELECT * FROM (SELECT a, b FROM t\n)) TO 'pkc-export.csv' (FORMAT CSV, HEADER true)`,
    );
    // 🔴 打った名前は器の中の path にならない
    expect(r.statement).not.toContain('out.csv');
  });

  it('Parquet / JSON / TSV / ndjson も拡張子から決まる', () => {
    expect(ok("COPY (SELECT 1) TO 'a.parquet'")).toMatchObject({ format: 'parquet', file: DUCKDB_EXPORT_FILES.parquet });
    expect(ok("COPY (SELECT 1) TO 'a.json'")).toMatchObject({ format: 'json', file: DUCKDB_EXPORT_FILES.json });
    expect(ok("COPY (SELECT 1) TO 'a.ndjson'").format).toBe('json');
    const tsv = ok("COPY (SELECT 1) TO 'a.tsv'");
    expect(tsv.format).toBe('csv');
    expect(tsv.statement).toContain("DELIMITER '\\t'");
    // 対照: TSV でも DELIMITER を書けばそちらが勝つ(2 つ並べない)
    const own = ok("COPY (SELECT 1) TO 'a.tsv' (DELIMITER ';')");
    expect(own.statement).toContain("DELIMITER ';'");
    expect(own.statement).not.toContain('\\t');
  });

  it('FORMAT を書けば拡張子より優先する。拡張子が不明でも FORMAT があれば通る', () => {
    expect(ok("COPY (SELECT 1) TO 'data.txt' (FORMAT CSV)").format).toBe('csv');
    expect(ok("COPY (SELECT 1) TO 'a.csv' (FORMAT parquet)").format).toBe('parquet');
    expect(why("COPY (SELECT 1) TO 'data.txt'")).toContain('形式を決められません');
  });

  it('表の名前を書く形は SELECT * FROM と同じ', () => {
    const r = ok("COPY csv TO 'o.csv'");
    expect(r.statement).toContain('SELECT * FROM csv');
    expect(ok('COPY "my table" TO \'o.csv\'').statement).toContain('SELECT * FROM "my table"');
  });

  it('許したオプションは作り直して渡す(値の引用符は二重化)。HEADER を書けば既定は足さない', () => {
    const r = ok("COPY (SELECT 1) TO 'a.csv' (HEADER false, DELIMITER '|', NULL 'it''s')");
    expect(r.statement).toContain('HEADER false');
    expect(r.statement).not.toContain('HEADER true');
    expect(r.statement).toContain("DELIMITER '|'");
    expect(r.statement).toContain("NULLSTR 'it''s'");
    expect(ok("COPY (SELECT 1) TO 'a.parquet' (COMPRESSION zstd, ROW_GROUP_SIZE 5000)").statement).toContain(
      'COMPRESSION zstd, ROW_GROUP_SIZE 5000',
    );
  });

  it('FROM 先行・WITH・末尾の ; と注釈の付いた問い合わせも通る(中は読む文だけ)', () => {
    expect(ok("COPY (FROM t SELECT a) TO 'a.csv'").ok).toBe(true);
    expect(ok("COPY (WITH x AS (SELECT 1 a) SELECT * FROM x) TO 'a.csv';").ok).toBe(true);
    // 末尾が注釈でも閉じ括弧が呑まれない(改行を入れて包む)
    expect(ok("COPY (SELECT 1 -- メモ\n) TO 'a.csv'").statement).toContain('-- メモ\n\n)) TO');
  });
});

describe('断る形', () => {
  it('🔴 ダウンロード名に場所・URL・不正な字は使えない(器の外へ書く道を作らない)', () => {
    for (const name of ['../x.csv', '/etc/x.csv', 'a/b.csv', 'C:\\x.csv', 's3://b/x.csv', 'a:b.csv', '.hidden.csv', 'x.csv.']) {
      expect(userCopyOf(`COPY (SELECT 1) TO '${name}'`), name).toMatchObject({ ok: false });
    }
    expect(why("COPY (SELECT 1) TO '../x.csv'")).toContain('ファイル名だけ');
    expect(why("COPY (SELECT 1) TO ''")).toContain('空');
  });

  it('🔴 COPY FROM(取り込み)は断る', () => {
    expect(why("COPY t FROM 'in.csv'")).toContain('FROM');
    expect(why("COPY t FROM '/etc/passwd'")).toContain('取り込み');
  });

  it('🔴 中の問い合わせは読む文だけ(書き込み・EXPLAIN・拡張の取得は断る)', () => {
    for (const q of ['DELETE FROM t', 'INSERT INTO t VALUES (1)', 'CREATE TABLE x AS SELECT 1', "INSTALL httpfs", 'SET x=1', 'EXPLAIN SELECT 1']) {
      expect(userCopyOf(`COPY (${q}) TO 'a.csv'`), q).toMatchObject({ ok: false });
    }
  });

  it('🔴 複数ファイルを作るオプション・未知のオプション・形式違いのオプションは断る', () => {
    for (const o of ['PARTITION_BY (a)', 'FILE_SIZE_BYTES 1000', 'USE_TMP_FILE false', 'OVERWRITE true', 'PER_THREAD_OUTPUT true']) {
      expect(why(`COPY (SELECT 1) TO 'a.parquet' (${o})`), o).toContain('使えません');
    }
    // 形式違い: HEADER は CSV だけ / COMPRESSION は Parquet だけ
    expect(why("COPY (SELECT 1) TO 'a.parquet' (HEADER true)")).toContain('PARQUET では使えません');
    expect(why("COPY (SELECT 1) TO 'a.csv' (COMPRESSION zstd)")).toContain('CSV では使えません');
    // 値の検査
    expect(why("COPY (SELECT 1) TO 'a.parquet' (COMPRESSION lz99)")).toContain('のどれかです');
    expect(why("COPY (SELECT 1) TO 'a.parquet' (ROW_GROUP_SIZE 0)")).toContain('正の整数');
    expect(why("COPY (SELECT 1) TO 'a.csv' (FORMAT xml)")).toContain('FORMAT は');
    expect(why("COPY (SELECT 1) TO 'a.csv' (HEADER true, HEADER false)")).toContain('重なって');
  });

  it('🔴 2 文目・形の崩れは断る。文字列の中の ; は数えない', () => {
    expect(why("COPY (SELECT 1) TO 'a.csv'; DROP TABLE t")).toContain('1 文だけ');
    expect(why('COPY (SELECT 1 TO \'a.csv\'')).toContain('括弧が閉じていません');
    expect(why('COPY (SELECT 1)')).toContain('COPY は');
    expect(why('COPY (SELECT 1) TO a.csv')).toContain('クォート');
    expect(ok("COPY (SELECT 'a;b') TO 'a.csv'").ok).toBe(true);
  });

  it('COPY でない字は null(今までの門へ渡る)。語の途中の copy は COPY ではない', () => {
    expect(userCopyOf('SELECT 1')).toBeNull();
    expect(userCopyOf('SELECT * FROM copy_log')).toBeNull();
    expect(userCopyOf('copycat')).toBeNull();
  });
});

describe('字の門と許可 path', () => {
  it('🔴 checkDuckDbRunSql は userCopyOf と同じ答え(通す / 断る、断り文も同じ)', () => {
    for (const sql of ["COPY (SELECT 1) TO 'a.csv'", "COPY t FROM 'x.csv'", "COPY (SELECT 1) TO '../a.csv'", "COPY (SELECT 1) TO 'a.csv'; SELECT 2"]) {
      const c = userCopyOf(sql)!;
      const g = checkDuckDbRunSql(sql);
      expect(g.ok, sql).toBe(c.ok);
      if (!c.ok) expect(g.why, sql).toBe(c.why);
    }
  });

  it('許可する path は、書き出す固定の名前(と上流の一時名)を全部含み、user の名前は含まない', () => {
    for (const f of Object.values(DUCKDB_EXPORT_FILES)) {
      expect(DUCKDB_ALLOW_EXPORT_SQL).toContain(`'${f}'`);
      expect(DUCKDB_ALLOW_EXPORT_SQL).toContain(`'tmp_${f}'`);
    }
    expect(Object.keys(DUCKDB_EXPORT_FILES).sort()).toEqual(['csv', 'json', 'parquet']);
  });
});
