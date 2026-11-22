/**
 * 🔴 **端末間の同期(#2000)段 3 ── 同期フォルダ(全データ)の実行部**。
 *
 * クラウドドライブ(OneDrive・Google ドライブ・Dropbox などのデスクトップ版が同期しているフォルダ)を「同期フォルダ」に選ぶと、
 * 端末ごとの差分ファイル(`pkc3-<端末 id>.pkc3-diff.zip`)をそこに置き、他の端末のファイルを取り込む。人がファイルを運ばなくてよい。
 * 何を読む・書くかの決めは `features/sync/sync-folder.ts`、取り込みの判定は段 1・2 の核(`sync-diff.ts` の `applySyncDiff`)。
 * ここが持つのは **handle と許可・タイマー・排他・読み書き**だけ。
 *
 * ## handle を憶える(段 3 で検証する約束)
 * - フォルダの handle は **IndexedDB に保存**し(handle は structured clone できる)、次に開いたときに `queryPermission` で許可を確かめる。
 *   `granted` ならそのまま回る。`prompt` なら「許可を出し直す」を押してもらう(`requestPermission` は押した操作の中でしか呼べない)。
 * - ⚠ PC タブのフォルダ同期(Markdown。`folder-sync.ts`)は「毎回選び直す」裁定(#215)のまま。こちらは**別の機能**で、
 *   設定「端末間の同期」がオンのときだけ動く(既定オフ = 何も保存しない・何も回らない)。
 * - 「同期フォルダをやめる」で handle と記録を消す(片道にしない)。フォルダの中のファイルは消さない(他の端末が使っている)。
 *
 * ## いつ回るか
 * - フォルダを選んだ直後・「今すぐ同期」(手で = 確認が要る相手もその場で聞く)
 * - 画面に出ている間、決めた間隔(既定 5 分)ごと。隠れている間は回らない。画面に戻ったとき、間隔を過ぎていれば回る
 * - 失敗が続いたら間隔を延ばす(上限 60 分)。手で同期すると元に戻る
 * - 同じワークスペースの同期は Web Locks で 1 つだけ(別のタブ・ウィンドウと重ならない)
 */
import { errorText } from '@features/error-text';
import type { DiffManifest } from '@features/sync/diff-file';
import {
  backoffMinutes,
  deviceOfFileName,
  emptyFolderRecord,
  folderFileName,
  isSyncFolderMinutes,
  normalizeFolderRecord,
  planFolderRound,
  SYNC_FOLDER_DEFAULT_MINUTES,
  updateWant,
  wantedByOf,
  type FolderFile,
  type FolderSyncRecord,
  type SyncFolderMinutes,
} from '@features/sync/sync-folder';
import type { SyncDirLike, SyncLock } from './folder-sync';
import type { ApplyOutcome, BuiltDiff, DiffTarget } from '@adapter/ui/actions/sync-diff';

/** 許可を確かめ・頼める handle。 */
export interface SyncFolderDirLike extends SyncDirLike {
  requestPermission?(descriptor: { mode: string }): Promise<string>;
}

export type SyncFolderPicker = (options: { mode: 'readwrite'; id?: string }) => Promise<SyncFolderDirLike>;

/** IndexedDB に置く 1 件(ワークスペースごと)。 */
export interface SyncFolderSaved {
  /** フォルダの handle。⚠ `null` = この端末では handle を憶えない(下の「読み込みの見張り」)── 開くたびに選び直す。 */
  handle: SyncFolderDirLike | null;
  minutes: SyncFolderMinutes;
  record: FolderSyncRecord;
  /** 自分が最後に書いた自分のファイルの大きさ・更新日時(他の端末が同じ名前で書いたか = 端末 id の重複を見分ける)。 */
  own?: { size: number; mtime: number; name?: string } | null;
}

export interface SyncFolderStore {
  load(cid: string): Promise<SyncFolderSaved | null>;
  save(cid: string, v: SyncFolderSaved): Promise<void>;
  remove(cid: string): Promise<void>;
  /**
   * 読み込みの見張りの印(handle とは別の場所)。⚠ 書けたら(tx が終わったら)戻る ── 画面やブラウザが落ちても残る置き場にする
   * (localStorage は書き込みが遅れてまとめて保存されるので、直後に落ちると印が消えていることがある)。
   */
  getMark(k: string): Promise<string | null>;
  setMark(k: string, v: string | null): Promise<void>;
}

export type SyncFolderPhase = 'unsupported' | 'off' | 'none' | 'permission' | 'idle' | 'running' | 'stopped';

export interface SyncFolderView {
  version: number;
  phase: SyncFolderPhase;
  folderName: string | null;
  minutes: SyncFolderMinutes;
  /** 直近の同期の時刻(`HH:MM`)。 */
  lastAt: string | null;
  lastText: string | null;
  /** 止まっている理由・案内。 */
  message: string | null;
  /** 確認が要るので取り込んでいない相手の数(「今すぐ同期」で確認を出す)。 */
  pending: number;
  /** この端末で同期フォルダを保存するか(見張りが止めたら偽 ── 画面に「保存するように戻す」を出す)。 */
  persist: boolean;
}

export interface SyncFolderDeps {
  cid(): string;
  /** 設定「端末間の同期」。 */
  enabled(): boolean;
  /** `null` = このブラウザでは選べない(Firefox / Safari / スマホ)。 */
  picker: SyncFolderPicker | null;
  store: SyncFolderStore;
  lock?: SyncLock | null;
  /** この端末の id(無ければ作る)。 */
  device(): Promise<string>;
  /** 自分のファイルを作る(`buildSyncDiff`)。 */
  build(target: Extract<DiffTarget, { kind: 'folder' }>): Promise<BuiltDiff | { skipped: true; key: string }>;
  /** 相手のファイルを読んで取り込む(`readDiffZip` + `applySyncDiff`)。読めなければ throw。 */
  apply(file: Blob, name: string, auto: boolean): Promise<{ outcome: ApplyOutcome; manifest: DiffManifest }>;
  /** 結果・失敗の知らせ(メッセージへ。配線は呼び手)。 */
  say(text: string): void;
  fail(text: string): void;
  onChange(): void;
  now?(): Date;
  nowMs?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(h: unknown): void;
  /** 画面に出ているか(隠れている間は定期の回を回さない)。 */
  visible?(): boolean;
}

/** 見張りの印。`loading` = いま handle を読んでいる / `no-persist` = この端末では handle を憶えない。 */
export const SYNC_FOLDER_LOADING_MARK = 'pkc3.sync-folder-loading';
export const SYNC_FOLDER_NO_PERSIST_MARK = 'pkc3.sync-folder-no-persist';
/** 別のタブが読んでいる途中の印とみなす新しさ(ms)。 */
export const SYNC_FOLDER_MARK_FRESH_MS = 3000;
export const SYNC_FOLDER_CRASHED_NOTE =
  '前回、保存しておいた同期フォルダを読み込む途中で画面が止まりました。この端末では同期フォルダを保存しないようにしました。開くたびに「同期フォルダを選ぶ」を押してください';

export const SYNC_FOLDER_UNSUPPORTED_NOTE =
  'このブラウザでは同期フォルダを選べません(フォルダを読み書きする仕組みは、パソコンの Chrome・Edge にだけあります)。スマホや Safari・Firefox では「差分を書き出す」と差分ファイルの取り込みを使ってください';
export const SYNC_FOLDER_PERMISSION_NOTE = 'このフォルダを読み書きする許可が切れています。「許可を出し直す」を押してください';
const LOCK_PREFIX = 'pkc3-sync-folder:';

const pad2 = (n: number): string => String(n).padStart(2, '0');
const errName = (e: unknown): string => (typeof e === 'object' && e !== null ? String((e as { name?: unknown }).name ?? '') : '');

export class SyncFolder {
  private phase: SyncFolderPhase;
  private dir: SyncFolderDirLike | null = null;
  private minutes: SyncFolderMinutes = SYNC_FOLDER_DEFAULT_MINUTES;
  private record: FolderSyncRecord = emptyFolderRecord();
  private own: { size: number; mtime: number; name?: string } | null = null;
  private lastAt: string | null = null;
  private lastText: string | null = null;
  private message: string | null = null;
  private version = 0;
  private timer: unknown = null;
  private failures = 0;
  private lastRunMs = 0;
  private pending = new Set<string>();
  private current: Promise<void> | null = null;
  /** 「やめる」「選び直す」で増える(古い回の続きを捨てる)。 */
  private generation = 0;
  private lastFail: string | null = null;

  /** この端末では handle を憶えない(前に読み込みで画面が落ちた)。起動時に印から読む。 */
  private noPersistFlag = false;

  constructor(private readonly deps: SyncFolderDeps) {
    this.phase = deps.picker === null ? 'unsupported' : 'none';
  }

  private noPersist(): boolean {
    return this.noPersistFlag;
  }

  private async mark(k: string, v: string | null): Promise<void> {
    try {
      await this.deps.store.setMark(k, v);
    } catch {
      /* 印を書けなくても同期は続ける */
    }
  }

  view(): SyncFolderView {
    return {
      version: this.version,
      phase: this.phase,
      folderName: this.dir?.name ?? null,
      minutes: this.minutes,
      lastAt: this.lastAt,
      lastText: this.lastText,
      message: this.phase === 'unsupported' ? SYNC_FOLDER_UNSUPPORTED_NOTE : this.message,
      pending: this.pending.size,
      persist: !this.noPersistFlag,
    };
  }

  /** ステータスバーの一言(状態。結果はメッセージへ)。 */
  statusLine(): string {
    if (this.phase === 'running') return '端末間の同期をしています…';
    if (this.phase === 'permission' || this.phase === 'stopped') return '端末間の同期が止まっています';
    return '';
  }

  private changed(): void {
    this.version += 1;
    this.deps.onChange();
  }

  private nowMs(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    (this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.clearTimer();
    if (this.phase !== 'idle' && this.phase !== 'stopped') return;
    const gen = this.generation;
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = null;
      if (gen !== this.generation) return;
      // 隠れている間は回さない(画面に戻ったときに `onVisible` が拾う)
      if (this.deps.visible?.() === false) return;
      void this.syncNow(false);
    }, backoffMinutes(this.minutes, this.failures) * 60_000);
  }

  private async persist(): Promise<void> {
    if (this.dir === null) return;
    await this.deps.store.save(this.deps.cid(), { handle: this.noPersist() ? null : this.dir, minutes: this.minutes, record: this.record, own: this.own });
  }

  /** 起動時: 保存した handle を読み、許可があれば回り始める。 */
  async boot(): Promise<void> {
    if (this.phase === 'unsupported') return;
    // 🔴 設定がオフなら handle を読みもしない(既定オフ = 何も起こさない)
    if (!this.deps.enabled()) {
      this.phase = 'off';
      this.changed();
      return;
    }
    /**
     * 🔴 **読み込みの見張り**(段 3 の検証で見つけた)。この箱の Chromium(Chrome for Testing 153)では、**使い捨てのプロファイル**
     * (シークレットウィンドウと同じ形)で IndexedDB から handle を読むと**ブラウザごと落ちた**(ふつうのプロファイルでは落ちない ──
     * `tests/smoke/sync-folder.smoke.spec.ts` で両方を実測)。人が選んだフォルダ・本物の Chrome でも起きるかは実機で確かめる。
     * 落ちると次に開いたときにも同じ所で落ち、**アプリが開けなくなる**。だから読む前に印を(書き終えるまで待って)書き、
     * 残っていたら読まずに捨て、以後この端末では handle を保存しない(開くたびに選び直す)。
     */
    const loadingLeft = await this.deps.store.getMark(SYNC_FOLDER_LOADING_MARK).catch(() => null);
    this.noPersistFlag = (await this.deps.store.getMark(SYNC_FOLDER_NO_PERSIST_MARK).catch(() => null)) === '1';
    /**
     * ⚠ 印は読み始めた時刻。**ついさっきの印**は、別のタブがいま読んでいる途中のもの(落ちた跡ではない)── 捨てずにそのまま読む。
     *   落ちた後に開き直すには数秒かかる(人が開き直す)ので、`SYNC_FOLDER_MARK_FRESH_MS` より古い印だけを「落ちた跡」とみなす。
     *   時刻の読めない印(前の版の `'1'` など)は落ちた跡として扱う(安全側)。
     */
    const markAt = loadingLeft === null ? Number.NaN : Number(loadingLeft);
    const fresh = Number.isFinite(markAt) && markAt > 1_000_000 && Math.abs(this.nowMs() - markAt) < SYNC_FOLDER_MARK_FRESH_MS;
    if (loadingLeft !== null && !fresh) {
      await this.mark(SYNC_FOLDER_LOADING_MARK, null);
      await this.mark(SYNC_FOLDER_NO_PERSIST_MARK, '1');
      this.noPersistFlag = true;
      try {
        await this.deps.store.remove(this.deps.cid());
      } catch {
        /* 消せなくても、以後は読まない(no-persist は handle を書かない) */
      }
      this.phase = 'none';
      this.message = SYNC_FOLDER_CRASHED_NOTE;
      this.changed();
      this.deps.fail(SYNC_FOLDER_CRASHED_NOTE);
      return;
    }
    let saved: SyncFolderSaved | null;
    // 🔴 印を**書き終えてから**読む(落ちたときに印が残っているように)
    await this.mark(SYNC_FOLDER_LOADING_MARK, String(this.nowMs()));
    try {
      saved = await this.deps.store.load(this.deps.cid());
    } catch {
      saved = null;
    } finally {
      await this.mark(SYNC_FOLDER_LOADING_MARK, null);
    }
    if (saved !== null && saved.handle === null) {
      // 憶えない端末: 間隔と記録だけ戻す(フォルダは選び直す)
      this.minutes = isSyncFolderMinutes(saved.minutes) ? saved.minutes : SYNC_FOLDER_DEFAULT_MINUTES;
      this.record = normalizeFolderRecord(saved.record);
      this.own = saved.own ?? null;
      saved = null;
    }
    if (saved === null) {
      this.phase = 'none';
      this.changed();
      return;
    }
    this.dir = saved.handle;
    this.minutes = isSyncFolderMinutes(saved.minutes) ? saved.minutes : SYNC_FOLDER_DEFAULT_MINUTES;
    this.record = normalizeFolderRecord(saved.record);
    this.own = saved.own ?? null;
    if (!this.deps.enabled()) {
      this.phase = 'off';
      this.changed();
      return;
    }
    if (!(await this.permitted(false))) {
      this.phase = 'permission';
      this.message = SYNC_FOLDER_PERMISSION_NOTE;
      this.changed();
      return;
    }
    this.phase = 'idle';
    this.message = null;
    this.changed();
    void this.syncNow(false);
  }

  /** 設定「端末間の同期」を切り替えたとき。 */
  async onEnabledChanged(): Promise<void> {
    this.generation += 1;
    this.clearTimer();
    if (this.phase === 'unsupported') return;
    if (!this.deps.enabled()) {
      this.phase = 'off';
      this.changed();
      return;
    }
    await this.boot();
  }

  /** 画面に戻ったとき: 間隔を過ぎていれば回す。 */
  onVisible(): void {
    if (this.phase !== 'idle' && this.phase !== 'stopped') return;
    if (this.nowMs() - this.lastRunMs >= backoffMinutes(this.minutes, this.failures) * 60_000) void this.syncNow(false);
  }

  private async permitted(ask: boolean): Promise<boolean> {
    const d = this.dir;
    if (d === null) return false;
    if (typeof d.queryPermission !== 'function') return true;
    try {
      if ((await d.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
      if (!ask || typeof d.requestPermission !== 'function') return false;
      return (await d.requestPermission({ mode: 'readwrite' })) === 'granted';
    } catch {
      return false;
    }
  }

  /** フォルダを選ぶ(押した操作の中で呼ぶ)。 */
  async pick(): Promise<void> {
    const picker = this.deps.picker;
    if (picker === null) {
      this.deps.fail(SYNC_FOLDER_UNSUPPORTED_NOTE);
      return;
    }
    if (!this.deps.enabled()) {
      this.deps.fail('設定の「端末間の同期」をオンにしてから、同期フォルダを選んでください');
      return;
    }
    let dir: SyncFolderDirLike;
    try {
      dir = await picker({ mode: 'readwrite', id: 'pkc3-sync-folder' });
    } catch (e) {
      if (errName(e) === 'AbortError') return; // 選ぶのをやめた
      this.deps.fail(`同期フォルダを選べませんでした: ${errorText(e)}`);
      return;
    }
    this.generation += 1;
    this.clearTimer();
    await this.waitCurrent();
    const sameFolder = this.dir !== null && typeof (this.dir as { isSameEntry?: unknown }).isSameEntry === 'function'
      ? await (this.dir as unknown as { isSameEntry(o: unknown): Promise<boolean> }).isSameEntry(dir).catch(() => false)
      : false;
    this.dir = dir;
    if (!sameFolder) {
      this.record = emptyFolderRecord();
      this.own = null;
    }
    this.phase = 'idle';
    this.message = null;
    this.failures = 0;
    this.pending.clear();
    try {
      await this.persist();
    } catch (e) {
      this.deps.fail(`同期フォルダを保存できませんでした(この画面を閉じるまでは同期します): ${errorText(e)}`);
    }
    this.changed();
    await this.syncNow(true);
  }

  /** 許可を出し直す(押した操作の中で呼ぶ)。 */
  async reconnect(): Promise<void> {
    if (this.dir === null) return this.pick();
    if (!(await this.permitted(true))) {
      this.phase = 'permission';
      this.message = SYNC_FOLDER_PERMISSION_NOTE;
      this.changed();
      this.deps.fail('同期フォルダを読み書きする許可が出ませんでした。もう一度「許可を出し直す」を押すか、同期フォルダを選び直してください');
      return;
    }
    this.phase = 'idle';
    this.message = null;
    this.failures = 0;
    this.changed();
    await this.syncNow(true);
  }

  /** 同期フォルダをやめる(handle と記録を消す。フォルダの中のファイルは消さない)。 */
  async stop(): Promise<void> {
    this.generation += 1;
    this.clearTimer();
    await this.waitCurrent();
    this.dir = null;
    this.record = emptyFolderRecord();
    this.own = null;
    this.pending.clear();
    this.lastAt = null;
    this.lastText = null;
    this.message = null;
    this.phase = this.phase === 'unsupported' ? 'unsupported' : this.deps.enabled() ? 'none' : 'off';
    try {
      await this.deps.store.remove(this.deps.cid());
    } catch (e) {
      this.deps.fail(`同期フォルダの記録を消せませんでした: ${errorText(e)}`);
    }
    this.changed();
    this.deps.say('同期フォルダとの同期をやめました(フォルダの中のファイルはそのままです。他の端末が使っていなければ、手で消せます)');
  }

  /**
   * 「同期の記録を消す」の後: 端末 id が変わるので、すぐに 1 回まわして、前の id で置いた自分のファイルを片付ける
   * (片付け自体は回の最初の「端末 id が変わった」の確かめが持つ ── オフの間・別のワークスペースで消したときも、次にオンで回ったときに片付く)。
   * ⚠ 設定がオフ・フォルダを選んでいないときは何もしない(オフの間はフォルダにも IndexedDB にも書かない)。
   */
  async forgetRecords(): Promise<void> {
    if (!this.deps.enabled() || this.dir === null) return;
    await this.syncNow(false);
  }

  /**
   * 🔴 「この端末で同期フォルダを保存する」に戻す(見張りが保存をやめた後の戻り道 ── 片道にしない)。いま選んでいるフォルダがあれば保存する。
   * ⚠ 本当にブラウザが落ちる環境なら、次に開いたときにもう 1 度見張りが止める(落ちるのは 1 回で済む)。
   */
  async allowPersist(): Promise<void> {
    this.noPersistFlag = false;
    await this.mark(SYNC_FOLDER_NO_PERSIST_MARK, null);
    if (this.message === SYNC_FOLDER_CRASHED_NOTE) this.message = null;
    try {
      await this.persist();
    } catch {
      /* 次に保存できたときに残る */
    }
    this.changed();
    this.deps.say('同期フォルダを、この端末で保存するように戻しました。次に開いたときも、選んだフォルダを使います');
  }

  async setMinutes(m: number): Promise<void> {
    if (!isSyncFolderMinutes(m)) return;
    this.minutes = m;
    this.changed();
    this.schedule();
    try {
      await this.persist();
    } catch {
      /* 間隔は次に憶えられたときに残る */
    }
  }

  private async waitCurrent(): Promise<void> {
    if (this.current !== null) await this.current.catch(() => undefined);
  }

  /** 1 回同期する。`manual` = 手で(確認が要る相手もその場で聞き、変わっていないファイルも読み直す)。 */
  async syncNow(manual: boolean): Promise<void> {
    if (this.dir === null || this.phase === 'unsupported' || this.phase === 'off' || this.phase === 'none') return;
    if (!this.deps.enabled()) return;
    if (this.current !== null) {
      if (!manual) return;
      await this.waitCurrent();
    }
    const gen = this.generation;
    const run = async (): Promise<void> => {
      const body = async (): Promise<void> => this.round(manual, gen);
      const lock = this.deps.lock;
      if (lock) {
        let ran: boolean;
        try {
          ran = await lock(LOCK_PREFIX + this.deps.cid(), body);
        } catch {
          // 排他の口が使えない(file:// など)── 同じタブの中は `current` で直列なので、そのまま回す
          await body();
          ran = true;
        }
        if (!ran && manual) this.deps.say('別のタブ・ウィンドウが同期フォルダと同期しています(終わったあとの回に同期します)');
      } else {
        await body();
      }
    };
    this.current = run().finally(() => {
      this.current = null;
    });
    await this.current;
  }

  private async round(manual: boolean, gen: number): Promise<void> {
    const dir = this.dir;
    if (dir === null) return;
    this.phase = 'running';
    this.changed();
    let imported = 0;
    let conflicts = 0;
    let wrote = false;
    const problems: string[] = [];
    try {
      if (!(await this.permitted(manual))) {
        this.phase = 'permission';
        this.message = SYNC_FOLDER_PERMISSION_NOTE;
        this.changed();
        if (manual) this.deps.fail(SYNC_FOLDER_PERMISSION_NOTE);
        return;
      }
      const self = await this.deps.device();
      // ── 🔴 端末 id が変わった(「同期の記録を消す」をした — どのワークスペース・オフの間でも)── 前の id で置いた自分のファイルを片付け、記録を最初からにする
      //   (残すと、他の端末から「もう来ない別の端末」に見え続ける)。⚠ 複製の確認で作り直したときは、前の名前は複製元の物なので `own` を先に空にしてある
      const ownName = this.own?.name;
      if (ownName !== undefined && deviceOfFileName(ownName) !== null && deviceOfFileName(ownName) !== self) {
        await dir.removeEntry(ownName).catch(() => undefined);
        this.record = emptyFolderRecord();
        this.own = null;
      }
      // ── フォルダを見る(同期フォルダのファイルだけ。他のファイルには触らない)
      const files: FolderFile[] = [];
      const handles = new Map<string, { getFile(): Promise<File> }>();
      for await (const e of dir.values()) {
        if (e.kind !== 'file' || deviceOfFileName(e.name) === null) continue;
        const fh = await dir.getFileHandle(e.name);
        const f = await fh.getFile();
        files.push({ name: e.name, size: f.size, mtime: f.lastModified });
        handles.set(e.name, fh);
      }
      if (gen !== this.generation) return;
      const plan = planFolderRound(self, files, this.record, manual);
      // ── 自分の名前のファイルを、自分以外が書いた(端末のデータの複製)── 取り込みの核が見分けて、手で同期したときに確認する
      const ownFile = plan.ownFile;
      // ⚠ 自分が書いた控えが無い(選び直した・記録が消えた)ときも読んで確かめる ── 自分が書いた物なら核が「取り込む物は無い」と言う
      const foreignOwn = ownFile !== null && (this.own === null || ownFile.size !== this.own.size || ownFile.mtime !== this.own.mtime);
      const reads = foreignOwn && ownFile !== null ? [...plan.toRead, ownFile] : plan.toRead;
      this.pending.clear();
      let ownUnresolved: string | null = null;
      for (const f of reads) {
        if (gen !== this.generation) return;
        const peer = deviceOfFileName(f.name) as string;
        try {
          const file = await handles.get(f.name)!.getFile();
          const { outcome, manifest } = await this.deps.apply(file, f.name, !manual);
          if (outcome.pending !== undefined || outcome.declined === true) {
            // 確認待ち / 確認に「やめる」と答えた ── 取り込んでいない。控え(`seen`)も頼み(`want`)も動かさない(次の回も確認待ちのまま)
            this.pending.add(peer);
            if (peer === self) ownUnresolved = 'この端末と同じ ID の端末が同期フォルダに書いています(端末のデータを複製した可能性があります)。「今すぐ同期」を押して確認してください';
            continue;
          }
          if (!outcome.ok) {
            const why = outcome.reason ?? f.name;
            problems.push(why);
            if (peer === self) ownUnresolved = why;
            // 🔴 同じ中身のファイルを無人の回で読み直し続けない(変わったら読む。手で同期すれば読み直す)── 頼み(`want`)は動かさない
            else this.record.seen[f.name] = { size: f.size, mtime: f.mtime, want: this.record.seen[f.name]?.want ?? [] };
            continue;
          }
          if (peer === self) {
            // 自分が書いた物だった / 複製の確認を済ませた(端末 id を作り直した)── 自分のファイルとして憶え直す
            this.own = { size: f.size, mtime: f.mtime, name: f.name };
            continue;
          }
          imported += outcome.changed;
          conflicts += outcome.conflicts;
          this.record.seen[f.name] = { size: f.size, mtime: f.mtime, want: manifest.want ?? [] };
          this.record.want = updateWant(this.record.want, peer, { needFull: outcome.needFull, complete: manifest.complete });
        } catch (e) {
          problems.push(`${f.name}: ${errorText(e)}`);
        }
      }
      for (const n of plan.vanished) delete this.record.seen[n];
      if (gen !== this.generation) return;
      // 🔴 自分の名前のファイルを、まだ片付けていない誰かが書いている(同じ端末 id の別の端末 / このブラウザの別のワークスペース)──
      //   同じ名前のファイルを書き合わないよう、書かずに待つ
      if (ownUnresolved !== null) {
        await this.persist();
        this.phase = 'stopped';
        this.message = ownUnresolved.includes('別のワークスペース')
          ? `${ownUnresolved}(ワークスペースごとに別の同期フォルダを選んでください)`
          : ownUnresolved;
        if (manual || this.message !== this.lastFail) this.deps.fail(this.message);
        this.lastFail = this.message;
        return;
      }
      // ── 自分のファイルを書く(中身が前回と同じなら書かない)。⚠ 確認待ちの相手が居ても書く(相手は自分のファイルを読める)
      const self2 = await this.deps.device(); // 取り込みで端末 id を作り直した場合は新しい名前で書く
      if (self2 !== self) {
        // 作り直した: 前の名前のファイルは複製元の物(消さない)。同期の記録は worker が捨てたので、フォルダの記録も最初から
        this.own = null;
        this.record = emptyFolderRecord();
      }
      const built = await this.deps.build({
        kind: 'folder',
        others: plan.others.filter((d) => d !== self2),
        wantedBy: wantedByOf(self2, this.record),
        want: this.record.want,
        ownFilePresent: self2 === self && plan.ownFilePresent,
        lastKey: self2 === self ? this.record.lastKey : null,
      });
      if (!built.skipped) {
        if (gen !== this.generation) return;
        const name = folderFileName(self2);
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        try {
          await w.write(built.blob);
          await w.close();
        } catch (e) {
          await w.abort?.().catch(() => undefined);
          throw e;
        }
        const after = await fh.getFile();
        this.own = { size: after.size, mtime: after.lastModified, name };
        this.record.lastKey = built.key;
        wrote = true;
      }
      if (gen !== this.generation) return;
      await this.persist();
      this.failures = 0;
      const d = this.deps.now?.() ?? new Date();
      this.lastAt = [pad2(d.getHours()), pad2(d.getMinutes())].join(':');
      this.lastText = `取り込み ${imported} 件${conflicts > 0 ? `(競合 ${conflicts} 件)` : ''}${wrote ? ' / この端末の変更を書き出しました' : ''}`;
      this.message = this.pending.size > 0 ? `確認が要る端末が ${this.pending.size} 台あります。「今すぐ同期」を押すと確認します` : null;
      this.phase = 'idle';
      if (problems.length > 0) {
        const t = `同期フォルダの一部のファイルを取り込めませんでした(${problems.length} 件): ${problems.slice(0, 3).join(' / ')}`;
        if (manual || t !== this.lastFail) this.deps.fail(t);
        this.lastFail = t;
      } else this.lastFail = null;
      if (manual || imported > 0) this.deps.say(`同期フォルダと同期しました(${this.lastText})`);
    } catch (e) {
      this.failures += 1;
      this.phase = 'stopped';
      const lost = errName(e) === 'NotFoundError' || errName(e) === 'NotAllowedError' || errName(e) === 'SecurityError';
      this.message = lost ? `同期フォルダを読み書きできません(移動・削除されたか、許可が切れました)。選び直してください: ${errorText(e)}` : `同期に失敗しました(次の回にやり直します): ${errorText(e)}`;
      if (lost) this.phase = 'permission';
      if (manual || this.message !== this.lastFail) this.deps.fail(this.message);
      this.lastFail = this.message;
    } finally {
      this.lastRunMs = this.nowMs();
      if (this.phase === 'running') this.phase = 'idle';
      // 回っている間に設定がオフになった ── 画面だけ「待機」にしない
      if (!this.deps.enabled()) this.phase = 'off';
      this.changed();
      if (gen === this.generation) this.schedule();
    }
  }
}

/** IndexedDB の置き場(ワークスペースごとに 1 件)。⚠ handle は structured clone で保存できる(Chromium)。 */
export function idbSyncFolderStore(dbName = 'pkc3-sync-folder'): SyncFolderStore {
  const STORE = 'folders';
  const MARKS = 'marks';
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        if (!req.result.objectStoreNames.contains(MARKS)) req.result.createObjectStore(MARKS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB を開けません'));
    });
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        // 印は `strict`(書き終えるまで戻らない ── 直後に落ちても残る)
        const t = store === MARKS ? db.transaction(store, mode, { durability: 'strict' }) : db.transaction(store, mode);
        const r = fn(t.objectStore(store));
        t.oncomplete = () => resolve(r.result);
        t.onerror = () => reject(t.error ?? new Error('IndexedDB に書けません'));
        t.onabort = () => reject(t.error ?? new Error('IndexedDB の書き込みが中断されました'));
      });
    } finally {
      db.close();
    }
  };
  return {
    load: async (cid) => ((await tx('readonly', (s) => s.get(cid))) as SyncFolderSaved | undefined) ?? null,
    save: async (cid, v) => {
      await tx('readwrite', (s) => s.put(v, cid));
    },
    remove: async (cid) => {
      await tx('readwrite', (s) => s.delete(cid));
    },
    getMark: async (k) => {
      const v = await tx('readonly', (s) => s.get(k), MARKS);
      return typeof v === 'string' ? v : null;
    },
    setMark: async (k, v) => {
      if (v === null) await tx('readwrite', (s) => s.delete(k), MARKS);
      else await tx('readwrite', (s) => s.put(v, k), MARKS);
    },
  };
}
