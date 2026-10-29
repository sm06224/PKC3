/**
 * 🔴 **PC のフォルダと同期する ── 何を書き、何を取り込み、何を残すかを決める純関数**(#1455 の後半)。
 *
 * > 「SQLite を正本とし、外部フォルダーへの定期同期・書き出し／読み込み として非同期・疎結合に保つ」
 *
 * ## 決めごと(issue の推薦案 + 業務画面の原則)
 *
 * - **正本は PKC3(SQLite)**。フォルダは写し。⚠ フォルダを正にして PKC3 を消す道は作らない。
 * - **対象**: 本文を持つノート(ノート / ログ / チェックリスト / 表 / テンプレート / フォーム)。
 *   フォルダ・スマートフォルダ・スタック・添付・アプリのグループは対象外(本文が組織の情報ではない / 別の形で持つ)。
 * - **形**: フォルダ直下に `<題名>.md`(本文をそのまま。frontmatter は本文の一部なので触らない)+ 管理用の `.pkc3-sync.json`。
 *   階層・つながり・履歴・添付は写さない(`md ZIP` と同じ「片道で落ちるもの」)。
 * - **照合は世代とハッシュ**: ノート側は「前回の同期時の更新日時と文字数」、ファイル側は「前回の同期時の内容のハッシュ」。
 *   どちらも変わっていなければ何もしない。
 * - **競合(両方が変わった)**: PKC3 の版を正とする。フォルダ側の版は消さず `_conflicts/` へ退避してから書く。
 * - **フォルダ側だけ変わった**: ノートの本文を置き換える(前の本文は履歴に残る)。題名・つながりは触らない。
 * - **フォルダに新しい `.md` が増えた**: 新しいノートとして取り込む。
 * - **ノートが消えた**: ファイルは消さない(「同期が消した」を作らない)。管理用の記録に「消した」と残し、
 *   同じ内容のファイルを取り込み直さない。ファイルを書き換えたら新しいノートとして取り込む。
 * - **フォルダ側のファイルが消えた**: PKC3 が正本なので、次の同期で書き戻す。
 * - **編集中のノートは触らない**(次の回へ)。
 *
 * ⚠ pure module。ファイルの読み書き・ハッシュは呼び手(`adapter/platform/folder-sync.ts`)が持つ。
 */
import { slugForTitle } from '@features/export/pkc3-markdown-zip';

export const SYNC_MANIFEST_NAME = '.pkc3-sync.json';
export const SYNC_CONFLICT_DIR = '_conflicts';
export const SYNC_FORMAT = 'pkc3-folder-sync';
export const SYNC_VERSION = 1;

/** 同期の間隔(分)。⚠ 画面の選択肢はここ 1 か所。 */
export const SYNC_INTERVAL_MINUTES = [1, 5, 15, 60] as const;
export type SyncIntervalMinutes = (typeof SYNC_INTERVAL_MINUTES)[number];
export const SYNC_DEFAULT_MINUTES: SyncIntervalMinutes = 5;

/** 同期の対象にしない種別(本文がノートの文章ではない / 別の形で持つ)。 */
const SKIP_ARCHETYPES: ReadonlySet<string> = new Set(['folder', 'smart', 'stack', 'appgroup', 'attachment', 'opaque']);

export function isSyncable(archetype: string): boolean {
  return !SKIP_ARCHETYPES.has(archetype);
}

/** 前回の同期の時点の記録(1 ノート分)。 */
export interface SyncRecord {
  /** フォルダ直下のファイル名。 */
  file: string;
  /** 前回書いた(または取り込んだ)ファイルの内容のハッシュ。 */
  hash: string;
  /** 前回の同期の時点のノートの題名(改題を見つけて、ファイル名を付け替える)。`''` = 取り込んだばかりで未確認(次の回に確かめるだけで、名前は変えない)。 */
  title: string;
  /** 前回の同期の時点のノートの更新日時 / 文字数(世代)。 */
  updatedAt: string | null;
  chars: number | null;
}

export interface SyncManifest {
  format: typeof SYNC_FORMAT;
  version: typeof SYNC_VERSION;
  /** どの保存領域(container)の写しか ── 別の領域のフォルダへ書かない。 */
  cid: string;
  entries: Record<string, SyncRecord>;
  /** ノートが消えたあとも残してあるファイル(取り込み直さないための目印)。 */
  removed: Record<string, { file: string; hash: string }>;
}

export function emptyManifest(cid: string): SyncManifest {
  return { format: SYNC_FORMAT, version: SYNC_VERSION, cid, entries: {}, removed: {} };
}

/** 管理用の記録を読む。壊れていれば `null`(呼び手が「読めない」と言う ── 黙って作り直さない)。 */
export function parseManifest(text: string): SyncManifest | null {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    if (o['format'] !== SYNC_FORMAT || o['version'] !== SYNC_VERSION || typeof o['cid'] !== 'string') return null;
    const entries = o['entries'];
    const removed = o['removed'];
    if (typeof entries !== 'object' || entries === null || typeof removed !== 'object' || removed === null) return null;
    for (const r of Object.values(entries as Record<string, unknown>)) {
      const x = r as Partial<SyncRecord> | null;
      if (x === null || typeof x !== 'object' || typeof x.file !== 'string' || typeof x.hash !== 'string') return null;
    }
    return v as SyncManifest;
  } catch {
    return null;
  }
}

export interface LocalNote {
  lid: string;
  title: string;
  archetype: string;
  updatedAt: string | null;
  chars: number | null;
  /** 編集中・入力中など、いま触ってはいけない。 */
  busy: boolean;
}

export interface ExternalFile {
  name: string;
  /** 内容のハッシュ(呼び手が、前回から変わっていないファイルは記録を流用して計算を省く)。 */
  hash: string;
}

export type SyncAction =
  /** ノートの本文をファイルへ書く。`prevFile` は改題で名前が変わったときの前のファイル。 */
  | { kind: 'write'; lid: string; file: string; prevFile: string | null; reason: 'new' | 'local' | 'missing' | 'conflict' }
  /** ファイルの中身でノートの本文を置き換える。 */
  | { kind: 'pull'; lid: string; file: string }
  /** 新しいファイルを新しいノートとして取り込む。 */
  | { kind: 'adopt'; file: string }
  /** ノートが無くなった(または対象外になった)── 記録に「消した」と残す。 */
  | { kind: 'forget'; lid: string }
  /** いま触れない(編集中)。 */
  | { kind: 'defer'; lid: string };

/** 大文字小文字と正規化(NFC)を同一視する(macOS / Windows は同じファイルとして扱う)。 */
const fold = (s: string): string => s.normalize('NFC').toLowerCase();

/** 取り込める拡張子。 */
export function isMarkdownName(name: string): boolean {
  if (name.startsWith('.') || name.startsWith('_')) return false;
  return /\.(md|markdown)$/i.test(name);
}

/** 他のファイルと重ならない名前を配る(`題名.md`、`題名-2.md`…)。 */
export function claimName(used: Set<string>, title: string): string {
  const base = slugForTitle(title);
  for (let n = 1; ; n += 1) {
    const name = `${n === 1 ? base : `${base}-${n}`}.md`;
    const key = fold(name);
    if (!used.has(key)) {
      used.add(key);
      return name;
    }
  }
}

export interface SyncPlan {
  actions: SyncAction[];
  /** 書くと決めたノートに配った名前(`lid` → ファイル名)。呼び手が記録へ入れる。 */
  names: Map<string, string>;
}

export function planSync(
  manifest: SyncManifest,
  locals: readonly LocalNote[],
  externals: readonly ExternalFile[],
): SyncPlan {
  const actions: SyncAction[] = [];
  const names = new Map<string, string>();
  const extByName = new Map(externals.map((e) => [e.name, e]));
  // 使われている名前: フォルダに在るもの + 記録にあるもの(消した印のものも ── 上書きしない)
  const used = new Set<string>();
  for (const e of externals) used.add(fold(e.name));
  for (const r of Object.values(manifest.entries)) used.add(fold(r.file));
  for (const r of Object.values(manifest.removed)) used.add(fold(r.file));

  const eligible = locals.filter((n) => isSyncable(n.archetype));
  const live = new Set(eligible.map((n) => n.lid));

  for (const n of eligible) {
    if (n.busy) {
      actions.push({ kind: 'defer', lid: n.lid });
      continue;
    }
    const rec = manifest.entries[n.lid];
    if (rec === undefined) {
      const file = claimName(used, n.title);
      names.set(n.lid, file);
      actions.push({ kind: 'write', lid: n.lid, file, prevFile: null, reason: 'new' });
      continue;
    }
    const ext = extByName.get(rec.file);
    if (ext === undefined) {
      names.set(n.lid, rec.file);
      actions.push({ kind: 'write', lid: n.lid, file: rec.file, prevFile: null, reason: 'missing' });
      continue;
    }
    const localChanged = n.updatedAt !== rec.updatedAt || n.chars !== rec.chars;
    const extChanged = ext.hash !== rec.hash;
    if (localChanged && extChanged) {
      names.set(n.lid, rec.file);
      actions.push({ kind: 'write', lid: n.lid, file: rec.file, prevFile: null, reason: 'conflict' });
    } else if (localChanged) {
      // 🔑 改題されていたら新しい名前へ(古いファイルは、外で触られていないので置き換える)
      let file = rec.file;
      let prevFile: string | null = null;
      if (rec.title !== '' && n.title !== rec.title) {
        used.delete(fold(rec.file));
        file = claimName(used, n.title);
        prevFile = rec.file === file ? null : rec.file;
      }
      names.set(n.lid, file);
      actions.push({ kind: 'write', lid: n.lid, file, prevFile, reason: 'local' });
    } else if (extChanged) {
      actions.push({ kind: 'pull', lid: n.lid, file: rec.file });
    }
  }

  // ノートが無くなった記録 → 「消した」に移す(ファイルは残す)
  for (const lid of Object.keys(manifest.entries)) {
    if (!live.has(lid)) actions.push({ kind: 'forget', lid });
  }

  // 新しいファイル → 取り込む(記録にあるファイル・消した印と同じ内容のファイルは除く)
  const known = new Set(Object.values(manifest.entries).map((r) => fold(r.file)));
  const removedByFile = new Map(Object.values(manifest.removed).map((r) => [fold(r.file), r.hash]));
  const writing = new Set([...names.values()].map(fold));
  for (const e of externals) {
    if (!isMarkdownName(e.name)) continue;
    const key = fold(e.name);
    if (known.has(key) || writing.has(key)) continue;
    if (removedByFile.get(key) === e.hash) continue;
    actions.push({ kind: 'adopt', file: e.name });
  }
  return { actions, names };
}

/** 画面の一言(結果)。⚠ 0 件のものは言わない。 */
export interface SyncCounts {
  written: number;
  pulled: number;
  adopted: number;
  conflicts: number;
  deferred: number;
  failed: number;
}

export function describeSync(c: SyncCounts): string {
  const parts: string[] = [];
  if (c.written > 0) parts.push(`${c.written} 件をフォルダへ書きました`);
  if (c.pulled > 0) parts.push(`${c.pulled} 件をフォルダから取り込みました`);
  if (c.adopted > 0) parts.push(`${c.adopted} 件の新しいファイルをノートにしました`);
  if (c.conflicts > 0) parts.push(`${c.conflicts} 件は両方が変わっていたので、フォルダ側の版を『${SYNC_CONFLICT_DIR}』に残してノートの版を書きました`);
  if (c.deferred > 0) parts.push(`${c.deferred} 件は編集中なので次の回にします`);
  if (c.failed > 0) parts.push(`${c.failed} 件は失敗しました`);
  return parts.length === 0 ? '変更はありませんでした' : parts.join('、');
}
