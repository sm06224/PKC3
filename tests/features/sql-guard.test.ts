/**
 * 🔴 **打たれた SQL が「読むだけ」か**(#681 段①)。
 *
 * ⚠ ここは**安全の門**である ── 抜けると user が自分の全ノートを 1 行で消せる。
 * 🔑 だから見るのは 2 方向:①**読むだけを通す** ②🔴 **書き込みを 1 つも通さない**。
 * ⚠ ②の側は「知らない書き方が出たら通してしまう」ほうが害なので、
 *   白名簿(先頭の語)で判定していることも見る。
 */
import { describe, expect, it } from 'vitest';
import { checkReadOnlySql, normalizeSqlInput, stripSqlNoise } from '../../src/features/query/sql-guard';

const ok = (sql: string): boolean => checkReadOnlySql(sql).ok;
const why = (sql: string): string => checkReadOnlySql(sql).why;

describe('通すもの', () => {
  it.each([
    'SELECT 1',
    'select * from entries',
    '  SELECT 1  ',
    'SELECT 1;',
    "SELECT 'DROP TABLE t' AS s",
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'VALUES (1), (2)',
    'EXPLAIN SELECT 1',
    'SELECT updated_at FROM t', // ⚠ 列名の部分一致で止めない
    '-- 注釈\nSELECT 1',
    '/* 注釈 */ SELECT 1',
    // ⚠ ここから下は「**断る側へ倒れる誤り**」── 鳴っても不具合に見えないので pin する
    '(SELECT 1) UNION SELECT 2', // 先頭が丸括弧
    'SELECT insert2 FROM t', // 数字で終わる列名(`insert` に化けない)
    "SELECT * FROM t WHERE s = 'a;b'", // `;` が文字列の中
    'SELECT 1 -- ; DROP TABLE t', // `;` が注釈の中
    "SELECT * FROM pragma_table_info('t')", // 表を返す関数(`pragma` に化けない)
  ])('%s', (sql) => {
    expect(ok(sql), why(sql)).toBe(true);
  });
});

describe('🔴 断るもの(1 つでも通ると、取り消せない壊し方ができる)', () => {
  it.each([
    ['DELETE FROM entries', 'DELETE'],
    ['UPDATE entries SET body = 1', 'UPDATE'],
    ['insert into t values (1)', 'INSERT'],
    ['DROP TABLE entries', 'DROP'],
    ['ALTER TABLE t ADD COLUMN x', 'ALTER'],
    ['CREATE TABLE t (a)', 'CREATE'],
    ['ATTACH DATABASE x AS y', 'ATTACH'],
    ['PRAGMA journal_mode = OFF', 'PRAGMA'],
    ['VACUUM', 'VACUUM'],
    ['BEGIN', 'BEGIN'],
  ])('%s は断る(理由に %s が出る)', (sql, word) => {
    const r = checkReadOnlySql(sql as string);
    expect(r.ok).toBe(false);
    expect(r.why, '理由が字で出ていない').toContain(word as string);
  });

  /** 🔴 **先頭だけ見ると読むだけに見える** ── SQLite は `WITH … INSERT` が書ける。 */
  it('🔴 WITH の中に書き込みが混じっていたら断る', () => {
    expect(ok('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')).toBe(false);
  });

  /** 🔴 2 文目に紛れ込ませる形 ── いちばん通しやすい抜け道である。 */
  it('🔴 `;` で 2 文にしたら断る', () => {
    const r = checkReadOnlySql('SELECT 1; DROP TABLE entries');
    expect(r.ok).toBe(false);
    expect(r.why).toContain('1 文だけ');
  });

  /** ⚠ 注釈で隠しても、注釈は先に落とすので効かない。 */
  it('🔴 注釈で頭を隠しても断る', () => {
    expect(ok('/* SELECT */ DROP TABLE t')).toBe(false);
  });

  it('空は断る', () => {
    expect(ok('   ')).toBe(false);
    expect(why('')).toContain('空');
  });

  /** ⚠ 白名簿なので、知らない語は**通さない**側へ倒れる。 */
  it('知らない先頭の語は通さない(白名簿)', () => {
    expect(ok('FOOBAR 1')).toBe(false);
  });
});

describe('注釈と文字列を落とす', () => {
  /** ⚠ **長さを保つ** ── 位置がずれると「何文字目が悪いか」を言えなくなる。 */
  it('長さが変わらない', () => {
    const sql = "SELECT 'abc' -- x\n/* y */ 1";
    expect(stripSqlNoise(sql)).toHaveLength(sql.length);
  });

  it('文字列の中身は消える(語として数えない)', () => {
    expect(stripSqlNoise("SELECT 'DROP'")).not.toContain('DROP');
  });

  /** ⚠ SQLite の `''` は 1 つの `'` ── ここで切ると、後ろが全部文字列に見える。 */
  it("'' を含む文字列でも、終わりを正しく見つける", () => {
    expect(ok("SELECT 'it''s ok' AS s")).toBe(true);
  });

  it.each([['"'], ['`'], ['[']])('識別子(%s)の中身も落とす', (q) => {
    const close = q === '[' ? ']' : (q as string);
    expect(stripSqlNoise(`SELECT ${q as string}DROP${close} FROM t`)).not.toContain('DROP');
  });

  it('改行は残す(行番号がずれない)', () => {
    expect(stripSqlNoise('-- a\n-- b\nSELECT 1').split('\n')).toHaveLength(3);
  });
});

/**
 * 🔴 **日本語入力のまま打つ**(#764 の型)。
 *
 * ⚠ ここが無いと、corpus は**半角で打つ人の経路しか通らない** ── user は
 *   IME を切らずに打つので、`ＳＥＬＥＣＴ` が来る。
 */
describe('🔴 日本語入力のまま打たれても通る', () => {
  it('全角の SELECT を半角へ直して通す', () => {
    const r = checkReadOnlySql('\uff33\uff25\uff2c\uff25\uff23\uff34\u30001');
    expect(r.ok, r.why).toBe(true);
    expect(r.sql, '打つべき字が半角になっていない').toBe('SELECT 1');
  });

  /** 🔴 全角で隠しても抜けられない ── 直してから見るので、むしろ捕まる。 */
  it('全角の DROP も断る', () => {
    const r = checkReadOnlySql('\uff24\uff32\uff2f\uff30 TABLE t');
    expect(r.ok).toBe(false);
    expect(r.why).toContain('DROP');
  });

  /** 🔴 **文字列の中は直さない** ── user が探したい字そのものだからである。 */
  it('文字列の中の全角は、そのまま残す', () => {
    const r = checkReadOnlySql("SELECT * FROM t WHERE s LIKE '%\uff21\uff22\uff23%'");
    expect(r.ok, r.why).toBe(true);
    expect(r.sql).toContain('\uff21\uff22\uff23');
  });

  /** ⚠ 対照群 ── 直す口そのものが死んでいないこと(空振り防止)。 */
  it('外側は直る(同じ 1 文の中で、外と中が別に扱われる)', () => {
    expect(normalizeSqlInput("SELECT\u3000\uff0a FROM t WHERE s = '\uff0a'")).toBe(
      "SELECT * FROM t WHERE s = '\uff0a'",
    );
  });
});

describe('絵文字を含む文字列', () => {
  /**
   * 🔴 **符号点で切ると、文字列の後ろが絵文字の数だけ余計に塗り潰される。**
   *
   * ⚠ 実測(旧実装 `[...sql]`):絵文字 3 つで `; DR` まで食べるので、
   *   残るのは `OP TABLE t` ── **`;` も `DROP` も消えて、判定は `OK` になる**
   *   (= user の全ノートを消す 2 文目が、門を素通りする)。
   * 🔑 だから絵文字は **3 つ**置く ── 1 つでは `DROP` が残って別の理由で断られ、
   *   **直す前も後も赤**になり、この門を守っていることにならない。
   */
  it('🔴 絵文字の後ろに隠した 2 文目を見落とさない', () => {
    const r = checkReadOnlySql("SELECT '\u{1f600}\u{1f600}\u{1f600}'; DROP TABLE t");
    expect(r.ok).toBe(false);
    expect(r.why, '断った理由が「2 文」でない = 塗り潰しがずれている').toContain('1 文だけ');
  });

  it('絵文字を含んでも長さが変わらない', () => {
    const sql = "SELECT '\u{1f600}\u{1f601}' FROM t";
    expect(stripSqlNoise(sql)).toHaveLength(sql.length);
  });
});
