/**
 * 🔴 **端末間の同期(#2000)段 2 ── worker 側の「同期の記録」の読み書きと現在の指紋の測り方**。
 *
 * 置き場は `settings` 表(スキーマは変えない。設計 doc §12.1)。端末の物 = `__sync__`、ワークスペースごとの物 = `__sync__:<cid>`。
 * ⚠ **同期が OFF の間は、ここの書く関数を 1 本も呼ばない**(行を 1 本も作らない)。呼ぶ側(`storage-worker.ts`)が
 *   `syncEnabled` を見る。読むだけの関数(`readSyncRows`)は行を作らない。
 * ⚠ 指紋の測り方は `features/sync/sync-fp.ts` の 1 本(書き出す側・取り込む側・ここで同じ値になる)。
 */
import type { Database } from '@sqlite.org/sqlite-wasm';
import {
  decodeBaseline,
  decodeTombstone,
  deviceIdFromBytes,
  encodeBaseline,
  encodeTombstone,
  isDeviceId,
  parseSeq,
  pruneTombstones,
  SYNC_KEY_BASE_PREFIX,
  SYNC_KEY_DEVICE,
  SYNC_KEY_PAIR_PREFIX,
  SYNC_KEY_SEQ,
  SYNC_KEY_TOMB_PREFIX,
  SYNC_SCOPE,
  syncScope,
  TOMBSTONE_MAX,
} from '@features/sync/sync-state';
import { relationKey, type Baseline, type KeyedState, type Tombstone } from '@features/sync/change-set';
import { entryFp, relationFp } from '@features/sync/sync-fp';
import type { DiffRelation } from '@features/sync/diff-file';
import { USER_REALM_SQL } from './schema';

/** 書き出した差分の控え(`out:<連番>` = 指紋の一覧の要約)。自分の履歴の突き合わせ(端末 id の重複の見分け)に使う。 */
export const SYNC_KEY_OUT_PREFIX = 'out:';
/** 相手ごとの前回の合意を書いた時刻(`baseat:<相手の端末 id>`)。古さの判定にだけ使う。 */
export const SYNC_KEY_BASEAT_PREFIX = 'baseat:';
const OUT_KEEP = 8;

export function getSetting(db: Database, scope: string, k: string): string | null {
  const v = db.selectValue('SELECT v FROM settings WHERE scope = ? AND k = ?', [scope, k]);
  return typeof v === 'string' ? v : null;
}

export function putSetting(db: Database, scope: string, k: string, v: string): void {
  db.exec({ sql: 'INSERT INTO settings(scope, k, v) VALUES (?, ?, ?) ON CONFLICT(scope, k) DO UPDATE SET v = excluded.v', bind: [scope, k, v] });
}

export function deleteSetting(db: Database, scope: string, k: string): void {
  db.exec({ sql: 'DELETE FROM settings WHERE scope = ? AND k = ?', bind: [scope, k] });
}

/** 行の読み書きの記録(取り消しのため、触る前の値を 1 度だけ控える)。 */
export type RowRecorder = (scope: string, k: string) => void;

/** 端末 id が無ければ作る(同期が入のときだけ呼ぶ)。 */
export function ensureDevice(db: Database, rec?: RowRecorder): string {
  const cur = getSetting(db, SYNC_SCOPE, SYNC_KEY_DEVICE);
  if (isDeviceId(cur)) return cur;
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const id = deviceIdFromBytes(bytes);
  rec?.(SYNC_SCOPE, SYNC_KEY_DEVICE);
  putSetting(db, SYNC_SCOPE, SYNC_KEY_DEVICE, id);
  if (getSetting(db, SYNC_SCOPE, SYNC_KEY_SEQ) === null) {
    rec?.(SYNC_SCOPE, SYNC_KEY_SEQ);
    putSetting(db, SYNC_SCOPE, SYNC_KEY_SEQ, '0');
  }
  return id;
}

export function readSeq(db: Database): number {
  return parseSeq(getSetting(db, SYNC_SCOPE, SYNC_KEY_SEQ));
}

export function writeSeq(db: Database, n: number, rec?: RowRecorder): void {
  rec?.(SYNC_SCOPE, SYNC_KEY_SEQ);
  putSetting(db, SYNC_SCOPE, SYNC_KEY_SEQ, String(n));
}

function rowsOf(db: Database, scope: string, prefix: string): Array<{ k: string; v: string | null }> {
  return db.selectObjects('SELECT k, v FROM settings WHERE scope = ? AND substr(k, 1, ?) = ?', [scope, prefix.length, prefix]) as Array<{ k: string; v: string | null }>;
}

export function readTombstones(db: Database, cid: string): Tombstone[] {
  const out: Tombstone[] = [];
  for (const r of rowsOf(db, syncScope(cid), SYNC_KEY_TOMB_PREFIX)) {
    const t = decodeTombstone(r.k.slice(SYNC_KEY_TOMB_PREFIX.length), r.v);
    if (t) out.push(t);
  }
  return out;
}

/** 削除の記録を 1 本書く。期限・件数の整理もここ(書くときだけ。ゴミ箱を空にしても呼ばない)。 */
export function writeTombstone(db: Database, cid: string, t: Tombstone, rec?: RowRecorder): void {
  const scope = syncScope(cid);
  rec?.(scope, SYNC_KEY_TOMB_PREFIX + t.key);
  putSetting(db, scope, SYNC_KEY_TOMB_PREFIX + t.key, encodeTombstone(t));
  const all = readTombstones(db, cid);
  if (all.length > TOMBSTONE_MAX) {
    const kept = new Set(pruneTombstones(all, Date.now()).map((x) => x.key));
    for (const x of all) {
      if (kept.has(x.key)) continue;
      rec?.(scope, SYNC_KEY_TOMB_PREFIX + x.key);
      deleteSetting(db, scope, SYNC_KEY_TOMB_PREFIX + x.key);
    }
  }
}

export function readPairs(db: Database, cid: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rowsOf(db, syncScope(cid), SYNC_KEY_PAIR_PREFIX)) if (r.v) out[r.k.slice(SYNC_KEY_PAIR_PREFIX.length)] = r.v;
  return out;
}

export function readBases(db: Database, cid: string): Record<string, { baseline: Baseline; at: string | null }> {
  const scope = syncScope(cid);
  const out: Record<string, { baseline: Baseline; at: string | null }> = {};
  for (const r of rowsOf(db, scope, SYNC_KEY_BASE_PREFIX)) {
    const peer = r.k.slice(SYNC_KEY_BASE_PREFIX.length);
    out[peer] = { baseline: decodeBaseline(r.v), at: getSetting(db, scope, SYNC_KEY_BASEAT_PREFIX + peer) };
  }
  return out;
}

export function writeBase(db: Database, cid: string, peer: string, base: Baseline, nowIso: string, rec?: RowRecorder): void {
  const scope = syncScope(cid);
  rec?.(scope, SYNC_KEY_BASE_PREFIX + peer);
  rec?.(scope, SYNC_KEY_BASEAT_PREFIX + peer);
  putSetting(db, scope, SYNC_KEY_BASE_PREFIX + peer, encodeBaseline(base));
  putSetting(db, scope, SYNC_KEY_BASEAT_PREFIX + peer, nowIso);
}

export function readOuts(db: Database, cid: string): Record<number, string> {
  const out: Record<number, string> = {};
  for (const r of rowsOf(db, syncScope(cid), SYNC_KEY_OUT_PREFIX)) if (r.v) out[parseSeq(r.k.slice(SYNC_KEY_OUT_PREFIX.length))] = r.v;
  return out;
}

export function writeOut(db: Database, cid: string, seq: number, digest: string): void {
  const scope = syncScope(cid);
  putSetting(db, scope, SYNC_KEY_OUT_PREFIX + String(seq), digest);
  const rows = rowsOf(db, scope, SYNC_KEY_OUT_PREFIX)
    .map((r) => ({ k: r.k, n: parseSeq(r.k.slice(SYNC_KEY_OUT_PREFIX.length)) }))
    .sort((a, b) => b.n - a.n);
  for (const r of rows.slice(OUT_KEEP)) deleteSetting(db, scope, r.k);
}

/** 端末 id の作り直し: この端末の同期の記録(ワークスペースごとの相手・合意・控え)を全ワークスペースぶん捨てる。削除の記録は残す。 */
export function discardPeerRecords(db: Database, rec?: RowRecorder): void {
  const rows = db.selectObjects(
    "SELECT scope, k FROM settings WHERE substr(scope, 1, ?) = ? AND (substr(k, 1, 5) = 'base:' OR substr(k, 1, 5) = 'pair:' OR substr(k, 1, 4) = 'out:' OR substr(k, 1, 7) = 'baseat:')",
    [SYNC_SCOPE.length + 1, `${SYNC_SCOPE}:`],
  ) as Array<{ scope: string; k: string }>;
  for (const r of rows) {
    rec?.(r.scope, r.k);
    deleteSetting(db, r.scope, r.k);
  }
}

export interface LiveNote {
  lid: string;
  title: string;
  archetype: string;
  parentLid: string | null;
}

/** 生きているフォルダが親になる structural の辺から、ノートごとの親(複数あれば lid の最小)。 */
function parentMap(db: Database, cid: string, folders: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  const rows = db.selectObjects("SELECT from_lid, to_lid FROM relations WHERE cid = ? AND kind = 'structural' ORDER BY from_lid", [cid]) as Array<{ from_lid: string; to_lid: string }>;
  for (const r of rows) if (folders.has(r.from_lid) && !out.has(r.to_lid)) out.set(r.to_lid, r.from_lid);
  return out;
}

export interface SyncSnapshot {
  states: KeyedState[];
  notes: LiveNote[];
  relations: DiffRelation[];
}

/** 現在の指紋(ノート + 非 structural のつながり)。⚠ 本文は 1 行ずつ読んで捨てる(全件を同時に持たない)。 */
export function measureStates(db: Database, cid: string): SyncSnapshot {
  const metas = db.selectObjects(`SELECT lid, archetype FROM entries WHERE cid = ? AND ${USER_REALM_SQL}`, [cid]) as Array<{ lid: string; archetype: string }>;
  const live = new Set(metas.map((m) => m.lid));
  const folders = new Set(metas.filter((m) => m.archetype === 'folder').map((m) => m.lid));
  const parents = parentMap(db, cid, folders);
  const states: KeyedState[] = [];
  const notes: LiveNote[] = [];
  db.exec({
    sql: `SELECT lid, title, archetype, body FROM entries WHERE cid = ? AND ${USER_REALM_SQL}`,
    bind: [cid],
    rowMode: 'array',
    callback: (r: unknown[]): void => {
      const lid = r[0] as string;
      const parentLid = parents.get(lid) ?? null;
      const fp = entryFp({ title: r[1] as string, archetype: r[2] as string, parentLid, body: r[3] as string });
      states.push({ key: lid, ...fp });
      notes.push({ lid, title: r[1] as string, archetype: r[2] as string, parentLid });
    },
  });
  const relations: DiffRelation[] = [];
  const seen = new Set<string>();
  const rrows = db.selectObjects("SELECT from_lid, to_lid, kind FROM relations WHERE cid = ? AND kind != 'structural' ORDER BY id", [cid]) as Array<{ from_lid: string; to_lid: string; kind: string }>;
  for (const r of rrows) {
    if (!live.has(r.from_lid) || !live.has(r.to_lid)) continue;
    const key = relationKey({ from: r.from_lid, to: r.to_lid, kind: r.kind });
    if (seen.has(key)) continue;
    seen.add(key);
    relations.push({ from: r.from_lid, to: r.to_lid, kind: r.kind });
    states.push({ key, ...relationFp() });
  }
  return { states, notes, relations };
}

/**
 * ノートを消す直前に、削除の記録を書く(`deleteEntry` と取り込みで消すときの両方。同期が入のときだけ呼ばれる)。
 * ⚠ 何も書かれていない作りたてのノート(`untouched`)は、相手に伝える事実が無いので書かない。
 */
export function recordDeletion(db: Database, cid: string, lid: string, untouched: boolean, rec?: RowRecorder): void {
  if (untouched) return;
  const row = db.selectObjects(`SELECT title, archetype, body FROM entries WHERE cid = ? AND lid = ? AND ${USER_REALM_SQL}`, [cid, lid])[0] as { title: string; archetype: string; body: string } | undefined;
  if (!row) return;
  const folders = new Set(
    (db.selectObjects(`SELECT lid FROM entries WHERE cid = ? AND archetype = 'folder' AND ${USER_REALM_SQL}`, [cid]) as Array<{ lid: string }>).map((x) => x.lid),
  );
  const parentLid = parentMap(db, cid, folders).get(lid) ?? null;
  const device = ensureDevice(db, rec);
  const seq = readSeq(db) + 1;
  writeSeq(db, seq, rec);
  writeTombstone(db, cid, { key: lid, lastFp: entryFp({ title: row.title, archetype: row.archetype, parentLid, body: row.body }), device, seq, deletedAt: new Date().toISOString() }, rec);
}
