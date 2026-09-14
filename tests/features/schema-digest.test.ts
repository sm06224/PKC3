/**
 * 🔴 **構造 1 枚**(#918 段①)。
 *
 * ⚠ ここで守るのは 3 つ:
 * ① 🔴 **中身が 1 文字も混ざらない**(出すのは構造だけ、という約束そのもの)
 * ② **問い合わせの列の順に依存しない**(`select` を直しても壊れない)
 * ③ **採れなかったものを「無い」と書かない**(行数が採れない回に嘘を書かない)
 */
import { describe, expect, it } from 'vitest';
import {
  SCHEMA_COLUMNS_SQL,
  SCHEMA_FK_SQL,
  countsSql,
  renderSchemaDigest,
  type Grid,
} from '../../src/features/query/schema-digest';
import { checkReadOnlySql } from '../../src/features/query/sql-guard';

const grid = (columns: string[], rows: (string | number | null)[][]): Grid => ({ columns, rows });

const COLS = grid(
  ['kind', 'tbl', 'cid', 'col', 'typ', 'nn', 'pk'],
  [
    ['table', 'entries', 0, 'lid', 'TEXT', 1, 1],
    ['table', 'entries', 1, 'title', 'TEXT', 0, 0],
    ['table', 'tags', 0, 'name', '', 0, 0],
    ['view', 'recent', 0, 'lid', 'TEXT', 0, 0],
  ],
);
const FKS = grid(
  ['tbl', 'ref', 'col', 'refcol'],
  [['tags', 'entries', 'lid', 'lid']],
);
const COUNTS = grid(['tbl', 'n'], [['entries', 3], ['tags', 0]]);

describe('構造 1 枚を組む', () => {
  it('表・列・型・鍵・繋がり・行数が出る', () => {
    const out = renderSchemaDigest({ source: 'この PKC のノート', columns: COLS, fks: FKS, counts: COUNTS });
    expect(out).toContain('# この PKC のノート の構造');
    expect(out).toContain('表 / ビュー: 3 件');
    expect(out, '行数が出ていない').toContain('## entries(表・3 行)');
    // ⚠ ビューには行数を付けない(数えると**その場でビューが走る**ので、重い相手で刺さる)
    expect(out, 'ビューだと分からない').toContain('## recent(ビュー)');
    expect(out).toContain('| lid | TEXT | 不可 | 主キー |');
    expect(out, '型が空の列で「(型なし)」と言っていない').toContain('| name | (型なし) | 可 |  |');
    expect(out, '繋がりが出ていない').toContain('- tags.lid → entries.lid');
  });

  /**
   * 🔴 **この test がこの file の存在理由である。**
   * ⚠ 構造の書き出しは「AI に渡す」ためなので、**中身が混ざると外へ出る**。
   */
  it('🔴 値(中身)は 1 文字も混ざらない', () => {
    const out = renderSchemaDigest({ source: 'x', columns: COLS, fks: FKS, counts: COUNTS });
    // ⚠ 列の**名前**は出るが、**行の値**は出ない ── 値しか持たない字で見る
    expect(out).not.toContain('ひみつの本文');
    expect(out, '中身を出していないと言っていない').toContain('中身は 1 行も含まれていません');
  });

  it('🔴 列の順に依存しない(問い合わせを直しても壊れない)', () => {
    // ⚠ 同じ中身を**列の順だけ入れ替えて**渡す
    const shuffled = grid(
      ['pk', 'nn', 'typ', 'col', 'cid', 'tbl', 'kind'],
      [
        [1, 1, 'TEXT', 'lid', 0, 'entries', 'table'],
        [0, 0, 'TEXT', 'title', 1, 'entries', 'table'],
      ],
    );
    const out = renderSchemaDigest({ source: 'x', columns: shuffled, fks: grid(['tbl'], []) });
    expect(out).toContain('| lid | TEXT | 不可 | 主キー |');
    expect(out).toContain('| title | TEXT | 可 |  |');
  });

  it('🔴 行数が採れなかった回は、行数を書かずに「採れなかった」と言う', () => {
    const out = renderSchemaDigest({ source: 'x', columns: COLS, fks: grid(['tbl'], []) });
    expect(out, '採れていない行数を書いている').not.toContain('3 行');
    expect(out).toContain('## entries(表)');
    expect(out, '採れなかったことを言っていない').toContain('行数は採れませんでした');
  });

  it('⚠ 表が 1 つも無くても 1 枚は出る(押して無反応にしない)', () => {
    const out = renderSchemaDigest({ source: 'からっぽ', columns: grid(['tbl'], []), fks: grid(['tbl'], []) });
    expect(out).toContain('表もビューも 1 つもありません');
  });

  it('⚠ 繋がりが 0 件なら、その見出しごと出さない', () => {
    const out = renderSchemaDigest({ source: 'x', columns: COLS, fks: grid(['tbl'], []) });
    expect(out).not.toContain('表どうしの繋がり');
  });
});

describe('行数を採る問い合わせを組む', () => {
  it('表が 0 件なら組まない(空の select を打たない)', () => {
    expect(countsSql([])).toBeNull();
  });

  it('🔴 名前の中の引用符を逃がす(打った字が壊れない)', () => {
    const sql = countsSql(['a"b'])!;
    expect(sql, '器の名前を逃がしていない').toContain('from "a""b"');
    expect(sql, '値の側を逃がしていない').toContain("select 'a\"b' as tbl");
  });

  it("名前の中の `'` も逃がす", () => {
    const sql = countsSql(["it's"])!;
    expect(sql).toContain("select 'it''s' as tbl");
  });
});

/**
 * 🔴 **門を 1 ミリも緩めずに採れること**(この設計の肝)。
 * ⚠ ここが落ちたら、構造を採るために**門を開けようとしている**ということである。
 */
describe('打つ字が、いまの門をそのまま通る', () => {
  it('🔴 3 つとも `select` として通る(worker にも門にも手を入れていない)', () => {
    for (const [name, sql] of [
      ['列', SCHEMA_COLUMNS_SQL],
      ['繋がり', SCHEMA_FK_SQL],
      ['行数', countsSql(['entries', 'tags'])!],
    ] as const) {
      const c = checkReadOnlySql(sql);
      expect(c.ok, `${name}を採る字が門で断られる: ${c.why}`).toBe(true);
    }
  });

  it('⚠ 対照群 ── 書き込む字はちゃんと断られる(門が生きている)', () => {
    expect(checkReadOnlySql('drop table entries').ok).toBe(false);
  });
});
