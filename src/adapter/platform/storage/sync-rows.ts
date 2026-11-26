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
  parseRelatedMode,
  parseScopeMode,
  pruneTombstones,
  SYNC_KEY_BASE_PREFIX,
  SYNC_KEY_SCOPE_MODE,
  SYNC_KEY_SCOPE_RELATED,
  SYNC_KEY_SEL_END,
  SYNC_KEY_SEL_PREFIX,
  SYNC_RELATED_DEFAULT,
  SYNC_SCOPE_MODE_DEFAULT,
  SYNC_KEY_DEVICE,
  SYNC_KEY_PAIR_PREFIX,
  SYNC_KEY_SEQ,
  SYNC_KEY_TOMB_PREFIX,
  SYNC_SCOPE,
  syncScope,
  TOMBSTONE_MAX,
  type SyncRelatedMode,
  type SyncScopeMode,
} from '@features/sync/sync-state';
import { isReservedSyncLid } from '@features/sync/sync-guard';
import { bodyLinkTargets } from '@features/entry-ref/body-links';
import { placeEntryLids } from '@features/markdown/place-notation';
import { relationKey, type Baseline, type KeyedState, type Tombstone } from '@features/sync/change-set';
import { entryFp, labelFp, pinFp, relationFp } from '@features/sync/sync-fp';
import { labelKey, pinKey } from '@features/sync/sync-attr';
import { isNoteLabelColor } from '@features/note-label';
import type { DiffRelation } from '@features/sync/diff-file';
import { USER_REALM_SQL } from './schema';

/** 書き出した差分の控え(`out:<連番>` = 指紋の一覧の要約)。自分の履歴の突き合わせ(端末 id の重複の見分け)に使う。 */
export const SYNC_KEY_OUT_PREFIX = 'out:';
/** 相手ごとの前回の合意を書いた時刻(`baseat:<相手の端末 id>`)。古さの判定にだけ使う。 */
export const SYNC_KEY_BASEAT_PREFIX = 'baseat:';
const OUT_KEEP = 8;

/** ノートのピン留めを持つ `settings` の scope(器ごと。#1377)。1 ノート 1 行(`k` = lid、`v` = 留めた順の通し番号)。⚠ 正本はここ 1 か所。 */
export function notePinScope(cid: string): string {
  return `note-pin:${cid}`;
}

/** ノートの色ラベルを持つ `settings` の scope(器ごと。#1982 段 4)。1 ノート 1 行(`k` = lid、`v` = 色の番号)。 */
export function noteLabelScope(cid: string): string {
  return `note-label:${cid}`;
}

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
  pruneTombstoneRows(db, cid, rec);
}

/** 件数が上限を超えたときだけ全件を読んで整理する(⚠ 件数は索引(主キーの範囲)で数える。1 件ごとに全件を読まない)。 */
export function pruneTombstoneRows(db: Database, cid: string, rec?: RowRecorder): void {
  const scope = syncScope(cid);
  // 'tomb:' の次の文字(';')までの範囲 = 主キー (scope, k) の索引で数えられる
  const n = Number(db.selectValue('SELECT count(*) FROM settings WHERE scope = ? AND k >= ? AND k < ?', [scope, SYNC_KEY_TOMB_PREFIX, 'tomb;']) ?? 0);
  if (n > TOMBSTONE_MAX) {
    const all = readTombstones(db, cid);
    const kept = new Set(pruneTombstones(all, Date.now()).map((x) => x.key));
    for (const x of all) {
      if (kept.has(x.key)) continue;
      rec?.(scope, SYNC_KEY_TOMB_PREFIX + x.key);
      deleteSetting(db, scope, SYNC_KEY_TOMB_PREFIX + x.key);
    }
  }
}

export function readPairs(db: Database, cid: string): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const r of rowsOf(db, syncScope(cid), SYNC_KEY_PAIR_PREFIX)) if (r.v) out[r.k.slice(SYNC_KEY_PAIR_PREFIX.length)] = r.v;
  return out;
}

export function readBases(db: Database, cid: string): Record<string, { baseline: Baseline; at: string | null }> {
  const scope = syncScope(cid);
  const out = Object.create(null) as Record<string, { baseline: Baseline; at: string | null }>;
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

/** 選択同期の設定(#2066 段 5-A)。行が無ければ既定(`'all'` / `'1hop'` / 指定なし)。⚠ 読むだけ(行を作らない)。 */
export interface SelectiveSetting {
  mode: SyncScopeMode;
  related: SyncRelatedMode;
  /** 直接指定の lid(昇順)。 */
  directLids: string[];
}

export function readSelective(db: Database, cid: string): SelectiveSetting {
  const scope = syncScope(cid);
  // 'sel:' の次の文字(';')までの範囲 = 主キー (scope, k) の索引で読む
  const rows = db.selectObjects('SELECT k FROM settings WHERE scope = ? AND k >= ? AND k < ? ORDER BY k', [scope, SYNC_KEY_SEL_PREFIX, SYNC_KEY_SEL_END]) as Array<{ k: string }>;
  return {
    mode: parseScopeMode(getSetting(db, scope, SYNC_KEY_SCOPE_MODE)),
    related: parseRelatedMode(getSetting(db, scope, SYNC_KEY_SCOPE_RELATED)),
    directLids: rows.map((r) => r.k.slice(SYNC_KEY_SEL_PREFIX.length)).filter((lid) => lid !== ''),
  };
}

/** 選択同期の設定を変える(呼び手が tx を張る)。⚠ 同期が入のときだけ呼ぶ。既定と同じ値の行は消す(既定の端末に行を残さない)。 */
export function writeSelective(
  db: Database,
  cid: string,
  change: { mode?: SyncScopeMode; related?: SyncRelatedMode; add?: readonly string[]; remove?: readonly string[] },
  rec?: RowRecorder,
): void {
  const scope = syncScope(cid);
  const put = (k: string, v: string | null): void => {
    if (getSetting(db, scope, k) === v) return;
    rec?.(scope, k);
    if (v === null) deleteSetting(db, scope, k);
    else putSetting(db, scope, k, v);
  };
  if (change.mode !== undefined) put(SYNC_KEY_SCOPE_MODE, change.mode === SYNC_SCOPE_MODE_DEFAULT ? null : change.mode);
  if (change.related !== undefined) put(SYNC_KEY_SCOPE_RELATED, change.related === SYNC_RELATED_DEFAULT ? null : change.related);
  for (const lid of change.remove ?? []) if (lid !== '') put(SYNC_KEY_SEL_PREFIX + lid, null);
  // 🔴 system 領域のノートは指定にしない(同期で運ばない物)
  for (const lid of change.add ?? []) if (lid !== '' && !isReservedSyncLid(lid)) put(SYNC_KEY_SEL_PREFIX + lid, '1');
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
  /** 生きているノートの色ラベル・ピン留め(段 3)。ゴミ箱のノートの印は運ばない(戻したときに一緒に戻る)。 */
  labels: Array<{ lid: string; color: number }>;
  pins: string[];
  /**
   * 本文の参照(`fromLid → toLids`。生きているノート宛てだけ・自分は除く)。🔴 `withBodyRefs` のときだけ
   * 指紋を測る同じ 1 回の読みで抜き出す(本文を主スレッドへ出さない / 2 度読まない)。それ以外は空。
   */
  bodyRefs: Record<string, string[]>;
}

/** 本文が指すノートの lid(リンク + 板の `entry=`)。選択同期の関連の材料。 */
export function bodyRefTargets(body: string, cid: string): string[] {
  const out = new Set<string>(bodyLinkTargets(body, cid));
  for (const lid of placeEntryLids(body)) out.add(lid);
  return [...out];
}

/**
 * 現在の指紋(ノート + 非 structural のつながり)。⚠ 本文は 1 行ずつ読んで捨てる(全件を同時に持たない)。
 * `opts.withBodyRefs`(選択同期で関連をたどるときだけ): 同じ読みの中で本文の参照も抜き出す。⚠ 全部のノートのとき(既定)は抜き出さない(手間を増やさない)。
 */
export function measureStates(db: Database, cid: string, opts: { withBodyRefs?: boolean } = {}): SyncSnapshot {
  const metas = db.selectObjects(`SELECT lid, archetype FROM entries WHERE cid = ? AND ${USER_REALM_SQL}`, [cid]) as Array<{ lid: string; archetype: string }>;
  const live = new Set(metas.map((m) => m.lid));
  const folders = new Set(metas.filter((m) => m.archetype === 'folder').map((m) => m.lid));
  const parents = parentMap(db, cid, folders);
  const states: KeyedState[] = [];
  const notes: LiveNote[] = [];
  const rawRefs: Array<[string, string[]]> = [];
  const withRefs = opts.withBodyRefs === true;
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
      if (withRefs) {
        const to = bodyRefTargets(r[3] as string, cid);
        if (to.length > 0) rawRefs.push([lid, to]);
      }
    },
  });
  const bodyRefs = Object.create(null) as Record<string, string[]>;
  for (const [from, to] of rawRefs) {
    const kept = to.filter((x) => x !== from && live.has(x));
    if (kept.length > 0) bodyRefs[from] = kept;
  }
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
  // ── 印(色ラベル・ピン留め)。生きているノートの物だけ(`sync-attr.ts`)
  const labels: Array<{ lid: string; color: number }> = [];
  for (const r of db.selectObjects('SELECT k, v FROM settings WHERE scope = ? ORDER BY k', [noteLabelScope(cid)]) as Array<{ k: string; v: string | null }>) {
    const color = Number(r.v);
    if (!live.has(r.k) || !isNoteLabelColor(color)) continue;
    labels.push({ lid: r.k, color });
    states.push({ key: labelKey(r.k), ...labelFp(color) });
  }
  const pins: string[] = [];
  for (const r of db.selectObjects('SELECT k FROM settings WHERE scope = ? ORDER BY k', [notePinScope(cid)]) as Array<{ k: string }>) {
    if (!live.has(r.k)) continue;
    pins.push(r.k);
    states.push({ key: pinKey(r.k), ...pinFp() });
  }
  return { states, notes, relations, labels, pins, bodyRefs };
}

/**
 * 1 つのノートの親フォルダ(生きているフォルダが親の辺。複数なら lid の最小)。⚠ `measureStates` の `parentMap` と同じ選び方
 * (指紋が食い違わないように)── こちらは 1 つのノートだけを索引(`idx_rel_to`)で引くので、全件を読まない。
 */
export function parentOf(db: Database, cid: string, lid: string): string | null {
  const v = db.selectValue(
    `SELECT r.from_lid FROM relations r JOIN entries f ON f.cid = r.cid AND f.lid = r.from_lid
      WHERE r.cid = ? AND r.to_lid = ? AND r.kind = 'structural' AND f.archetype = 'folder' AND f.${USER_REALM_SQL}
      ORDER BY r.from_lid LIMIT 1`,
    [cid, lid],
  );
  return typeof v === 'string' ? v : null;
}

/** 生きているノート 1 件の指紋(無ければ null)。⚠ `measureStates` と同じ関数・同じ親の選び方。tx の中の測り直しに使う。 */
export function measureOne(db: Database, cid: string, lid: string): { content: string; place: string } | null {
  const row = db.selectObjects(`SELECT title, archetype, body FROM entries WHERE cid = ? AND lid = ? AND ${USER_REALM_SQL}`, [cid, lid])[0] as
    | { title: string; archetype: string; body: string }
    | undefined;
  if (!row) return null;
  const fp = entryFp({ title: row.title, archetype: row.archetype, parentLid: parentOf(db, cid, lid), body: row.body });
  return { content: fp.content, place: fp.place as string };
}

/** 相手のノート(本文つき)の指紋。worker で測る(主スレッドで本文の SHA-256 をしない)。 */
export function measureNoteFps(notes: ReadonlyArray<{ lid: string; title: string; archetype: string; parentLid: string | null; body: string }>): Array<{ lid: string; content: string; place: string }> {
  return notes.map((n) => {
    const fp = entryFp({ title: n.title, archetype: n.archetype, parentLid: n.parentLid, body: n.body });
    return { lid: n.lid, content: fp.content, place: fp.place as string };
  });
}

/**
 * ノートを消す直前に、削除の記録をまとめて書く(`deleteEntry` と取り込みで消すときの両方。同期が入のときだけ呼ばれる)。
 * ⚠ 端末 id・連番・削除の記録の整理は **1 回の呼び出しにつき 1 度**(1 件ごとに全件を読まない)。
 * ⚠ 何も書かれていない作りたてのノート(`untouched`)は、相手に伝える事実が無いので呼ぶ側が渡さない。
 */
export function recordDeletions(db: Database, cid: string, lids: readonly string[], rec?: RowRecorder): number {
  const rows: Array<{ lid: string; fp: { content: string; place: string } }> = [];
  for (const lid of lids) {
    const row = db.selectObjects(`SELECT title, archetype, body FROM entries WHERE cid = ? AND lid = ? AND ${USER_REALM_SQL}`, [cid, lid])[0] as
      | { title: string; archetype: string; body: string }
      | undefined;
    if (!row) continue;
    const fp = entryFp({ title: row.title, archetype: row.archetype, parentLid: parentOf(db, cid, lid), body: row.body });
    rows.push({ lid, fp: { content: fp.content, place: fp.place as string } });
  }
  if (rows.length === 0) return 0;
  const device = ensureDevice(db, rec);
  const base = readSeq(db);
  const scope = syncScope(cid);
  const at = new Date().toISOString();
  rows.forEach((x, i) => {
    rec?.(scope, SYNC_KEY_TOMB_PREFIX + x.lid);
    putSetting(db, scope, SYNC_KEY_TOMB_PREFIX + x.lid, encodeTombstone({ key: x.lid, lastFp: x.fp, device, seq: base + i + 1, deletedAt: at }));
  });
  writeSeq(db, base + rows.length, rec);
  pruneTombstoneRows(db, cid, rec);
  return rows.length;
}

/** 1 件版(`deleteEntry` 用)。 */
export function recordDeletion(db: Database, cid: string, lid: string, untouched: boolean, rec?: RowRecorder): void {
  if (untouched) return;
  recordDeletions(db, cid, [lid], rec);
}

/** 同期の記録を全部消す(端末 id・連番・全ワークスペースの対応・前回の同期の記録・削除の記録)。ノートは触らない。 */
export function forgetAllSyncRows(db: Database): number {
  db.exec({ sql: 'DELETE FROM settings WHERE scope = ? OR substr(scope, 1, ?) = ?', bind: [SYNC_SCOPE, SYNC_SCOPE.length + 1, `${SYNC_SCOPE}:`] });
  return db.changes();
}
