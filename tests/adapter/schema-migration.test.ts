/**
 * 🔴 **既に DB を持っている user の道**(#277 段②の migration)。
 *
 * ⚠ この経路は**新規 DB では一度も走らない** ── 手元で開発している限り、
 *   `CREATE TABLE` が最新形をそのまま作るので、migration の枝は
 *   **弱いのではなく実行されない**(CLAUDE.md §2)。だからここでは
 *   **旧い形の DB を自分で作って**通す。
 *
 * 🔑 守る主張:
 * 1. 列が無い DB に**列が足される**
 * 2. 🔴 **既存行が埋まる** ── DDL / ALTER は既定値のままにするので、埋めないと
 *    **いま在るノートが 1 件もカンバンに出ない**まま緑になる
 *    (全文検索 #181 で索引を足したときに踏んだのと同じ型)
 * 3. **冪等**(2 回通しても壊れない / 半端な DB も自己修復する)
 * 4. ⚠ **埋め戻しが `updated_at` を触らない**(user の編集ではない)
 */
import { beforeAll, describe, expect, it } from 'vitest';
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import {
  DB_SCHEMA_VERSION,
  ENTRY_ADDED_COLUMNS,
  SCHEMA_DDL,
} from '../../src/adapter/platform/storage/schema';
import { applySchema } from '../../src/adapter/platform/storage/storage-worker';

/**
 * 🔑 **旧い形の DDL を作る** ── いまの DDL から、後から足した列と索引を落とす。
 * ⚠ DDL を手で書き写さない ── 写すと、本物が変わったときにここだけ古くなり、
 *   「旧い DB」のつもりで**別物**を作ることになる(§1 の空振り)。
 */
function oldSchemaDdl(): string[] {
  const added = ENTRY_ADDED_COLUMNS.map((c) => c.name);
  return SCHEMA_DDL
    // ⚠ 後付け列を**使う**もの(索引など)は、旧い DB にはそもそも作れない
    .filter((ddl) => !added.some((n) => new RegExp(`\\b${n}\\b`).test(ddl) && /INDEX/.test(ddl)))
    .map((ddl) => {
      let out = ddl;
      for (const name of added) {
        out = out.replace(new RegExp(`\\n\\s*${name}\\s+[^,]+,`), '');
      }
      return out;
    });
}

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).sqlite3ApiConfig = {
    disable: { vfs: { opfs: true, 'opfs-wl': true } },
  };
  sqlite3 = await sqlite3InitModule();
}, 30_000);

/** 旧い形(task_total 無し)の DB を作り、行を入れて返す。 */
function oldDb(rows: ReadonlyArray<readonly [string, string]>): Database {
  const db = new sqlite3.oo1.DB(':memory:');
  for (const ddl of oldSchemaDdl()) db.exec(ddl);
  db.exec('PRAGMA user_version = 3');
  for (const [lid, body] of rows) {
    db.exec({
      sql: `INSERT INTO entries (cid, lid, title, archetype, created_at, updated_at,
              entry_order, status, date, archived, body)
            VALUES ('c1', ?, ?, 'text', '2020-01-01 00:00:00', '2020-01-01 00:00:00',
              1, NULL, NULL, 0, ?)`,
      bind: [lid, 't-' + lid, body],
    });
  }
  return db;
}

const cols = (db: Database): Set<string> =>
  new Set(
    (db.selectObjects(`SELECT name FROM pragma_table_info('entries')`) as Array<{ name: string }>)
      .map((r) => r.name),
  );
const taskTotal = (db: Database, lid: string): number =>
  Number(db.selectValue(`SELECT task_total FROM entries WHERE lid = ?`, [lid]) ?? -1);

describe('entries の後付け列(#277 段②)', () => {
  /** ⚠ **空振り防止** ── 旧い DDL が本当に列を持っていないこと。 */
  it('⚠ 前提: 旧い形の DB には列が無い', () => {
    const db = oldDb([]);
    expect(cols(db).has('task_total'), '旧い DB の作り方が間違っている(既に列が在る)').toBe(
      false,
    );
    db.close();
  });

  it('🔴 列が足される', () => {
    const db = oldDb([['a', '- [ ] x\n']]);
    applySchema(db);
    expect(cols(db).has('task_total'), '列が足されていない').toBe(true);
    expect(Number(db.selectValue('PRAGMA user_version')), '刻印が古いまま').toBe(
      DB_SCHEMA_VERSION,
    );
    db.close();
  });

  /**
   * 🔴 **これが本丸** ── 既存行が埋まる。埋めないと、いま在るノートが
   * 1 件もカンバンに出ないまま緑になる。
   */
  it('🔴 既存行が埋まる(埋めないと、いま在るノートが 1 件も出ない)', () => {
    const db = oldDb([
      ['t-plain', '# ただの本文\n'],
      ['t-two', '- [ ] 牛乳\n- [x] 卵\n'],
      ['t-quote', '> - [ ] 引用の中\n'],
      ['t-fence', '```\n- [ ] にせもの\n```\n'],
    ]);
    applySchema(db);
    expect(taskTotal(db, 't-two'), '既存行が埋まっていない').toBe(2);
    expect(taskTotal(db, 't-quote'), '引用の中を落としている').toBe(1);
    expect(taskTotal(db, 't-plain'), 'チェックが無いのに数が入った').toBe(0);
    expect(taskTotal(db, 't-fence'), 'fence の中まで数えた').toBe(0);
    db.close();
  });

  /**
   * ⚠ **埋め戻しは user の編集ではない** ── `updated_at` を触ると
   *   「今日ぜんぶ更新された」ように見える(情報列の嘘)。
   */
  it('🔴 埋め戻しが updated_at を触らない', () => {
    const db = oldDb([['t-stamp', '- [ ] x\n']]);
    applySchema(db);
    expect(
      db.selectValue(`SELECT updated_at FROM entries WHERE lid = 't-stamp'`),
      '埋め戻しで更新日時が動いた',
    ).toBe('2020-01-01 00:00:00');
    db.close();
  });

  /** 🔴 **冪等** ── 2 回通しても落ちず、値も動かない(半端な DB の自己修復)。 */
  it('🔴 2 回通しても壊れない', () => {
    const db = oldDb([['t-idem', '- [x] a\n- [ ] b\n']]);
    applySchema(db);
    const first = taskTotal(db, 't-idem');
    expect(() => applySchema(db), '2 回目で落ちた').not.toThrow();
    expect(taskTotal(db, 't-idem'), '2 回目で値が動いた').toBe(first);
    db.close();
  });

  /**
   * 🔴 **旧ビルドが書いた行を取りこぼさない**(#277 段②、2026-08-19 の実地調査で改良)。
   *
   * 版(`DB_SCHEMA_VERSION`)を**上げていない**ので、旧ビルドは同じ DB を普通に
   * 開いて書く(#286 の「アプリが起動しない」を作らないための判断)。
   * ⚠ 旧ビルドの UPSERT はこの列を知らないので、**新しく作った行は NULL** になる。
   *
   * 🔑 だから列を **`NOT NULL DEFAULT 0` にしない** ── 既定 0 にすると
   *   「まだ数えていない」と「チェックが 0 件」が同じ値に潰れ、
   *   **その行が二度と拾えなくなる**(= カンバンから永久に消える)。
   *   NULL = 未計算と読めるからこそ、次の open が埋め戻せる。
   */
  it('🔴 旧ビルドが書いた行は NULL で残り、次の open で埋まる', () => {
    const db = new sqlite3.oo1.DB(':memory:');
    for (const ddl of SCHEMA_DDL) db.exec(ddl);
    db.exec(`PRAGMA user_version = ${DB_SCHEMA_VERSION}`);
    // ⚠ **旧ビルドの upsert は列を知らない** ── 列を指定しない INSERT で再現する
    db.exec({
      sql: `INSERT INTO entries (cid, lid, title, archetype, entry_order, archived, body)
            VALUES ('c1', 'oldwrite', 't', 'text', 1, 0, ?)`,
      bind: ['- [ ] 旧ビルドが書いた\n'],
    });
    expect(
      db.selectValue(`SELECT task_total FROM entries WHERE lid = 'oldwrite'`),
      '既定が NULL でない(0 に潰れると、この行は二度と拾えない)',
    ).toBeNull();
    // 🔑 次の open で埋まる(判定は「NULL の行が在るか」)
    applySchema(db);
    expect(taskTotal(db, 'oldwrite'), '旧ビルドが書いた行が埋まっていない').toBe(1);
    db.close();
  });

  /**
   * 🔴 **塊で回しても取りこぼさない**(埋め戻しは本文を一度に heap へ載せない)。
   * ⚠ 実地調査の指摘:全件を 1 回で読むと、20MB の容れ物で boot の worker が
   *   20MB 抱える(不可侵指示 2026-07-27「速やかな破棄」に反する)。
   * 🔑 塊の大きさ(200)を**跨ぐ件数**で試す ── 跨がないと分割の枝を 1 度も通らない。
   */
  it('🔴 塊の境目を跨ぐ件数でも、全部埋まる', () => {
    const rows: Array<readonly [string, string]> = [];
    for (let i = 0; i < 250; i++) rows.push([`bulk-${i}`, `- [${i % 2 ? 'x' : ' '}] ${i}\n`]);
    const db = oldDb(rows);
    applySchema(db);
    const remaining = Number(
      db.selectValue(`SELECT count(*) FROM entries WHERE task_total IS NULL`) ?? -1,
    );
    expect(remaining, '塊の境目で埋め残した').toBe(0);
    expect(taskTotal(db, 'bulk-249'), '最後の塊が埋まっていない').toBe(1);
    db.close();
  });
});
