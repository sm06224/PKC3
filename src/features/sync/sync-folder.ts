/**
 * 🔴 **端末間の同期(#2000)段 3 ── フォルダ同期(全データ)の置き方と判断(純関数)**。
 *
 * クラウドドライブなどの**同じフォルダ**を 2 台以上の端末で指す。各端末は次を置き、他の端末の物を取り込む:
 *
 * ```
 * <選んだフォルダ>/pkc3-sync/
 *   <端末 id>.pkc3-diff.zip   この端末の全件の差分ファイル(端末ごとに 1 つ。書き換えるだけで増えない)
 *   assets/<添付の key>        添付の実体(内容で名前が決まるので端末間で共有。無ければ置く)
 * ```
 *
 * - **端末ごとに自分のファイルだけを書く**(他の端末のファイルには書かない)→ クラウドの同期が同じファイルを両側から書き換える競合が起きない。
 * - 中身は段 2 の差分ファイル(`diff-file.ts`)そのまま(全件。`complete: true`)。取り込みは段 2 と同じ道(lid を保つ合流・競合は両方残す・
 *   相手で消えた物はゴミ箱・取り消し)。色ラベル・ピン留めも入る。
 * - **同じファイルを取り込み直さない**: 相手ごとに「取り込んだ最新の連番」を同期の記録(`last:<端末 id>`)に持ち、ファイルの連番がそれ以下なら読まない。
 *   ファイルの大きさ・更新日時が前回と同じなら、概要も読まない。
 * - **途中までしか届いていないファイルに備える**: 更新日時が直近(`SYNC_FOLDER_SETTLE_MS` 以内)なら次の回へ回し、zip として読めなければ取り込まずに
 *   次の回でやり直す(壊れたまま残っても、何も書かない)。
 * - 古い端末のファイル: 端末ごとに 1 つなので溜まらない。使わなくなった端末のファイルは、**取り込み済みなら手で消してよい**(消しても他の端末のノートは消えない)。
 *
 * ⚠ pure module。
 */
import { DIFF_SUFFIX } from './diff-file';
import { isDeviceId } from './sync-state';

/** 選んだフォルダの中に作る置き場(クラウドのルートを散らかさない)。 */
export const SYNC_FOLDER_DIR = 'pkc3-sync';
/** 添付の実体の置き場(`SYNC_FOLDER_DIR` の中)。 */
export const SYNC_FOLDER_ASSETS_DIR = 'assets';
/** 定期の同期の間隔(ms)。 */
export const SYNC_FOLDER_INTERVAL_MS = 60_000;
/** 読み込み中・編集中で同期を始められなかったときの、やり直しの間隔(ms)。 */
export const SYNC_FOLDER_RETRY_MS = 5_000;
/** 更新日時がこれより新しいファイルは、書き込み・アップロードの途中かもしれないので次の回へ回す。 */
export const SYNC_FOLDER_SETTLE_MS = 2_000;
/** 添付の key として置いてよい名前(`referencedAssets` と同じ字種。パスを含まない)。 */
const ASSET_NAME_RE = /^[A-Za-z0-9_.-]{1,200}$/;

/** この端末のファイル名。 */
export const folderFileNameOf = (device: string): string => `${device}${DIFF_SUFFIX}`;

/** ファイル名から端末 id を取る(同期のファイルでなければ `null`。クラウドが付ける「競合コピー」などの名前は対象外)。 */
export function deviceOfFolderFile(name: string): string | null {
  if (!name.endsWith(DIFF_SUFFIX)) return null;
  const id = name.slice(0, name.length - DIFF_SUFFIX.length);
  return isDeviceId(id) ? id : null;
}

/** 添付の実体のファイル名として安全か(フォルダの外へ出る名前を作らない)。 */
export const isSafeAssetFileName = (key: string): boolean => ASSET_NAME_RE.test(key) && key !== '.' && key !== '..';

export interface FolderFileInfo {
  name: string;
  size: number;
  lastModified: number;
}

export type FolderFileAction =
  /** 取り込む候補(概要を読んで連番を見る)。 */
  | { kind: 'consider'; name: string; device: string }
  /** 前回と同じ(大きさ・更新日時が同じ)なので読まない。 */
  | { kind: 'unchanged'; name: string; device: string }
  /** 書き込みの途中かもしれない。次の回へ。 */
  | { kind: 'settling'; name: string; device: string }
  /** 自分のファイル。 */
  | { kind: 'own'; name: string; device: string };

export const memoKey = (f: FolderFileInfo): string => [f.size, f.lastModified].join(':');

/**
 * フォルダの中のファイルから、この回にすることを決める。
 * @param memo 前回までに処理を済ませたファイルの控え(名前 → `memoKey`)
 */
export function planFolderFiles(files: readonly FolderFileInfo[], self: string, memo: ReadonlyMap<string, string>, nowMs: number): FolderFileAction[] {
  const out: FolderFileAction[] = [];
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const device = deviceOfFolderFile(f.name);
    if (device === null) continue;
    if (device === self) out.push({ kind: 'own', name: f.name, device });
    else if (nowMs - f.lastModified < SYNC_FOLDER_SETTLE_MS) out.push({ kind: 'settling', name: f.name, device });
    else if (memo.get(f.name) === memoKey(f)) out.push({ kind: 'unchanged', name: f.name, device });
    else out.push({ kind: 'consider', name: f.name, device });
  }
  return out;
}

/** 連番が、取り込み済みの最新以下なら読む必要が無い(同じファイルを取り込み直さない)。 */
export const alreadyImported = (fileSeq: number, lastSeq: number | undefined): boolean => lastSeq !== undefined && fileSeq <= lastSeq;

/**
 * 自分のファイルを書く必要があるか。
 * - フォルダにまだ無い → 書く
 * - あっても、その連番が**この端末の控え**(`outs`)に無い → 書く(別の端末が同じ id で書いた疑いは呼び手が先に扱う)
 * - 控えの指紋の要約が、いまの要約と同じ → 書かない(変わっていないので書き換えない = クラウドの無駄な同期を起こさない)
 */
export function needsOwnWrite(existingSeq: number | null, outs: Readonly<Record<number, string>>, currentDigest: string): boolean {
  if (existingSeq === null) return true;
  const d = outs[existingSeq];
  return d === undefined || d !== currentDigest;
}

/**
 * 🔴 **フォルダの中の、この端末の名前のファイルが「この端末が書いた物」か**。
 * - この端末の控え(`outs`)に連番がある → 自分の物
 * - 控えに無いが、控えの**一番古い連番より前**(手で何度も書き出して、控えの保持数から押し出された)→ 自分の物(名前と端末 id が合っている)
 * - それ以外(控えの範囲内なのに無い・控えより新しい連番)→ 別の端末が同じ id で書いた疑い(端末のデータの複製)
 * ⚠ 控えの保持数に左右されて、手動の書き出しの繰り返しだけで「重複の確認」が出ないようにする。
 */
export function ownFileVerdict(seq: number, outs: Readonly<Record<number, string>>, currentSeq: number): 'own' | 'suspect' {
  if (seq <= 0 || outs[seq] !== undefined) return 'own';
  const kept = Object.keys(outs).map(Number);
  if (kept.length > 0 && seq < Math.min(...kept) && seq <= currentSeq) return 'own';
  return 'suspect';
}

/** 状態の種類。 */
export type FolderSyncPhase = 'unsupported' | 'off' | 'needs-permission' | 'idle' | 'running' | 'lost' | 'disabled';

/** 起動時に保存してあったフォルダの許可の状態から、次の状態を決める。 */
export function phaseForPermission(perm: string | null): 'idle' | 'needs-permission' | 'lost' {
  if (perm === 'granted') return 'idle';
  if (perm === 'prompt') return 'needs-permission';
  return 'lost';
}

/** 画面に出す文(ステータス・設定の注記)。 */
export const FOLDER_UNSUPPORTED_NOTE =
  'このブラウザはフォルダへの書き込みを許可する仕組みを持たないため、フォルダで同期できません(Chrome / Edge のパソコン版で使えます)。別の端末へは、コレクションの「書き出す ▾」の「差分を書き出す」で作ったファイル(.pkc3-diff.zip)を受け渡してください';
export const FOLDER_NEEDS_PERMISSION_NOTE = 'フォルダへのアクセスの許可が切れています。「許可する」を押すと、同期を再開します';
export const FOLDER_LOST_NOTE = 'フォルダにアクセスできません(許可が拒否されたか、フォルダが見つかりません)。「フォルダを選び直す」で選んでください';
