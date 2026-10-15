/**
 * 🔴 **列の名前と同じ綴りの語で断られたとき、引用符で囲む案内を返す**(#1087 の見直し)。
 *
 * 門は緩めない(語で見る)── 囲んだ名前は `stripSqlNoise` が塗り潰すので語に数えられず通る。
 * 守る主張:
 * 1. sqlite / DuckDB / DuckDB の書ける画面(`checkDuckDbRunSql`)の 3 つの断り文が、**実際に断った語**で案内する
 * 2. 案内のとおりに囲めば**本当に通る**(案内が行き止まりにならない)
 * 3. 案内の無い断り(先頭の語・2 文)には付かない
 */
import { describe, expect, it } from 'vitest';
import { checkReadOnlySql } from '../../src/features/query/sql-guard';
import { checkDuckDbSql } from '../../src/features/query/duckdb-guard';
import { checkDuckDbRunSql } from '../../src/features/query/duckdb-write';

const HINT = (w: string): string => `列の名前なら "${w}" のように二重引用符で囲んでください`;

describe('sqlite の門', () => {
  it('列の名前と同じ語で断るとき、その語で案内する', () => {
    const r = checkReadOnlySql('SELECT release FROM t');
    expect(r.ok).toBe(false);
    expect(r.why).toContain('RELEASE は打てません');
    expect(r.why).toContain(HINT('release'));
  });

  it('案内のとおり囲めば通る', () => {
    expect(checkReadOnlySql('SELECT "release" FROM t').ok).toBe(true);
  });

  it('先頭の語で断る回には付けない(SELECT に囲み直せる話ではない)', () => {
    expect(checkReadOnlySql('DROP TABLE t').why).not.toContain('二重引用符');
    expect(checkReadOnlySql('FOO').why).not.toContain('二重引用符');
  });
});

describe('DuckDB の門', () => {
  it.each(['comment', 'set', 'use', 'load', 'export', 'import', 'call', 'copy', 'reset', 'truncate'])(
    '%s は断るが、案内が付き、囲めば通る',
    (w) => {
      const r = checkDuckDbSql(`SELECT ${w} FROM t`);
      expect(r.ok, '門が緩んでいる').toBe(false);
      expect(r.why).toContain(HINT(w));
      expect(checkDuckDbSql(`SELECT "${w}" FROM t`).ok, '案内どおり囲んでも通らない').toBe(true);
    },
  );

  it('sqlite 側の語(DuckDB の門が sqlite の門へ渡す回)にも付く', () => {
    expect(checkDuckDbSql('SELECT begin FROM t').why).toContain(HINT('begin'));
  });
});

describe('DuckDB の書ける画面 ── 断り文を書き直しても案内が残る', () => {
  it('読むだけの門の断りを組み直す枝(rewriteRefusal)で落ちない', () => {
    const r = checkDuckDbRunSql('SELECT release FROM t');
    expect(r.ok).toBe(false);
    expect(r.why).toContain('RELEASE は打てません(DuckDB で書き込めるのは');
    expect(r.why).toContain(HINT('release'));
  });

  it('組み直さない枝(INSTALL / SET)でも残る', () => {
    expect(checkDuckDbRunSql('SELECT set FROM t').why).toContain(HINT('set'));
  });

  it('囲めば通る', () => {
    expect(checkDuckDbRunSql('SELECT "comment" FROM t').ok).toBe(true);
  });
});
