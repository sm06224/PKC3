/**
 * 🔴 **端末間の同期(#2000)段 2 ── 差分を書き出すときに何を入れるかの決め(純関数)**。
 *
 * - 相手(前回の同期の記録がある端末)が決まっていて、記録が新しければ、**記録から変わった物だけ**(`extractChanges`)の本文を入れる。
 * - 相手が無い(初回)・記録が古い(削除の記録を整理した可能性がある期間より前)・削除の記録が上限に達している・「全件」を選んだときは
 *   **全件**(`complete: true`)。受け取る側は全件を見て突き合わせる(設計 doc §12.1 の約束 3)。
 * - どの場合も**全件の指紋の一覧**と削除の記録を添える(種の同期の記録・全件の突き合わせ・端末 id の重複の見分け)。
 * ⚠ pure module。
 */
import { extractChanges, type Baseline, type KeyedState, type Tombstone } from './change-set';
import { sha256Hex } from './sha256';
import { TOMBSTONE_KEEP_DAYS, TOMBSTONE_MAX } from './sync-state';
import { isNoteKey } from './sync-attr';
import type { DiffFingerprint } from './diff-file';

const DAY_MS = 86_400_000;

export interface ExportInput {
  device: string;
  seq: number;
  states: readonly KeyedState[];
  tombstones: readonly Tombstone[];
  /** 選んだ相手の前回の合意と時刻(初回は `null`)。 */
  peer: { baseline: Baseline; at: string | null } | null;
  /** 「全件」を選んだ。 */
  all: boolean;
  nowMs: number;
}

export interface ExportPlan {
  complete: boolean;
  /** 本文を入れるノートの lid。 */
  noteLids: string[];
  tombstones: Tombstone[];
  fingerprints: DiffFingerprint[];
  /** 送り手が受け手について持っている記録(競合の連鎖を止める用)。 */
  peerBase: DiffFingerprint[];
}

const toFpList = (s: ReadonlyArray<{ key: string; content: string; place?: string }>): DiffFingerprint[] =>
  s.map((x) => (x.place === undefined ? { key: x.key, c: x.content } : { key: x.key, c: x.content, p: x.place })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

/** 古い記録か(削除の記録の整理期間より前 / 時刻が無い・読めない)。 */
export function isStaleBase(at: string | null, nowMs: number): boolean {
  if (at === null) return true;
  const t = Date.parse(at);
  return Number.isNaN(t) || nowMs - t > TOMBSTONE_KEEP_DAYS * DAY_MS;
}

export function planExport(input: ExportInput): ExportPlan {
  const complete = input.all || input.peer === null || isStaleBase(input.peer.at, input.nowMs) || input.tombstones.length >= TOMBSTONE_MAX;
  const noteStates = input.states.filter((s) => isNoteKey(s.key));
  let noteLids: string[];
  const tombstones = [...input.tombstones];
  if (complete || input.peer === null) {
    noteLids = noteStates.map((s) => s.key).sort();
  } else {
    const ch = extractChanges(input.states, input.peer.baseline, input.tombstones);
    noteLids = [...ch.added, ...ch.changed].filter((s) => isNoteKey(s.key)).map((s) => s.key);
    // 記録に在って今は無い物(墓標が残っていなくても分かる削除)も、削除の記録として運ぶ(ノートだけ。つながり・印は全件の一覧が運ぶ)
    const have = new Set(tombstones.map((t) => t.key));
    for (const d of ch.deleted) {
      if (!isNoteKey(d.key) || have.has(d.key)) continue;
      tombstones.push({ key: d.key, lastFp: d.lastFp, device: input.device, seq: input.seq });
    }
  }
  return {
    complete,
    noteLids,
    tombstones,
    fingerprints: toFpList(input.states),
    peerBase: input.peer === null ? [] : toFpList(Object.entries(input.peer.baseline).map(([key, fp]) => ({ key, ...fp }))),
  };
}

/** 指紋の一覧の要約(書き出した差分の控え。自分が書き出した物か・端末 id の複製かの見分けに使う)。 */
export function fingerprintDigest(list: ReadonlyArray<DiffFingerprint>): string {
  const sorted = [...list].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return sha256Hex(JSON.stringify(sorted.map((x) => [x.key, x.c, x.p ?? null])));
}

/** `KeyedState[]` から書き出す指紋の一覧へ(要約を作る側と書き出す側が同じ形を通る)。 */
export function fingerprintsOf(states: ReadonlyArray<{ key: string; content: string; place?: string }>): DiffFingerprint[] {
  return toFpList(states);
}

/**
 * 🔴 **同期フォルダ(段 3)に置く自分のファイルの中身を決める**(純関数)。
 *
 * 同期フォルダには**端末ごとに 1 つ**の差分ファイル(`pkc3-<端末 id>.pkc3-diff.zip`)を置き、**自分のファイルだけを書き、
 * 他の端末のファイルは読むだけ**にする(クラウドドライブの同期で書き込みがぶつからない)。1 つのファイルを複数の相手が読むので:
 *
 * - **全件**(`complete`)にするとき: 自分のファイルがまだ無い / フォルダに記録の無い(または古い)相手がいる /
 *   相手が「全件をください」(`want`)と言っている / 削除の記録が上限に達している。
 * - それ以外は、フォルダに居る**どの相手**の前回の合意から見ても変わった物の**和**を入れる(相手ごとに要る物は必ず入る。
 *   余分に入った物は、相手の側で「同じ内容」として何もしない)。
 * - 競合の連鎖を止める `peerBase` は相手ごとに違うので、`peerBases`(相手の端末 id → 記録)で全員分を添える。
 */
export interface FolderExportInput {
  device: string;
  seq: number;
  states: readonly KeyedState[];
  tombstones: readonly Tombstone[];
  /** 相手ごとの前回の合意と時刻。 */
  bases: Readonly<Record<string, { baseline: Baseline; at: string | null }>>;
  /** 同期フォルダに自分以外のファイルがある端末。 */
  others: readonly string[];
  /** 「全件をください」と言っている端末(相手のファイルの `want` に自分の id がある)。 */
  wantedBy: readonly string[];
  /** 自分のファイルが同期フォルダに在るか。 */
  ownFilePresent: boolean;
  nowMs: number;
}

export interface FolderExportPlan extends Omit<ExportPlan, 'peerBase'> {
  peerBases: Record<string, DiffFingerprint[]>;
  /** 書く必要があるかを決める要約(前回書いた物と同じなら書かない)。⚠ 連番は含めない(書くたびに変わるため)。 */
  writeKey: string;
}

export function planFolderExport(input: FolderExportInput): FolderExportPlan {
  const others = [...new Set(input.others)].filter((d) => d !== input.device).sort();
  const unknownOrStale = others.some((d) => input.bases[d] === undefined || isStaleBase(input.bases[d]!.at, input.nowMs));
  const complete = !input.ownFilePresent || unknownOrStale || input.wantedBy.length > 0 || input.tombstones.length >= TOMBSTONE_MAX;
  const peerBases: Record<string, DiffFingerprint[]> = {};
  for (const d of others) {
    const b = input.bases[d];
    if (b !== undefined) peerBases[d] = toFpList(Object.entries(b.baseline).map(([key, fp]) => ({ key, ...fp })));
  }
  const tombByKey = new Map(input.tombstones.map((t) => [t.key, t] as const));
  let noteLids: string[];
  if (complete) {
    noteLids = input.states.filter((s) => isNoteKey(s.key)).map((s) => s.key).sort();
  } else {
    const lids = new Set<string>();
    for (const d of others) {
      const ch = extractChanges(input.states, input.bases[d]!.baseline, input.tombstones);
      for (const s of [...ch.added, ...ch.changed]) if (isNoteKey(s.key)) lids.add(s.key);
      for (const x of ch.deleted) {
        if (!isNoteKey(x.key) || tombByKey.has(x.key)) continue;
        tombByKey.set(x.key, { key: x.key, lastFp: x.lastFp, device: input.device, seq: input.seq });
      }
    }
    noteLids = [...lids].sort();
  }
  const fingerprints = toFpList(input.states);
  const tombstones = [...tombByKey.values()];
  const writeKey = sha256Hex(
    JSON.stringify([
      fingerprintDigest(fingerprints),
      complete,
      noteLids,
      tombstones.map((t) => [t.key, t.lastFp.content, t.lastFp.place ?? null]).sort(),
      Object.entries(peerBases).map(([d, l]) => [d, fingerprintDigest(l)]).sort(),
    ]),
  );
  return { complete, noteLids, tombstones, fingerprints, peerBases, writeKey };
}
