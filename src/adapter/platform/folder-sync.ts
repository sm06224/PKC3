/**
 * 🔴 **PC のフォルダと同期する**(#1455 の後半。「PC」タブの仕組みに寄せる)。
 *
 * > 「SQLite を正本とし、外部フォルダーへの定期同期・書き出し／読み込み として非同期・疎結合に保つ」
 *
 * 何を書き、何を取り込み、何を残すかの**判断**は `features/folder-sync/folder-sync.ts`(純関数)。
 * ここは **handle の持ち主**と、読み書き・ハッシュ・タイマー・直列化だけを持つ。
 *
 * ## ⚠ handle はこの module だけが持つ。state にも IndexedDB にも置かない(`local-folder.ts` と同じ作法)
 *
 * - **このセッションだけ**。開き直すと同期は止まり、PC タブで選び直す(#215 の「毎回選び直す」裁定)。
 *   権限が切れたら止めて「もう一度選んでください」と言う(黙って書けない状態で回り続けない)。
 * - 選べないブラウザ(`showDirectoryPicker` が無い Firefox / Safari)では、**理由を言って断る**。
 *
 * ## 安全
 *
 * - 書く先は選んだフォルダの**直下**だけ(`<題名>.md` と管理用の `.pkc3-sync.json`、競合の退避 `_conflicts/`)。
 * - **照合は世代とハッシュ**(ノートの更新日時・文字数 / ファイルの内容の SHA-256)。どちらも変わっていなければ触らない。
 * - 競合(両方が変わった)は **PKC3 の版を書く前に、フォルダ側の版を `_conflicts/` へ写す**(消えない)。
 * - フォルダの内容でノートの本文を置き換えるときは `REIMPORT_BODY`(前の本文は履歴に残る)。
 *   ⚠ **読んでいる間にノートが変わった / 編集が始まったら置き換えない**(世代を確かめ直す)。
 * - UTF-8 として読めないファイルは取り込まない(文字化けでノートを壊さない)。
 * - 1 つずつ await で読み書きし、メインスレッドを塞がない。重い計算は無い(ハッシュは `crypto.subtle` = ブラウザ内部)。
 * - 管理用の記録が壊れている・別の保存領域のものなら、**何も書かずに止める**。
 */
import { errorText } from '@features/error-text';
import {
  SYNC_CONFLICT_DIR,
  SYNC_DEFAULT_MINUTES,
  SYNC_INTERVAL_MINUTES,
  SYNC_MANIFEST_NAME,
  describeSync,
  emptyManifest,
  isMarkdownName,
  parseManifest,
  planSync,
  type ExternalFile,
  type LocalNote,
  type SyncCounts,
  type SyncIntervalMinutes,
  type SyncManifest,
} from '@features/folder-sync/folder-sync';
import { IMPORT_TEXT_MAX_BYTES } from '@features/import/text-decode';
import { humanBytes } from '@features/human-bytes';
import { slugForTitle } from '@features/export/pkc3-markdown-zip';

/** `FileSystemWritableFileStream`(必要な部分だけ)。 */
interface WritableLike {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface SyncFileHandleLike {
  readonly kind: 'file';
  readonly name: string;
  createWritable(): Promise<WritableLike>;
  getFile(): Promise<File>;
}

/** 読み書きできる `FileSystemDirectoryHandle`(必要な部分だけ)。 */
export interface SyncDirLike {
  readonly name: string;
  values(): AsyncIterable<{ kind: string; name: string }>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<SyncFileHandleLike>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<SyncDirLike>;
  removeEntry(name: string): Promise<void>;
  queryPermission?(descriptor: { mode: string }): Promise<string>;
}

export type SyncDirPicker = (options: { mode: 'readwrite' }) => Promise<SyncDirLike>;

/** 窓の `showDirectoryPicker` を引く(無ければ `null` ── Firefox / Safari)。 */
export function windowSyncPicker(win: object = window): SyncDirPicker | null {
  const fn = (win as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  if (typeof fn !== 'function') return null;
  return (options) => (fn as (o: { mode: string }) => Promise<SyncDirLike>).call(win, options);
}

/** 選べないブラウザで言う理由。 */
export const SYNC_UNSUPPORTED_NOTE =
  'このブラウザはフォルダへの書き込みを許可する仕組みを持たないため、同期は使えません(Chrome / Edge で開いてください)';

export type FolderSyncPhase = 'unsupported' | 'none' | 'idle' | 'running' | 'lost' | 'stopped';

export interface FolderSyncView {
  /** 変わるたびに増える(描画器の指紋)。 */
  readonly version: number;
  readonly phase: FolderSyncPhase;
  readonly folderName: string | null;
  readonly minutes: SyncIntervalMinutes;
  /** 直近の結果の一言(無ければ `null`)。 */
  readonly lastText: string | null;
  /** 直近の同期の時刻(`HH:MM`。無ければ `null`)。 */
  readonly lastAt: string | null;
  /** `lost` / `stopped` のときの理由。 */
  readonly message: string | null;
}

export interface FolderSyncDeps {
  /** `null` = このブラウザには無い。 */
  picker: SyncDirPicker | null;
  /** いまの保存領域の id(別の領域の記録を持つフォルダへは書かない)。 */
  cid(): string;
  /** 同期の対象を選ぶ前の、全ノートの控え(`entryMetas` から)。 */
  notes(): readonly Omit<LocalNote, 'busy'>[];
  /** いま触ってはいけない(編集中・入力中)。 */
  isBusy(lid: string): boolean;
  /** 同期を始めてよい状態か(読み込み中・保存に失敗して止まっている・章の欄が開いている間は `false`)。 */
  ready(): boolean;
  /** 直前の保存が disk に着くのを待つ(本文を読む前に)。 */
  settle(): Promise<void>;
  readBody(lid: string): Promise<string | null>;
  /** 別のタブ・窓が編集中か(置き換えの前に確かめる。省くと確かめない)。確かめられなければ `true`(置き換えない)。 */
  editedElsewhere?(lid: string): Promise<boolean>;
  /** 本文を置き換える(`REIMPORT_BODY`)。前の本文は履歴に残る。 */
  replaceBody(lid: string, body: string): void;
  /** 新しいファイルをノートにする。⚠ ファイルの順で lid を返す(取り込めなかったら空)。 */
  adopt(files: File[]): Promise<readonly string[]>;
  /** 最初の接続で、フォルダに在る Markdown を取り込むかを聞く。 */
  askAdopt(message: string): Promise<boolean>;
  /** 結果の知らせ・失敗の知らせ(画面の下の 1 行ではなくメッセージへ ── 配線は呼び手)。 */
  say(text: string): void;
  fail(text: string): void;
  /** 見え方が変わったときに呼ぶ(面を描き直す)。 */
  onChange(): void;
  /** テスト用の差し替え口。 */
  hash?(bytes: ArrayBuffer): Promise<string>;
  now?(): Date;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

const errName = (e: unknown): string =>
  typeof e === 'object' && e !== null ? String((e as { name?: unknown }).name ?? '') : '';

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** UTF-8 として厳密に読む(読めなければ `null` ── 文字化けでノートを壊さない)。 */
function decodeUtf8(bytes: ArrayBuffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export class FolderSync {
  private dir: SyncDirLike | null = null;
  private phase: FolderSyncPhase;
  private minutes: SyncIntervalMinutes = SYNC_DEFAULT_MINUTES;
  private lastText: string | null = null;
  private lastAt: string | null = null;
  private message: string | null = null;
  private version = 0;
  private timer: unknown = null;
  /** 「選び直し」「やめる」で増える。古い同期の続きを捨てる札。 */
  private generation = 0;
  private running = false;
  /** UTF-8 で読めない / 大きすぎて取り込まなかったファイル(同じ知らせを毎回出さない)。 */
  private readonly skipped = new Set<string>();
  /** 前回のハッシュ(名前 → 大きさ・更新日時・ハッシュ)。同じなら読み直さない。 */
  private readonly hashed = new Map<string, { size: number; mtime: number; hash: string }>();

  constructor(private readonly deps: FolderSyncDeps) {
    this.phase = deps.picker === null ? 'unsupported' : 'none';
  }

  view(): FolderSyncView {
    return {
      version: this.version,
      phase: this.phase,
      folderName: this.dir?.name ?? null,
      minutes: this.minutes,
      lastText: this.lastText,
      lastAt: this.lastAt,
      message: this.phase === 'unsupported' ? SYNC_UNSUPPORTED_NOTE : this.message,
    };
  }

  /** いま持っている handle(検査用 ── 「やめる」で捨てたかを見る)。 */
  heldHandle(): SyncDirLike | null {
    return this.dir;
  }

  private changed(): void {
    this.version += 1;
    this.deps.onChange();
  }

  private setTimer(): void {
    this.clearTimer();
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const gen = this.generation;
    this.timer = set(() => {
      this.timer = null;
      if (gen === this.generation) void this.syncNow(false);
    }, this.minutes * 60 * 1000);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    (this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  /**
   * フォルダを選んで、すぐ 1 回同期する。⚠ **user の操作の流れの中で呼ぶ**(OS の選択は gesture が要る ──
   * `await` を挟まずに `picker` へ渡す)。選ばずに閉じたら何も変えない。
   */
  async pick(): Promise<void> {
    const picker = this.deps.picker;
    if (picker === null) return;
    let dir: SyncDirLike;
    try {
      dir = await picker({ mode: 'readwrite' });
    } catch (e) {
      if (errName(e) === 'AbortError') return;
      this.deps.fail(`同期するフォルダを開けませんでした: ${errorText(e)}`);
      return;
    }
    this.generation += 1;
    this.clearTimer();
    this.dir = dir;
    this.phase = 'idle';
    this.message = null;
    this.lastText = null;
    this.lastAt = null;
    this.hashed.clear();
    this.skipped.clear();
    this.changed();
    await this.syncNow(true);
  }

  /** 同期をやめる(handle を捨てる。フォルダのファイルとノートには何もしない)。 */
  stop(): void {
    this.generation += 1;
    this.clearTimer();
    this.dir = null;
    this.phase = this.deps.picker === null ? 'unsupported' : 'none';
    this.message = null;
    this.lastText = null;
    this.lastAt = null;
    this.hashed.clear();
    this.skipped.clear();
    this.changed();
  }

  /** 間隔を変える(動いているタイマーも張り直す)。 */
  setMinutes(minutes: number): void {
    const m = SYNC_INTERVAL_MINUTES.find((x) => x === minutes);
    if (m === undefined || m === this.minutes) return;
    this.minutes = m;
    if (this.dir !== null && this.phase !== 'lost' && this.phase !== 'stopped') this.setTimer();
    this.changed();
  }

  /**
   * 1 回同期する。⚠ 重ならない(動いている間に呼ばれたら何もしない)。
   * @param manual user が押した回。`false` = タイマー(黙って済ませられる回は黙る)
   */
  async syncNow(manual: boolean): Promise<void> {
    const dir = this.dir;
    if (dir === null || this.running) return;
    if (this.phase === 'lost' || this.phase === 'stopped') {
      if (manual) this.deps.fail(this.message ?? 'フォルダを選び直してください');
      return;
    }
    if (!this.deps.ready()) {
      // 編集中などは次の回へ(タイマーの回は黙る)
      if (manual) this.deps.say('いまは同期できません(編集を終えると同期できます)');
      this.setTimer();
      return;
    }
    const gen = this.generation;
    this.running = true;
    this.phase = 'running';
    this.changed();
    try {
      if (dir.queryPermission !== undefined && (await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        this.halt(gen, 'lost', '許可が切れたので同期を止めました。PC タブでもう一度フォルダを選んでください');
        return;
      }
      const counts = await this.runOnce(dir, gen);
      if (gen !== this.generation || counts === null) return;
      const text = describeSync(counts);
      this.lastText = text;
      this.lastAt = this.clock();
      if (manual || counts.written + counts.pulled + counts.adopted + counts.conflicts + counts.failed > 0) {
        this.deps.say(`フォルダと同期しました: ${text}`);
      }
      this.phase = 'idle';
      this.changed();
      this.setTimer();
    } catch (e) {
      if (gen !== this.generation) return;
      if (errName(e) === 'NotAllowedError' || errName(e) === 'SecurityError') {
        this.halt(gen, 'lost', '許可が切れたので同期を止めました。PC タブでもう一度フォルダを選んでください');
      } else {
        // 一時的な失敗かもしれない(ファイルが使われている等)── 理由を言い、次の回でやり直す
        this.deps.fail(`フォルダとの同期に失敗しました: ${errorText(e)}`);
        this.phase = 'idle';
        this.lastText = `失敗しました(${errorText(e)})`;
        this.lastAt = this.clock();
        this.changed();
        this.setTimer();
      }
    } finally {
      this.running = false;
    }
  }

  private clock(): string {
    const d = this.deps.now?.() ?? new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /** 続けられない理由で止める(タイマーを外し、理由を画面に残す)。 */
  private halt(gen: number, phase: 'lost' | 'stopped', message: string): void {
    if (gen !== this.generation) return;
    this.clearTimer();
    this.phase = phase;
    this.message = message;
    this.deps.fail(message);
    this.changed();
  }

  private async hashOf(bytes: ArrayBuffer): Promise<string> {
    return (this.deps.hash ?? sha256Hex)(bytes);
  }

  private async readManifest(dir: SyncDirLike): Promise<{ manifest: SyncManifest; fresh: boolean } | 'broken'> {
    let fh: SyncFileHandleLike;
    try {
      fh = await dir.getFileHandle(SYNC_MANIFEST_NAME);
    } catch (e) {
      if (errName(e) === 'NotFoundError') return { manifest: emptyManifest(this.deps.cid()), fresh: true };
      throw e;
    }
    const parsed = parseManifest(await (await fh.getFile()).text());
    return parsed === null ? 'broken' : { manifest: parsed, fresh: false };
  }

  private async writeManifest(dir: SyncDirLike, manifest: SyncManifest): Promise<void> {
    await this.writeText(dir, SYNC_MANIFEST_NAME, JSON.stringify(manifest, null, 1));
  }

  /** 1 つのファイルへ書く。⚠ `close()` までが書き込み(途中で失敗したら元のファイルは変わらない)。 */
  private async writeText(dir: SyncDirLike, name: string, text: string): Promise<ArrayBuffer> {
    const bytes = new TextEncoder().encode(text);
    // 🔴 新しく作ったファイルが書けなかったら、0 バイトの書きかけを残さない(次の回で「外のファイル」に見える)
    let existed = true;
    try {
      await dir.getFileHandle(name);
    } catch (e) {
      if (errName(e) !== 'NotFoundError') throw e;
      existed = false;
    }
    const fh = await dir.getFileHandle(name, { create: true });
    try {
      const w = await fh.createWritable();
      try {
        await w.write(new Blob([bytes]));
        await w.close();
      } catch (e) {
        await w.abort?.().catch(() => {});
        throw e;
      }
    } catch (e) {
      if (!existed) await dir.removeEntry(name).catch(() => {});
      throw e;
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  /** フォルダ直下の .md を列挙してハッシュを引く。 */
  private async listExternals(
    dir: SyncDirLike,
    watched: ReadonlySet<string>,
  ): Promise<{ files: ExternalFile[]; failed: number }> {
    const files: ExternalFile[] = [];
    let failed = 0;
    const seen = new Set<string>();
    for await (const e of dir.values()) {
      if (e.kind !== 'file' || !isMarkdownName(e.name)) {
        // 記録にあるのに .md でない名前は無い(書くのは .md だけ)
        continue;
      }
      if (!watched.has(e.name) && this.skipped.has(e.name)) {
        seen.add(e.name);
        continue;
      }
      try {
        const fh = await dir.getFileHandle(e.name);
        const file = await fh.getFile();
        seen.add(e.name);
        const prev = this.hashed.get(e.name);
        if (prev !== undefined && prev.size === file.size && prev.mtime === file.lastModified) {
          files.push({ name: e.name, hash: prev.hash });
          continue;
        }
        if (file.size > IMPORT_TEXT_MAX_BYTES) {
          // 大きすぎるファイルは読まない(取り込まない・書き換えない)── 同じ知らせを毎回出さない
          if (!this.skipped.has(e.name)) {
            this.skipped.add(e.name);
            this.deps.fail(`「${e.name}」は大きすぎて同期できません(${humanBytes(IMPORT_TEXT_MAX_BYTES)} まで)`);
          }
          failed += 1;
          continue;
        }
        const hash = await this.hashOf(await file.arrayBuffer());
        this.hashed.set(e.name, { size: file.size, mtime: file.lastModified, hash });
        files.push({ name: e.name, hash });
      } catch (err) {
        if (errName(err) === 'NotFoundError') continue; // 列挙と読みの間に消えた
        throw err;
      }
    }
    for (const k of [...this.hashed.keys()]) if (!seen.has(k)) this.hashed.delete(k);
    return { files, failed };
  }

  private async runOnce(dir: SyncDirLike, gen: number): Promise<SyncCounts | null> {
    const counts: SyncCounts = { written: 0, pulled: 0, adopted: 0, conflicts: 0, deferred: 0, failed: 0 };
    const got = await this.readManifest(dir);
    if (got === 'broken') {
      this.halt(
        gen,
        'stopped',
        `フォルダの同期の記録(${SYNC_MANIFEST_NAME})を読めないので、何も書かずに止めました。別の用途のフォルダかもしれません。記録を消すか、別のフォルダを選んでください`,
      );
      return null;
    }
    const { manifest, fresh } = got;
    if (manifest.cid !== this.deps.cid()) {
      this.halt(
        gen,
        'stopped',
        'このフォルダは別の保存領域との同期に使われているため、何も書かずに止めました。別のフォルダを選んでください',
      );
      return null;
    }
    const watched = new Set(Object.values(manifest.entries).map((r) => r.file));
    const { files: externals, failed } = await this.listExternals(dir, watched);
    counts.failed += failed;
    if (gen !== this.generation) return null;
    const locals: LocalNote[] = this.deps.notes().map((n) => ({ ...n, busy: this.deps.isBusy(n.lid) }));
    const plan = planSync(manifest, locals, externals);
    const hashOf = new Map(externals.map((e) => [e.name, e.hash]));

    // 最初の接続で、フォルダに在る Markdown を取り込むかを聞く(断られたら「見た」として記録だけ残す)
    let allowAdopt = true;
    const adoptNames = plan.actions.flatMap((a) => (a.kind === 'adopt' ? [a.file] : []));
    if (fresh && adoptNames.length > 0) {
      allowAdopt = await this.deps.askAdopt(
        `このフォルダに Markdown のファイルが ${adoptNames.length} 件あります。ノートとして取り込みますか。` +
          '(取り込まない場合も、ファイルは書き換えません)',
      );
      if (gen !== this.generation) return null;
      if (!allowAdopt) {
        for (const f of adoptNames) manifest.removed[`ignored:${f}`] = { file: f, hash: hashOf.get(f) ?? '' };
      }
    }

    const stampOf = (lid: string): { updatedAt: string | null; chars: number | null } | null => {
      const n = this.deps.notes().find((x) => x.lid === lid);
      return n === undefined ? null : { updatedAt: n.updatedAt, chars: n.chars };
    };
    const adopts: string[] = [];

    for (const a of plan.actions) {
      if (gen !== this.generation) return null;
      try {
        if (a.kind === 'defer') {
          counts.deferred += 1;
        } else if (a.kind === 'forget') {
          const r = manifest.entries[a.lid];
          if (r !== undefined) {
            manifest.removed[a.lid] = { file: r.file, hash: r.hash };
            delete manifest.entries[a.lid];
          }
        } else if (a.kind === 'adopt') {
          if (allowAdopt) adopts.push(a.file);
        } else if (a.kind === 'pull') {
          if (await this.pull(dir, manifest, a.lid, a.file, hashOf.get(a.file) ?? '', stampOf)) counts.pulled += 1;
          else counts.deferred += 1;
        } else {
          const r = await this.write(dir, manifest, a, hashOf, stampOf);
          if (r === 'wrote') counts.written += 1;
          else if (r === 'conflict') {
            counts.written += 1;
            counts.conflicts += 1;
          } else if (r === 'deferred') counts.deferred += 1;
        }
      } catch (e) {
        if (errName(e) === 'NotAllowedError' || errName(e) === 'SecurityError') throw e;
        counts.failed += 1;
        this.deps.fail(
          `フォルダとの同期で『${a.kind === 'adopt' || a.kind === 'pull' || a.kind === 'write' ? a.file : a.lid}』を処理できませんでした: ${errorText(e)}`,
        );
      }
    }

    if (adopts.length > 0) counts.adopted += await this.adoptFiles(dir, manifest, adopts, hashOf, stampOf, counts);
    if (gen !== this.generation) return null;
    // 記録は最後に 1 回(途中で失敗しても、書けた分の記録は残す)
    await this.writeManifest(dir, manifest);
    return counts;
  }

  /** ノートの本文をファイルへ書く。 */
  private async write(
    dir: SyncDirLike,
    manifest: SyncManifest,
    a: Extract<ReturnType<typeof planSync>['actions'][number], { kind: 'write' }>,
    hashOf: ReadonlyMap<string, string>,
    stampOf: (lid: string) => { updatedAt: string | null; chars: number | null } | null,
  ): Promise<'wrote' | 'conflict' | 'deferred' | 'skipped'> {
    if (this.deps.isBusy(a.lid)) return 'deferred';
    await this.deps.settle();
    // 🔑 世代は本文を読む**前**に採る(読んだ後に変わっても、次の回で「変わった」と読める)
    const stamp = stampOf(a.lid);
    const meta = this.deps.notes().find((n) => n.lid === a.lid);
    if (stamp === null || meta === undefined) return 'skipped';
    const body = await this.deps.readBody(a.lid);
    if (body === null) return 'skipped';
    const bytes = new TextEncoder().encode(body);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const hash = await this.hashOf(buf);
    const prev = manifest.entries[a.lid];
    const record = { file: a.file, hash, title: meta.title, updatedAt: stamp.updatedAt, chars: stamp.chars };
    // ファイルの中身がもう同じなら書かない(フォルダから取り込んだ直後の世代の更新など)
    if (a.reason === 'local' && a.prevFile === null && prev !== undefined && hashOf.get(a.file) === hash) {
      manifest.entries[a.lid] = record;
      return 'skipped';
    }
    let conflict = false;
    if (a.reason === 'conflict' && hashOf.has(a.file)) {
      // 🔴 フォルダ側の版を消す前に写す(競合の退避)
      await this.saveConflict(dir, a.file);
      conflict = true;
    }
    await this.writeText(dir, a.file, body);
    const written = await (await dir.getFileHandle(a.file)).getFile();
    this.hashed.set(a.file, { size: written.size, mtime: written.lastModified, hash });
    manifest.entries[a.lid] = record;
    if (a.prevFile !== null && a.prevFile !== a.file) {
      // 改題で名前が変わった: 前のファイルは外で触られていない(計画が確かめた)ので置き換え済みとして外す
      await dir.removeEntry(a.prevFile).catch(() => {});
      this.hashed.delete(a.prevFile);
    }
    return conflict ? 'conflict' : 'wrote';
  }

  /** フォルダ側の版を `_conflicts/<題名>-<日時>.md` へ写す。 */
  private async saveConflict(dir: SyncDirLike, file: string): Promise<void> {
    const src = await (await dir.getFileHandle(file)).getFile();
    const sub = await dir.getDirectoryHandle(SYNC_CONFLICT_DIR, { create: true });
    const d = this.deps.now?.() ?? new Date();
    const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    const stem = slugForTitle(file.replace(/\.(md|markdown)$/i, ''));
    for (let n = 1; ; n += 1) {
      const name = `${stem}-${stamp}${n === 1 ? '' : `-${n}`}.md`;
      try {
        await sub.getFileHandle(name);
        continue; // 在る
      } catch (e) {
        if (errName(e) !== 'NotFoundError') throw e;
      }
      const fh = await sub.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      try {
        await w.write(src);
        await w.close();
      } catch (e) {
        await w.abort?.().catch(() => {});
        throw e;
      }
      return;
    }
  }

  /** ファイルの中身でノートの本文を置き換える。 */
  private async pull(
    dir: SyncDirLike,
    manifest: SyncManifest,
    lid: string,
    file: string,
    hash: string,
    stampOf: (lid: string) => { updatedAt: string | null; chars: number | null } | null,
  ): Promise<boolean> {
    const rec = manifest.entries[lid];
    if (rec === undefined || this.deps.isBusy(lid)) return false;
    const f = await (await dir.getFileHandle(file)).getFile();
    const bytes = await f.arrayBuffer();
    // 読んでいる間にファイルが変わっていたら、次の回へ(ハッシュが計画と違う)
    if ((await this.hashOf(bytes)) !== hash) return false;
    const text = decodeUtf8(bytes);
    if (text === null) {
      if (!this.skipped.has(file)) {
        this.skipped.add(file);
        this.deps.fail(`「${file}」は UTF-8 として読めないので、ノートに取り込みませんでした(ノートはそのままです)`);
      }
      return false;
    }
    if (this.deps.editedElsewhere !== undefined && (await this.deps.editedElsewhere(lid))) return false;
    // 🔴 世代を確かめ直す: 読んでいる間にノートが変わった / 編集が始まったら置き換えない
    const now = stampOf(lid);
    if (now === null || now.updatedAt !== rec.updatedAt || now.chars !== rec.chars || this.deps.isBusy(lid)) return false;
    this.deps.replaceBody(lid, text);
    // 記録: ファイルの内容を「前回の内容」にする。ノートの世代は置き換えの後に動く ── 次の回で本文が同じと確かめて世代だけ更新する
    manifest.entries[lid] = { ...rec, hash };
    return true;
  }

  /** 新しいファイルを新しいノートにする(50 件ずつ)。 */
  private async adoptFiles(
    dir: SyncDirLike,
    manifest: SyncManifest,
    names: readonly string[],
    hashOf: ReadonlyMap<string, string>,
    stampOf: (lid: string) => { updatedAt: string | null; chars: number | null } | null,
    counts: SyncCounts,
  ): Promise<number> {
    let adopted = 0;
    for (let at = 0; at < names.length; at += 50) {
      const batch: { name: string; file: File }[] = [];
      for (const name of names.slice(at, at + 50)) {
        const file = await (await dir.getFileHandle(name)).getFile();
        const bytes = await file.arrayBuffer();
        if (decodeUtf8(bytes) === null) {
          if (!this.skipped.has(name)) {
            this.skipped.add(name);
            this.deps.fail(`「${name}」は UTF-8 として読めないので、ノートに取り込みませんでした`);
          }
          counts.failed += 1;
          continue;
        }
        batch.push({ name, file });
      }
      if (batch.length === 0) continue;
      const lids = await this.deps.adopt(batch.map((b) => b.file));
      if (lids.length !== batch.length) {
        counts.failed += batch.length;
        continue;
      }
      batch.forEach((b, i) => {
        const lid = lids[i]!;
        const s = stampOf(lid);
        manifest.entries[lid] = {
          file: b.name,
          hash: hashOf.get(b.name) ?? '',
          title: '',
          updatedAt: s?.updatedAt ?? null,
          chars: s?.chars ?? null,
        };
        adopted += 1;
      });
    }
    return adopted;
  }
}
