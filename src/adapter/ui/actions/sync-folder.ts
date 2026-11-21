/**
 * 🔴 **端末間の同期(#2000)段 3 ── フォルダで同期する(全データ)の動かし方**。
 *
 * 置き方・判断は `features/sync/sync-folder.ts`、差分ファイルの書き出し・取り込みは段 2 の `sync-diff.ts`(同じ核)。
 * ここは **handle の持ち主・許可の取り直し・1 回の同期(取り込み → 書き出し)・タイマー**だけを持つ。
 *
 * ## 1 回の同期
 * 1. 許可を確かめる(切れていれば止めて、押してもらう)。
 * 2. 他の端末のファイル(`<端末 id>.pkc3-diff.zip`)を、**連番が新しい物だけ**取り込む(読めない・書き込み途中の物は次の回へ)。
 * 3. この端末の変更があれば、添付の実体(`assets/`)→ 自分のファイルの順に書く(同じ名前に書き換える。`createWritable` は閉じるまで元のファイルを残す)。
 *
 * ## 守ること
 * - 設定「端末間の同期」が切のときは、何も読まず・書かず・タイマーも張らない(handle の保存は残る = 入に戻せば再開できる)。
 * - 定期の回は**確認を出さない**(初めての相手・端末 id の重複は「確認が要る」と状態に出し、押した回で聞く)。
 * - 同じワークスペースの同期は 1 つしか走らない(`navigator.locks` + 同じタブ内の直列化)。
 * - 取り込んだ物は段 2 と同じく取り消せる(最新 1 回分)。競合は両方残す・消えた物はゴミ箱へ。
 */
import { errorText } from '@features/error-text';
import { readDiffManifest, readDiffZip, type DiffAssetMeta, type DiffManifest } from '@features/sync/diff-file';
import { fingerprintDigest, fingerprintsOf } from '@features/sync/sync-export';
import {
  alreadyImported,
  deviceOfFolderFile,
  FOLDER_LOST_NOTE,
  FOLDER_NEEDS_PERMISSION_NOTE,
  FOLDER_UNSUPPORTED_NOTE,
  folderFileNameOf,
  isSafeAssetFileName,
  memoKey,
  needsOwnWrite,
  ownFileVerdict,
  phaseForPermission,
  planFolderFiles,
  SYNC_FOLDER_ASSETS_DIR,
  SYNC_FOLDER_DIR,
  SYNC_FOLDER_INTERVAL_MS,
  SYNC_FOLDER_RETRY_MS,
  type FolderFileInfo,
  type FolderSyncPhase,
} from '@features/sync/sync-folder';
import { SYNC_OFF_REFUSAL } from '@features/sync/sync-setting';
import type { SyncDirLike, SyncDirPicker, SyncFileHandleLike, SyncLock } from '@adapter/platform/folder-sync';
import type { SyncFolderStore } from '@adapter/platform/sync-folder-store';
import { assetMismatch, buildSyncDiff, importSyncDiff, peerLabel, type SyncDeps } from './sync-diff';

const errName = (e: unknown): string => (typeof e === 'object' && e !== null ? String((e as { name?: unknown }).name ?? '') : '');
const pad2 = (n: number): string => String(n).padStart(2, '0');

export interface SyncFolderView {
  /** 変わるたびに増える(描画器の指紋)。 */
  readonly version: number;
  readonly phase: FolderSyncPhase;
  readonly folderName: string | null;
  /** 理由・案内の一言(無ければ `null`)。 */
  readonly message: string | null;
  readonly lastText: string | null;
  readonly lastAt: string | null;
  /** 確認が要って止まっている相手(押した回で聞く)。 */
  readonly pendingPeers: readonly string[];
}

export interface SyncFolderDeps {
  /** `null` = このブラウザには無い(Firefox / Safari)。 */
  picker: SyncDirPicker | null;
  store: SyncFolderStore;
  cid: string;
  enabled(): boolean;
  /** 段 2 と同じ口の束(取り込み・書き出しに渡す)。 */
  syncDeps(): Promise<SyncDeps>;
  /** 同期を始めてよい状態か(読み込み中・編集中の欄がある間は `false`)。 */
  ready(): boolean;
  lock?: SyncLock | null;
  /** 「取り込みを取り消す」が残っているか。残っているあいだは、同期の取り込みでそれを上書きしない。 */
  undoPending?(): boolean;
  /** 結果・失敗の知らせ(メッセージへ。ステータスバーには出さない)。 */
  say(text: string): void;
  fail(text: string): void;
  onChange(): void;
  nowMs?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(h: unknown): void;
  intervalMs?: number;
}

interface Counts {
  imported: number;
  changed: number;
  conflictsHint: boolean;
  wrote: boolean;
  unreadable: number;
  settling: number;
  failed: number;
}

export class SyncFolder {
  private dir: SyncDirLike | null = null;
  private folderName: string | null = null;
  private phase: FolderSyncPhase;
  private message: string | null = null;
  private lastText: string | null = null;
  private lastAt: string | null = null;
  private version = 0;
  private timer: unknown = null;
  private generation = 0;
  /** いま走っている回の世代。 */
  private runGen = 0;
  private running: Promise<void> | null = null;
  /** 処理を済ませたファイル(名前 → 大きさ:更新日時)。同じ物を読み直さない。 */
  private readonly memo = new Map<string, string>();
  /** 読めなかったファイルの控え(同じ知らせを毎回出さない)。 */
  private readonly unreadableSeen = new Map<string, string>();
  private readonly pendingPeers = new Set<string>();
  /** 失敗した・読めなかったファイル(名前 → 大きさ:更新日時)。定期の回は、ファイルが変わるまで飛ばす(毎分同じ失敗を繰り返さない)。「今すぐ同期」は試す。 */
  private readonly failedMemo = new Map<string, string>();
  /** 置けなかった添付の控え(同じ知らせを 1 度だけ出す)。 */
  private readonly assetFailSeen = new Set<string>();
  /** 取り込んだが実体が見つからなかった・内容が合わなかった添付(次の回で引き直す。保存した handle の記録に添えて、開き直しても続ける)。 */
  private readonly missingAssets = new Map<string, DiffAssetMeta>();
  private prevMsgs = new Set<string>();
  private roundMsgs = new Set<string>();
  private manualRound = false;
  private blockWrite = false;

  constructor(private readonly deps: SyncFolderDeps) {
    this.phase = deps.picker === null ? 'unsupported' : 'off';
  }

  view(): SyncFolderView {
    return {
      version: this.version,
      phase: this.viewPhase(),
      folderName: this.folderName,
      message: this.viewMessage(),
      lastText: this.lastText,
      lastAt: this.lastAt,
      pendingPeers: [...this.pendingPeers].sort(),
    };
  }

  private viewPhase(): FolderSyncPhase {
    if (this.phase === 'unsupported') return 'unsupported';
    if (!this.deps.enabled() && this.dir !== null) return 'disabled';
    return this.phase;
  }

  private viewMessage(): string | null {
    switch (this.phase) {
      case 'unsupported':
        return FOLDER_UNSUPPORTED_NOTE;
      case 'needs-permission':
        return FOLDER_NEEDS_PERMISSION_NOTE;
      case 'lost':
        return this.message ?? FOLDER_LOST_NOTE;
      default:
        return this.message;
    }
  }

  /** ステータスバーに出す「いまの状態」(知らせではない)。 */
  statusLine(): string {
    const p = this.viewPhase();
    if (p === 'running') return 'フォルダ同期中…';
    if (p === 'lost' || p === 'needs-permission') return 'フォルダ同期が止まっています';
    if (p === 'idle' && this.lastAt !== null) return `フォルダ同期 ${this.lastAt}`;
    return '';
  }

  private changed(): void {
    this.version += 1;
    this.deps.onChange();
  }

  /** 保存してある handle を読み戻して、許可を確かめる(起動時・設定を入にしたとき)。 */
  async init(): Promise<void> {
    if (this.deps.picker === null || this.dir !== null) return;
    // 置き場が読めない = フォルダ未設定として扱う(選び直せる)
    const rec = await this.deps.store.get(this.deps.cid).catch(() => null);
    if (rec === null) return;
    this.dir = rec.handle;
    this.folderName = rec.name;
    for (const m of rec.missing ?? []) this.missingAssets.set(m.key, m);
    const perm = await this.permissionOf(rec.handle);
    this.phase = phaseForPermission(perm);
    this.message = this.phase === 'lost' ? FOLDER_LOST_NOTE : null;
    this.changed();
    if (this.phase === 'idle') await this.syncNow(false);
  }

  private async permissionOf(dir: SyncDirLike): Promise<string> {
    if (dir.queryPermission === undefined) return 'granted';
    try {
      return await dir.queryPermission({ mode: 'readwrite' });
    } catch {
      return 'denied';
    }
  }

  /** フォルダを選ぶ。⚠ 押した操作の中で呼ぶ(OS の選択画面は gesture が要る = 最初の `await` が `picker`)。選ばずに閉じたら何も変えない。 */
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
    this.reset();
    this.dir = dir;
    this.folderName = dir.name;
    this.phase = 'idle';
    this.message = null;
    try {
      await this.deps.store.put(this.deps.cid, { handle: dir, name: dir.name, savedAt: new Date().toISOString(), missing: [...this.missingAssets.values()] });
    } catch (e) {
      // 保存できなくても、このセッションは使える(次の起動では選び直し)
      this.deps.fail(`選んだフォルダを覚えておけませんでした(次に開いたときは選び直しが要ります): ${errorText(e)}`);
    }
    this.changed();
    await this.syncNow(true);
  }

  /** 切れた許可を求め直す。⚠ 押した操作の中で呼ぶ(最初の `await` が `requestPermission`)。 */
  async grant(): Promise<void> {
    const dir = this.dir;
    if (dir === null) return;
    const perm = await (dir.requestPermission !== undefined ? dir.requestPermission({ mode: 'readwrite' }) : Promise.resolve('granted')).catch(() => 'denied');
    this.phase = perm === 'granted' ? 'idle' : 'lost';
    this.message = perm === 'granted' ? null : FOLDER_LOST_NOTE;
    this.changed();
    if (perm === 'granted') await this.syncNow(true);
  }

  /** フォルダの設定を外す(保存した handle を消す。フォルダの中のファイルとノートには何もしない)。 */
  async release(): Promise<void> {
    this.reset();
    this.dir = null;
    this.folderName = null;
    this.phase = this.deps.picker === null ? 'unsupported' : 'off';
    this.message = null;
    try {
      await this.deps.store.delete(this.deps.cid);
    } catch (e) {
      this.deps.fail(`保存したフォルダを消せませんでした: ${errorText(e)}`);
    }
    this.changed();
  }

  /** 設定「端末間の同期」の入 / 切が変わった。切ならタイマーを外し、入なら保存した handle で再開する。 */
  async onSettingChanged(): Promise<void> {
    this.changed(); // 設定の画面の「フォルダで同期する」の出し入れ(オンのときだけ出す)を映し直す
    if (!this.deps.enabled()) {
      this.clearTimer();
      this.changed();
      return;
    }
    if (this.dir === null) await this.init();
    else if (this.phase === 'idle') await this.syncNow(true);
    else this.changed();
  }

  private reset(): void {
    this.generation += 1;
    this.clearTimer();
    this.memo.clear();
    this.unreadableSeen.clear();
    this.failedMemo.clear();
    this.assetFailSeen.clear();
    this.pendingPeers.clear();
    // ⚠ 足りない添付の控えは消さない(ノートの側の問題で、フォルダを選び直しても続く)
    this.lastText = null;
    this.lastAt = null;
    this.blockWrite = false;
  }

  private setTimer(ms?: number): void {
    this.clearTimer();
    if (!this.deps.enabled() || this.phase !== 'idle') return;
    const gen = this.generation;
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = null;
      if (gen === this.generation) void this.syncNow(false);
    }, ms ?? this.deps.intervalMs ?? SYNC_FOLDER_INTERVAL_MS);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    (this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private emit(text: string, kind: 'say' | 'fail'): void {
    const again = this.prevMsgs.has(text);
    this.roundMsgs.add(text);
    if (this.manualRound || !again) (kind === 'say' ? this.deps.say : this.deps.fail)(text);
  }

  /** 1 回同期する。⚠ 同じワークスペースの中では重ならない(動いている間に呼ばれたら、その回の終わりを待つ)。 */
  async syncNow(manual: boolean): Promise<void> {
    if (this.dir === null || this.deps.picker === null) return;
    if (!this.deps.enabled()) {
      if (manual) this.deps.fail(SYNC_OFF_REFUSAL);
      return;
    }
    if (this.phase === 'needs-permission' || this.phase === 'lost') {
      if (manual) this.deps.fail(this.viewMessage() ?? FOLDER_LOST_NOTE);
      return;
    }
    if (this.running !== null) {
      const g = this.runGen;
      await this.running;
      // 🔴 待っている間にフォルダが選び直された(走っていた回の世代と変わった)なら、古い回は新しいフォルダを同期していない・タイマーも張っていない。ここで改めて 1 回回す
      if (g !== this.generation && this.phase === 'idle' && this.running === null) await this.syncNow(true);
      return;
    }
    if (!this.deps.ready()) {
      if (manual) this.deps.say('いまはフォルダ同期できません(編集を終えると同期できます)');
      this.setTimer(SYNC_FOLDER_RETRY_MS); // 読み込み中・編集中は短い間隔でもう一度(起動直後の最初の同期を 1 分待たせない)
      return;
    }
    const gen = this.generation;
    this.runGen = gen;
    const dir = this.dir;
    this.phase = 'running';
    this.changed();
    const task = this.runLocked(dir, gen, manual)
      .catch((e: unknown) => {
        if (gen !== this.generation) return;
        this.emit(`フォルダ同期が止まりました: ${errorText(e)}`, 'fail');
      })
      .finally(() => {
        if (this.running === task) this.running = null;
        if (gen === this.generation && this.phase === 'running') {
          this.phase = 'idle';
          this.changed();
          this.setTimer();
        } else if (gen !== this.generation && this.phase === 'idle' && this.timer === null) {
          this.setTimer(); // フォルダが選び直された後に古い回が終わった: タイマーを必ず残す
        }
      });
    this.running = task;
    await task;
  }

  private async runLocked(dir: SyncDirLike, gen: number, manual: boolean): Promise<void> {
    const body = async (): Promise<void> => {
      this.prevMsgs = this.roundMsgs;
      this.roundMsgs = new Set();
      this.manualRound = manual;
      const perm = await this.permissionOf(dir);
      if (perm !== 'granted') {
        if (gen !== this.generation) return;
        this.phase = perm === 'prompt' ? 'needs-permission' : 'lost';
        this.message = perm === 'prompt' ? null : FOLDER_LOST_NOTE;
        this.emit(perm === 'prompt' ? FOLDER_NEEDS_PERMISSION_NOTE : FOLDER_LOST_NOTE, 'fail');
        this.changed();
        return;
      }
      try {
        const counts = await this.cycle(dir, gen, manual);
        if (gen !== this.generation || counts === null) return;
        const parts: string[] = [];
        if (counts.imported > 0) parts.push(`他の端末から取り込み ${counts.imported} ファイル(${counts.changed} 件を反映)`);
        if (counts.wrote) parts.push('この端末の変更を書き出し');
        if (counts.unreadable > 0) parts.push(`読めなかったファイル ${counts.unreadable} 件(書き込み中の可能性。次の回でやり直します)`);
        if (counts.settling > 0) parts.push(`書き込み途中のファイル ${counts.settling} 件(次の回へ)`);
        if (counts.failed > 0) parts.push(`取り込めなかったファイル ${counts.failed} 件`);
        if (this.pendingPeers.size > 0) parts.push(`確認が要る相手 ${this.pendingPeers.size} 件(「今すぐ同期」で確認します)`);
        const text = parts.length === 0 ? '変更はありませんでした' : parts.join(' / ');
        this.lastText = text;
        this.lastAt = this.clock();
        this.message = null;
        if (manual || counts.imported + (counts.wrote ? 1 : 0) + counts.failed > 0) this.emit(`フォルダと同期しました: ${text}`, 'say');
      } catch (e) {
        if (gen !== this.generation) return;
        if (errName(e) === 'NotAllowedError' || errName(e) === 'SecurityError') {
          this.phase = 'needs-permission';
          this.emit(FOLDER_NEEDS_PERMISSION_NOTE, 'fail');
        } else if (errName(e) === 'NotFoundError') {
          this.phase = 'lost';
          this.message = FOLDER_LOST_NOTE;
          this.emit(FOLDER_LOST_NOTE, 'fail');
        } else {
          // 一時的な失敗(ファイルが使われている等)── 理由を言い、次の回でやり直す
          this.lastText = `失敗しました(${errorText(e)})`;
          this.lastAt = this.clock();
          this.emit(`フォルダ同期に失敗しました: ${errorText(e)}`, 'fail');
        }
      }
    };
    const lock = this.deps.lock ?? null;
    if (lock === null) return body();
    let ran = false;
    try {
      const got = await lock(`pkc3-sync-folder:${this.deps.cid}`, async () => {
        ran = true;
        await body();
      });
      if (!got && manual) this.deps.say('別のタブ・ウィンドウが、このフォルダを同期しています(終わったあとの回に同期します)');
    } catch {
      if (!ran) await body(); // locks が使えない環境(file:// など)は排他なしで動かす
    }
  }

  private clock(): string {
    const d = new Date(this.deps.nowMs?.() ?? Date.now());
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  private async fileInfo(root: SyncDirLike, name: string): Promise<{ info: FolderFileInfo; file: File } | null> {
    try {
      const fh = await root.getFileHandle(name);
      const file = await fh.getFile();
      return { info: { name, size: file.size, lastModified: file.lastModified }, file };
    } catch (e) {
      if (errName(e) === 'NotFoundError') return null;
      throw e;
    }
  }

  /** 添付の実体を、フォルダの `assets/<key>` から引く(無い・安全でない名前・読めないは `null`)。 */
  private assetReader(assets: SyncDirLike): (key: string) => Promise<Blob | null> {
    return async (key) => {
      if (!isSafeAssetFileName(key)) return null;
      try {
        return await (await (await assets.getFileHandle(key)).getFile()).slice();
      } catch {
        return null;
      }
    };
  }

  /** 足りない添付の控えを、保存した記録へ書く(開き直しても引き直しを続ける)。失敗しても同期は止めない。 */
  private async saveMissing(): Promise<void> {
    try {
      const rec = await this.deps.store.get(this.deps.cid);
      if (rec !== null) await this.deps.store.put(this.deps.cid, { ...rec, missing: [...this.missingAssets.values()] });
    } catch {
      /* 記録できなくても、このセッションの控えは残る */
    }
  }

  private async healMissingAssets(deps: SyncDeps, read: (key: string) => Promise<Blob | null>): Promise<void> {
    let changed = false;
    for (const [key, meta] of [...this.missingAssets]) {
      const blob = await read(key);
      if (blob === null) continue;
      // 🔴 内容が目録(hash・大きさ)と合わなければ置かない(取り込みと同じ門。クラウドが途中までしか届けていない実体を置かない)
      if ((await assetMismatch(blob, meta)) !== null) continue;
      await deps.putBlob(key, blob);
      await deps.putAssetMeta({ key, mime: meta.mime, size: meta.size, hash: meta.hash });
      this.missingAssets.delete(key);
      changed = true;
    }
    if (changed) await this.saveMissing();
  }

  /** 定期の回は、結果・失敗を**メッセージ**へだけ出す(ステータスバー・注意の面を使わない。同じ知らせは繰り返さない)。 */
  private depsFor(base: SyncDeps, manual: boolean): SyncDeps {
    if (manual) return base;
    return {
      ...base,
      notify: () => undefined,
      reportProblem: (m) => this.emit(m, 'fail'),
      report: (notes) => this.emit(notes.join('\n'), 'say'),
    };
  }

  private async cycle(dir: SyncDirLike, gen: number, manual: boolean): Promise<Counts | null> {
    const deps = this.depsFor(await this.deps.syncDeps(), manual);
    if (!deps.enabled()) return null;
    // 取り消しが残っているあいだ・定期の回は、「取り込みを取り消す」を上書きしない(user が押す前に奪わない)
    const remember = manual && this.deps.undoPending?.() !== true;
    await deps.ensureConfigured?.();
    await deps.settle();
    const root = await dir.getDirectoryHandle(SYNC_FOLDER_DIR, { create: true });
    const assets = await root.getDirectoryHandle(SYNC_FOLDER_ASSETS_DIR, { create: true });
    const readAsset = this.assetReader(assets);
    const counts: Counts = { imported: 0, changed: 0, conflictsHint: false, wrote: false, unreadable: 0, settling: 0, failed: 0 };
    let snap = await deps.request({ op: 'syncSnapshot', cid: deps.cid, ensureDevice: true });
    if (snap.device === null) throw new Error('端末の記録を作れませんでした');
    let self = snap.device;

    // ── 1. フォルダの中のファイルを見る
    const found = new Map<string, { info: FolderFileInfo; file: File }>();
    for await (const e of root.values()) {
      if (e.kind !== 'file' || deviceOfFolderFile(e.name) === null) continue;
      const fi = await this.fileInfo(root, e.name);
      if (fi !== null) found.set(e.name, fi);
    }
    const nowMs = this.deps.nowMs?.() ?? Date.now();
    this.blockWrite = false;
    this.pendingPeers.clear();

    // ── 2. この端末のファイルの確かめ(別のワークスペース・同じ id の別の書き手)
    const own = found.get(folderFileNameOf(self));
    let ownSeq: number | null = null;
    if (own !== undefined) {
      try {
        const m = await readDiffManifest(own.file);
        if (m.cid !== deps.cid) {
          this.blockWrite = true;
          this.emit(
            `このフォルダには、この端末が別のワークスペース「${m.title}」のために置いたファイルがあります。上書きしないため、このワークスペースの書き出しは止めています。別のフォルダを選んでください`,
            'fail',
          );
        } else if (ownFileVerdict(m.seq, snap.outs, snap.seq) === 'suspect') {
          // この端末の記録に無い連番 = 別の端末が同じ id で書いた(端末のデータの複製)疑い。段 2 の取り込み(確認つき)に任せる
          // (手動の書き出しで記録から押し出された古い連番は、名前と端末 id が合っていれば自分の物 = `ownFileVerdict`)
          const r = await importSyncDiff(deps, own.file, own.info.name, { quiet: !manual, interactive: manual, assetReader: readAsset, remember });
          if (r.pending === 'duplicate') {
            this.pendingPeers.add(self);
            this.blockWrite = true;
          } else if (r.ok) {
            snap = await deps.request({ op: 'syncSnapshot', cid: deps.cid });
            self = snap.device ?? self;
          } else {
            this.blockWrite = true;
          }
        } else {
          ownSeq = m.seq;
        }
      } catch {
        ownSeq = null; // 読めない自分のファイルは、書き直す
      }
    }

    // ── 3. 他の端末のファイルを取り込む
    await this.healMissingAssets(deps, readAsset);
    const plan = planFolderFiles([...found.values()].map((f) => f.info), self, this.memo, nowMs);
    for (const a of plan) {
      if (gen !== this.generation) return null;
      if (a.kind === 'settling') {
        counts.settling++;
        continue;
      }
      if (a.kind !== 'consider') continue;
      const f = found.get(a.name) as { info: FolderFileInfo; file: File };
      const key = memoKey(f.info);
      if (!manual && this.failedMemo.get(a.name) === key) continue; // 前に失敗・読めなかった同じファイル(変わるまで飛ばす)
      let manifest: DiffManifest;
      try {
        manifest = await readDiffManifest(f.file);
      } catch (e) {
        // 書き込み・アップロードの途中かもしれない。取り込まず、次の回でやり直す(同じ知らせは繰り返さない)
        counts.unreadable++;
        this.failedMemo.set(a.name, key);
        if (this.unreadableSeen.get(a.name) !== key) {
          this.unreadableSeen.set(a.name, key);
          this.emit(`「${a.name}」を読めませんでした(書き込み中か、読めない状態です)。ファイルが更新されると取り込みます(「今すぐ同期」でもう一度試せます): ${errorText(e)}`, 'fail');
        }
        continue;
      }
      if (manifest.device !== a.device) {
        this.memo.set(a.name, key);
        this.emit(`「${a.name}」は、ファイル名の端末と中身の端末が違うので取り込みません`, 'fail');
        continue;
      }
      if (alreadyImported(manifest.seq, snap.peerSeqs[a.device])) {
        this.memo.set(a.name, key);
        continue;
      }
      let diff;
      try {
        diff = await readDiffZip(f.file);
      } catch (e) {
        counts.unreadable++;
        this.failedMemo.set(a.name, key);
        if (this.unreadableSeen.get(a.name) !== key) {
          this.unreadableSeen.set(a.name, key);
          this.emit(`「${a.name}」を読めませんでした(書き込み中か、読めない状態です)。ファイルが更新されると取り込みます(「今すぐ同期」でもう一度試せます): ${errorText(e)}`, 'fail');
        }
        continue;
      }
      const r = await importSyncDiff(deps, f.file, a.name, { diff, quiet: !manual, interactive: manual, assetReader: readAsset, remember });
      if (r.pending !== undefined) {
        this.pendingPeers.add(a.device);
        continue;
      }
      if (!r.ok) {
        counts.failed++;
        this.failedMemo.set(a.name, key);
        continue;
      }
      this.failedMemo.delete(a.name);
      this.memo.set(a.name, key);
      counts.imported++;
      counts.changed += r.count;
      for (const m of r.missingAssets ?? []) this.missingAssets.set(m.key, m);
      if ((r.missingAssets ?? []).length > 0) await this.saveMissing();
      snap = await deps.request({ op: 'syncSnapshot', cid: deps.cid });
      self = snap.device ?? self;
    }
    for (const dev of this.pendingPeers) if (dev !== self) this.emit(`${peerLabel(dev)}のファイルは、初めての相手なので確認が要ります。「今すぐ同期」を押してください`, 'say');

    // ── 4. この端末のファイルを書く(変わっているときだけ)
    if (this.blockWrite || gen !== this.generation) return counts;
    const digest = fingerprintDigest(fingerprintsOf(snap.states));
    if (needsOwnWrite(ownSeq, snap.outs, digest)) {
      const built = await buildSyncDiff(deps, { all: true, inlineAssets: false, peerBases: true });
      for (const meta of built.carried) await this.ensureAssetFile(assets, meta, deps);
      await this.writeFile(root, folderFileNameOf(built.device), built.blob);
      counts.wrote = true;
    }
    return counts;
  }

  /** 添付の実体を `assets/<key>` に置く(同じ名前があれば触らない = 内容で名前が決まるので端末間で共有)。 */
  private async ensureAssetFile(assets: SyncDirLike, meta: DiffAssetMeta, deps: SyncDeps): Promise<void> {
    if (!isSafeAssetFileName(meta.key)) return;
    try {
      await assets.getFileHandle(meta.key);
      return;
    } catch (e) {
      const n = errName(e);
      if (n === 'NotAllowedError' || n === 'SecurityError') throw e; // 許可の問題は同期全体の状態へ
      if (n !== 'NotFoundError') {
        // 🔴 この添付だけが置けない(名前を受け付けない等)── 全体を止めず、この添付を飛ばして 1 度だけ知らせる
        if (!this.assetFailSeen.has(meta.key)) {
          this.assetFailSeen.add(meta.key);
          this.emit(`添付「${meta.key}」をフォルダへ置けませんでした(この添付だけ飛ばして続けます): ${errorText(e)}`, 'fail');
        }
        return;
      }
    }
    const blob = await deps.getAssetBlob(meta.key);
    if (blob === null) return;
    await this.writeFile(assets, meta.key, blob);
  }

  /**
   * ファイルを書く。🔴 `createWritable` は閉じるまで元のファイルを残し、閉じた時点で入れ替える(途中で落ちても半端なファイルにならない)。
   * 失敗したら書き込みを捨てる(`abort`)。⚠ 他の端末のファイルには書かない(名前は呼び手が自分の端末 id で作る)。
   */
  private async writeFile(dir: SyncDirLike, name: string, blob: Blob): Promise<void> {
    const fh: SyncFileHandleLike = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(blob);
      await w.close();
    } catch (e) {
      await w.abort?.().catch(() => undefined);
      throw e;
    }
  }
}
