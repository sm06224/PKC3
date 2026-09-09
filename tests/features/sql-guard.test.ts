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
    "SELECT replace(title, 'a', 'b') FROM entries", // 🔴 `replace()` は普通の関数
    "SELECT replace (title, 'a', 'b') FROM entries", // ⚠ 名前と `(` の間は空けてよい
    'SELECT a$insert FROM t', // `$` も識別子の字(`insert` に化けない)
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

  /**
   * 🔴 **先頭だけ見ると読むだけに見える** ── SQLite は `WITH … INSERT` が書ける。
   *
   * ⚠ **上の表は、この門を 1 度も通っていない**(着地前レビュー 2026-09-09)──
   *   10 行とも書き込みの語が**先頭**なので、白名簿の門だけで断られる。
   *   実測:`WRITE_WORDS` から `delete` / `update` / `replace` を 1 語ずつ外す変異が
   *   **3 つとも生き延び**、しかも 3 つとも同梱 3.53.0 で**実際に行が動く**。
   * 🔑 だから **1 語につき 1 場面**を置く(CLAUDE.md「門を N 個置いたら、
   *   N 個目だけが鳴る場面を N 通り作る」)。
   * 🔑 そして **どちらの門が鳴ったかを文言で見分ける** ── 白名簿の門だけが
   *   「では始められません」と言うので、それが**出ていない**ことを見る。
   *   ⚠ これが無いと、先頭語の門に救われても緑になる(= この門は空振り)。
   * ⚠ **2026-09-09 に見分ける字を張り替えた** ── 断り文を「起きたことと一致させる」
   *   直しで、白名簿の門の文言が変わった(前は両方が「読み取り専用です」で始まり、
   *   白名簿の側だけ「打てるのは…」を足していた)。⚠ 張り替えを忘れると、
   *   **どちらの門でも真になる**ので、この見分けは黙って死ぬ。
   */
  it.each([
    ['WITH x(a) AS (SELECT 1) INSERT INTO entries SELECT a FROM x', 'INSERT'],
    ['WITH x(a) AS (SELECT 1) UPDATE entries SET body = 1', 'UPDATE'],
    ['WITH x(a) AS (SELECT 1) DELETE FROM entries', 'DELETE'],
    ['WITH x(a) AS (SELECT 1) REPLACE INTO entries SELECT a FROM x', 'REPLACE'],
  ])('🔴 先頭が WITH でも %s は断る', (sql, word) => {
    const r = checkReadOnlySql(sql as string);
    expect(r.ok).toBe(false);
    expect(r.why).toContain(word as string);
    expect(r.why, '白名簿の門が鳴っている = 語の門を見ていない').not.toContain(
      'では始められません',
    );
    // ⚠ **空振り防止** ── 見分ける字が製品から消えたら、この検査は何も見なくなる
    expect(
      checkReadOnlySql('SELCT 1').why,
      '白名簿の門の文言が変わった ── 上の見分けが死んでいる',
    ).toContain('では始められません');
  });

  /**
   * 🔴 **断り文は「起きたこと」と一致させる**(2026-09-09 の動線レビュー)。
   *
   * ⚠ 直す前は**この 3 つが全部**「読み取り専用です」だった ── つまり
   *   **打ち間違い**にも**まだ SQL を打っていない日本語**にも「権限がありません」の
   *   意味の字を返しており、user は**直す所ではなく許可の在り処**を探しに行く。
   * ⚠ 記号(バッククォート)も出さない ── この 1 行は画面に**字として**出る。
   */
  it.each([
    ['UPDATE entries SET title = 1', '読み取り専用です', '書き込みの語'],
    ['SELCT * FROM entries', 'では始められません', '打ち間違い'],
    ['最近直したノートを見たい', 'では始められません', 'まだ SQL ではない'],
    ['PRAGMA table_info(entries)', 'PRAGMA はこの面では使えません', '読むだけだが使えない命令'],
  ])('🔴 %s の断り文は「%s」', (sql, want) => {
    const r = checkReadOnlySql(sql as string);
    expect(r.ok).toBe(false);
    expect(r.why).toContain(want as string);
    expect(r.why, '記号がそのまま画面に出る').not.toContain('`');
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

  /**
   * ⚠ **これは「危ないから守っている」test ではない**(着地前レビュー 2026-09-09 で
   *   コメントが実装と正反対だったのを直した)。
   * 🔑 実装は `''` を**特別扱いしない** ── 素朴に閉じると `'a''b'` は 2 本に割れるが、
   *   **塗り潰す字は同じ**なので結果が変わらない(自前の総当たりで差 0 件)。
   *   ここはその**回帰の錨**である。
   */
  it("'' を含む文字列でも、結果は同じ(素朴に閉じてよい)", () => {
    expect(ok("SELECT 'it''s ok' AS s")).toBe(true);
  });

  it.each([['"'], ['`'], ['[']])('識別子(%s)の中身も落とす', (q) => {
    const close = q === '[' ? ']' : (q as string);
    expect(stripSqlNoise(`SELECT ${q as string}DROP${close} FROM t`)).not.toContain('DROP');
  });

  /**
   * ⚠ **端を 1 字残す誤りは、語にならない字しか残さないので気づけない** ──
   *   だから**等値で 1 本 pin する**(閉じ引用符と `]` の位置がずれたら落ちる)。
   */
  it('どこからどこまでを塗るか(等値)', () => {
    expect(stripSqlNoise("SELECT 'ab' , [cd] , `ef` -- x")).toBe('SELECT      ,      ,          ');
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

  /**
   * 🔴 **小文字と数字も直す**(着地前レビュー 2026-09-09)。
   * ⚠ 直す前の fixture は**全角の大文字しか使っていなかった**ので、
   *   直す範囲の上端を `ff5e` → `ff3a`(= 大文字まで)に縮める変異が**生き延びた**。
   *   ⚠ IME を切らずに打つ人は `ｓｅｌｅｃｔ` も `１` も打つ。
   */
  it('全角の小文字と数字も直る', () => {
    const r = checkReadOnlySql('\uff53\uff45\uff4c\uff45\uff43\uff54\u3000\uff11\uff0b\uff12');
    expect(r.ok, r.why).toBe(true);
    expect(r.sql).toBe('select 1+2');
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
