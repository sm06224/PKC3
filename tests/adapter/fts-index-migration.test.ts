/**
 * 🔴 **全文検索の索引と、起動不能(2026-08-20)。**
 *
 * user 報告:「**起動に失敗しました: SQLITE_CORRUPT_VTAB: sqlite3 result code 267:
 * database disk image is malformed**」。原因は 2 つの欠陥の合わせ技だった ──
 *
 * 1. **順序**: `applySchema` は「空の索引と trigger を作る」→「派生列の埋め戻しで
 *    `entries` を全行 UPDATE」の順で走っていた。UPDATE の trigger は
 *    **空の索引に `'delete'` を撃つ**ので、FTS5 が索引の破損として 267 を返す。
 *    ⚠ tx ごと巻き戻るので **DB は無傷**だが、**毎回の起動で同じ所で落ちる**。
 * 2. **空振り**: 救済のはずの「索引が空なら組み直す」判定は
 *    `SELECT count(*) FROM entries_fts` で数えていた。⚠ 外部内容
 *    (`content='entries'`)の全走査は**内容表**を読むので、
 *    **索引が空でも `entries` の行数が返る** ── 判定は**一度も真にならない**。
 *
 * 🔑 この file は **2 を先に pin する**(1 だけ直しても 2 が残れば同じ穴に戻る)。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { ENTRY_ADDED_COLUMNS, SCHEMA_DDL } from '../../src/adapter/platform/storage/schema';
import { applySchema } from '../../src/adapter/platform/storage/storage-worker';

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).sqlite3ApiConfig = {
    disable: { vfs: { opfs: true, 'opfs-wl': true } },
  };
  sqlite3 = await sqlite3InitModule();
}, 30_000);

const ROWS: ReadonlyArray<readonly [string, string]> = [
  ['e1', '牛乳を買う\n- [ ] やること\n'],
  ['e2', 'ここに全文検索のための本文がある\n'],
  ['e3', 'みっつめのノート\n'],
];

/**
 * 🔴 **#181(全文検索)より前に作られた DB** ── `entries_fts` も trigger も無く、
 * 派生列(`task_total` / `body_chars`)も無い。
 *
 * ⚠ 既存の `schema-migration.test.ts` の「旧 DB」は**ここまで古くない**
 *   (FTS を落としていないので、行を入れた時点で trigger が索引を埋める)──
 *   だからあちらは 12 日間この穴を 1 度も通らなかった(§2 未実行の経路)。
 * ⚠ DDL は手で書き写さず**本物から削る** ── 写すと本物が変わったときに
 *   ここだけ古くなり、「旧い DB」のつもりで別物を作る(§1 空振り)。
 */
function preFtsDb(opts: { fts: boolean; triggers: boolean }): Database {
  const db = new sqlite3.oo1.DB(':memory:');
  const added = ENTRY_ADDED_COLUMNS.map((c) => c.name);
  for (const ddl of SCHEMA_DDL) {
    const isFtsTable = /CREATE VIRTUAL TABLE/.test(ddl) && /entries_fts/.test(ddl);
    const isFtsTrigger = /CREATE TRIGGER/.test(ddl) && /entries_fts/.test(ddl);
    if (isFtsTable && !opts.fts) continue;
    if (isFtsTrigger && !opts.triggers) continue;
    if (added.some((n) => new RegExp(`\\b${n}\\b`).test(ddl)) && /INDEX/.test(ddl)) continue;
    let out = ddl;
    for (const n of added) out = out.replace(new RegExp(`\\n\\s*${n}\\s+[^,]+,`), '');
    db.exec(out);
  }
  db.exec('PRAGMA user_version = 3');
  for (const [lid, body] of ROWS)
    db.exec({
      sql: `INSERT INTO entries (cid, lid, title, archetype, created_at, updated_at,
              entry_order, status, date, archived, body)
            VALUES ('c1', ?, ?, 'text', '2020-01-01 00:00:00', '2020-01-01 00:00:00',
              1, NULL, NULL, 0, ?)`,
      bind: [lid, 't-' + lid, body],
    });
  return db;
}

/** 索引に本当に入っている doc の数(影表 = 1 doc 1 行)。 */
const docs = (db: Database): number =>
  Number(db.selectValue('SELECT count(*) FROM entries_fts_docsize') ?? -1);

describe('全文検索の索引 migration(2026-08-20 の起動不能)', () => {
  /**
   * 🔴 **これが「救済の判定が空振りしていた」ことの証拠**。
   *
   * ⚠ この 1 件が落ちたら、それは sqlite の挙動が変わったということ ──
   *   そのときは `ftsDocCount` の実装(影表を数える)を見直してよい。
   *   ⚠ **落ちていないのに `count(*) FROM entries_fts` へ戻さない**。
   */
  it('🔴 count(*) FROM entries_fts は索引ではなく内容表を数える(だから使えない)', () => {
    const db = preFtsDb({ fts: true, triggers: false });
    expect(docs(db), '前提が崩れている(索引が空でない)').toBe(0);
    expect(
      Number(db.selectValue('SELECT count(*) FROM entries_fts') ?? -1),
      '外部内容の count(*) が内容表を読まなくなった',
    ).toBe(ROWS.length);
    db.close();
  });

  it('🔴 FTS を持たない DB が、起動不能にならずに開く(#297)', () => {
    const db = preFtsDb({ fts: false, triggers: false });
    expect(
      db.selectValue(`SELECT count(*) FROM sqlite_master WHERE name = 'entries_fts'`),
      '前提が崩れている(この DB は FTS を持っていてはいけない)',
    ).toBe(0);
    // ⚠ ここが user の踏んだ場所 ── 直す前は SQLITE_CORRUPT_VTAB(267)で落ちた
    expect(() => applySchema(db)).not.toThrow();
    db.close();
  });

  /**
   * ⚠ 「落ちない」だけでは足りない ── **索引が実際に埋まった**ことまで見る。
   *   落ちないが空のまま、は「探しても何も出ない」という**静かな壊れ方**である。
   */
  it('🔴 開いたあと、索引が実際に埋まっている(探して出る)', () => {
    const db = preFtsDb({ fts: false, triggers: false });
    applySchema(db);
    expect(docs(db), '索引が埋まっていない(探しても何も出ない)').toBe(ROWS.length);
    expect(
      Number(
        db.selectValue(
          `SELECT count(*) FROM entries_fts WHERE entries_fts MATCH '全文検索'`,
        ) ?? -1,
      ),
      '本文で引けない',
    ).toBe(1);
    // ⚠ 整合検査そのものも通ること(delete/insert の帳尻が合っている)
    expect(() =>
      db.exec(`INSERT INTO entries_fts(entries_fts) VALUES ('integrity-check')`),
    ).not.toThrow();
    db.close();
  });

  /**
   * 🔴 **表は在るのに索引が空**(= #181 が配られた後の既存 user の実際の姿)。
   * ⚠ 判定を `count(*) FROM entries_fts` に戻すと、この 1 件が落ちる。
   */
  it('🔴 表は在るが索引が空の DB も、開いたときに組み直される', () => {
    const db = preFtsDb({ fts: true, triggers: false });
    expect(docs(db), '前提が崩れている').toBe(0);
    applySchema(db);
    expect(docs(db), '索引が空のまま素通りした(判定が空振りしている)').toBe(ROWS.length);
    db.close();
  });

  /**
   * ⚠ 数が食い違うだけ(一部だけずれた索引)でも組み直す。
   *
   * 🔴 **派生列を先に埋めておくのが、この test の要**(2026-08-20 の変異試験で判明)。
   *   1 稿目は埋めずに書いたので `backfillDerivedColumns` が全行 UPDATE し、
   *   **trigger が索引を戻していた** ── つまり検査したい経路を 1 度も通らずに
   *   緑だった(§1 空振り / §2 未実行の経路)。実際、判定を
   *   「空のときだけ組み直す」へ壊す変異が**生き延びた**。
   */
  it('索引が一部だけ欠けていても組み直される', () => {
    const db = preFtsDb({ fts: true, triggers: true });
    expect(docs(db), '前提が崩れている(trigger で埋まっているはず)').toBe(ROWS.length);
    // ⚠ 埋め戻しに救わせない ── 派生列を先に埋めて、UPDATE が 1 行も走らない形にする
    db.exec('ALTER TABLE entries ADD COLUMN task_total INTEGER');
    db.exec('ALTER TABLE entries ADD COLUMN body_chars INTEGER');
    db.exec('UPDATE entries SET task_total = 0, body_chars = length(body)');
    expect(docs(db), '前提が崩れている(この UPDATE で索引は保たれるはず)').toBe(ROWS.length);
    // 1 doc ぶんだけ影表から落として「ずれた索引」を作る
    db.exec(`DELETE FROM entries_fts_docsize WHERE id = (SELECT max(id) FROM entries_fts_docsize)`);
    expect(docs(db)).toBe(ROWS.length - 1);
    applySchema(db);
    expect(docs(db), 'ずれたまま素通りした').toBe(ROWS.length);
    db.close();
  });

  /**
   * 🔴 **`'rebuild'` でも直らない索引は、作り直す**(2026-08-20 に実測して決めた)。
   *
   * ⚠ 影表(`%_docsize`)を落とした索引に `'rebuild'` を撃つと **`SQLITE_ERROR`**
   *   で落ちる ── つまり「組み直せば直る」は**成り立たない前提**だった。
   *   ここで throw させると、直そうとしている症状(**起動そのものの失敗**)を
   *   別の理由で再現してしまう。
   * 🔑 仮想表ごと落として作り直すと、**壊れ方に依らず**直る(実測)。
   * ⚠ `entries` を 0 件にしてあるのは、「読めない」を **0 件**と読み替える実装だと
   *   `0 === 0` で**素通りしてしまう**から ── その取り違えをここで殺す。
   */
  it('🔴 組み直しでも直らない索引は、作り直して起動できる', () => {
    const db = preFtsDb({ fts: true, triggers: true });
    db.exec(`DELETE FROM entries`);
    db.exec(`DROP TABLE entries_fts_docsize`);
    const readable = (): boolean => {
      try {
        db.selectValue('SELECT count(*) FROM entries_fts_docsize');
        return true;
      } catch {
        return false;
      }
    };
    expect(readable(), '前提が崩れている(影表を落とせていない)').toBe(false);
    // ⚠ ここが要 ── 直す前は「起動に失敗しました」と同じ形で throw していた
    expect(() => applySchema(db)).not.toThrow();
    expect(readable(), '索引が壊れたまま素通りした').toBe(true);
    expect(docs(db)).toBe(0);
    db.close();
  });

  it('2 回通しても壊れない(冪等)', () => {
    const db = preFtsDb({ fts: false, triggers: false });
    applySchema(db);
    applySchema(db);
    expect(docs(db)).toBe(ROWS.length);
    expect(() =>
      db.exec(`INSERT INTO entries_fts(entries_fts) VALUES ('integrity-check')`),
    ).not.toThrow();
    db.close();
  });
});
