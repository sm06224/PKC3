/**
 * PKC3 storage worker(設計 doc §4.4)。
 * sqlite(OPFS SAHPool)はこの worker に閉じる。OPFS 不可環境は :memory: に
 * fallback する(その場合の永続化戦略は IDB-VFS を P2 後半で判定 ── p2 log 参照)。
 *
 * メモリ 2 原則(§4.2): stmt は毎回 finalize(exec/selectObjects の内部で完結する
 * API のみを使う)/ 大きな値は保持しない。
 */
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { DB_SCHEMA_VERSION, SCHEMA_DDL } from './schema';
import type {
  StorageRequest,
  StorageResponse,
  InitResult,
} from './protocol';

let db: Database | null = null;

async function init(dbName: string): Promise<InitResult> {
  const sqlite3 = await sqlite3InitModule();
  const meta: Omit<InitResult, 'vfs'> = {
    libVersion: sqlite3.version.libVersion,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
  };
  try {
    const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: dbName });
    db = new poolUtil.OpfsSAHPoolDb(`/${dbName}.db`);
    applySchema(db);
    return { ...meta, vfs: 'opfs-sahpool' };
  } catch {
    // OPFS 不可(旧ブラウザ / 特殊環境)。test でもこの経路を使う
    db = new sqlite3.oo1.DB(':memory:');
    applySchema(db);
    return { ...meta, vfs: 'memory' };
  }
}

function applySchema(database: Database): void {
  database.exec('PRAGMA foreign_keys = ON');
  for (const ddl of SCHEMA_DDL) database.exec(ddl);
}

function need(): Database {
  if (!db) throw new Error('storage worker not initialized');
  return db;
}

function handle(req: StorageRequest): Promise<unknown> | unknown {
  switch (req.op) {
    case 'init':
      return init(req.dbName);
    case 'openContainer': {
      need().exec({
        sql: `INSERT INTO containers (cid, title, created_at, updated_at, schema_version)
              VALUES (?, ?, datetime('now'), datetime('now'), ?)
              ON CONFLICT(cid) DO NOTHING`,
        bind: [req.cid, req.title ?? '', DB_SCHEMA_VERSION],
      });
      return null;
    }
    case 'listEntryMetas':
      // body 列を読まない ── boot / 一覧は O(メタ)(設計 doc §4.1)
      return need().selectObjects(
        `SELECT lid, title, archetype, created_at, updated_at, entry_order,
                status, date, archived
           FROM entries WHERE cid = ? ORDER BY entry_order`,
        [req.cid],
      );
    case 'getBody': {
      const rows = need().selectObjects(
        'SELECT body FROM entries WHERE cid = ? AND lid = ?',
        [req.cid, req.lid],
      );
      return rows.length > 0 ? (rows[0]?.body as string) : null;
    }
    case 'upsertEntry': {
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
          e.status ?? null,
          e.date ?? null,
          e.archived ? 1 : 0,
          e.body,
        ],
      });
      return null;
    }
    case 'deleteEntry':
      need().exec({
        sql: 'DELETE FROM entries WHERE cid = ? AND lid = ?',
        bind: [req.cid, req.lid],
      });
      return null;
    case 'counts': {
      const one = (sql: string): number =>
        Number(need().selectObjects(sql, [req.cid])[0]?.n ?? 0);
      return {
        entries: one('SELECT COUNT(*) AS n FROM entries WHERE cid = ?'),
        relations: one('SELECT COUNT(*) AS n FROM relations WHERE cid = ?'),
        revisions: one('SELECT COUNT(*) AS n FROM revisions WHERE cid = ?'),
        assets: one('SELECT COUNT(*) AS n FROM assets WHERE cid = ?'),
      };
    }
    case 'close':
      db?.close();
      db = null;
      return null;
  }
}

self.onmessage = (ev: MessageEvent<{ id: number; req: StorageRequest }>) => {
  const { id, req } = ev.data;
  Promise.resolve()
    .then(() => handle(req))
    .then(
      (result) => postMessage({ id, ok: true, result } satisfies StorageResponse),
      (err: unknown) =>
        postMessage({ id, ok: false, error: String(err) } satisfies StorageResponse),
    );
};
