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

/**
 * 🔴 暗号化した差分ファイルの名前の末尾(#2000 段 4b)。平文の `.pkc3-diff.zip` とは**名前で分ける**
 * (`pkc3-<端末>.pkc3-diff.zip.enc`。平文のファイルを暗号化したと取り違えない・逆も)。
 */
export const ENC_SUFFIX = '.enc';

/** 暗号化した端末のファイル名。 */
export function encFileName(device: string): string {
  return `${folderFileName(device)}${ENC_SUFFIX}`;
}

/** 暗号化したファイルの名前か(形を満たすものだけ)。 */
export function isEncFileName(name: string): boolean {
  return name.endsWith(ENC_SUFFIX) && deviceOfFileName(name) !== null;
}

/**
 * ファイル名から端末 id を読む(同期フォルダのファイルでなければ `null`)。⚠ 大文字・余計な字を含む名前は読まない。
 * 平文(`….pkc3-diff.zip`)も暗号化(`….pkc3-diff.zip.enc`)も同じ端末のファイルとして読む(見分けは `isEncFileName`)。
 */
export function deviceOfFileName(name: string): string | null {
  const base = name.endsWith(ENC_SUFFIX) ? name.slice(0, name.length - ENC_SUFFIX.length) : name;
  if (!base.startsWith(SYNC_FOLDER_FILE_PREFIX) || !base.endsWith(DIFF_SUFFIX)) return null;
  const id = base.slice(SYNC_FOLDER_FILE_PREFIX.length, base.length - DIFF_SUFFIX.length);
  return isDeviceId(id) ? id : null;
}

/** フォルダで見えたファイル。 */
export interface FolderFile {
  name: string;
  size: number;
  /** 更新日時(ms)。⚠ 比べるのは「前の回と同じか」だけ(大小は比べない ── 端末の時計に依らない)。 */
  mtime: number;
  /**
   * 保管先の版の印(S3 の ETag。#2000 段 4a)。⚠ 在れば**こちらで**同じかを見る(更新日時は見ない ── S3 の一覧の日時と書いた後の
   *   日時が取り方で食い違うことがある)。フォルダには無い(大きさ + 更新日時で見る)。
   */
  version?: string;
}

/** 前の回に取り込んだファイルの控え(同じなら読み直さない)。 */
export interface SeenFile {
  size: number;
  mtime: number;
  /** 保管先の版の印(`FolderFile.version`)。 */
  version?: string;
  /** そのファイルが「全件をください」と言っていた端末。 */
  want: string[];
}

/**
 * 🔴 相手の端末ごとに**取り込んだ最大の連番**(#2000 段 4b ── 古いファイルへの巻き戻し・差し替えの拒否)。
 * ファイルの印(大きさ・更新日時・版)は、同じ連番で中身が違う物を見分けるために一緒に置く。
 */
export interface PeerSeq {
  seq: number;
  /** 認証済みの中身の識別子(`decryptDiff` の `contentId`)。在れば、同じ連番の「同じファイルか」はこれだけで見る(更新日時・版は見ない)。 */
  contentId?: string;
  size: number;
  mtime: number;
  version?: string;
}

/** 端末ごと・ワークスペースごとに残す同期フォルダの記録(フォルダの handle と一緒に IndexedDB へ)。 */
export interface FolderSyncRecord {
  /** 取り込んだ他の端末のファイル(ファイル名 → 控え)。 */
  seen: Record<string, SeenFile>;
  /**
   * 🔴 相手の端末 id → 取り込んだ最大の連番(暗号化したファイルのヘッダの連番)。
   * ⚠ 旧い版はこの欄を知らない(`normalizeFolderRecord` は知っている欄だけを読む ── 無視されて壊れない。`tests/features/sync/e2e-rollback.test.ts` で固定)。
   */
  peerSeq: Record<string, PeerSeq>;
  /** 前回自分のファイルに書いた中身の要約(同じなら書かない)。 */
  lastKey: string | null;
  /** 全件を頼んでいる相手。 */
  want: string[];
}

export const emptyFolderRecord = (): FolderSyncRecord => ({ seen: {}, peerSeq: {}, lastKey: null, want: [] });

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
      out.seen[name] = {
        size: r.size,
        mtime: r.mtime,
        ...(typeof r.version === 'string' ? { version: r.version } : {}),
        want: Array.isArray(r.want) ? r.want.filter((x): x is string => isDeviceId(x)) : [],
      };
    }
  }
  if (typeof o.peerSeq === 'object' && o.peerSeq !== null) {
    for (const [dev, s] of Object.entries(o.peerSeq as Record<string, unknown>)) {
      if (!isDeviceId(dev) || typeof s !== 'object' || s === null) continue;
      const r = s as Record<string, unknown>;
      if (typeof r.seq !== 'number' || !Number.isSafeInteger(r.seq) || r.seq < 0 || typeof r.size !== 'number' || typeof r.mtime !== 'number') continue;
      out.peerSeq[dev] = {
        seq: r.seq,
        size: r.size,
        mtime: r.mtime,
        ...(typeof r.version === 'string' ? { version: r.version } : {}),
        ...(typeof r.contentId === 'string' ? { contentId: r.contentId } : {}),
      };
    }
  }
  return out;
}

/** 相手のファイルの連番の判定。 */
export type PeerSeqVerdict = 'ok' | 'rollback' | 'replaced';

/**
 * 🔴 **巻き戻しの拒否**(#2000 段 4b-d)── 相手の端末から**取り込み済みの最大の連番より小さい**ファイルは取り込まない
 * (古い暗号文の差し戻し)。**同じ連番で中身(版・大きさ・更新日時)が違う**ファイルも断る(差し替え)。
 * 記録が無い相手(初めて)は通す。
 */
export function checkPeerSeq(
  rec: FolderSyncRecord,
  device: string,
  seq: number,
  file: { size: number; mtime: number; version?: string },
  contentId?: string,
): PeerSeqVerdict {
  const prev = rec.peerSeq[device];
  if (prev === undefined) return 'ok';
  if (seq < prev.seq) return 'rollback';
  if (seq === prev.seq) {
    // 🔴 同じ連番の「同じファイルか」は、認証済みの中身の識別子で見る(クラウドドライブが更新日時だけ変えても、版だけ変わっても誤って断らない)
    const same = prev.contentId !== undefined && contentId !== undefined ? prev.contentId === contentId : sameFileVersion(prev, file);
    if (!same) return 'replaced';
  }
  return 'ok';
}

/** 取り込めた相手の連番を記録する(下げない)。 */
export function notePeerSeq(rec: FolderSyncRecord, device: string, seq: number, file: { size: number; mtime: number; version?: string }, contentId?: string): void {
  const prev = rec.peerSeq[device];
  if (prev !== undefined && prev.seq > seq) return;
  rec.peerSeq[device] = {
    seq,
    size: file.size,
    mtime: file.mtime,
    ...(file.version === undefined ? {} : { version: file.version }),
    ...(contentId === undefined ? {} : { contentId }),
  };
}

/**
 * 🔴 **相手の連番の記録を忘れる**(「この端末を受け入れ直す」── 相手が古いバックアップから戻したときの救済。画面は段 4b-B)。
 * 忘れた相手のファイルは、次の回に(連番の比べ無しで)読み直す(控え `seen` も外す)。他の相手の記録は動かさない。
 * @returns 記録を変えたか
 */
export function forgetPeerSeq(rec: FolderSyncRecord, device: string): boolean {
  let changed = false;
  if (rec.peerSeq[device] !== undefined) {
    delete rec.peerSeq[device];
    changed = true;
  }
  for (const name of Object.keys(rec.seen)) {
    if (deviceOfFileName(name) === device) {
      delete rec.seen[name];
      changed = true;
    }
  }
  return changed;
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
    if (force || seen === undefined || !sameFileVersion(seen, f)) toRead.push(f);
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

/** 回で読む・書く前に、置き場の一覧から「どのファイルを見るか」を選んだ結果(#2000 段 4b)。 */
export interface RoundFiles {
  /** 計画(`planFolderRound`)へ渡すファイル(端末ごとに 1 つ)。 */
  files: FolderFile[];
  /** 自分の端末の、**もう片方の形**のファイルの名前(暗号化へ切り替えた後に消す平文 / 平文へ戻した後に消す暗号化)。無ければ `null`。 */
  ownCounterpart: string | null;
  /**
   * 🔴 暗号化している間は、**平文の差分ファイルを取り込まない**(置き場に書ける者が平文を差し込めないように)。
   * 平文しか無い他の端末のファイルはここに入る(自分の平文は読まず、書き直したあとで消す) ── 回は控え(`seen`)だけ更新し、案内を出す。
   */
  skippedPlain: FolderFile[];
  /** 自分は暗号化している ── 平文しか置いていない他の端末(その端末でも暗号化をオンにしてもらう)。 */
  peersNeedEnc: string[];
  /** 自分は暗号化していない ── 暗号化したファイルを置いている他の端末(読めない。この端末でも暗号化をオンにしてもらう)。 */
  peersEncOnly: string[];
}

/**
 * 🔴 **端末ごとに見るファイルを 1 つ選ぶ**(平文 / 暗号化の両方が在る端末の取り違えを 1 か所で決める)。
 * - 暗号化している(`encOn`): **暗号化したファイルだけ**を取り込む。平文しか無い相手は取り込まない(`skippedPlain` + 案内)
 * - 暗号化していない: 平文だけを見る。暗号化したファイルしか無い相手は**読めない**(案内を出す)
 */
export function chooseRoundFiles(entries: readonly FolderFile[], self: string, encOn: boolean): RoundFiles {
  const byDev = new Map<string, { plain?: FolderFile; enc?: FolderFile }>();
  for (const f of entries) {
    const dev = deviceOfFileName(f.name);
    if (dev === null) continue;
    const g = byDev.get(dev) ?? {};
    if (isEncFileName(f.name)) g.enc = f;
    else g.plain = f;
    byDev.set(dev, g);
  }
  const out: RoundFiles = { files: [], skippedPlain: [], ownCounterpart: null, peersNeedEnc: [], peersEncOnly: [] };
  for (const dev of [...byDev.keys()].sort()) {
    const g = byDev.get(dev)!;
    const use = encOn ? g.enc : g.plain;
    if (use !== undefined) out.files.push(use);
    if (encOn && g.enc === undefined && g.plain !== undefined && dev !== self) out.skippedPlain.push(g.plain);
    if (dev === self) {
      out.ownCounterpart = (encOn ? g.plain : g.enc)?.name ?? null;
    } else if (encOn && g.enc === undefined && g.plain !== undefined) out.peersNeedEnc.push(dev);
    else if (!encOn && g.enc !== undefined) out.peersEncOnly.push(dev);
  }
  return out;
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

/**
 * 🔴 **前の回と同じファイルか**(#2000 段 4a)── 版の印(ETag)が両方に在ればそれで、無ければ大きさ + 更新日時で見る(段 3 のまま)。
 * ⚠ 同じ問いに答える所はここ 1 つ(回の計画と、自分のファイルの控え(`own`)の両方がここを通る)。
 */
export function sameFileVersion(
  a: { readonly size: number; readonly mtime: number; readonly version?: string },
  b: { readonly size: number; readonly mtime: number; readonly version?: string },
): boolean {
  if (a.version !== undefined && b.version !== undefined) return a.version === b.version;
  return a.size === b.size && a.mtime === b.mtime;
}
