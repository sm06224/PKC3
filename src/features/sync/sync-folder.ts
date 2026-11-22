/**
 * 🔴 **端末間の同期(#2000)段 3 ── 同期フォルダの回の決め(純関数)**。
 *
 * 同期フォルダ(クラウドドライブの中のフォルダなど)には、**端末ごとに 1 つ**の差分ファイル `pkc3-<端末 id>.pkc3-diff.zip` を置く。
 * - **自分のファイルだけを書き、他の端末のファイルは読むだけ**(書き込みがぶつからない。クラウドドライブ側の「競合コピー」を作らない)。
 * - 1 回の同期 = ①他の端末のファイルのうち**前の回から変わった物**を取り込む → ②自分のファイルを、中身が変わったときだけ書き直す。
 * - 取り込みの判定・競合の扱いは段 1・2 の核(`sync-plan.ts`)をそのまま使う。ここは「どのファイルを読む / 書くか」だけを決める。
 * - 取り込んだ差分に本文が足りなかった(相手の前回の合意が古い)相手には、自分のファイルの `want` で全件を頼む。
 *   頼まれた側は次の回に全件を書く。全件を取り込めたら頼みを下ろす。
 *
 * ⚠ pure module。ファイルの読み書きは adapter(`adapter/platform/sync-folder.ts`)。
 */
import { DIFF_SUFFIX } from './diff-file';
import { isDeviceId } from './sync-state';

export const SYNC_FOLDER_FILE_PREFIX = 'pkc3-';

/** 端末のファイル名。 */
export function folderFileName(device: string): string {
  return `${SYNC_FOLDER_FILE_PREFIX}${device}${DIFF_SUFFIX}`;
}

/** ファイル名から端末 id を読む(同期フォルダのファイルでなければ `null`)。⚠ 大文字・余計な字を含む名前は読まない。 */
export function deviceOfFileName(name: string): string | null {
  if (!name.startsWith(SYNC_FOLDER_FILE_PREFIX) || !name.endsWith(DIFF_SUFFIX)) return null;
  const id = name.slice(SYNC_FOLDER_FILE_PREFIX.length, name.length - DIFF_SUFFIX.length);
  return isDeviceId(id) ? id : null;
}

/** フォルダで見えたファイル。 */
export interface FolderFile {
  name: string;
  size: number;
  /** 更新日時(ms)。⚠ 比べるのは「前の回と同じか」だけ(大小は比べない ── 端末の時計に依らない)。 */
  mtime: number;
}

/** 前の回に取り込んだファイルの控え(同じなら読み直さない)。 */
export interface SeenFile {
  size: number;
  mtime: number;
  /** そのファイルが「全件をください」と言っていた端末。 */
  want: string[];
}

/** 端末ごと・ワークスペースごとに残す同期フォルダの記録(フォルダの handle と一緒に IndexedDB へ)。 */
export interface FolderSyncRecord {
  /** 取り込んだ他の端末のファイル(ファイル名 → 控え)。 */
  seen: Record<string, SeenFile>;
  /** 前回自分のファイルに書いた中身の要約(同じなら書かない)。 */
  lastKey: string | null;
  /** 全件を頼んでいる相手。 */
  want: string[];
}

export const emptyFolderRecord = (): FolderSyncRecord => ({ seen: {}, lastKey: null, want: [] });

/** 記録を読む(壊れていれば空から)。 */
export function normalizeFolderRecord(v: unknown): FolderSyncRecord {
  const out = emptyFolderRecord();
  if (typeof v !== 'object' || v === null) return out;
  const o = v as Record<string, unknown>;
  if (typeof o.lastKey === 'string') out.lastKey = o.lastKey;
  if (Array.isArray(o.want)) out.want = o.want.filter((x): x is string => isDeviceId(x));
  if (typeof o.seen === 'object' && o.seen !== null) {
    for (const [name, s] of Object.entries(o.seen as Record<string, unknown>)) {
      if (deviceOfFileName(name) === null || typeof s !== 'object' || s === null) continue;
      const r = s as Record<string, unknown>;
      if (typeof r.size !== 'number' || typeof r.mtime !== 'number') continue;
      out.seen[name] = { size: r.size, mtime: r.mtime, want: Array.isArray(r.want) ? r.want.filter((x): x is string => isDeviceId(x)) : [] };
    }
  }
  return out;
}

export interface FolderRound {
  /** 取り込む他の端末のファイル(前の回から変わった / 初めて見た)。名前の順(決定的)。 */
  toRead: FolderFile[];
  /** 自分以外でファイルのある端末。 */
  others: string[];
  /** 自分のファイルがあるか(無ければ全件で書く)。 */
  ownFilePresent: boolean;
  /** 自分の端末 id のファイル(端末のデータの複製を見分ける)。 */
  ownFile: FolderFile | null;
  /** フォルダから消えた端末のファイル(記録から外す)。 */
  vanished: string[];
}

/**
 * 回の計画。`self` = この端末の id、`force` = 手で同期した(変わっていなくても全部読み直す ── 前の回で確認待ちにした相手を拾う)。
 */
export function planFolderRound(self: string, files: readonly FolderFile[], rec: FolderSyncRecord, force = false): FolderRound {
  const toRead: FolderFile[] = [];
  const others = new Set<string>();
  let ownFile: FolderFile | null = null;
  const present = new Set<string>();
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const dev = deviceOfFileName(f.name);
    if (dev === null) continue;
    present.add(f.name);
    if (dev === self) {
      ownFile = f;
      continue;
    }
    others.add(dev);
    const seen = rec.seen[f.name];
    if (force || seen === undefined || seen.size !== f.size || seen.mtime !== f.mtime) toRead.push(f);
  }
  return {
    toRead,
    others: [...others].sort(),
    ownFilePresent: ownFile !== null,
    ownFile,
    vanished: Object.keys(rec.seen).filter((n) => !present.has(n)),
  };
}

/** 自分に全件を頼んでいる端末(他の端末のファイルの `want` に自分の id がある)。 */
export function wantedByOf(self: string, rec: FolderSyncRecord): string[] {
  const out = new Set<string>();
  for (const [name, s] of Object.entries(rec.seen)) {
    const dev = deviceOfFileName(name);
    if (dev !== null && s.want.includes(self)) out.add(dev);
  }
  return [...out].sort();
}

/**
 * 取り込んだ結果で、全件の頼みを更新する。
 * - 本文が足りなかった → その相手へ頼む
 * - 全件のファイルを足りなく無く取り込めた → 頼みを下ろす
 */
export function updateWant(want: readonly string[], peer: string, result: { needFull: boolean; complete: boolean }): string[] {
  const set = new Set(want);
  if (result.needFull) set.add(peer);
  else if (result.complete) set.delete(peer);
  return [...set].sort();
}

/** 定期の回の間隔(分)。⚠ 画面に出ている間だけ回す(隠れている間・閉じている間は回らない)。 */
export const SYNC_FOLDER_MINUTES = [1, 5, 15, 60] as const;
export type SyncFolderMinutes = (typeof SYNC_FOLDER_MINUTES)[number];
export const SYNC_FOLDER_DEFAULT_MINUTES: SyncFolderMinutes = 5;

export function isSyncFolderMinutes(v: unknown): v is SyncFolderMinutes {
  return typeof v === 'number' && (SYNC_FOLDER_MINUTES as readonly number[]).includes(v);
}

/** 失敗が続いたときに次の回を延ばす(分)。上限は 60 分。⚠ 手で同期すると元の間隔へ戻る。 */
export function backoffMinutes(base: SyncFolderMinutes, failures: number): number {
  if (failures <= 0) return base;
  return Math.min(60, base * 2 ** Math.min(failures, 6));
}

/**
 * 自分のファイルを書き直すかを決める要約(`planFolderExport` の `writeKey` + 全件の頼み + 確認済みの対応)。
 * ⚠ 頼みと対応も中身の一部 ── 変われば書き直す(相手が初回の確認を省けるのは、新しい対応が届いてから)。
 */
export function folderWriteKey(writeKey: string, want: readonly string[], pairs: Readonly<Record<string, string>>): string {
  const pairsKey = Object.entries(pairs)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([d, c]) => `${d}=${c}`)
    .join(',');
  return [writeKey, [...want].sort().join(','), pairsKey].join('|');
}
