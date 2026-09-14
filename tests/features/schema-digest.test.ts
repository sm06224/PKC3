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
  schemaModel,
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

/**
 * 🔴 **構造そのものを値で返す口**(#918 段⑤a)。
 *
 * ⚠ ここを作った理由は ER(段⑤b)だが、守りたいのは**取り出しで段① を壊さないこと**である
 *   ── `renderSchemaDigest` は**この値を読むだけ**にしたので、
 *   模型が狂えば段① の字も狂う。
 */
describe('構造そのものを値で返す(#918 段⑤a)', () => {
  it('表・列・鍵・行数が、採ってきた順のまま入る', () => {
    const m = schemaModel({ source: 'x', columns: COLS, fks: FKS, counts: COUNTS });
    expect(
      m.tables.map((t) => t.name),
      '採ってきた順が変わっている(ここでは並べ替えない)',
    ).toEqual(['entries', 'tags', 'recent']);
    expect(m.tables[0]!.columns.map((c) => c.name)).toEqual(['lid', 'title']);
    expect(m.tables[0]!.columns[0]).toEqual({
      name: 'lid',
      type: 'TEXT',
      notNull: true,
      primaryKey: true,
    });
    // ⚠ 型は**採れた字のまま**(「(型なし)」に飾るのは見せる側の仕事)
    expect(m.tables[1]!.columns[0]!.type, '模型の側で飾っている').toBe('');
  });

  it('🔴 ビューと表を見分ける(綴りの正規化はここ 1 か所)', () => {
    const m = schemaModel({ source: 'x', columns: COLS, fks: FKS });
    expect(m.tables.map((t) => t.kind)).toEqual(['table', 'table', 'view']);
  });

  it('🔴 「0 行」と「採れなかった」を区別する', () => {
    const withCounts = schemaModel({ source: 'x', columns: COLS, fks: FKS, counts: COUNTS });
    expect(withCounts.tables[0]!.rows, '採れた行数が入っていない').toBe(3);
    // 🔑 ここが肝 ── `0` は「採れて 0 行」であって、採れなかったのではない
    expect(withCounts.tables[1]!.rows, '0 行が「採れなかった」に潰れている').toBe(0);
    // ⚠ counts に居ない表(ビュー)は採れていない
    expect(withCounts.tables[2]!.rows).toBeNull();

    const without = schemaModel({ source: 'x', columns: COLS, fks: FKS });
    expect(without.tables.every((t) => t.rows === null), '採れていないのに数が入る').toBe(true);
  });

  it('⚠ 数として読めない行数は「採れなかった」扱い(嘘の「N 行」を書かない)', () => {
    // ⚠ `count(*)` は必ず整数なので普通は起きない ── 起きたときに**嘘を書かない**ための門
    const m = schemaModel({
      source: 'x',
      columns: COLS,
      fks: FKS,
      counts: grid(['tbl', 'n'], [['entries', 'よんじゅう']]),
    });
    expect(m.tables[0]!.rows).toBeNull();
    const out = renderSchemaDigest({
      source: 'x',
      columns: COLS,
      fks: FKS,
      counts: grid(['tbl', 'n'], [['entries', 'よんじゅう']]),
    });
    expect(out, '読めない字をそのまま「N 行」と書いている').not.toContain('よんじゅう');
    // ⚠ 空振り防止 ── そもそもこの入力で表の見出しは出ている
    expect(out).toContain('## entries(表)');
  });

  it('🔴 繋がりは両端を持つ / 読めない行は落とす', () => {
    const m = schemaModel({
      source: 'x',
      columns: COLS,
      fks: grid(
        ['tbl', 'ref', 'col', 'refcol'],
        [
          ['tags', 'entries', 'lid', 'lid'],
          // ⚠ 自分の表が空の行は、繋がりとして読めない
          ['', 'entries', 'lid', 'lid'],
        ],
      ),
    });
    expect(m.links).toEqual([
      { from: 'tags', fromColumn: 'lid', to: 'entries', toColumn: 'lid' },
    ]);
  });
});

/**
 * 🔴 **段① の字は、模型から出ている**(#918 段⑤a)。
 *
 * ⚠ ここが落ちるときは、`renderSchemaDigest` が模型を読まずに**もう 1 度組み立てている**
 *   ── CLAUDE.md §7「同じ問いに答える口が 2 つ」そのものである。
 * 🔑 期待値を別の綴りで組まず、**模型に在る物が字にも在る**という対応だけを見る。
 */
describe('段① の字と模型が食い違わない', () => {
  it('🔴 表の数・名前・行数が、字の側と一致する', () => {
    const input = { source: 'x', columns: COLS, fks: FKS, counts: COUNTS };
    const m = schemaModel(input);
    const out = renderSchemaDigest(input);
    const heads = out.split('\n').filter((l) => l.startsWith('## ') && l !== '## 表どうしの繋がり');
    expect(heads.length, '見出しの数が模型の表の数と違う').toBe(m.tables.length);
    for (const t of m.tables) {
      const kind = t.kind === 'view' ? 'ビュー' : '表';
      const want = t.rows === null ? `## ${t.name}(${kind})` : `## ${t.name}(${kind}・${t.rows} 行)`;
      expect(heads, `模型に在る表が字に無い: ${t.name}`).toContain(want);
      for (const c of t.columns) {
        expect(out, `模型に在る列が字に無い: ${t.name}.${c.name}`).toContain(`| ${c.name} | `);
      }
    }
  });

  it('🔴 繋がりが、模型と字で 1 本ずつ対応する', () => {
    const input = { source: 'x', columns: COLS, fks: FKS, counts: COUNTS };
    const m = schemaModel(input);
    const lines = renderSchemaDigest(input)
      .split('\n')
      .filter((l) => l.startsWith('- ') && l.includes('→'));
    expect(lines.length, '線の本数が違う').toBe(m.links.length);
    expect(lines.length, '空振り ── そもそも繋がりが 0 本').toBeGreaterThan(0);
    for (const f of m.links) {
      const to = f.toColumn === '' ? f.to : `${f.to}.${f.toColumn}`;
      expect(lines).toContain(`- ${f.from}.${f.fromColumn} → ${to}`);
    }
  });

  /**
   * 🔴 **取り出しで 1 バイトも変えていないことの錨**(#918 段⑤a)。
   *
   * ⚠ この字は**取り出す前の実装**(`e7d7948` 時点)を走らせて採った物である ──
   *   別の綴りで組み直した期待値ではない(CLAUDE.md §1「同じ盲点を共有する」回避)。
   * ⚠ 段① の見せ方を**わざと**変えるときは、ここも同時に直す(直さずに通ることはない)。
   */
  it('🔴 段① の字を丸ごと pin する', () => {
    const out = renderSchemaDigest({
      source: 'この PKC のノート',
      columns: COLS,
      fks: FKS,
      counts: COUNTS,
    });
    expect(out).toBe(
      `# この PKC のノート の構造

表 / ビュー: 3 件

## entries(表・3 行)

| 列 | 型 | 空を許すか | 鍵 |
|---|---|---|---|
| lid | TEXT | 不可 | 主キー |
| title | TEXT | 可 |  |

## tags(表・0 行)

| 列 | 型 | 空を許すか | 鍵 |
|---|---|---|---|
| name | (型なし) | 可 |  |

## recent(ビュー)

| 列 | 型 | 空を許すか | 鍵 |
|---|---|---|---|
| lid | TEXT | 可 |  |

## 表どうしの繋がり

- tags.lid → entries.lid

---

⚠ ここに在るのは構造だけです(中身は 1 行も含まれていません)。`,
    );
  });
});
