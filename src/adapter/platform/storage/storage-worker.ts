/**
 * PKC3 storage worker(設計 doc §4.4)。
 * sqlite(OPFS SAHPool)はこの worker に閉じる。OPFS 不可環境(旧ブラウザ /
 * SAH を他タブが保持)は :memory: に fallback し、**理由を InitResult に載せる**
 * (silent fallback にしない ── review #1)。多重タブの writer リースは P2 残作業。
 *
 * メモリ 2 原則(§4.2): stmt は毎回 finalize(exec/selectObjects/selectValue の
 * 内部完結 API のみを使う)/ 大きな値は保持しない。
 */
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { DB_SCHEMA_VERSION, SCHEMA_DDL } from './schema';
import type {
  StorageRequest,
  StorageResponse,
  InitResult,
  RequestFor,
  ResultMap,
} from './protocol';

let db: Database | null = null;
let initResult: InitResult | null = null;

async function init(dbName: string): Promise<InitResult> {
  // 冪等(review #4): 二重 init で WASM を二重化しない・旧 db を leak しない
  if (initResult) return initResult;

  const sqlite3 = await sqlite3InitModule();
  const meta = {
    libVersion: sqlite3.version.libVersion,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
  };

  // catch の範囲は「OPFS の確保」だけに絞る(review #1)
  let opened: Database;
  let vfs: InitResult['vfs'] = 'opfs-sahpool';
  let fallbackReason: string | undefined;
  try {
    const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: dbName });
    opened = new poolUtil.OpfsSAHPoolDb(`/${dbName}.db`);
  } catch (e) {
    vfs = 'memory';
    fallbackReason = String(e);
    opened = new sqlite3.oo1.DB(':memory:');
  }

  // schema 適用の失敗は fallback ではなく error(review #1b ── open 済み接続は閉じる)
  try {
    applySchema(opened);
  } catch (e) {
    opened.close();
    throw e;
  }

  db = opened;
  initResult = fallbackReason ? { ...meta, vfs, fallbackReason } : { ...meta, vfs };
  return initResult;
}

function applySchema(database: Database): void {
  // schema 進化の seam(review #7): user_version を v1 から刻む。
  // 新しい DB(未来の user_version)は読み書きせず明示 reject ── 単調・明示 reject の
  // 規約(schema-migration-policy)を storage 層でも守る
  const userVersion = Number(database.selectValue('PRAGMA user_version') ?? 0);
  if (userVersion > DB_SCHEMA_VERSION) {
    throw new Error(
      `db user_version ${userVersion} is newer than supported ${DB_SCHEMA_VERSION}`,
    );
  }
  database.exec('PRAGMA foreign_keys = ON');
  for (const ddl of SCHEMA_DDL) database.exec(ddl);
  database.exec(`PRAGMA user_version = ${DB_SCHEMA_VERSION}`);
}

function need(): Database {
  if (!db) throw new Error('storage worker not initialized');
  return db;
}

/**
 * op → handler の typed dispatch(review #6): 返り値型を ResultMap に pin する。
 * ⚠ 現状 init 以外は同期実装で、message 間の interleave は起きない。handler を
 * async 化するときは client 側の直列化とセットで行うこと(review #5、p2 log に pin)。
 */
type Handlers = {
  [Op in StorageRequest['op']]: (
    req: RequestFor<Op>,
  ) => ResultMap[Op] | Promise<ResultMap[Op]>;
};

const handlers: Handlers = {
  init: (req) => init(req.dbName),
  openContainer: (req) => {
    need().exec({
      sql: `INSERT INTO containers (cid, title, created_at, updated_at, schema_version)
            VALUES (?, ?, datetime('now'), datetime('now'), ?)
            ON CONFLICT(cid) DO NOTHING`,
      bind: [req.cid, req.title ?? '', DB_SCHEMA_VERSION],
    });
    return null;
  },
  listEntryMetas: (req) =>
    // body 列を読まない ── boot / 一覧は O(メタ)(設計 doc §4.1)
    need().selectObjects(
      `SELECT lid, title, archetype, created_at, updated_at, entry_order,
              status, date, archived
         FROM entries WHERE cid = ? ORDER BY entry_order`,
      [req.cid],
    ) as unknown as ResultMap['listEntryMetas'],
  getBody: (req) => {
    const rows = need().selectObjects(
      'SELECT body FROM entries WHERE cid = ? AND lid = ?',
      [req.cid, req.lid],
    );
    return rows.length > 0 ? (rows[0]?.body as string) : null;
  },
  upsertEntry: (req) => {
    const e = req.entry;
    need().exec({
      sql: `INSERT INTO entries
              (cid, lid, title, archetype, created_at, updated_at,
               entry_order, status, date, archived, body)
            VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?, ?)
            ON CONFLICT(cid, lid) DO UPDATE SET
              title = excluded.title,
              archetype = excluded.archetype,
              updated_at = excluded.updated_at,
              entry_order = excluded.entry_order,
              status = excluded.status,
              date = excluded.date,
              archived = excluded.archived,
              body = excluded.body`,
      bind: [
        req.cid,
        e.lid,
        e.title,
        e.archetype,
        e.entryOrder,
        e.status,
        e.date,
        e.archived ? 1 : 0,
        e.body,
      ],
    });
    return null;
  },
  deleteEntry: (req) => {
    // TODO(P3): relations / revisions の orphan 掃除(FK + CASCADE か tx 内多表削除。
    // review #8、p2 log に pin)
    need().exec({
      sql: 'DELETE FROM entries WHERE cid = ? AND lid = ?',
      bind: [req.cid, req.lid],
    });
    return null;
  },
  counts: (req) => {
    const one = (sql: string): number =>
      Number(need().selectObjects(sql, [req.cid])[0]?.n ?? 0);
    return {
      entries: one('SELECT COUNT(*) AS n FROM entries WHERE cid = ?'),
      relations: one('SELECT COUNT(*) AS n FROM relations WHERE cid = ?'),
      revisions: one('SELECT COUNT(*) AS n FROM revisions WHERE cid = ?'),
      assets: one('SELECT COUNT(*) AS n FROM assets WHERE cid = ?'),
    };
  },
  close: () => {
    // ⚠ close は DB 接続を閉じるだけで、SAHPool の SAH は worker 破棄まで残る
    // (review #9)。multi-tab リース実装時はこの前提で設計する
    db?.close();
    db = null;
    initResult = null;
    return null;
  },
};

self.onmessage = (ev: MessageEvent<{ id: number; req: StorageRequest }>) => {
  const { id, req } = ev.data;
  const handler = handlers[req.op] as (r: StorageRequest) => unknown;
  Promise.resolve()
    .then(() => handler(req))
    .then(
      (result) => postMessage({ id, ok: true, result } satisfies StorageResponse),
      (err: unknown) =>
        postMessage({ id, ok: false, error: String(err) } satisfies StorageResponse),
    );
};
