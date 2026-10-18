/** @vitest-environment node */
/**
 * 🔴 **束 B2 の着地前レビューで出た穴を、直に塞ぐ test**(台帳 #1852)。
 *
 * ① 作り直しの途中で前の版が `'rebuild'` を撃っても、新しい版が開き直したとき索引を捨てて最初からやり直す(二重に入れない・古い本文で当たり続けない)
 * ② 作り直しの途中(`built_upto` を途中で止めたまま)で、印の前後の行を書く・消しても索引が壊れない(`foldStep` を直に回す)
 * ③ 「値が変わらない更新では索引を触らない」(`entries_fts_au` の WHEN)
 * ④ 旧い形の移行に失敗した回は、索引の形の版を刻まない
 * ⑤ 1 塊は行数だけでなく本文の字数でも切る / 20 回続けて落ちて諦めたらシステムのメッセージに残す
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { ResultMap, StorageRequest, StorageResponse } from '../../src/adapter/platform/storage/protocol';
import { ENTRY_ADDED_COLUMNS, LEGACY_FTS_DDL, LEGACY_SCHEMA_DDL, SCHEMA_DDL } from '../../src/adapter/platform/storage/schema';

type RawDb = {
  pointer: number;
  close: () => void;
  exec: (o: string | { sql: string; bind?: unknown[] }) => void;
  selectValue: (sql: string, bind?: unknown[]) => unknown;
  selectObjects: (sql: string, bind?: unknown[]) => Array<Record<string, unknown>>;
};
type Sqlite = { oo1: { DB: new (f: string, m?: string) => RawDb }; capi: Record<string, (...a: never[]) => unknown>; wasm: Record<string, (...a: never[]) => unknown> };
let api: Sqlite;
let applySchema: (d: never) => void;
let foldStep: (d: never, chunk?: number) => boolean;

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).sqlite3ApiConfig = { disable: { vfs: { opfs: true, 'opfs-wl': true } } };
  (globalThis as unknown as Record<string, unknown>).self = { onmessage: null };
  (globalThis as unknown as Record<string, unknown>).postMessage = () => {};
  const w = await import('../../src/adapter/platform/storage/storage-worker');
  applySchema = w.applySchema as never;
  foldStep = w.foldStep as never;
  api = (await sqlite3InitModule()) as unknown as Sqlite;
}, 30_000);

const step = (db: RawDb, n?: number): boolean => foldStep(db as never, n);
const apply = (db: RawDb): void => applySchema(db as never);

/** 束 B2 より前のビルドが作った DB(列も索引も旧い形)。`bodyChars` は本文の字数の申告(省略 = 実際の長さ)。 */
function legacyDb(n: number, bodyOf: (i: number) => string = (i) => `本文 row${i}`): RawDb {
  const db = new api.oo1.DB(':memory:', 'c');
  const added = ENTRY_ADDED_COLUMNS.map((c) => c.name).filter((x) => ['title_f', 'body_f', 'fold_rev'].includes(x));
  for (const ddl of LEGACY_SCHEMA_DDL()) {
    let out = ddl;
    for (const a of added) out = out.replace(new RegExp(`\\n\\s*${a}\\s+[^,]+,`), '');
    db.exec(out);
  }
  db.exec('PRAGMA user_version = 3');
  db.exec(`INSERT INTO containers (cid, title, created_at, updated_at, schema_version) VALUES ('c1', 't', datetime('now'), datetime('now'), 3)`);
  for (let i = 0; i < n; i++)
    db.exec({
      sql: `INSERT INTO entries (cid, lid, title, archetype, created_at, updated_at, entry_order, archived, body)
            VALUES ('c1', ?, ?, 'text', '2020-01-01 00:00:00', '2020-01-01 00:00:00', ?, 0, ?)`,
      bind: [`r${i}`, `題 ${i}`, i + 1, bodyOf(i)],
    });
  return db;
}

// rank = 1 は、索引と内容表(視点)の突き合わせまで見る強い検査(二重に入った・消し損ねた行を拾う)
const integrity = (db: RawDb): void =>
  db.exec(`INSERT INTO entries_fts(entries_fts, rank) VALUES ('integrity-check', 1)`);
const docs = (db: RawDb): number => Number(db.selectValue('SELECT count(*) FROM entries_fts_docsize'));
const rows = (db: RawDb): number => Number(db.selectValue('SELECT count(*) FROM entries'));
const cursor = (db: RawDb): unknown =>
  db.selectValue(`SELECT v FROM settings WHERE scope = '__fts__' AND k = 'built_upto'`) ?? null;
const hits = (db: RawDb, term: string): number =>
  Number(db.selectValue(`SELECT count(*) FROM entries_fts WHERE entries_fts MATCH ?`, [`"${term}"`]));
const finish = (db: RawDb): void => {
  for (let i = 0; i < 1000 && step(db); i++) {
    /* 続きがある間 */
  }
};

describe('① 作り直しの途中で前の版が rebuild を撃っても、新しい版が最初からやり直す', () => {
  it('🔴 印より後の行が索引に居る → 索引を捨てて印を -1 に戻し、流し直すと整合し、古い本文で当たらない', () => {
    const db = legacyDb(250, (i) => (i === 200 ? '二百番の元の本文 ZZOLD' : `本文 row${i}`));
    apply(db);
    expect(step(db, 100)).toBe(true);
    expect(cursor(db), '前提: 途中で止まっている').toBe('100');
    // ── 前の版が開く: 数が合わないので 'rebuild'(視点を読むので全行が入る)
    for (const ddl of LEGACY_FTS_DDL) db.exec(ddl);
    expect(docs(db)).toBeLessThan(rows(db));
    db.exec(`INSERT INTO entries_fts(entries_fts) VALUES ('rebuild')`);
    expect(docs(db), '前提: 前の版が全行を索引に入れた').toBe(rows(db));
    expect(cursor(db), '前提: 印は残ったまま').toBe('100');
    // 前の版が書く・消す(印より後の行 ── 新しい引き金は黙る)
    db.exec(`UPDATE entries SET body = '二百番の新しい本文 ZZNEW' WHERE lid = 'r200'`);
    db.exec(`DELETE FROM entries WHERE lid = 'r210'`);
    // ── 新しい版が開く
    apply(db);
    expect(cursor(db), '印より後が索引に居るのに、続きを流そうとしている(二重に入れて壊れる)').toBe('-1');
    expect(docs(db), '索引を捨てていない').toBe(0);
    finish(db);
    expect(cursor(db)).toBeNull();
    expect(() => integrity(db), '流し直した索引が壊れている').not.toThrow();
    expect(docs(db)).toBe(rows(db));
    expect(hits(db, 'ZZNEW'), '新しい本文で当たらない').toBe(1);
    expect(hits(db, 'ZZOLD'), '古い本文で当たり続けている').toBe(0);
    db.close();
  });

  it('対照群: 印より後に誰も入れていなければ、続きから流す(捨てない)', () => {
    const db = legacyDb(250);
    apply(db);
    step(db, 100);
    apply(db); // 開き直し
    expect(cursor(db), '捨ててしまった').toBe('100');
    finish(db);
    expect(() => integrity(db)).not.toThrow();
    db.close();
  });
});

describe('② 作り直しの途中で、印の前後の行を書く・消しても索引が壊れない', () => {
  it('🔴 foldStep を直に回して印を途中で止め、前後の行の更新・削除・追加 → 流し終えると整合する', () => {
    const db = legacyDb(250);
    apply(db);
    step(db, 100);
    expect(cursor(db)).toBe('100');
    // 印の前(索引に入っている行)
    db.exec(`UPDATE entries SET body = '前の行を書き換えた ZZBEFORE' WHERE lid = 'r5'`);
    db.exec(`DELETE FROM entries WHERE lid = 'r6'`);
    // 印の後(まだ入れていない行 ── 引き金は黙る。'delete' を撃つと壊れる)
    db.exec(`UPDATE entries SET body = '後ろの行を書き換えた ZZAFTER' WHERE lid = 'r200'`);
    db.exec(`DELETE FROM entries WHERE lid = 'r201'`);
    db.exec(
      `INSERT INTO entries (cid, lid, title, archetype, entry_order, archived, body) VALUES ('c1', 'rnew', '新', 'text', 999, 0, '作り直し中に足した ZZNEWROW')`,
    );
    expect(cursor(db), '書いたら印が動いた').toBe('100');
    finish(db);
    expect(() => integrity(db)).not.toThrow();
    expect(docs(db)).toBe(rows(db));
    expect(hits(db, 'ZZBEFORE')).toBe(1);
    expect(hits(db, 'ZZAFTER')).toBe(1);
    expect(hits(db, 'ZZNEWROW')).toBe(1);
    expect(hits(db, 'row200'), '書き換える前の本文が残っている').toBe(0);
    db.close();
  });
});

describe('③ 値が変わらない更新では索引を触らない', () => {
  it('🔴 索引に入る字が同じ更新は変更 1 件(更新そのもの)だけ / 変わる更新は索引も書き直す', () => {
    const db = new api.oo1.DB(':memory:', 'c');
    for (const ddl of SCHEMA_DDL) db.exec(ddl);
    db.exec(`INSERT INTO entries (cid, lid, title, archetype, entry_order, archived, body, fold_rev) VALUES ('c1', 'a', 't', 'text', 1, 0, '本文ＡＢＣ', 1)`);
    const total = (): number => Number(db.selectValue('SELECT total_changes()'));
    const t0 = total();
    db.exec(`UPDATE entries SET title_f = title_f WHERE lid = 'a'`); // 値は変わらない
    const same = total() - t0;
    const t1 = total();
    db.exec(`UPDATE entries SET body_f = 'ABC本文' WHERE lid = 'a'`); // 索引に入る字が変わる
    const changed = total() - t1;
    expect(same, '値が変わらないのに索引を書き直している').toBe(1);
    expect(changed, '前提: 変わる更新は索引も書き直す').toBeGreaterThan(same);
    db.close();
  });
});

describe('④ 旧い形の移行に失敗した回は、索引の形の版を刻まない', () => {
  it('🔴 影の表を落とせない旧い索引 → 起動は止まらず、版は刻まれない(次の起動でやり直す)', () => {
    const db = legacyDb(3);
    // FTS5 が影の表を落とす手を塞ぐ(影の表の名前を別物の視点にする)
    db.exec('DROP TABLE entries_fts_config');
    db.exec('CREATE VIEW entries_fts_config AS SELECT 1 AS k, 1 AS v');
    expect(() => apply(db)).not.toThrow();
    const stillLegacy = String(db.selectValue(`SELECT sql FROM sqlite_master WHERE name = 'entries_fts'`)).includes("content='entries'");
    expect(stillLegacy, '前提: 落とせなかった旧い形のまま(この前提が崩れたら test の塞ぎ方を直す)').toBe(true);
    expect(
      db.selectValue(`SELECT v FROM settings WHERE scope = '__fts__' AND k = 'form'`) ?? null,
      '移行に失敗したのに版を刻んだ(二度と移行されない)',
    ).toBeNull();
    db.close();
  });
});

describe('⑤ 1 塊は本文の字数でも切る', () => {
  it('🔴 申告の字数が大きい行が続くと、1 塊は 1 行ずつ進む', () => {
    const db = legacyDb(5);
    // 本文の字数の申告(1 行 300 万字)。⚠ 派生列を全部埋めて、起動の埋め戻しに数え直させない
    db.exec("UPDATE entries SET body_chars = 3000000, task_total = 0, body_tags = ''");
    apply(db);
    // 注: applySchema の埋め戻しは NULL の行だけ。申告はそのまま残る
    expect(step(db, 100)).toBe(true);
    expect(cursor(db), '字数の上限(400 万字)を越えるのに 2 行目まで入れた').toBe('1');
    expect(step(db, 100)).toBe(true);
    expect(cursor(db)).toBe('2');
    finish(db);
    expect(cursor(db)).toBeNull();
    expect(() => integrity(db)).not.toThrow();
    db.close();
  });

  it('対照群: 字数が小さければ、1 塊に行数ぶん入る', () => {
    const db = legacyDb(5);
    apply(db);
    expect(step(db, 3)).toBe(true);
    expect(cursor(db)).toBe('3');
    db.close();
  });
});

// ── 20 回続けて落ちて諦めたら、システムのメッセージに残す ──────────────────────────
type Req = <O extends StorageRequest['op']>(req: Extract<StorageRequest, { op: O }>) => Promise<ResultMap[O]>;
const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;
async function spawnWorker(): Promise<Req> {
  const mySelf: { onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null } = { onmessage: null };
  (globalThis as unknown as Record<string, unknown>).self = mySelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  vi.resetModules();
  await import('../../src/adapter/platform/storage/storage-worker');
  return ((req: StorageRequest) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (resp) => (resp.ok ? resolve(resp.result as never) : reject(new Error(resp.error))));
      mySelf.onmessage!({ data: { id, req } });
    })) as Req;
}

describe('⑤ 作り直しを諦めたら、システムのメッセージに 1 件残す', () => {
  it('🔴 続けて 20 回落ちる → 「検索の索引を作り直せませんでした」が残り、検索は動き続ける', async () => {
    const first = await spawnWorker();
    await first({ op: 'init', dbName: 'give-up-1', memory: true });
    await first({ op: 'openContainer', cid: 'c1', title: 't' });
    await first({
      op: 'upsertEntry',
      cid: 'c1',
      entry: { lid: 'a', title: '題', archetype: 'text', body: '壊れても動く本文', entryOrder: 1, status: null, date: null, archived: false },
      checkpoint: false,
    });
    const { image } = await first({ op: 'exportImage' });
    // 索引を空にして印を -1 に戻し、視点を壊す(流すたびに落ちる)
    const raw = new api.oo1.DB(':memory:', 'c');
    const p = (api.wasm.allocFromTypedArray as unknown as (a: Uint8Array) => number)(image);
    (api.capi.sqlite3_deserialize as unknown as (...a: unknown[]) => number)(raw.pointer, 'main', p, BigInt(image.byteLength), BigInt(image.byteLength), 1 | 2);
    raw.exec(`INSERT INTO entries_fts(entries_fts) VALUES ('delete-all')`);
    raw.exec(`INSERT INTO settings(scope, k, v) VALUES ('__fts__', 'built_upto', '-1') ON CONFLICT(scope, k) DO UPDATE SET v = '-1'`);
    raw.exec('DROP VIEW entries_fts_src');
    raw.exec('CREATE VIEW entries_fts_src AS SELECT rowid AS rid, title, body, nosuchcolumn FROM entries');
    const broken = (api.capi.sqlite3_js_db_export as unknown as (p: number) => Uint8Array)(raw.pointer);
    raw.close();
    const second = await spawnWorker();
    await second({ op: 'init', dbName: 'give-up-2', memory: true, image: broken });
    let body = '';
    for (let i = 0; i < 400 && !body.includes('検索の索引を作り直せませんでした'); i++) {
      await new Promise((r) => setTimeout(r, 50));
      body = (await second({ op: 'getBody', cid: 'c1', lid: 'sys-messages' })) ?? '';
    }
    expect(body, '諦めたのにメッセージが残っていない').toContain('検索の索引を作り直せませんでした');
    // 検索は(全走査で)動き続ける
    expect((await second({ op: 'searchEntries', cid: 'c1', query: '壊れても動く' })).lids).toEqual(['a']);
  }, 60_000);
});
