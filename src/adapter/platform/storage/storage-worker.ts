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
import { DB_SCHEMA_VERSION, SCHEMA_DDL, REVISIONS_V2_COLUMNS } from './schema';
import type { EntryUpsert } from './schema';
import { contentHash64Hex } from './content-hash';
import {
  JOURNAL_MODES,
  type JournalMode,
  type StorageRequest,
  type StorageResponse,
  type InitResult,
  type RequestFor,
  type ResultMap,
} from './protocol';

let db: Database | null = null;
let initResult: InitResult | null = null;

async function init(dbName: string, journalMode?: JournalMode): Promise<InitResult> {
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
  let actualJournalMode: string;
  try {
    applySchema(opened);
    // journal_mode は allowlist 経由のみ(injection 防止)。読み戻し値を正とする
    // (VFS 非対応なら要求と違う値が返る ── WAL は SAHPool 非対応を実測で確認済み)。
    // 既定 = truncate: 2026-07-30 掃引で delete よりわずかに速く安全性同等。
    // memory は最速だがクラッシュ時の DB 破損リスクがあり既定にしない(p2 log)
    const requested: JournalMode =
      journalMode && JOURNAL_MODES.includes(journalMode) ? journalMode : 'truncate';
    actualJournalMode = String(opened.selectValue(`PRAGMA journal_mode=${requested}`));
  } catch (e) {
    opened.close();
    throw e;
  }

  db = opened;
  const base = { ...meta, vfs, journalMode: actualJournalMode };
  initResult = fallbackReason ? { ...base, fallbackReason } : base;
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
  database.exec('PRAGMA foreign_keys = ON'); // tx 内では効かないので外に置く
  // 🔒 DDL → migration → 刻印を **1 tx に原子化**(review P5a F1)。非原子だと
  // クラッシュ窓で 2 型の恒久破損を作る(実験で実証済み):
  //   (d1) 表はあるが刻印なし(=0)→ 次回 open が migration を飛ばして
  //        最新版と刻印 → 列欠損のまま無音で恒久失敗
  //   (d2) ALTER 半端 + 旧版刻印 → 次回 open が duplicate column で毎回 throw
  database.exec('BEGIN IMMEDIATE');
  try {
    // 新規 DB は最新 DDL がそのまま最新形を作る(既存 DB では no-op)
    for (const ddl of SCHEMA_DDL) database.exec(ddl);
    // v2(P5)migration: 判定は user_version ではなく**列の実在**(冪等)──
    // 上記 (d1)(d2) の半端状態も次回 open で自己修復する(schema.ts の原則)
    const revCols = new Set(
      (
        database.selectObjects(
          `SELECT name FROM pragma_table_info('revisions')`,
        ) as Array<{ name: string }>
      ).map((r) => r.name),
    );
    for (const col of REVISIONS_V2_COLUMNS) {
      if (!revCols.has(col))
        database.exec(`ALTER TABLE revisions ADD COLUMN ${col} TEXT`);
    }
    database.exec(`PRAGMA user_version = ${DB_SCHEMA_VERSION}`);
    database.exec('COMMIT');
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* rollback 失敗は元エラーを優先 */
    }
    throw err;
  }
}

function need(): Database {
  if (!db) throw new Error('storage worker not initialized');
  return db;
}

/**
 * scanAssetRefs 用の限定 unescape(markdown-it の unescapeAll 相当のうち、
 * asset key の字母に効く 2 形だけ): backslash escape(ASCII 記号)と数値実体。
 * 範囲外 code point は空に落とす(照合を広げないだけで安全)。
 */
function unescapeForScan(s: string): string {
  const fromCode = (n: number): string =>
    Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  return s
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/&#(\d{1,7});/g, (_m, d: string) => fromCode(Number(d)))
    .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (_m, h: string) => fromCode(parseInt(h, 16)));
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

const UPSERT_SQL = `INSERT INTO entries
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
    body = excluded.body`;

function bindUpsert(cid: string, e: EntryUpsert): (string | number | null)[] {
  return [
    cid,
    e.lid,
    e.title,
    e.archetype,
    e.entryOrder,
    e.status,
    e.date,
    e.archived ? 1 : 0,
    e.body,
  ];
}

const handlers: Handlers = {
  init: (req) => init(req.dbName, req.journalMode),
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
    need().exec({ sql: UPSERT_SQL, bind: bindUpsert(req.cid, req.entry) });
    return null;
  },
  bulkUpsertEntries: (req) => {
    // 1 tx に束ねる ── journal 増幅対策(計器 1 で実測した ~120 倍の主因が
    // upsert 毎の暗黙 tx であることの検証と対策を兼ねる)
    const database = need();
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const e of req.entries)
        database.exec({ sql: UPSERT_SQL, bind: bindUpsert(req.cid, e) });
      database.exec('COMMIT');
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
    return null;
  },
  deleteEntry: (req) => {
    // entry の削除は relations(両向き)を**同 tx**で掃除する(storage
    // review #8 ── orphan relation を作らない)。revisions は P5 から**消さない**:
    // 削除直前の行から trash snapshot を同 tx で積み、「entries に居ない
    // entry_lid の revisions」= ゴミ箱、が復元経路になる(掃除は purgeTrash)。
    // assets の掃除は body 参照ベースなので asset GC(P4b)
    const database = need();
    database.exec('BEGIN IMMEDIATE');
    try {
      const row = database.selectObjects(
        'SELECT title, archetype, body FROM entries WHERE cid = ? AND lid = ?',
        [req.cid, req.lid],
      )[0] as { title: string; archetype: string; body: string } | undefined;
      if (row) {
        const hash = contentHash64Hex(row.body);
        const last = database.selectObjects(
          `SELECT rev_order, content_hash FROM revisions
            WHERE cid = ? AND entry_lid = ?
            ORDER BY rev_order DESC LIMIT 1`,
          [req.cid, req.lid],
        )[0] as { rev_order: number; content_hash: string | null } | undefined;
        // 直前 revision と同一内容なら積まない(review P5a F3 ── 復元 → 無変更 →
        // 削除の周回で同一 snapshot が積もる縁)。skip 時は既存の最新 revision が
        // そのまま trash 行になる(listTrash は「最新」を返す)
        if (!last || last.content_hash !== hash) {
          database.exec({
            sql: `INSERT INTO revisions
                    (cid, id, entry_lid, created_at, rev_order, snapshot,
                     title, archetype, content_hash)
                  VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)`,
            bind: [
              req.cid,
              `rev-${crypto.randomUUID()}`,
              req.lid,
              (last?.rev_order ?? 0) + 1,
              row.body,
              row.title,
              row.archetype,
              hash,
            ],
          });
        }
      }
      database.exec({
        sql: 'DELETE FROM relations WHERE cid = ? AND (from_lid = ? OR to_lid = ?)',
        bind: [req.cid, req.lid, req.lid],
      });
      database.exec({
        sql: 'DELETE FROM entries WHERE cid = ? AND lid = ?',
        bind: [req.cid, req.lid],
      });
      database.exec('COMMIT');
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
    return null;
  },
  listRelations: (req) =>
    need().selectObjects(
      `SELECT id, from_lid, to_lid, kind, created_at, updated_at
         FROM relations WHERE cid = ? ORDER BY id`,
      [req.cid],
    ) as unknown as ResultMap['listRelations'],
  bulkUpsertRelations: (req) => {
    const database = need();
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const r of req.relations) {
        database.exec({
          sql: `INSERT INTO relations (cid, id, from_lid, to_lid, kind, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                ON CONFLICT(cid, id) DO UPDATE SET
                  from_lid = excluded.from_lid,
                  to_lid = excluded.to_lid,
                  kind = excluded.kind,
                  updated_at = excluded.updated_at`,
          bind: [req.cid, r.id, r.fromLid, r.toLid, r.kind],
        });
      }
      database.exec('COMMIT');
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
    return null;
  },
  bulkAddRevisions: (req) => {
    const database = need();
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const r of req.revisions) {
        database.exec({
          sql: `INSERT INTO revisions
                  (cid, id, entry_lid, created_at, rev_order, snapshot,
                   title, archetype, content_hash)
                VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)
                ON CONFLICT(cid, id) DO NOTHING`,
          bind: [
            req.cid,
            r.id,
            r.entryLid,
            r.revOrder,
            r.snapshot,
            r.title ?? null,
            r.archetype ?? null,
            contentHash64Hex(r.snapshot),
          ],
        });
      }
      database.exec('COMMIT');
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
    return null;
  },
  addRevision: (req) => {
    // P5 の通常経路(COMMIT_EDIT の変更前 body)。同 tx で
    // ① 直前 revision と同一内容なら skip(content_hash ── PKC2 は field を
    //   作って一度も使わなかった。PKC3 は最初から使う)
    // ② rev_order = MAX+1 で挿入(採番も worker ── 競合面を作らない)
    // ③ keepLatest 超過分を古い順に prune(生存 entry への書込時のみ走るので、
    //   削除済み entry の trash snapshot が prune されることは構造的に無い)
    const database = need();
    const hash = contentHash64Hex(req.rev.body);
    database.exec('BEGIN IMMEDIATE');
    try {
      const last = database.selectObjects(
        `SELECT rev_order, content_hash FROM revisions
          WHERE cid = ? AND entry_lid = ?
          ORDER BY rev_order DESC LIMIT 1`,
        [req.cid, req.rev.entryLid],
      )[0] as { rev_order: number; content_hash: string | null } | undefined;
      if (last && last.content_hash === hash) {
        database.exec('COMMIT');
        return { added: false, pruned: 0 };
      }
      const nextOrder = (last?.rev_order ?? 0) + 1;
      database.exec({
        sql: `INSERT INTO revisions
                (cid, id, entry_lid, created_at, rev_order, snapshot,
                 title, archetype, content_hash)
              VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)`,
        bind: [
          req.cid,
          `rev-${crypto.randomUUID()}`,
          req.rev.entryLid,
          nextOrder,
          req.rev.body,
          req.rev.title,
          req.rev.archetype,
          hash,
        ],
      });
      const keep = Math.max(1, req.keepLatest);
      database.exec({
        sql: `DELETE FROM revisions
               WHERE cid = ? AND entry_lid = ? AND rev_order <= ?`,
        bind: [req.cid, req.rev.entryLid, nextOrder - keep],
      });
      const pruned = database.changes();
      database.exec('COMMIT');
      return { added: true, pruned };
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
  },
  listRevisionMetas: (req) =>
    // snapshot 列を読まない ── 一覧は meta だけ、本文は getRevision で 1 行ずつ
    need().selectObjects(
      `SELECT id, entry_lid, rev_order, created_at, title, archetype
         FROM revisions WHERE cid = ? AND entry_lid = ?
        ORDER BY rev_order DESC`,
      [req.cid, req.entryLid],
    ) as unknown as ResultMap['listRevisionMetas'],
  listTrash: (req) =>
    // ゴミ箱 = 「entries に居ない entry_lid の最新 revision」ビュー(P5 設計 §1)。
    // 独立 trash 機構は作らない ── PKC2 の設計を sqlite で自然に表現
    need().selectObjects(
      `SELECT r.id, r.entry_lid, r.rev_order, r.created_at, r.title, r.archetype
         FROM revisions r
         JOIN (SELECT entry_lid, MAX(rev_order) AS mx FROM revisions
                WHERE cid = ?1 GROUP BY entry_lid) m
           ON m.entry_lid = r.entry_lid AND m.mx = r.rev_order
        WHERE r.cid = ?1
          AND NOT EXISTS (SELECT 1 FROM entries e
                           WHERE e.cid = r.cid AND e.lid = r.entry_lid)
        ORDER BY r.created_at DESC, r.entry_lid`,
      [req.cid],
    ) as unknown as ResultMap['listTrash'],
  purgeTrash: (req) => {
    const database = need();
    database.exec({
      sql: `DELETE FROM revisions
             WHERE cid = ?1
               AND entry_lid NOT IN (SELECT lid FROM entries WHERE cid = ?1)`,
      bind: [req.cid],
    });
    return { purged: database.changes() };
  },
  revisionCounts: (req) =>
    // snapshot 列を読まない ── revisions は常駐ゼロ、件数は index scan(§4.1)
    need().selectObjects(
      `SELECT entry_lid, COUNT(*) AS n FROM revisions
        WHERE cid = ? GROUP BY entry_lid`,
      [req.cid],
    ) as unknown as ResultMap['revisionCounts'],
  getRevision: (req) => {
    // 表示要求時に 1 行だけ読む(要求駆動 ── §4.1)
    const rows = need().selectObjects(
      'SELECT snapshot, title, archetype FROM revisions WHERE cid = ? AND id = ?',
      [req.cid, req.id],
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      body: typeof r.snapshot === 'string' ? r.snapshot : '',
      title: typeof r.title === 'string' ? r.title : null,
      archetype: typeof r.archetype === 'string' ? r.archetype : null,
    };
  },
  putAssetMeta: (req) => {
    const m = req.meta;
    need().exec({
      sql: `INSERT INTO assets (cid, key, mime, size, hash)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(cid, key) DO UPDATE SET
              mime = excluded.mime, size = excluded.size, hash = excluded.hash`,
      bind: [req.cid, m.key, m.mime, m.size, m.hash ?? null],
    });
    return null;
  },
  listAssetMetas: (req) =>
    need().selectObjects(
      'SELECT key, mime, size, hash FROM assets WHERE cid = ? ORDER BY key',
      [req.cid],
    ) as unknown as ResultMap['listAssetMetas'],
  deleteAssetMeta: (req) => {
    need().exec({
      sql: 'DELETE FROM assets WHERE cid = ? AND key = ?',
      bind: [req.cid, req.key],
    });
    return null;
  },
  scanAssetRefs: (req) => {
    // asset GC(P4b)の keep-set: 候補 key が**どこかの body に substring として
    // 現れるか**で判定する。frontmatter(attachment.asset_key / app_icon_asset_key /
    // extra 内 JSON)も本文の asset: 参照も、参照は必ず key 文字列そのものを含むので
    // この 1 規則が全参照源を包摂する。誤差は false-keep 側にしか出ない
    // (本文の無関係な散文が key 文字列を偶然含む)── GC で許されるのはその向きだけ。
    // body は行ごとに callback で見て保持しない(全 body の同時 materialize は
    // 500MB 級で OOM ── PKC2 の reconcile 走査の教訓)。
    // ⚠ P5(revisions)着地時: 履歴 snapshot が参照する asset を消さないよう、
    // revisions 表も同じ規則で走査に加えること
    const remaining = new Set(req.candidates);
    const referenced: string[] = [];
    const scanText = (row: unknown): false | void => {
      if (remaining.size === 0) return false; // 全候補確定 ── 以降の行読みごと停止
      const body = typeof row === 'string' ? row : '';
      // ⚠ raw だけでは足りない(review F2 ── false-delete の反例):
      // markdown-it は link destination を unescape してから key を取り出すので、
      // `asset:ast\-key` / `asset:ast&#45;key` は**生きた参照なのに raw に key が
      // 現れない**。backslash escape と数値実体だけ畳んだ第 2 形でも照合する
      // (keep 側に広がるだけで安全)。正規 key の字母 [a-z0-9-] は名前付き
      // 実体では書けない(英数字と '-' の名前付き実体が存在しない)ため 2 形で閉じる
      const norm =
        body.includes('\\') || body.includes('&#') ? unescapeForScan(body) : null;
      for (const key of remaining) {
        if (
          key !== '' &&
          (body.includes(key) || (norm !== null && norm.includes(key)))
        ) {
          referenced.push(key);
          remaining.delete(key); // 反復中の自要素削除は Set 仕様で安全
        }
      }
      if (remaining.size === 0) return false;
    };
    if (remaining.size > 0) {
      need().exec({
        sql: 'SELECT body FROM entries WHERE cid = ?',
        bind: [req.cid],
        rowMode: '$body', // 列値を直接受ける(行 object を作らない)
        callback: scanText,
      });
    }
    if (remaining.size > 0) {
      // P5: revisions(履歴 + ゴミ箱)が参照する asset も keep ── trash から
      // 復元した entry の添付が purge 済み、を防ぐ(P4b worker コメントの義務)
      need().exec({
        sql: 'SELECT snapshot FROM revisions WHERE cid = ?',
        bind: [req.cid],
        rowMode: '$snapshot',
        callback: scanText,
      });
    }
    return { referenced };
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
