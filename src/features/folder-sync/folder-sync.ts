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
 * - **フォルダ側のファイルが消えた**: 黙って書き戻さない。「フォルダで消えたノート」として画面に出し、行ごとに
 *   「書き戻す」か「同期から外す」を選んでもらう(外したノートは「同期に戻す」で戻せる)。
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
  /**
   * ノートが消えたあとも残してあるファイル(取り込み直さないための目印)。
   * 鍵: ノートの lid / `ignored:<ファイル名>`(最初の接続で取り込まないと答えた物)/ `stale:<ファイル名>`(改題で消せなかった前のファイル)。
   * ⚠ ノートの lid の鍵は、ゴミ箱から戻ったとき記録へ戻す(`reinstateReturned`)── 同じファイル名を使い続ける。
   */
  removed: Record<string, { file: string; hash: string }>;
  /** 「同期から外す」を選んだノート(lid)。⚠ 無い記録(旧)は空として読む。 */
  detached?: Record<string, true>;
}

export function emptyManifest(cid: string): SyncManifest {
  return { format: SYNC_FORMAT, version: SYNC_VERSION, cid, entries: {}, removed: {}, detached: {} };
}

export type ManifestRead =
  | { ok: true; manifest: SyncManifest }
  /** `broken` = JSON として・形として読めない / `version` = 別の版の記録(新しい PKC3 が書いたかもしれない) */
  | { ok: false; reason: 'broken' | 'version' };

/** 管理用の記録を読む。読めなければ理由を返す(呼び手が言って止める ── 黙って作り直さない)。 */
export function readManifest(text: string): ManifestRead {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null) return { ok: false, reason: 'broken' };
    const o = v as Record<string, unknown>;
    if (o['format'] !== SYNC_FORMAT) return { ok: false, reason: 'broken' };
    if (o['version'] !== SYNC_VERSION) return { ok: false, reason: typeof o['version'] === 'number' ? 'version' : 'broken' };
    if (typeof o['cid'] !== 'string') return { ok: false, reason: 'broken' };
    const entries = o['entries'];
    const removed = o['removed'];
    if (typeof entries !== 'object' || entries === null || typeof removed !== 'object' || removed === null) {
      return { ok: false, reason: 'broken' };
    }
    for (const r of Object.values(entries as Record<string, unknown>)) {
      const x = r as Partial<SyncRecord> | null;
      if (x === null || typeof x !== 'object' || typeof x.file !== 'string' || typeof x.hash !== 'string') {
        return { ok: false, reason: 'broken' };
      }
    }
    const m = v as SyncManifest;
    if (typeof m.detached !== 'object' || m.detached === null) m.detached = {};
    // 🔴 「消した」と「外した」の印は形を検査し、壊れた要素は捨てる(形の違う要素が 1 つあっても、計画の途中で落とさない)
    for (const [k, r] of Object.entries(m.removed)) {
      const x = r as Partial<{ file: string; hash: string }> | null;
      if (x === null || typeof x !== 'object' || typeof x.file !== 'string' || typeof x.hash !== 'string') delete m.removed[k];
    }
    for (const [k, r] of Object.entries(m.detached)) if (r !== true) delete m.detached[k];
    return { ok: true, manifest: m };
  } catch {
    return { ok: false, reason: 'broken' };
  }
}

/** 互換: 読めなければ `null`。 */
export function parseManifest(text: string): SyncManifest | null {
  const r = readManifest(text);
  return r.ok ? r.manifest : null;
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
  /** 内容のハッシュ(呼び手が、前回から変わっていないファイルは記録を流用して計算を省く)。読めないファイルは `''`。 */
  hash: string;
  /**
   * 読めないファイル(大きすぎる)。⚠ 中身を知らないので、**書き換えも取り込みもしない**(`unreadable` の action)。
   * 「読めない」を「変わっていない」や「変わった」と読むと、外の編集を黙って上書きする。
   */
  unreadable?: boolean;
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
  | { kind: 'defer'; lid: string }
  /** 記録にあるファイルが読めない(大きすぎる)── 書かず・取り込まず、そのままにする。 */
  | { kind: 'unreadable'; lid: string; file: string }
  /** フォルダでファイルが消えている ── 黙って書き戻さず、画面に出して選んでもらう。 */
  | { kind: 'gone'; lid: string; file: string }
  /** 「同期から外す」を選んだ(記録を外し、以後このノートは同期しない)。 */
  | { kind: 'detach'; lid: string };

/** 「フォルダで消えたノート」への答え。 */
export type GoneDecision = 'restore' | 'detach';

/** 大文字小文字と正規化(NFC)を同一視する(macOS / Windows は同じファイルとして扱う)。 */
export const foldName = (s: string): string => s.normalize('NFC').toLowerCase();
const fold = foldName;

/** 取り込める拡張子。⚠ 取り込みの入口の判定 ── 記録にあるファイルの照合には使わない(`_` や `.` で始まる名前も記録にある)。 */
export function isMarkdownName(name: string): boolean {
  if (name.startsWith('.') || name.startsWith('_')) return false;
  return /\.(md|markdown)$/i.test(name);
}

/**
 * 他のファイルと重ならない名前を配る(`題名.md`、`題名-2.md`…)。
 * 🔴 `_` と `.` で始まる名前は配らない ── 取り込みの入口(`isMarkdownName`)が隠しファイルや退避先と見なして外すので、
 *   書いたファイルが次の回に「無い」と読まれて書き直され続ける(題名が `_` で始まるノート)。先頭の `_` `.` は落とす。
 */
export function claimName(used: Set<string>, title: string): string {
  let base = slugForTitle(title).replace(/^[._\s]+/, '');
  if (base === '') base = 'ノート';
  for (let n = 1; ; n += 1) {
    const name = `${n === 1 ? base : `${base}-${n}`}.md`;
    const key = fold(name);
    if (!used.has(key)) {
      used.add(key);
      return name;
    }
  }
}

/**
 * ゴミ箱から戻ったノート(記録は「消した」に移してある)を、前のファイル名のまま記録へ戻す。
 * 🔴 戻さないと、戻ったノートは「新しいノート」と読まれて別の名前(`題名-2.md`)で書かれ、前のファイルと 2 つになる。
 * 世代は `null` にしておく(次の回に「ノート側が変わった」と読み、中身が同じなら書かずに世代だけ合わせる)。
 */
export function reinstateReturned(manifest: SyncManifest, locals: readonly LocalNote[]): number {
  let n = 0;
  for (const l of locals) {
    const gone = manifest.removed[l.lid];
    if (gone === undefined || manifest.entries[l.lid] !== undefined || !isSyncable(l.archetype)) continue;
    manifest.entries[l.lid] = { file: gone.file, hash: gone.hash, title: '', updatedAt: null, chars: null };
    delete manifest.removed[l.lid];
    n += 1;
  }
  return n;
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
  /** 「フォルダで消えたノート」への答え(lid → 書き戻す / 同期から外す)。 */
  decisions: ReadonlyMap<string, GoneDecision> = new Map(),
): SyncPlan {
  const actions: SyncAction[] = [];
  const names = new Map<string, string>();
  // 🔴 名前の照合は大文字小文字・正規化を同一視する(macOS / Windows でファイラが綴りを変えても同じファイル)
  const extByName = new Map(externals.map((e) => [fold(e.name), e]));
  // 使われている名前: フォルダに在るもの + 記録にあるもの(消した印のものも ── 上書きしない)
  const used = new Set<string>();
  for (const e of externals) used.add(fold(e.name));
  for (const r of Object.values(manifest.entries)) used.add(fold(r.file));
  for (const r of Object.values(manifest.removed)) used.add(fold(r.file));
  const detached = manifest.detached ?? {};
  // 同じファイルを 2 つの記録が指していたら(壊れた記録)先の 1 つだけが持つ ── 2 つが同じファイルを書き合わない
  const owner = new Map<string, string>();
  for (const [lid, r] of Object.entries(manifest.entries)) if (!owner.has(fold(r.file))) owner.set(fold(r.file), lid);

  const eligible = locals.filter((n) => isSyncable(n.archetype));
  const live = new Set(eligible.map((n) => n.lid));

  for (const n of eligible) {
    if (detached[n.lid] === true) continue;
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
    if (owner.get(fold(rec.file)) !== n.lid) {
      // 別のノートの記録と同じファイルを指している ── 新しい名前で書き直す(記録は呼び手が差し替える)
      const file = claimName(used, n.title);
      names.set(n.lid, file);
      actions.push({ kind: 'write', lid: n.lid, file, prevFile: null, reason: 'new' });
      continue;
    }
    const decision = decisions.get(n.lid);
    if (decision === 'detach') {
      actions.push({ kind: 'detach', lid: n.lid });
      continue;
    }
    const ext = extByName.get(fold(rec.file));
    if (ext === undefined) {
      if (decision === 'restore') {
        names.set(n.lid, rec.file);
        actions.push({ kind: 'write', lid: n.lid, file: rec.file, prevFile: null, reason: 'missing' });
      } else {
        actions.push({ kind: 'gone', lid: n.lid, file: rec.file });
      }
      continue;
    }
    if (ext.unreadable === true) {
      actions.push({ kind: 'unreadable', lid: n.lid, file: rec.file });
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
        // 🔴 大文字小文字・NFC だけの改題は同じファイル(大文字小文字を区別しない FS で、書いたばかりのファイルを消さない)
        prevFile = fold(rec.file) === fold(file) ? null : rec.file;
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

  // 新しいファイル → 取り込む(記録にあるファイル・消した印と同じ内容のファイル・読めないファイルは除く)
  const known = new Set(Object.values(manifest.entries).map((r) => fold(r.file)));
  const removedByFile = new Map(Object.values(manifest.removed).map((r) => [fold(r.file), r.hash]));
  const writing = new Set([...names.values()].map(fold));
  for (const e of externals) {
    if (!isMarkdownName(e.name) || e.unreadable === true) continue;
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
  /** フォルダでファイルが消えているノート(選んでもらう)。 */
  gone: number;
  failed: number;
}

export function describeSync(c: SyncCounts): string {
  const parts: string[] = [];
  if (c.written > 0) parts.push(`${c.written} 件をフォルダへ書きました`);
  if (c.pulled > 0) parts.push(`${c.pulled} 件をフォルダから取り込みました`);
  if (c.adopted > 0) parts.push(`${c.adopted} 件の新しいファイルをノートにしました`);
  if (c.conflicts > 0) parts.push(`${c.conflicts} 件は両方が変わっていたので、フォルダ側の版を『${SYNC_CONFLICT_DIR}』に残してノートの版を書きました`);
  if (c.deferred > 0) parts.push(`${c.deferred} 件は編集中か読めないファイルなので、そのままにしました`);
  if (c.gone > 0) parts.push(`${c.gone} 件はフォルダでファイルが消えています(PC タブで選べます)`);
  if (c.failed > 0) parts.push(`${c.failed} 件は失敗しました`);
  return parts.length === 0 ? '変更はありませんでした' : parts.join('、');
}
