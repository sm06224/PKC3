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
 * - 🔴 **上書き・削除の直前にハッシュを取り直す**。計画を立ててから書くまでの間に外で直されていたら、
 *   上書きせず「競合」に倒す(フォルダ側の版を `_conflicts/` へコピーしてから書く)。
 * - 競合(両方が変わった)は **PKC3 の版を書く前に、フォルダ側の版を `_conflicts/` へコピーする**(消えない)。
 * - フォルダの内容でノートの本文を置き換えるときは `REIMPORT_BODY`(前の本文は履歴に残る)。
 *   ⚠ **読んでいる間にノートが変わった / 編集が始まったら置き換えない**(世代を確かめ直す)。
 * - UTF-8 として読めないファイル・大きすぎて読めないファイルは取り込まない。大きすぎるファイルは**上書きもしない**。
 * - 🔴 **記録(`.pkc3-sync.json`)は、書けた分を必ず保存する**(`finally`)+ 100 件ごと + 新しいノートを作った直後。
 *   最後にしか書かないと、途中の失敗・許可切れ・タブを閉じるで、次の回に同じファイルが重複ノートになる。
 * - 🔴 **同じフォルダの同期は 1 つしか走らない**(`navigator.locks`。別のタブ・ウィンドウと重ならない)。
 * - 1 つずつ await で読み書きし、メインスレッドを塞がない。重い計算は無い(ハッシュは `crypto.subtle` = ブラウザ内部)。
 * - 管理用の記録が読めない・別の版・別の保存領域のものなら、**何も書かずに止める**。
 */
import { errorText } from '@features/error-text';
import {
  SYNC_CONFLICT_DIR,
  SYNC_DEFAULT_MINUTES,
  SYNC_INTERVAL_MINUTES,
  SYNC_MANIFEST_NAME,
  describeSync,
  emptyManifest,
  foldName,
  isMarkdownName,
  planSync,
  readManifest as readManifestText,
  reinstateReturned,
  type ExternalFile,
  type GoneDecision,
  type LocalNote,
  type SyncAction,
  type SyncCounts,
  type SyncIntervalMinutes,
  type SyncManifest,
} from '@features/folder-sync/folder-sync';
import { IMPORT_TEXT_MAX_BYTES } from '@features/import/text-decode';
import { humanBytes } from '@features/human-bytes';
import { slugForTitle } from '@features/export/pkc3-markdown-zip';

/** 記録をこの件数ごとに保存する。 */
export const SYNC_SAVE_EVERY = 100;
/** 記録を、前の保存からこの時間(ms)が過ぎたら保存する(件数が少なくても、タブを閉じる・落ちるに備える)。 */
export const SYNC_SAVE_EVERY_MS = 2000;

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

/**
 * 排他の口。`fn` を動かせたら `true`、ほかが動かしていて取れなかったら `false`。
 * ⚠ 口が無い環境(`navigator.locks` が無い)では `null` ── 排他なしで動かす(同じタブの中は `FolderSync` が直列にする)。
 */
export type SyncLock = (key: string, fn: () => Promise<void>) => Promise<boolean>;

export function windowSyncLock(nav: object = navigator): SyncLock | null {
  const locks = (nav as { locks?: { request?: unknown } }).locks;
  if (locks === undefined || typeof locks.request !== 'function') return null;
  const request = (locks.request as (n: string, o: object, cb: (l: unknown) => Promise<void>) => Promise<void>).bind(locks);
  return async (key, fn) => {
    let ran = false;
    // ⚠ 不透明な origin・file:// などでは request 自身が SecurityError で reject する ── 呼び手が「排他なしで動かす」へ落とせるよう、
    //   動かす前の reject はそのまま投げる(`FolderSync.runLocked` が受ける)。動かした後の例外は握らない
    await request(key, { ifAvailable: true }, async (lock) => {
      if (lock === null) return;
      ran = true;
      await fn();
    });
    return ran;
  };
}

/** 選べないブラウザで言う理由。 */
export const SYNC_UNSUPPORTED_NOTE =
  'このブラウザはフォルダへの書き込みを許可する仕組みを持たないため、同期は使えません(Chrome / Edge で開いてください)';

export const SYNC_OTHER_TAB_NOTE = '別のタブ・ウィンドウが、このフォルダを同期しています(終わったあとの回に同期します)';

export type FolderSyncPhase = 'unsupported' | 'none' | 'idle' | 'running' | 'lost' | 'stopped';

export interface FolderSyncNoteRow {
  readonly lid: string;
  readonly title: string;
}

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
  /** フォルダでファイルが消えているノート(書き戻す / 同期から外す を選んでもらう)。 */
  readonly gone: readonly FolderSyncNoteRow[];
  /** 「同期から外した」ノート(「同期に戻す」で戻せる)。 */
  readonly detached: readonly FolderSyncNoteRow[];
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
  /** 別のタブ・ウィンドウとの排他。省くか `null` = 排他なし。 */
  lock?: SyncLock | null;
  /** テスト用の差し替え口。 */
  hash?(bytes: ArrayBuffer): Promise<string>;
  now?(): Date;
  /** 経過時間を測る時計(ms)。省くと `Date.now()`。 */
  nowMs?(): number;
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

const toBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

type WriteAction = Extract<SyncAction, { kind: 'write' }>;

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
  /**
   * 動いている同期の約束。🔴 **世代つき**で持つ ── 「やめる → すぐ選び直す」で、古い世代の同期が終わるまで
   * 新しい世代の同期が `running` に阻まれて始まらない(または古い同期の `finally` が新しい世代の印を倒す)のを防ぐ。
   * 新しい同期は、古い同期の約束を待ってから動く(古い同期は次の action の前に世代の違いを見て抜ける)。
   */
  private current: Promise<void> | null = null;
  private runningGen = -1;
  /** UTF-8 で読めない / 大きすぎて取り込まなかったファイル(同じ知らせを毎回出さない)。 */
  private readonly skipped = new Map<string, { size: number; mtime: number }>();
  /** 知らせの重複を省く: この回に出した字と、前の回に出した字(タイマーの回で同じ字を繰り返さない)。 */
  private roundMsgs = new Set<string>();
  private prevMsgs = new Set<string>();
  private manualRound = true;
  /** 前回のハッシュ(名前 → 大きさ・更新日時・ハッシュ)。同じなら読み直さない。 */
  private readonly hashed = new Map<string, { size: number; mtime: number; hash: string }>();
  /** 「フォルダで消えたノート」への答え。次の同期で計画に渡す。 */
  private readonly decisions = new Map<string, GoneDecision>();
  /** 「同期に戻す」の要望。次の同期の最初に記録へ反映する。 */
  private readonly attachReq = new Set<string>();
  private gone: { lid: string; file: string }[] = [];
  private detachedLids: string[] = [];

  constructor(private readonly deps: FolderSyncDeps) {
    this.phase = deps.picker === null ? 'unsupported' : 'none';
  }

  view(): FolderSyncView {
    const titleOf = new Map(this.deps.notes().map((n) => [n.lid, n.title]));
    const rows = (lids: readonly string[]): FolderSyncNoteRow[] =>
      lids.flatMap((lid) => (titleOf.has(lid) ? [{ lid, title: titleOf.get(lid)! }] : []));
    return {
      version: this.version,
      phase: this.phase,
      folderName: this.dir?.name ?? null,
      minutes: this.minutes,
      lastText: this.lastText,
      lastAt: this.lastAt,
      message: this.phase === 'unsupported' ? SYNC_UNSUPPORTED_NOTE : this.message,
      gone: rows(this.gone.map((g) => g.lid)),
      detached: rows(this.detachedLids),
    };
  }

  /** いま持っている handle(検査用 ── 「やめる」で捨てたかを見る)。 */
  heldHandle(): SyncDirLike | null {
    return this.dir;
  }

  /**
   * 知らせの出し口(2 つ)。🔴 **前の回と同じ字は、タイマーの回では黙る**(「消えたノート N 件」や「大きすぎる」を回のたびに繰り返さない)。
   * ⚠ 押した回(`manual`)は必ず出す。字が変わった(件数が変わった等)ときも出る。
   */
  private say(text: string): void {
    if (this.emit(text)) this.deps.say(text);
  }

  private fail(text: string): void {
    if (this.emit(text)) this.deps.fail(text);
  }

  private emit(text: string): boolean {
    const again = this.prevMsgs.has(text);
    this.roundMsgs.add(text);
    return this.manualRound || !again;
  }

  private rotateMessages(manual: boolean): void {
    this.prevMsgs = this.roundMsgs;
    this.roundMsgs = new Set();
    this.manualRound = manual;
  }

  private nowMs(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  /**
   * ステータスバーに出す「いまの状態」(知らせではない ── 結果・失敗は `say` / `fail` でメッセージへ)。
   * 動いている間は「同期しています…」、つながっている間は「最終同期 HH:MM」、止まっていれば「同期が止まっています」。
   */
  statusLine(): string {
    if (this.phase === 'running') return '同期しています…';
    if (this.phase === 'lost' || this.phase === 'stopped') return '同期が止まっています';
    if (this.phase === 'idle' && this.lastAt !== null) return `最終同期 ${this.lastAt}`;
    return '';
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

  private resetSession(): void {
    this.generation += 1;
    this.clearTimer();
    this.hashed.clear();
    this.skipped.clear();
    this.decisions.clear();
    this.attachReq.clear();
    this.gone = [];
    this.detachedLids = [];
    this.lastText = null;
    this.lastAt = null;
    this.message = null;
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
      this.fail(`同期するフォルダを開けませんでした: ${errorText(e)}`);
      return;
    }
    this.resetSession();
    this.dir = dir;
    this.phase = 'idle';
    this.changed();
    await this.syncNow(true);
  }

  /** 同期をやめる(handle を捨てる。フォルダのファイルとノートには何もしない)。 */
  stop(): void {
    this.resetSession();
    this.dir = null;
    this.phase = this.deps.picker === null ? 'unsupported' : 'none';
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

  /** 「フォルダで消えたノート」への答え(書き戻す / 同期から外す)。選んだらすぐ 1 回同期する。 */
  async resolveGone(lid: string, choice: GoneDecision): Promise<void> {
    if (!this.gone.some((g) => g.lid === lid)) return;
    this.decisions.set(lid, choice);
    await this.syncNow(true);
  }

  /** 「同期から外したノート」を同期に戻す。戻したらすぐ 1 回同期する(新しい名前で書く)。 */
  async attach(lid: string): Promise<void> {
    if (!this.detachedLids.includes(lid)) return;
    this.attachReq.add(lid);
    await this.syncNow(true);
  }

  /**
   * 1 回同期する。⚠ 同じ世代の中では重ならない(動いている間に呼ばれたら何もしない)。
   * @param manual user が押した回。`false` = タイマー(黙って済ませられる回は黙る)
   */
  async syncNow(manual: boolean): Promise<void> {
    const dir = this.dir;
    if (dir === null) return;
    if (this.runningGen === this.generation) return;
    if (this.phase === 'lost' || this.phase === 'stopped') {
      if (manual) this.fail(this.message ?? 'フォルダを選び直してください');
      return;
    }
    if (!this.deps.ready()) {
      // 編集中などは次の回へ(タイマーの回は黙る)
      if (manual) this.say('いまは同期できません(編集を終えると同期できます)');
      this.setTimer();
      return;
    }
    const gen = this.generation;
    const before = this.current;
    this.runningGen = gen;
    this.phase = 'running';
    this.changed();
    const task = (async () => {
      // 古い世代の同期が残っていたら、それが抜けるのを待つ(同じフォルダへ 2 つが同時に書かない)
      if (before !== null) await before.catch(() => undefined);
      if (gen !== this.generation) return;
      await this.runLocked(dir, gen, manual);
    })().catch((e: unknown) => {
      // 🔴 保険: 想定外の例外で「同期しています…」のまま固まらない(待つ側が無いので、握って idle へ戻し、次の回を張る)
      if (gen !== this.generation) return;
      this.fail(`フォルダとの同期が止まりました: ${errorText(e)}`);
      this.phase = 'idle';
      this.changed();
      this.setTimer();
    });
    this.current = task;
    try {
      await task;
    } finally {
      if (this.runningGen === gen) this.runningGen = -1;
    }
  }

  private async runLocked(dir: SyncDirLike, gen: number, manual: boolean): Promise<void> {
    const run = async (): Promise<void> => {
      this.rotateMessages(manual);
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
        if (manual || counts.written + counts.pulled + counts.adopted + counts.conflicts + counts.failed + counts.gone > 0) {
          this.say(`フォルダと同期しました: ${text}`);
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
          this.fail(`フォルダとの同期に失敗しました: ${errorText(e)}`);
          this.phase = 'idle';
          this.lastText = `失敗しました(${errorText(e)})`;
          this.lastAt = this.clock();
          this.changed();
          this.setTimer();
        }
      }
    };
    const lock = this.deps.lock ?? null;
    if (lock === null) {
      await run();
      return;
    }
    // 🔴 別のタブ・ウィンドウが同じフォルダを同期していたら、重ならない(取れなければ次の回へ)
    //   ⚠ `navigator.locks.request` が動かす前に reject する環境(不透明な origin・file:// の SecurityError)では、
    //   排他なしで動かす ── 同期が `running` のまま固まらない。動かした後の例外は握らない(二重に走らせない)
    let ran = false;
    let got: boolean;
    try {
      got = await lock(`pkc3-folder-sync:${this.deps.cid()}:${dir.name}`, async () => {
        ran = true;
        await run();
      });
    } catch {
      if (ran) return;
      await run();
      return;
    }
    if (!got && gen === this.generation) {
      if (manual) this.say(SYNC_OTHER_TAB_NOTE);
      this.phase = 'idle';
      this.changed();
      this.setTimer();
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
    this.fail(message);
    this.changed();
  }

  private async hashOf(bytes: ArrayBuffer): Promise<string> {
    return (this.deps.hash ?? sha256Hex)(bytes);
  }

  private async readManifest(
    dir: SyncDirLike,
  ): Promise<{ manifest: SyncManifest; fresh: boolean } | 'broken' | 'version'> {
    let fh: SyncFileHandleLike;
    try {
      fh = await dir.getFileHandle(SYNC_MANIFEST_NAME);
    } catch (e) {
      if (errName(e) === 'NotFoundError') return { manifest: emptyManifest(this.deps.cid()), fresh: true };
      throw e;
    }
    const r = readManifestText(await (await fh.getFile()).text());
    return r.ok ? { manifest: r.manifest, fresh: false } : r.reason;
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
    return toBuffer(bytes);
  }

  /** いま在るファイルのハッシュ(無ければ `null`)。⚠ 上書き・削除の直前に取り直す。 */
  private async currentHash(dir: SyncDirLike, name: string): Promise<string | null> {
    try {
      const f = await (await dir.getFileHandle(name)).getFile();
      return await this.hashOf(await f.arrayBuffer());
    } catch (e) {
      if (errName(e) === 'NotFoundError') return null;
      throw e;
    }
  }

  /** 読めなかったファイルを、同じ状態(大きさ・更新日時)のあいだは 1 度だけ言う。直されたら(状態が変われば)また言える。 */
  private warnSkipped(name: string, file: File, text: string): void {
    const sk = this.skipped.get(name);
    if (sk !== undefined && sk.size === file.size && sk.mtime === file.lastModified) return;
    this.skipped.set(name, { size: file.size, mtime: file.lastModified });
    this.fail(text);
  }

  /**
   * フォルダ直下の .md を列挙してハッシュを引く。
   * 🔴 記録にある名前は `.md` でなくても・`_` で始まっていても数える(`watched`)。大きすぎて読めない物は `unreadable`。
   */
  private async listExternals(
    dir: SyncDirLike,
    watched: ReadonlySet<string>,
  ): Promise<{ files: ExternalFile[]; failed: number }> {
    const files: ExternalFile[] = [];
    let failed = 0;
    const seen = new Set<string>();
    for await (const e of dir.values()) {
      if (e.kind !== 'file') continue;
      const isWatched = watched.has(foldName(e.name));
      if (!isWatched && !isMarkdownName(e.name)) continue;
      try {
        const fh = await dir.getFileHandle(e.name);
        const file = await fh.getFile();
        seen.add(e.name);
        // 🔴 読めなかった印は「名前」ではなく「名前 + 大きさ + 更新日時」に付ける ── 直されたら外して読み直す
        const sk = this.skipped.get(e.name);
        if (sk !== undefined && (sk.size !== file.size || sk.mtime !== file.lastModified)) this.skipped.delete(e.name);
        if (!isWatched && this.skipped.has(e.name)) continue;
        const prev = this.hashed.get(e.name);
        if (prev !== undefined && prev.size === file.size && prev.mtime === file.lastModified) {
          files.push({ name: e.name, hash: prev.hash });
          continue;
        }
        if (file.size > IMPORT_TEXT_MAX_BYTES) {
          // 🔴 大きすぎるファイルは読めない: 取り込まず・書き換えず(記録にある物は `unreadable` で渡す)。知らせは 1 度だけ
          this.warnSkipped(
            e.name,
            file,
            `「${e.name}」は大きすぎて同期できません(${humanBytes(IMPORT_TEXT_MAX_BYTES)} まで。ファイルもノートもそのままにします)`,
          );
          if (isWatched) files.push({ name: e.name, hash: '', unreadable: true });
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
    const counts: SyncCounts = { written: 0, pulled: 0, adopted: 0, conflicts: 0, deferred: 0, gone: 0, failed: 0 };
    const got = await this.readManifest(dir);
    if (got === 'broken') {
      this.halt(
        gen,
        'stopped',
        `フォルダの同期の記録(${SYNC_MANIFEST_NAME})を読めないので、何も書かずに止めました。別の用途のフォルダかもしれません。記録を消すか、別のフォルダを選んでください`,
      );
      return null;
    }
    if (got === 'version') {
      this.halt(
        gen,
        'stopped',
        `フォルダの同期の記録(${SYNC_MANIFEST_NAME})は、別のバージョンの PKC3 が書いたものです。このバージョンでは扱えないので、何も書かずに止めました。PKC3 を新しいバージョンにするか、別のフォルダを選んでください`,
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

    // ── 記録の保存: 動かす前に決めた「いつ保存するか」。書けた分は必ず保存する(`finally`)
    let dirty = false;
    let sinceSave = 0;
    let lastSaveAt = this.nowMs();
    const save = async (): Promise<void> => {
      if (!dirty) return;
      await this.writeManifest(dir, manifest);
      dirty = false;
      sinceSave = 0;
      lastSaveAt = this.nowMs();
    };
    // 🔴 件数(100 件)でも時間(約 2 秒)でも保存する ── タブを閉じる・落ちるで、最大 99 件ぶんの記録が残らず重複するのを防ぐ
    const touched = async (): Promise<void> => {
      dirty = true;
      sinceSave += 1;
      if (sinceSave >= SYNC_SAVE_EVERY || this.nowMs() - lastSaveAt >= SYNC_SAVE_EVERY_MS) await save();
    };

    try {
      // 「同期に戻す」: 外していた印を外す(「消した」の印は、フォルダを見てから決める ── 下)
      const attaching = [...this.attachReq];
      this.attachReq.clear();
      for (const lid of attaching) {
        if (manifest.detached?.[lid] === true) {
          delete manifest.detached[lid];
          dirty = true;
        }
      }

      const allNotes = this.deps.notes();
      const locals: LocalNote[] = allNotes.map((n) => ({ ...n, busy: this.deps.isBusy(n.lid) }));
      // 記録にある名前(`.md` でなくても・`_` で始まっていても)+ 「消した」ノートの前のファイル名を数える
      const watched = new Set(Object.values(manifest.entries).map((r) => foldName(r.file)));
      for (const [k, r] of Object.entries(manifest.removed)) if (!k.startsWith('ignored:') && !k.startsWith('stale:')) watched.add(foldName(r.file));
      const { files: externals, failed } = await this.listExternals(dir, watched);
      counts.failed += failed;
      if (gen !== this.generation) return null;

      // 「同期に戻す」の続き: 前のファイルが復活していれば、新しいファイルを作らず前の記録へ紐づける(重複させない)。無ければ新しい名前で書く
      const present = new Set(externals.map((e) => foldName(e.name)));
      for (const lid of attaching) {
        const r = manifest.removed[lid];
        if (r !== undefined && !present.has(foldName(r.file))) {
          delete manifest.removed[lid];
          dirty = true;
        }
      }
      // 🔴 ゴミ箱から戻ったノート(と、いま紐づけ直すノート)は、前のファイル名のまま記録へ戻す(2 つのファイルにしない)
      const detachedNow = manifest.detached ?? {};
      const returnable = locals.filter((l) => detachedNow[l.lid] !== true);
      if (reinstateReturned(manifest, returnable) > 0) dirty = true;

      const plan = planSync(manifest, locals, externals, this.decisions);
      // 名前は大文字小文字・NFC を同一視して引く(ファイラが綴りを変えても同じファイル)
      const hashMap = new Map(externals.map((e) => [foldName(e.name), e.hash]));
      const hashOf = (name: string): string | undefined => hashMap.get(foldName(name));

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
          for (const f of adoptNames) manifest.removed[`ignored:${f}`] = { file: f, hash: hashOf(f) ?? '' };
          dirty = true;
        }
      }

      const stampOf = (lid: string): { updatedAt: string | null; chars: number | null } | null => {
        const n = this.deps.notes().find((x) => x.lid === lid);
        return n === undefined ? null : { updatedAt: n.updatedAt, chars: n.chars };
      };
      const adopts: string[] = [];
      const goneNow: { lid: string; file: string }[] = [];
      // 触れなかったノート(編集中)への「書き戻す」の答えは、次の回まで持ち越す
      const keepDecisions = new Set<string>();

      for (const a of plan.actions) {
        if (gen !== this.generation) return null;
        try {
          if (a.kind === 'defer') {
            counts.deferred += 1;
            keepDecisions.add(a.lid);
          } else if (a.kind === 'unreadable') {
            counts.deferred += 1;
          } else if (a.kind === 'gone') {
            goneNow.push({ lid: a.lid, file: a.file });
            counts.gone += 1;
          } else if (a.kind === 'detach') {
            const r = manifest.entries[a.lid];
            if (r !== undefined) manifest.removed[a.lid] = { file: r.file, hash: r.hash };
            delete manifest.entries[a.lid];
            (manifest.detached ??= {})[a.lid] = true;
            this.decisions.delete(a.lid);
            await touched();
          } else if (a.kind === 'forget') {
            const r = manifest.entries[a.lid];
            if (r !== undefined) {
              manifest.removed[a.lid] = { file: r.file, hash: r.hash };
              delete manifest.entries[a.lid];
              await touched();
            }
          } else if (a.kind === 'adopt') {
            if (allowAdopt) adopts.push(a.file);
          } else if (a.kind === 'pull') {
            if (await this.pull(dir, manifest, a.lid, a.file, hashOf(a.file) ?? '', stampOf)) {
              counts.pulled += 1;
              await touched();
            } else counts.deferred += 1;
          } else {
            const r = await this.write(dir, manifest, a, hashOf, stampOf, counts);
            if (r === 'wrote') counts.written += 1;
            else if (r === 'conflict') {
              counts.written += 1;
              counts.conflicts += 1;
            } else if (r === 'deferred') {
              counts.deferred += 1;
              keepDecisions.add(a.lid);
            }
            if (r !== 'deferred') {
              this.decisions.delete(a.lid);
              await touched();
            }
          }
        } catch (e) {
          if (errName(e) === 'NotAllowedError' || errName(e) === 'SecurityError') throw e;
          counts.failed += 1;
          this.fail(
            `フォルダとの同期で『${a.kind === 'adopt' || a.kind === 'pull' || a.kind === 'write' || a.kind === 'gone' || a.kind === 'unreadable' ? a.file : a.lid}』を処理できませんでした: ${errorText(e)}`,
          );
        }
      }

      if (adopts.length > 0) {
        counts.adopted += await this.adoptFiles(dir, manifest, adopts, stampOf, counts, async () => {
          dirty = true;
          await save();
        });
      }
      // 答えを受けて動かした分は終わり(まだ「消えている」物の答えだけ残す)
      for (const lid of [...this.decisions.keys()]) {
        if (!keepDecisions.has(lid) && !goneNow.some((g) => g.lid === lid)) this.decisions.delete(lid);
      }
      if (gen === this.generation) {
        this.gone = goneNow;
        this.detachedLids = Object.keys(manifest.detached ?? {});
      }
      return gen === this.generation ? counts : null;
    } finally {
      // 🔴 書けた分の記録は、世代が変わっても・許可が切れても・途中で例外でも必ず保存する
      try {
        await save();
      } catch (e) {
        this.fail(
          `同期の記録を書けませんでした(${errorText(e)})。次の回に、取り込んだファイルをもう一度取り込むことがあります`,
        );
      }
    }
  }

  /** ノートの本文をファイルへ書く。 */
  private async write(
    dir: SyncDirLike,
    manifest: SyncManifest,
    a: WriteAction,
    hashOf: (name: string) => string | undefined,
    stampOf: (lid: string) => { updatedAt: string | null; chars: number | null } | null,
    counts: SyncCounts,
  ): Promise<'wrote' | 'conflict' | 'deferred' | 'skipped'> {
    if (this.deps.isBusy(a.lid)) return 'deferred';
    await this.deps.settle();
    // 🔑 世代は本文を読む**前**に採る(読んだ後に変わっても、次の回で「変わった」と読める)
    const stamp = stampOf(a.lid);
    const meta = this.deps.notes().find((n) => n.lid === a.lid);
    if (stamp === null || meta === undefined) return 'skipped';
    const body = await this.deps.readBody(a.lid);
    if (body === null) return 'skipped';
    const buf = toBuffer(new TextEncoder().encode(body));
    const hash = await this.hashOf(buf);
    const prev = manifest.entries[a.lid];
    const record = { file: a.file, hash, title: meta.title, updatedAt: stamp.updatedAt, chars: stamp.chars };
    // ファイルの中身がもう同じなら書かない(フォルダから取り込んだ直後の世代の更新など)
    if (a.reason === 'local' && a.prevFile === null && prev !== undefined && hashOf(a.file) === hash) {
      manifest.entries[a.lid] = record;
      return 'skipped';
    }
    /**
     * 🔴 **上書きの直前にハッシュを取り直す**。計画を立ててから書くまでに外で直されていたら、上書きせず競合に倒す
     * (フォルダ側の版を `_conflicts/` へコピーしてから書く)。新しい名前・書き戻しのファイルが、その間に作られていた場合も同じ。
     */
    const expected = a.reason === 'new' || a.reason === 'missing' ? null : (hashOf(a.file) ?? null);
    const cur = await this.currentHash(dir, a.file);
    let conflict = false;
    if (cur !== null && (a.reason === 'conflict' || cur !== expected)) {
      await this.saveConflict(dir, a.file);
      conflict = true;
    }
    await this.writeText(dir, a.file, body);
    const written = await (await dir.getFileHandle(a.file)).getFile();
    this.hashed.set(a.file, { size: written.size, mtime: written.lastModified, hash });
    manifest.entries[a.lid] = record;
    if (a.prevFile !== null && foldName(a.prevFile) !== foldName(a.file)) {
      await this.removePrevious(dir, manifest, a.prevFile, prev?.hash ?? null, counts);
    }
    return conflict ? 'conflict' : 'wrote';
  }

  /**
   * 改題で名前が変わったときの、前のファイルを片づける。
   * 🔴 消す直前にハッシュを取り直す(外で直されていたらコピーを残してから消す)。
   * 🔴 消せなかったら失敗に数え、「消した」の印(`stale:`)を残す ── 印が無いと、残った前のファイルが次の回に
   *   「新しいファイル」と読まれて、同じ内容のノートがもう 1 件できる。
   */
  private async removePrevious(
    dir: SyncDirLike,
    manifest: SyncManifest,
    prevFile: string,
    recordedHash: string | null,
    counts: SyncCounts,
  ): Promise<void> {
    const cur = await this.currentHash(dir, prevFile);
    this.hashed.delete(prevFile);
    if (cur === null) return;
    try {
      if (recordedHash === null || cur !== recordedHash) await this.saveConflict(dir, prevFile);
      await dir.removeEntry(prevFile);
    } catch (e) {
      manifest.removed[`stale:${prevFile}`] = { file: prevFile, hash: cur };
      counts.failed += 1;
      this.fail(`改題した前のファイル『${prevFile}』を消せませんでした(残したまま、取り込み直しません): ${errorText(e)}`);
    }
  }

  /** フォルダ側の版を `_conflicts/<題名>-<日時>.md` へコピーする。 */
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
      this.warnSkipped(file, f, `「${file}」は UTF-8 として読めないので、ノートに取り込みませんでした(ノートはそのままです)`);
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

  /**
   * 新しいファイルを新しいノートにする(50 件ずつ)。
   * 🔴 **1 バッチごとに、ノートを作った直後に記録を保存する**(`saveNow`)── 作ったのに記録が無い窓を最小にする。
   *   1 バッチの失敗は数えて次のバッチへ進む(例外で全体を落とさない)。
   */
  private async adoptFiles(
    dir: SyncDirLike,
    manifest: SyncManifest,
    names: readonly string[],
    stampOf: (lid: string) => { updatedAt: string | null; chars: number | null } | null,
    counts: SyncCounts,
    saveNow: () => Promise<void>,
  ): Promise<number> {
    let adopted = 0;
    for (let at = 0; at < names.length; at += 50) {
      try {
        const batch: { name: string; file: File; hash: string }[] = [];
        for (const name of names.slice(at, at + 50)) {
          const file = await (await dir.getFileHandle(name)).getFile();
          const bytes = await file.arrayBuffer();
          if (decodeUtf8(bytes) === null) {
            this.warnSkipped(name, file, `「${name}」は UTF-8 として読めないので、ノートに取り込みませんでした`);
            counts.failed += 1;
            continue;
          }
          // 読んだ中身そのもののハッシュを記録する(一覧を作ってから読むまでに変わっていても、記録は読んだ中身と合う)
          batch.push({ name, file, hash: await this.hashOf(bytes) });
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
            hash: b.hash,
            title: '',
            updatedAt: s?.updatedAt ?? null,
            chars: s?.chars ?? null,
          };
          adopted += 1;
        });
        await saveNow();
      } catch (e) {
        if (errName(e) === 'NotAllowedError' || errName(e) === 'SecurityError') throw e;
        counts.failed += 1;
        this.fail(`フォルダのファイルをノートにできませんでした: ${errorText(e)}`);
      }
    }
    return adopted;
  }
}
