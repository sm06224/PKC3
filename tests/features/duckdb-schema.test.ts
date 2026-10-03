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
      ['親', { columns: [], fks: [{ fromColumn: 'id', toTable: '子', toColumn: 'id' }] }],
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
