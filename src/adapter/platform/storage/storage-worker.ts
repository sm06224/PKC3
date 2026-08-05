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
import { DB_SCHEMA_VERSION, SCHEMA_DDL, REVISION_ADDED_COLUMNS } from './schema';
import type { EntryUpsert } from './schema';
import { contentHash64Hex } from './content-hash';
import { scanAssetRefsInto } from '@features/asset/asset-ref-scan';
import {
  applyLinePatch,
  diffLines,
  parseLinePatch,
  serializeLinePatch,
} from '@features/revision/line-patch';
import {
  JOURNAL_MODES,
  type JournalMode,
  type StorageRequest,
  type StorageResponse,
  type InitResult,
  type RequestFor,
  type ResultMap,
  type ImportRevisionsResult,
  type EncodedChainInput,
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
    for (const col of REVISION_ADDED_COLUMNS) {
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

// ── revision チェーン(P5c: jujutsu の「作業コピーはコミット」を写した形)──
//
// entries.body が **tip**(最新状態の全文。複製を持たない)。revisions は
// 「1 つ新しい状態から遡る逆向きパッチ」だけを持つ:
//   rev#k は rev#(k+1) の状態から遡り、鎖の頭は tip から遡る
// 依存が「古い → 新しい」の一方向なので、prune(古い側の削除)が鎖を壊さない。
//
// 書込は 2 モード:
//   checkpoint = 履歴を 1 件伸ばす(COMMIT_EDIT の変更あり)
//   amend      = 伸ばさず、鎖の頭を新しい tip からの符号化に張り替える
//                (todo toggle / rename ── 過去の状態そのものは不変)
// **維持は upsertEntry / deleteEntry の同 tx 内に閉じる**(旧 body は worker が
// 自分で読む ── app 層の協力に依存しない = 構造的に破れない)。

/** 保持上限の既定(caller 未指定時)。差分保持なので PKC2 より大きく取れる。 */
const DEFAULT_REVISION_KEEP = 100;

interface RevRow {
  id: string;
  rev_order: number;
  snapshot: string;
  content_hash: string | null;
  kind: string | null;
}

/** 鎖の頭(= 最も新しい revision 行)。 */
function headRevision(database: Database, cid: string, lid: string): RevRow | null {
  const rows = database.selectObjects(
    `SELECT id, rev_order, snapshot, content_hash, kind FROM revisions
      WHERE cid = ? AND entry_lid = ? ORDER BY rev_order DESC LIMIT 1`,
    [cid, lid],
  ) as unknown as RevRow[];
  return rows[0] ?? null;
}

/** kind NULL は 'full' 扱い(v2 までの既存行はすべて全文)。 */
const isFull = (row: RevRow): boolean => (row.kind ?? 'full') === 'full';

/** row が復元する状態を得る(base = row の 1 つ新しい状態 = tip か次行の状態)。 */
function materialize(row: RevRow, base: string): string {
  return isFull(row) ? row.snapshot : applyLinePatch(base, parseLinePatch(row.snapshot));
}

/**
 * 「base から target へ遡る」保存形を決める。パッチが全文以上に膨らむなら
 * 全文で持つ(git と同じ判断 ── 差分にする意味が無いときは素直に全文)。
 */
function encodeReverse(base: string, target: string): { kind: string; snapshot: string } {
  const patch = serializeLinePatch(diffLines(base, target));
  return patch.length < target.length
    ? { kind: 'patch', snapshot: patch }
    : { kind: 'full', snapshot: target };
}

/**
 * body 変更に伴う鎖の維持(同 tx で呼ぶこと)。
 * @returns 積んだかどうか(checkpoint で新しい行を作ったら true)
 */
function maintainChain(
  database: Database,
  cid: string,
  lid: string,
  oldBody: string,
  newBody: string,
  oldTitle: string,
  oldArchetype: string,
  checkpoint: boolean,
  keepLatest: number,
): { added: boolean; pruned: number } {
  const head = headRevision(database, cid, lid);
  const oldHash = contentHash64Hex(oldBody);
  // checkpoint かつ「頭が既に oldBody を記録していない」ときだけ 1 件伸ばす。
  // このとき既存の頭は **oldBody を基準に符号化済み**(直前まで tip だった)なので
  // 触らなくてよい ── 鎖はそのまま自然に伸びる
  if (checkpoint && !(head && head.content_hash === oldHash)) {
    const enc = encodeReverse(newBody, oldBody);
    const nextOrder = (head?.rev_order ?? 0) + 1;
    database.exec({
      sql: `INSERT INTO revisions
              (cid, id, entry_lid, created_at, rev_order, snapshot,
               title, archetype, content_hash, kind)
            VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)`,
      bind: [
        cid,
        `rev-${crypto.randomUUID()}`,
        lid,
        nextOrder,
        enc.snapshot,
        oldTitle,
        oldArchetype,
        oldHash,
        enc.kind,
      ],
    });
    database.exec({
      sql: `DELETE FROM revisions WHERE cid = ? AND entry_lid = ? AND rev_order <= ?`,
      bind: [cid, lid, nextOrder - Math.max(1, keepLatest)],
    });
    return { added: true, pruned: database.changes() };
  }
  // amend: 頭が復元する状態は変えず、**新しい tip からの符号化**へ張り替える。
  // 行の id / content_hash は保つ(change ID の安定 ── UI の「この版」が生き続ける)
  if (head) {
    const state = materialize(head, oldBody);
    const enc = encodeReverse(newBody, state);
    database.exec({
      sql: `UPDATE revisions SET snapshot = ?, kind = ? WHERE cid = ? AND id = ?`,
      bind: [enc.snapshot, enc.kind, cid, head.id],
    });
  }
  return { added: false, pruned: 0 };
}

/**
 * 鎖 1 本を書く(P5c の符号化)。⚠ **書込経路はここ 1 本だけ**にする ──
 * 取込(`importRevisionChains`)も復元(`restoreRevisionChains`)もここを通る。
 * PKC2 の教訓: 移行専用の書込経路こそが穴の空いていた場所である。
 *
 * 行 k は「その版の状態」を復元し、tip(entries.body)から rev_order 降順に
 * 遡って materialize される:
 *   行 m: encodeReverse(tip,   S_m)
 *   行 k: encodeReverse(S_k+1, S_k)
 * **全文で積む経路は持たない**(持つと PKC2 と同じ「履歴が本文の N 倍」に戻る)。
 *
 * @param snapshots **古い → 新しい**順の全文
 */
function writeChain(
  database: Database,
  cid: string,
  entryLid: string,
  snapshots: ReadonlyArray<{
    body: string;
    createdAt: string;
    /** その版の題名(復元時のみ持つ)。無ければ entry の値。 */
    title?: string | null;
    archetype?: string | null;
  }>,
  keepLatest: number,
  out: ImportRevisionsResult,
): void {
  const row = database.selectObjects(
    'SELECT body, title, archetype FROM entries WHERE cid = ? AND lid = ?',
    [cid, entryLid],
  )[0] as { body: string; title: string; archetype: string } | undefined;
  // entry が居ない / 既に鎖を持つ ものには積まない ── 既存の鎖に割り込むと
  // 符号化の前提(隣接する版の差分)が崩れる
  if (!row || headRevision(database, cid, entryLid)) {
    out.skippedEntries.push(entryLid);
    return;
  }
  // 無変更の版を畳む(PKC2 は本文が変わらなくても snapshot を作りうる)。
  // 「変更あり commit だけ刻む」= P5b で確立した規律
  const states: Array<{
    body: string;
    createdAt: string;
    title?: string | null;
    archetype?: string | null;
  }> = [];
  for (const s of snapshots) {
    if (states.length > 0 && states[states.length - 1]!.body === s.body) {
      out.skippedNoChange++;
      continue;
    }
    states.push(s);
  }
  // 最新の版が tip と同じなら、その版は履歴として持つ意味がない
  while (states.length > 0 && states[states.length - 1]!.body === row.body) {
    states.pop();
    out.skippedNoChange++;
  }
  // 保持上限(古い側から捨てる ── 直近を残すのが既定)
  if (states.length > keepLatest) {
    out.droppedOverLimit += states.length - keepLatest;
    states.splice(0, states.length - keepLatest);
  }

  // 新しい側から符号化する(基準は 1 つ新しい版、先頭は tip)
  let base = row.body;
  for (let k = states.length - 1; k >= 0; k--) {
    const st = states[k]!;
    const enc = encodeReverse(base, st.body);
    database.exec({
      sql: `INSERT INTO revisions
              (cid, id, entry_lid, created_at, rev_order, snapshot,
               title, archetype, content_hash, kind)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        cid,
        `rev-${crypto.randomUUID()}`,
        entryLid,
        // 履歴の時刻は捏造しない ── PKC2 の created_at をそのまま持ち込む
        st.createdAt || new Date().toISOString(),
        k + 1,
        enc.snapshot,
        // PKC2 の Revision は title / archetype を持たない ── entry の値を使う。
        // 復元(P6e)は版ごとの値を持っているので、あればそちらを立てる
        st.title ?? row.title,
        st.archetype ?? row.archetype,
        contentHash64Hex(st.body),
        enc.kind,
      ],
    });
    out.added++;
    base = st.body;
  }
}

/**
 * 鎖 1 本を**保存形から**復元する(P6e)。
 *
 * ⚠ **decode と encode を 1 パスに融合する**。全版を全文にして配列へ溜めてから
 * 書き直すと、`getRevision` がわざわざ避けている「全面書換 100 世代で 14MB を
 * 一度に持つ」形を復元が構造的にやることになる(review M-3)。
 * decode の向き(新 → 古)と encode の向き(新 → 古)は**同じ**なので、
 * 同時に生きるのは「1 つ新しい状態」と「いまの状態」の 2 本で済む。
 *
 * 積む行は**パッチ(小さい)**なので、`rev_order` を後から振るために貯めても
 * 全文を持つことにはならない。
 */
function restoreOneChain(
  database: Database,
  cid: string,
  chain: EncodedChainInput,
  keepLatest: number,
  out: ImportRevisionsResult,
): void {
  const head = database.selectObjects(
    'SELECT body, title, archetype FROM entries WHERE cid = ? AND lid = ?',
    [cid, chain.entryLid],
  )[0] as { body: string; title: string; archetype: string } | undefined;
  // entry が居ない / 既に鎖を持つ ものには積まない(writeChain と同じ規約)
  if (!head || headRevision(database, cid, chain.entryLid)) {
    out.skippedEntries.push(chain.entryLid);
    return;
  }

  /** 新しい → 古い の順に積む(rev_order は件数が決まってから振る)。 */
  const staged: Array<{
    kind: string;
    snapshot: string;
    createdAt: string;
    title: string | null;
    archetype: string | null;
    hash: string;
  }> = [];
  let base = head.body; // 符号化の基準 = 1 つ新しい状態(先頭は tip)
  let prev = head.body; // 無変更の畳み込み用

  let prevOrder = Number.POSITIVE_INFINITY;
  for (const r of chain.rows) {
    // 🔴 **向きの契約を検査する**(protocol: rows は新しい → 古い)。
    // ⚠ hash では捕まえられない ── 順序が逆でも各版は個別には正しく復元でき、
    // hash も一致する。壊れるのは**並び**で、`rev_order` を位置から振っている
    // ここが黙って履歴を逆順に書く(review M-4 の MUT5 と同根)
    if (!(r.revOrder < prevOrder)) {
      throw new Error(
        `履歴の並びが新しい → 古いになっていません(版 ${r.revOrder} が ${prevOrder} の後ろ)`,
      );
    }
    prevOrder = r.revOrder;
    // ⚠ 未知の保存形は**断る**(JSON parse の生エラーを user に見せない)
    if (r.kind !== 'full' && r.kind !== 'patch') {
      throw new Error(`未対応の履歴の保存形です: ${r.kind}`);
    }
    const state = materialize(
      { id: '', rev_order: r.revOrder, snapshot: r.snapshot, content_hash: null, kind: r.kind },
      base,
    );
    // 🔴 **噛み合わせ検査**(review H-1)。`applyLinePatch` は行数さえ合えば通るので、
    // tip がズレた鎖・改竄されたパッチが**例外にならずに**通ってしまう。しかも
    // 書込側は decode 結果から hash を計算し直すので、以後 `getRevision` の
    // 整合性検査も通る = 誤りが自己証明されて固定される
    const hash = contentHash64Hex(state);
    if (r.contentHash !== null && hash !== r.contentHash) {
      throw new Error(
        `履歴が噛み合いません(版 ${r.revOrder})── アーカイブが壊れているか、本文が書き出し時と違います`,
      );
    }
    // 「変更あり commit だけ刻む」= P5b の規律(取込経路と同じ)
    if (state === prev) {
      out.skippedNoChange++;
      base = state;
      continue;
    }
    if (staged.length >= keepLatest) {
      // 保持上限。古い側から捨てる = 新しい側から数えて上限に達したら以降は不要
      out.droppedOverLimit++;
      base = state;
      prev = state;
      continue;
    }
    const enc = encodeReverse(base, state);
    staged.push({
      kind: enc.kind,
      snapshot: enc.snapshot,
      createdAt: r.createdAt ?? '',
      title: r.title,
      archetype: r.archetype,
      hash,
    });
    base = state;
    prev = state;
  }

  // rev_order は**古い = 1**。staged は新しい → 古い なので逆から振る
  for (let i = 0; i < staged.length; i++) {
    const st = staged[i]!;
    database.exec({
      sql: `INSERT INTO revisions
              (cid, id, entry_lid, created_at, rev_order, snapshot,
               title, archetype, content_hash, kind)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        cid,
        `rev-${crypto.randomUUID()}`,
        chain.entryLid,
        // 履歴の時刻は捏造しない
        st.createdAt || new Date().toISOString(),
        staged.length - i,
        st.snapshot,
        // 版ごとの題名を持っているならそちらを立てる(復元だけが持つ情報)
        st.title ?? head.title,
        st.archetype ?? head.archetype,
        st.hash,
        st.kind,
      ],
    });
    out.added++;
  }
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
  getBodies: (req) => {
    // ⚠ postMessage を 1 回にするのが目的 ── SQL は 1 件ずつでよい
    // (worker の中の N 回は往復ではない)。無い lid は結果に出さない
    const database = need();
    const out: Array<{ lid: string; body: string }> = [];
    for (const lid of req.lids) {
      const rows = database.selectObjects(
        'SELECT body FROM entries WHERE cid = ? AND lid = ?',
        [req.cid, lid],
      );
      if (rows.length > 0) out.push({ lid, body: rows[0]?.body as string });
    }
    return out;
  },
  listBodies: (req) => {
    // 🔴 **カーソルは ORDER BY と同じ複合キー**。`entry_order > ?` だけだと
    // 境界の順序値を共有する行が全部飛ぶ(entry_order に UNIQUE は無い)。
    // ⚠ lid だけ持ち回って worker 側で順序値を引き直す形も駄目 ── その行が
    // 消えていると位置が解決できず、先頭から読み直して**重複する**
    const database = need();
    const a = req.after;
    const rows = database.selectObjects(
      a === undefined
        ? `SELECT lid, body, entry_order FROM entries WHERE cid = ?
             ORDER BY entry_order, lid`
        : `SELECT lid, body, entry_order FROM entries
             WHERE cid = ? AND (entry_order > ? OR (entry_order = ? AND lid > ?))
             ORDER BY entry_order, lid`,
      a === undefined ? [req.cid] : [req.cid, a.entryOrder, a.entryOrder, a.lid],
    ) as unknown as Array<{ lid: string; body: string; entry_order: number }>;

    // 1 メッセージの合計で切る。⚠ **1 件目は必ず返す** ── maxBytes より大きい
    // body が 1 件あるだけで、そこから先が永遠に進まなくなる(無限ループ)
    const out: Array<{ lid: string; body: string }> = [];
    let total = 0;
    for (const r of rows) {
      const size = r.body.length;
      if (out.length > 0 && total + size > req.maxBytes) {
        const last = rows[out.length - 1]!;
        return {
          rows: out,
          done: false,
          next: { entryOrder: last.entry_order, lid: last.lid },
        };
      }
      out.push({ lid: r.lid, body: r.body });
      total += size;
    }
    return { rows: out, done: true };
  },
  upsertEntry: (req) => {
    // 本文の書込は**すべてここを通る** ── 鎖の維持を同 tx に閉じ込める唯一の場所。
    // checkpoint(履歴を伸ばす)か amend(頭を張り替える)かだけが caller の裁量
    const database = need();
    database.exec('BEGIN IMMEDIATE');
    try {
      const old = database.selectObjects(
        'SELECT title, archetype, body FROM entries WHERE cid = ? AND lid = ?',
        [req.cid, req.entry.lid],
      )[0] as { title: string; archetype: string; body: string } | undefined;
      if (old && old.body !== req.entry.body) {
        // 🔒 **履歴より本文が上位**(review P5c F1 ── データ喪失方向で実証済み):
        // 鎖が既に壊れていると amend の materialize が throw し、tx ごと巻き戻って
        // **本文の保存が失敗する**。しかも toggle 系は永久に通らなくなる。
        // 鎖の維持に失敗しても body の書込は続行する ── 壊れた鎖は読み側の
        // 可視エラー(revision restore failed)で既に扱えている
        try {
          maintainChain(
            database,
            req.cid,
            req.entry.lid,
            old.body,
            req.entry.body,
            old.title,
            old.archetype,
            req.checkpoint === true,
            req.keepLatest ?? DEFAULT_REVISION_KEEP,
          );
        } catch {
          /* 履歴の維持失敗は本文の保存を巻き添えにしない */
        }
      }
      database.exec({ sql: UPSERT_SQL, bind: bindUpsert(req.cid, req.entry) });
      // 🔑 **刻んだ時刻を返す**(P9 段①)。`datetime('now')` を打つのはここだけなので、
      // 返さないと主スレッドは**次の boot まで作成・更新の時刻を知らない**
      // (実際に情報列が終日「—」になっていた)。⚠ 同 tx 内で読む ──
      // COMMIT の後に読むと、別タブの書込が割り込んだ値を返しうる。
      // ⚠ 主スレッド側で時刻を作らない(DB に無い値を画面に出すことになる)
      const stamped = database.selectObjects(
        'SELECT created_at, updated_at FROM entries WHERE cid = ? AND lid = ?',
        [req.cid, req.entry.lid],
      )[0] as { created_at: string | null; updated_at: string | null } | undefined;
      database.exec('COMMIT');
      return { createdAt: stamped?.created_at ?? null, updatedAt: stamped?.updated_at ?? null };
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback 失敗は元エラーを優先 */
      }
      throw err;
    }
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
        // 削除で tip(entries.body)が消えるので、鎖の base を**全文で確定**する。
        // 頭が既に同内容を記録していれば、その行を全文化するだけでよい
        // (行 id / content_hash は保つ ── change ID の安定)
        const hash = contentHash64Hex(row.body);
        const head = headRevision(database, req.cid, req.lid);
        if (head && head.content_hash === hash) {
          database.exec({
            sql: `UPDATE revisions SET snapshot = ?, kind = 'full' WHERE cid = ? AND id = ?`,
            bind: [row.body, req.cid, head.id],
          });
        } else {
          database.exec({
            sql: `INSERT INTO revisions
                    (cid, id, entry_lid, created_at, rev_order, snapshot,
                     title, archetype, content_hash, kind)
                  VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, 'full')`,
            bind: [
              req.cid,
              `rev-${crypto.randomUUID()}`,
              req.lid,
              (head?.rev_order ?? 0) + 1,
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
  importRevisionChains: (req) => {
    // 取込の履歴を **P5c の鎖**として積む(user 裁定 2026-08-01
    // 「revisions の考え方は持ち込む、ただし jujutsu 的に遡及パッチ」)。
    // 符号化は maintainChain と同一 ── 行 k は「その版の状態」を復元し、
    // tip(entries.body)から rev_order 降順に遡って materialize される。
    //   行 m: encodeReverse(tip,   S_m)
    //   行 k: encodeReverse(S_k+1, S_k)
    // **全文で積む経路は持たない**(持つと取込だけが設計から外れ、PKC2 と同じ
    // 「履歴が本文の N 倍」に戻る)。保存形は listRevisionMetas の kind で観測できる
    const database = need();
    const keepLatest = Math.max(1, req.keepLatest ?? DEFAULT_REVISION_KEEP);
    const out: ResultMap['importRevisionChains'] = {
      added: 0,
      skippedNoChange: 0,
      droppedOverLimit: 0,
      skippedEntries: [],
      brokenChains: [],
    };
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const chain of req.chains) {
        writeChain(database, req.cid, chain.entryLid, chain.snapshots, keepLatest, out);
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
    return out;
  },
  /**
   * 保存形の鎖を復元する(P6e)。**decode してから `writeChain` へ流す** ──
   * 移行専用の書込経路を作らないための形(PKC2 の教訓: 移行専用の書込経路こそが
   * 穴の空いていた場所)。codec(`materialize`)もここにしか無いので、
   * 読み側と書き側がずれようがない。
   *
   * ⚠ 保証するのは「**同じ状態列**が戻る」ことで、同じバイト列ではない ──
   * decode → encode を往復するので、刈り込みと無変更版の畳み込みが再適用される
   * (user 裁定 2026-08-02「目的に合っていればそれでいい」)。
   */
  /**
   * 保存形の鎖を復元する(P6e)。**decode してから `writeChain` へ流す** ──
   * 移行専用の書込経路を作らないための形(PKC2 の教訓: 移行専用の書込経路こそが
   * 穴の空いていた場所)。codec(`materialize`)もここにしか無いので、
   * 読み側と書き側がずれようがない。
   *
   * ⚠ 保証するのは「**同じ状態列**が戻る」ことで、同じバイト列ではない ──
   * decode → encode を往復するので、刈り込みと無変更版の畳み込みが再適用される
   * (user 裁定 2026-08-02「目的に合っていればそれでいい」)。
   */
  restoreRevisionChains: (req) => {
    const database = need();
    const keepLatest = Math.max(1, req.keepLatest ?? DEFAULT_REVISION_KEEP);
    const out: ResultMap['restoreRevisionChains'] = {
      added: 0,
      skippedNoChange: 0,
      droppedOverLimit: 0,
      skippedEntries: [],
      brokenChains: [],
    };
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const chain of req.chains) {
        // 🔴 **鎖ごとに救う**(review M-1)。1 本が壊れているだけで全 entry の
        // 履歴が巻き戻ると、user に残るのは「本文はあるが履歴ゼロ」で、
        // 取り直しても同じ場所で落ちる。添付は既に 1 件ずつ救っている
        database.exec('SAVEPOINT chain');
        try {
          restoreOneChain(database, req.cid, chain, keepLatest, out);
          database.exec('RELEASE chain');
        } catch (e) {
          database.exec('ROLLBACK TO chain');
          database.exec('RELEASE chain');
          out.skippedEntries.push(chain.entryLid);
          out.brokenChains.push(
            `${chain.entryLid}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
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
    return out;
  },
  /** 鎖を**保存形のまま**返す(P6e)。⚠ materialize しない。 */
  exportRevisionChain: (req) =>
    (
      need().selectObjects(
        `SELECT rev_order, created_at, title, archetype, kind, snapshot, content_hash
           FROM revisions WHERE cid = ? AND entry_lid = ?
          ORDER BY rev_order DESC`,
        [req.cid, req.entryLid],
      ) as unknown as Array<{
        rev_order: number;
        created_at: string | null;
        title: string | null;
        archetype: string | null;
        kind: string | null;
        snapshot: string;
        content_hash: string | null;
      }>
    ).map((r) => ({
      revOrder: r.rev_order,
      createdAt: r.created_at,
      title: r.title,
      archetype: r.archetype,
      // ⚠ NULL は 'full' 扱い(schema の規約)── **書出しの時点で正規化する**
      kind: r.kind ?? 'full',
      snapshot: r.snapshot,
      contentHash: r.content_hash,
    })),

  listRevisionMetas: (req) =>
    // snapshot 列を読まない ── 一覧は meta だけ、本文は getRevision で 1 行ずつ
    need().selectObjects(
      `SELECT id, entry_lid, rev_order, created_at, title, archetype, kind
         FROM revisions WHERE cid = ? AND entry_lid = ?
        ORDER BY rev_order DESC`,
      [req.cid, req.entryLid],
    ) as unknown as ResultMap['listRevisionMetas'],
  listRevisionLids: (req) =>
    // 取込の lid 衝突判定は **entries だけでは足りない**(review H-1)。
    // ゴミ箱は「entries に居ない entry_lid の revisions」ビューなので、削除済み lid は
    // entryMetas に居ない ── そこへ同じ lid を書くと ① その item がゴミ箱から消え
    // ② 取り込んだ entry の履歴に他人の版が並ぶ(復元で上書き)。両方とも実証済み
    (
      need().selectObjects(
        'SELECT DISTINCT entry_lid FROM revisions WHERE cid = ?',
        [req.cid],
      ) as unknown as Array<{ entry_lid: string }>
    ).map((r) => r.entry_lid),
  listTrash: (req) =>
    // ゴミ箱 = 「entries に居ない entry_lid の最新 revision」ビュー(P5 設計 §1)。
    // 独立 trash 機構は作らない ── PKC2 の設計を sqlite で自然に表現
    need().selectObjects(
      `SELECT r.id, r.entry_lid, r.rev_order, r.created_at, r.title, r.archetype, r.kind
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
    // 要求駆動(§4.1)。鎖を tip 側から目標まで遡って復元する ── 読むのは
    // 「その entry の、目標以降の行」だけ(他 entry も古い側も触らない)
    const database = need();
    const target = database.selectObjects(
      `SELECT entry_lid, rev_order, title, archetype, content_hash
         FROM revisions WHERE cid = ? AND id = ?`,
      [req.cid, req.id],
    )[0] as
      | {
          entry_lid: string;
          rev_order: number;
          title: string | null;
          archetype: string | null;
          content_hash: string | null;
        }
      | undefined;
    if (!target) return null;

    // ① まず **snapshot を読まずに** 骨組みだけ引き、出発点(anchor)を決める。
    // 出発点 = 目標に最も近い全文行(あれば)/ 無ければ tip(entries.body)。
    // ⚠ 先に snapshot 込みで全部読むと、anchor より新しい行の本文まで
    // materialize してしまう(review P5c F5 ── 全面書換 100 世代で 14MB を
    // 1 回の select で読む実測)。生成物を作らない = 即破棄以前の問題
    const skeleton = database.selectObjects(
      `SELECT rev_order, kind FROM revisions
        WHERE cid = ? AND entry_lid = ? AND rev_order >= ?
        ORDER BY rev_order DESC`,
      [req.cid, target.entry_lid, target.rev_order],
    ) as unknown as Array<{ rev_order: number; kind: string | null }>;
    let anchorOrder: number | null = null;
    for (let i = skeleton.length - 1; i >= 0; i--) {
      if ((skeleton[i]!.kind ?? 'full') === 'full') {
        anchorOrder = skeleton[i]!.rev_order;
        break;
      }
    }
    // ② 実際に遡る区間の snapshot だけを読む
    const rows = (
      anchorOrder === null
        ? database.selectObjects(
            `SELECT id, rev_order, snapshot, content_hash, kind FROM revisions
              WHERE cid = ? AND entry_lid = ? AND rev_order >= ?
              ORDER BY rev_order DESC`,
            [req.cid, target.entry_lid, target.rev_order],
          )
        : database.selectObjects(
            `SELECT id, rev_order, snapshot, content_hash, kind FROM revisions
              WHERE cid = ? AND entry_lid = ? AND rev_order BETWEEN ? AND ?
              ORDER BY rev_order DESC`,
            [req.cid, target.entry_lid, target.rev_order, anchorOrder],
          )
    ) as unknown as RevRow[];

    let state: string;
    let from: number;
    if (anchorOrder !== null) {
      state = rows[0]!.snapshot; // 区間の先頭 = anchor(全文行)
      from = 1;
    } else {
      const tip = database.selectObjects(
        'SELECT body FROM entries WHERE cid = ? AND lid = ?',
        [req.cid, target.entry_lid],
      )[0] as { body: string } | undefined;
      if (!tip) {
        // 全文行も tip も無い = 鎖の base が失われている。**嘘の本文を返さない**
        throw new Error(`revision restore failed (no base): ${target.entry_lid}`);
      }
      state = tip.body;
      from = 0;
    }
    try {
      // ⚠ 段ごとに parse → apply する(review M2): 全段を先に parse して
      // 配列に持つと、パッチの ops が**同時生存**して JS ヒープの峰が増える
      // (実測: 100 世代の全面書換で 15.8MB → 28.5MB、+80% の回帰だった)。
      // wasm 経路を配線するときは「全段を 1 往復で渡す」形に戻すが、そのときは
      // 中間の全文文字列が消える見返りがある ── 今は TS が本番経路なので、
      // 峰を上げるだけの前借りはしない
      for (let i = from; i < rows.length; i++) {
        state = materialize(rows[i]!, state);
      }
    } catch (e) {
      // パッチが base に噛み合わない = 鎖が壊れている(bulk 書込で tip を
      // 差し替えた等)。復元不能として可視で終える
      throw new Error(`revision restore failed (chain broken): ${String(e)}`, {
        cause: e,
      });
    }
    // git 的な整合性検証: 復元結果の hash が記録と食い違えば可視エラーで止める
    // (壊れた鎖から「それらしい本文」を返さない ── S3 規律)
    if (target.content_hash && contentHash64Hex(state) !== target.content_hash) {
      throw new Error(`revision restore failed (integrity check): ${req.id}`);
    }
    return { body: state, title: target.title, archetype: target.archetype };
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
      // ⚠ 2 回通す(review P5c F2 ── P5c で入った回帰):revisions.snapshot は
      // patch のとき **JSON テキスト**なので backslash が二重化している
      // (`asset:ast\-k` → snapshot 上は `ast\\-k`)。1 パスでは `\-k` までしか
      // 戻らず、古い版にしか無い escape 済み参照を GC が消してしまう。
      // 2 パスは keep 側にしか広がらないので安全
      // 🔴 判定は **features/asset/asset-ref-scan.ts が正本**(P6f review H-1)──
      // 同じ規則を別々に書くと、片方だけが「生きた参照」を落とす
      if (!scanAssetRefsInto(body, remaining, (k) => referenced.push(k))) return false;
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
  const handler = handlers[req.op] as ((r: StorageRequest) => unknown) | undefined;
  Promise.resolve()
    .then(() => {
      // 🔴 **未知の op を名指しで断る**。無条件に呼ぶと `TypeError: handler is not
      // a function` になるだけで、**どの op が無いのか分からない**(nightly の
      // store probe が P5c で消えた `bulkAddRevisions` を呼び続け、この文言だけを
      // 残して落ちていた)。op の増減は改名で起きるので、名前を出す価値がある
      if (typeof handler !== 'function') {
        throw new Error(`未知の op です: ${String((req as { op?: unknown }).op)}`);
      }
      return handler(req);
    })
    .then(
      (result) => postMessage({ id, ok: true, result } satisfies StorageResponse),
      (err: unknown) =>
        postMessage({ id, ok: false, error: String(err) } satisfies StorageResponse),
    );
};
