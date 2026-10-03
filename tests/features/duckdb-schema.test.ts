/**
 * 🔴 **DuckDB の器の構造を、構造ノート・つながり図が読む形へ採る**(#918。🟣 Gemini 裁定 2026-10-02 = A)。
 *
 * ⚠ ここは**字と重ね方**(純粋関数)を見る。実物の DuckDB に打たせて、内蔵の sqlite の道と
 *   **構造が 1 字も違わない**ことは `tests/duckdb-sqlite-ndjson.test.ts`(parity)が見る。
 */
import { describe, expect, it } from 'vitest';
import {
  DUCKDB_SCHEMA_COLUMNS_SQL,
  DUCKDB_SCHEMA_FK_SQL,
  duckDbMetaOf,
  mergeDuckDbSchema,
  type DuckDbTableMeta,
} from '../../src/features/query/duckdb-schema';
import {
  SCHEMA_COLUMNS_SQL,
  SCHEMA_FK_SQL,
  type Grid,
} from '../../src/features/query/schema-digest';

const aliases = (sql: string): string[] =>
  [...sql.matchAll(/\bas (\w+)/g)].map((m) => m[1] ?? '').sort();

describe('🔴 DuckDB で構造を採る SQL(字)', () => {
  it('🔴 DuckDB の 3 つの目録から採る / sqlite 専用の物を打たない(打つと器が断る)', () => {
    const all = DUCKDB_SCHEMA_COLUMNS_SQL + '\n' + DUCKDB_SCHEMA_FK_SQL;
    for (const f of ['duckdb_columns()', 'duckdb_views()', 'duckdb_constraints()']) {
      expect(all, `${f} から採っていない`).toContain(f);
    }
    for (const bad of ['sqlite_master', 'pragma_table_info', 'pragma_foreign_key_list']) {
      expect(all, `${bad} は DuckDB に無い`).not.toContain(bad);
    }
  });

  it('🔴 描く側へ渡す列名が、内蔵の sqlite の道と同じ(`schemaModel` が名前で読む)', () => {
    expect(aliases(DUCKDB_SCHEMA_COLUMNS_SQL)).toEqual(aliases(SCHEMA_COLUMNS_SQL));
    expect(aliases(DUCKDB_SCHEMA_FK_SQL)).toEqual(aliases(SCHEMA_FK_SQL));
  });

  it('🔴 DuckDB 自身の表・別の database の表を図に出さない', () => {
    expect(DUCKDB_SCHEMA_COLUMNS_SQL).toContain('not c.internal');
    expect(DUCKDB_SCHEMA_COLUMNS_SQL).toContain('current_database()');
    expect(DUCKDB_SCHEMA_FK_SQL).toContain('current_database()');
  });
});

const COLS = ['kind', 'tbl', 'cid', 'col', 'typ', 'nn', 'pk'];
const FKS = ['tbl', 'ref', 'col', 'refcol'];
const col = (
  tbl: string,
  cid: number,
  name: string,
  typ = 'VARCHAR',
  nn = 0,
  pk = 0,
  kind = 'table',
): (string | number)[] => [kind, tbl, cid, name, typ, nn, pk];

describe('🔴 器の答えに、写す前の .sqlite の姿を重ねる(mergeDuckDbSchema)', () => {
  const meta = new Map<string, DuckDbTableMeta>([
    [
      '子',
      {
        columns: [
          { name: 'id', type: 'INTEGER', notNull: true, primaryKey: true },
          { name: '親id', type: 'INT', notNull: false, primaryKey: false },
        ],
        fks: [{ fromColumn: '親id', toTable: '親', toColumn: 'id' }],
      },
    ],
  ]);
  const raw = (): { columns: Grid; fks: Grid } => ({
    columns: {
      columns: COLS,
      rows: [col('子', 0, 'id', 'BIGINT'), col('子', 1, '親id', 'BIGINT'), col('親', 0, 'id', 'BIGINT')],
    },
    fks: { columns: FKS, rows: [] },
  });

  it('🔴 型・空を許さない・主キーを元の宣言で置き換える(器は型を 3 つへ潰し、主キーも作らない)', () => {
    const { columns } = mergeDuckDbSchema(raw(), meta);
    expect(columns.rows).toEqual([
      col('子', 0, 'id', 'INTEGER', 1, 1),
      col('子', 1, '親id', 'INT', 0, 0),
      // 🔑 控えの無い表(持ち込んだ file / user が作った表)は器の答えのまま
      col('親', 0, 'id', 'BIGINT'),
    ]);
  });

  it('🔴 外部キーを足す ── 両端の表が器に在るときだけ(写せなかった表を指す線は出さない)', () => {
    const { fks } = mergeDuckDbSchema(raw(), meta);
    expect(fks.rows).toEqual([['子', '親', '親id', 'id']]);
    const lost = new Map(meta);
    lost.set('子', { ...meta.get('子')!, fks: [{ fromColumn: '親id', toTable: '消えた表', toColumn: 'id' }] });
    expect(mergeDuckDbSchema(raw(), lost).fks.rows, '箱の無い線が出ている').toEqual([]);
    // 器に無い表の控え(DROP された / 断った)は、線も出さない
    const orphan = new Map<string, DuckDbTableMeta>([
      ['無い', { columns: [], fks: [{ fromColumn: 'x', toTable: '親', toColumn: 'id' }] }],
    ]);
    expect(mergeDuckDbSchema(raw(), orphan).fks.rows).toEqual([]);
  });

  it('🔴 器が答えた外部キーと同じ線は 1 本へ / 並びは表の名前順(同じ表の中は足した順)', () => {
    const r = raw();
    const base = {
      columns: r.columns,
      fks: { columns: FKS, rows: [['子', '親', '親id', 'id'], ['親', '親', 'id', 'id']] },
    };
    const { fks } = mergeDuckDbSchema(base, meta);
    expect(fks.rows, '同じ線が 2 本出ている').toEqual([
      ['子', '親', '親id', 'id'],
      ['親', '親', 'id', 'id'],
    ]);
    // 並び:表の名前順(内蔵の sqlite の道の `order by m.name` と同じ)
    const two = new Map<string, DuckDbTableMeta>([
      ['子', meta.get('子')!],
      // ⚠ 列の形は器の `親`(id 1 列)と同じにする ── 形が違う表には重ねない(下の R2)
      [
        '親',
        {
          columns: [{ name: 'id', type: 'INTEGER', notNull: true, primaryKey: true }],
          fks: [{ fromColumn: 'id', toTable: '子', toColumn: 'id' }],
        },
      ],
    ]);
    expect(mergeDuckDbSchema(raw(), two).fks.rows.map((x) => x[0])).toEqual(['子', '親']);
  });

  it('🔴 控えが空なら入力のまま(持ち込んだ file だけの器 = 四角だけの図)', () => {
    const r = raw();
    const out = mergeDuckDbSchema(r, new Map());
    expect(out.columns.rows).toEqual(r.columns.rows);
    expect(out.fks.rows).toEqual([]);
  });
});

describe('🔴 DROP して同じ名前で作り直した表には、元の .sqlite の姿を重ねない(R2)', () => {
  const meta = new Map<string, DuckDbTableMeta>([
    [
      '子',
      {
        columns: [
          { name: 'id', type: 'INTEGER', notNull: true, primaryKey: true },
          { name: '親id', type: 'INT', notNull: false, primaryKey: false },
        ],
        fks: [{ fromColumn: '親id', toTable: '親', toColumn: 'id' }],
      },
    ],
  ]);
  const parent = col('親', 0, 'id', 'BIGINT');

  it('🔴 列の名前が違う表(user が作り直した)へ、型・主キー・外部キーを重ねない', () => {
    const raw = {
      columns: { columns: COLS, rows: [col('子', 0, 'id', 'INTEGER'), col('子', 1, '別の列', 'VARCHAR'), parent] },
      fks: { columns: FKS, rows: [] },
    };
    const out = mergeDuckDbSchema(raw, meta);
    // 器の答えのまま(元の .sqlite の「主キー」「空を許さない」を、user が作っていない表に付けない)
    expect(out.columns.rows).toEqual(raw.columns.rows);
    expect(out.fks.rows, '作り直した表に、元の外部キーが復活している').toEqual([]);
  });

  it('🔴 列の数が違う / 並びが違う表にも重ねない(集合ではなく並びで見る)', () => {
    const fewer = {
      columns: { columns: COLS, rows: [col('子', 0, 'id'), parent] },
      fks: { columns: FKS, rows: [] },
    };
    expect(mergeDuckDbSchema(fewer, meta).fks.rows).toEqual([]);
    expect(mergeDuckDbSchema(fewer, meta).columns.rows).toEqual(fewer.columns.rows);
    const swapped = {
      columns: { columns: COLS, rows: [col('子', 0, '親id', 'BIGINT'), col('子', 1, 'id', 'BIGINT'), parent] },
      fks: { columns: FKS, rows: [] },
    };
    expect(mergeDuckDbSchema(swapped, meta).fks.rows, '並びが逆なのに重ねている').toEqual([]);
  });

  it('対照群:列の形が同じなら重なる(写した表そのもの)', () => {
    const same = {
      columns: { columns: COLS, rows: [col('子', 0, 'id', 'BIGINT'), col('子', 1, '親id', 'BIGINT'), parent] },
      fks: { columns: FKS, rows: [] },
    };
    const out = mergeDuckDbSchema(same, meta);
    expect(out.columns.rows[0]).toEqual(col('子', 0, 'id', 'INTEGER', 1, 1));
    expect(out.fks.rows).toEqual([['子', '親', '親id', 'id']]);
  });
});

describe('🔴 外部キーの相手の名前を、器での名前へ直す(R3)', () => {
  const shape = (n: string) => ({ name: n, type: 'INTEGER', notNull: false, primaryKey: false });

  it('🔴 大小文字を区別せずに引く(REFERENCES Customers と CREATE TABLE customers は同じ表)', () => {
    const finalOf = new Map([['customers', 'customers']]);
    const m = duckDbMetaOf([shape('cid')], [{ fromColumn: 'cid', toTable: 'Customers', toColumn: 'id' }], finalOf);
    // ⚠ 直す前は完全一致で引いたので、この線は黙って落ちていた
    expect(m.fks, '大小の違いで線が落ちている').toEqual([{ fromColumn: 'cid', toTable: 'customers', toColumn: 'id' }]);
  });

  it('🔴 2 件以上のときは「ファイル名_表名」へ直る', () => {
    const finalOf = new Map([['客', '家計_客']]);
    const m = duckDbMetaOf([shape('客id')], [{ fromColumn: '客id', toTable: '客', toColumn: 'id' }], finalOf);
    expect(m.fks).toEqual([{ fromColumn: '客id', toTable: '家計_客', toColumn: 'id' }]);
  });

  it('🔴 この file に無い表を指す外部キーは捨てる(元の名前へ落とさない)', () => {
    const m = duckDbMetaOf(
      [shape('x')],
      [{ fromColumn: 'x', toTable: 'orders', toColumn: 'id' }],
      new Map([['customers', 'customers']]),
    );
    expect(m.fks, '無い表を指す線を元の名前のまま残している').toEqual([]);
  });

  it('🔴 同じ名前の別の表が器に在っても、偽の線にならない(並べた csv の表 orders)', () => {
    // 器には csv 由来の `orders` が在る。.sqlite は `orders` を持たず、その外部キーだけが `orders` を指していた
    const meta = new Map<string, DuckDbTableMeta>([
      ['子', duckDbMetaOf([shape('id'), shape('oid')], [{ fromColumn: 'oid', toTable: 'orders', toColumn: 'id' }], new Map())],
    ]);
    const raw = {
      columns: {
        columns: COLS,
        rows: [col('子', 0, 'id', 'BIGINT'), col('子', 1, 'oid', 'BIGINT'), col('orders', 0, 'id', 'VARCHAR')],
      },
      fks: { columns: FKS, rows: [] },
    };
    expect(mergeDuckDbSchema(raw, meta).fks.rows, '別の file の orders へ偽の線が引かれている').toEqual([]);
  });
});
