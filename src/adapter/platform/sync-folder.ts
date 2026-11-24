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
 *
 * ## S3 互換の保管先(#2000 段 4a-4)
 * - フォルダの代わりに、S3 互換の保管先(AWS S3 / Cloudflare R2 / MinIO など)を選べる。回の中身は同じ(`RemoteBox` の口だけが違う)。
 * - 接続情報と認証情報はこの端末の鍵の保管(`sync-keystore.ts`。取り出せない鍵で暗号化)に置き、ここの記録(IndexedDB)には
 *   **種類(`kind: 's3'`)だけ**を置く。🔴 認証情報はこの記録・バックアップ・差分 zip・設定ファイル・メッセージのどれにも入れない。
 * - フォルダと保管先は同時には使わない(選び直すと、前の方をやめる。保管先をやめるときは認証情報も消す ── 片道にしない)。
 * - 📌 `file://` では選べない(「HTTPS で開いたときだけ使えます」)。
 */
import { errorText } from '@features/error-text';
import type { DiffManifest } from '@features/sync/diff-file';
import { E2EError, createKeyMaterial, openDataKey, rewrapKeyring, type E2ECrypto, type OpenedKey } from '@features/sync/e2e-crypto';
import { KeyringFormatError } from '@features/sync/keyring';
import type { E2EKeyState } from './sync-e2e';
import {
  backoffMinutes,
  checkPeerSeq,
  chooseRoundFiles,
  deviceOfFileName,
  emptyFolderRecord,
  encFileName,
  forgetPeerSeq,
  folderFileName,
  isEncFileName,
  notePeerSeq,
  isSyncFolderMinutes,
  normalizeFolderRecord,
  planFolderRound,
  sameFileVersion,
  SYNC_FOLDER_DEFAULT_MINUTES,
  updateWant,
  wantedByOf,
  type FolderFile,
  type FolderSyncRecord,
  type SyncFolderMinutes,
} from '@features/sync/sync-folder';
import type { SyncDirLike, SyncLock } from './folder-sync';
import { EncryptedBox, KeyringConflictError } from './encrypted-box';
import { folderBox, type RemoteBox } from './sync-box';
import { BoxConflictError } from './s3-box';
import { normalizeS3Config, s3ConfigProblem, type S3BoxConfig, type S3BoxSecret } from './sync-keystore';
import type { ApplyOutcome, BuiltDiff, DiffTarget } from '@adapter/ui/actions/sync-diff';

/** 許可を確かめ・頼める handle。 */
export interface SyncFolderDirLike extends SyncDirLike {
  requestPermission?(descriptor: { mode: string }): Promise<string>;
}

export type SyncFolderPicker = (options: { mode: 'readwrite'; id?: string }) => Promise<SyncFolderDirLike>;

/**
 * 🔴 **S3 互換の保管先の口**(#2000 段 4a-4)。認証情報の置き場(鍵の保管)と、保管先の口(`S3Box`)を作る所。
 * ⚠ 認証情報はこの口の外へ出さない(`SyncFolder` は開いた認証情報を口(`box`)へ渡すだけで、自分の記録には置かない)。
 */
export interface SyncRemoteDeps {
  /** 使えない理由(`file://` で開いた等)。使えるなら `null`。 */
  unavailable(): string | null;
  open(cid: string): Promise<{ config: S3BoxConfig; secret: S3BoxSecret } | null>;
  save(cid: string, config: S3BoxConfig, secret: S3BoxSecret): Promise<void>;
  remove(cid: string): Promise<void>;
  box(config: S3BoxConfig, secret: S3BoxSecret): RemoteBox;
}

/**
 * 🔴 **端末間の同期の暗号化の口**(#2000 段 4b)。開いた暗号化キーの持ち主(`SyncE2E`)と暗号の口を渡す所。
 * 🔴 **fail-closed**(段 4b-B): 暗号化したい箱(S3 は既定 / フォルダは入れたとき)で、この口が無い・暗号化キーが開かれていないときは、
 *   **平文で書かずに止まる**(メッセージで知らせる)。
 */
export interface SyncE2EDeps {
  readonly crypto: E2ECrypto;
  /** 開いた暗号化キー(無ければ `null` ── まだパスフレーズを入れていない / 保管しない設定で開き直していない)。 */
  key(cid: string): Promise<OpenedKey | null>;
  /** 画面の見え方(開いているか・端末に置いてあるか)。`refresh` のあとに正しい。 */
  state(cid: string): E2EKeyState;
  refresh(cid: string): Promise<E2EKeyState>;
  /** 開いた暗号化キーを置く(`remember` = 端末の保管にも置く / 偽 = メモリだけ)。 */
  hold(cid: string, key: OpenedKey, remember: boolean): Promise<void>;
  /** 端末の保管の有無だけを切り替える(開いているときだけ。切り替えたか)。 */
  setRemember(cid: string, remember: boolean): Promise<boolean>;
  /** この端末の暗号化キーを忘れる。 */
  forget(cid: string): Promise<void>;
}

/** 暗号化の画面の見え方(`SyncFolderView.e2e`)。 */
export interface SyncE2EView {
  /** 暗号化の口があるか(無い環境では「このビルドでは使えません」)。 */
  available: boolean;
  /** この接続は暗号化するか(S3 は既定オン / フォルダは入れたとき)。 */
  on: boolean;
  /** 暗号化キーを開いているか。 */
  open: boolean;
  /** 開いたキーをこの端末に置いているか(偽 = 開くたびにパスフレーズを入れる)。 */
  stored: boolean;
  /** 「開くたびにパスフレーズを入れる」を選んでいるか(この端末の選び方。再起動しても残る)。 */
  ask: boolean;
  /** 置き場の暗号化キーの束(keyring.json)の有無。`unknown` = まだ調べていない / 調べられない。 */
  keyring: 'unknown' | 'none' | 'present' | 'broken';
  /** 巻き戻し・差し替えの疑いで取り込んでいない端末の ID(「この端末を受け入れ直す」の相手)。 */
  refused: string[];
}

/** 暗号化の操作の結果(字は画面にそのまま出す。⚠ 入れた字は含めない)。 */
export interface E2EResult {
  ok: boolean;
  text: string;
}

/** 初回の設定の途中(回復キーを見せて打ち直してもらう間)。確定するまで置き場には何も書かない。 */
export type E2ESetupStart =
  | { kind: 'ready'; recoveryKey: string; commit(): Promise<E2EResult>; cancel(): void }
  | { kind: 'refused'; text: string };

/** 開く / 包み直すときの入力(パスフレーズか回復キー)。 */
export type E2EVia = { passphrase: string } | { recoveryKey: string };

/** 画面で入れた接続先(確かめる前の生の字)。 */
export interface SyncRemoteForm {
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 🔴 中身を暗号化するか(段 4b。省略 = オン)。 */
  encrypt?: boolean;
}

/** 📌 `file://` などで保管先を選べない理由(user 裁定 2026-11-22)。 */
export const SYNC_REMOTE_HTTPS_ONLY = 'HTTPS で開いたときだけ使えます';
export const SYNC_REMOTE_UNREADABLE_NOTE =
  'この端末に保存した保管先の認証情報を読めません(ブラウザがデータを消した可能性があります)。設定の「S3 互換の保管先」で接続し直してください';

/** IndexedDB に置く 1 件(ワークスペースごと)。 */
export interface SyncFolderSaved {
  /** 何と同期するか(既定 = フォルダ)。⚠ `s3` のときの接続情報・認証情報は鍵の保管にある(ここには置かない)。 */
  kind?: 'folder' | 's3';
  /** 🔴 同期フォルダを暗号化するか(段 4b。**既定オフ**)。⚠ S3 互換は接続情報の `encrypt`(既定オン)。 */
  encrypt?: boolean;
  /** 🔴 「開くたびにパスフレーズを入れる」を選んでいるか(段 4b-B。偽・無し = この端末に取り出せない形で置いて自動で開く)。 */
  e2eAsk?: boolean;
  /** フォルダの handle。⚠ `null` = この端末では handle を憶えない(下の「読み込みの見張り」)── 開くたびに選び直す。 */
  handle: SyncFolderDirLike | null;
  minutes: SyncFolderMinutes;
  record: FolderSyncRecord;
  /** 自分が最後に書いた自分のファイルの大きさ・更新日時・版(他の端末が同じ名前で書いたか = 端末 id の重複を見分ける)。 */
  own?: { size: number; mtime: number; version?: string; name?: string } | null;
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
  /** いま同期している物の名前(フォルダの名前 / 保管先のバケットと置き場)。 */
  folderName: string | null;
  /** いま同期している物の種類(`null` = 選んでいない)。 */
  kind: 'folder' | 's3' | null;
  /** フォルダを選べるブラウザか(Chrome・Edge のパソコン版)。 */
  folderSupported: boolean;
  /** 保管先を選べない理由(`null` = 選べる)。 */
  remoteUnavailable: string | null;
  /** 保管先の接続先(秘密でない物だけ ── 画面の欄に戻す)。 */
  remoteConfig: S3BoxConfig | null;
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
  /** 🔴 暗号化の見え方(段 4b-B)。 */
  e2e: SyncE2EView;
}

export interface SyncFolderDeps {
  cid(): string;
  /** 設定「端末間の同期」。 */
  enabled(): boolean;
  /** `null` = このブラウザでは選べない(Firefox / Safari / スマホ)。 */
  picker: SyncFolderPicker | null;
  /** S3 互換の保管先(#2000 段 4a-4)。無ければ選べない。 */
  remote?: SyncRemoteDeps | null;
  /** 暗号化の口(#2000 段 4b)。無ければ暗号化の層は動かない。 */
  e2e?: SyncE2EDeps | null;
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
/** ⚠ IndexedDB(`pkc3-sync-folder` の `marks`)の中の名前 ── 端末の設定(localStorage の `pkc3.*`)ではない。 */
export const SYNC_FOLDER_LOADING_MARK = 'loading';
export const SYNC_FOLDER_NO_PERSIST_MARK = 'no-persist';
/** 別のタブが読んでいる途中の印とみなす新しさ(ms)。 */
export const SYNC_FOLDER_MARK_FRESH_MS = 3000;
export const SYNC_FOLDER_CRASHED_NOTE =
  '前回、保存しておいた同期フォルダを読み込む途中で画面が止まりました。この端末では同期フォルダを保存しないようにしました。開くたびに「同期フォルダを選ぶ」を押してください';

/** 🔴 暗号化の案内(#2000 段 4b)。⚠ 字に端末 ID の先頭 8 字だけを出す。 */
const shortDevices = (ds: readonly string[]): string => ds.map((d) => d.slice(0, 8)).join('・');
export const SYNC_E2E_LOCKED_NOTE = '暗号化キーが開かれていないため、同期を止めています。パスフレーズを入れると同期を再開します(設定の「端末間の同期」で入れられます)';
export const SYNC_E2E_SETUP_NOTE = 'この置き場にはまだ暗号化キーがありません。同期を止めています。設定の「端末間の同期」でパスフレーズを決めると、同期を始めます';
export const SYNC_E2E_UNAVAILABLE_NOTE = 'このブラウザでは暗号化を使えないため、同期を止めています(暗号化したい接続は、平文では書きません)';
/** 状態の 1 行(メッセージの「いまの状態」)。 */
export const SYNC_E2E_LOCKED_STATUS = 'パスフレーズを入れると同期を再開します';
export const SYNC_E2E_SETUP_STATUS = 'パスフレーズを決めると同期を始めます';
export const syncE2EPeerPlainNote = (ds: readonly string[]): string =>
  `暗号化していない端末があります(${shortDevices(ds)})。その端末でも暗号化をオンにしてください`;
export const syncE2EPeerEncNote = (ds: readonly string[]): string =>
  `暗号化されたファイルを置いている端末があります(${shortDevices(ds)})。この端末でも暗号化をオンにしてください(オンにするまで、その端末のファイルは読めません)`;
export const syncE2ERollbackNote = (dev: string, kind: 'rollback' | 'replaced'): string =>
  (kind === 'rollback'
    ? `端末 ${dev.slice(0, 8)} のファイルは、取り込み済みのものより古いため取り込みませんでした`
    : `端末 ${dev.slice(0, 8)} のファイルは、取り込み済みのものと連番が同じで中身が違うため取り込みませんでした`) +
  '(古いファイルの差し戻しや差し替えの可能性があります。相手の端末が古いバックアップから戻した場合は、設定の端末間の同期で、その端末を受け入れ直してください)';
export const SYNC_E2E_KEYRING_NOTE =
  '置き場の暗号化キーの束(keyring.json)が、この端末で開いている暗号化キーと一致しないか、読めません。同期を止めています(暗号化キーを開き直してください)';

export const SYNC_FOLDER_UNSUPPORTED_NOTE =
  'このブラウザでは同期フォルダを選べません(フォルダを読み書きする仕組みは、パソコンの Chrome・Edge にだけあります)。スマホや Safari・Firefox では「差分を書き出す」と差分ファイルの取り込みを使ってください';
export const SYNC_FOLDER_PERMISSION_NOTE = 'このフォルダを読み書きする許可が切れています。「許可を出し直す」を押してください';
const LOCK_PREFIX = 'pkc3-sync-folder:';

const pad2 = (n: number): string => String(n).padStart(2, '0');
const errName = (e: unknown): string => (typeof e === 'object' && e !== null ? String((e as { name?: unknown }).name ?? '') : '');

export class SyncFolder {
  private phase: SyncFolderPhase;
  private dir: SyncFolderDirLike | null = null;
  /** S3 互換の保管先(`dir` とどちらか一方)。⚠ 認証情報は `box` の中にだけある。 */
  private remote: { box: RemoteBox; config: S3BoxConfig } | null = null;
  /** 保管先へ接続している途中(回を始めない・二重に接続しない)。 */
  private connecting = false;
  private minutes: SyncFolderMinutes = SYNC_FOLDER_DEFAULT_MINUTES;
  private record: FolderSyncRecord = emptyFolderRecord();
  private own: { size: number; mtime: number; version?: string; name?: string } | null = null;
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
  /** 同期フォルダを暗号化するか(段 4b。既定オフ)。 */
  private folderEncrypt = false;
  private lastGuide: string | null = null;
  /** 置き場の暗号化キーの束の有無(画面の見え方。`probeKeyring` が更新する)。 */
  private keyringState: SyncE2EView['keyring'] = 'unknown';
  /** 巻き戻し・差し替えの疑いで取り込んでいない端末(メモリだけ ── 次の回で、まだ古ければまた入る)。 */
  private refused = new Set<string>();
  /** 暗号化キーが開かれていなくて止まっているか(状態の 1 行とボタンの出し入れ)。 */
  private e2eLocked = false;
  /** 「開くたびにパスフレーズを入れる」を選んでいるか(保存する ── 再起動後の開き方の初期値)。 */
  private e2eAsk = false;

  /** この端末では handle を憶えない(前に読み込みで画面が落ちた)。起動時に印から読む。 */
  private noPersistFlag = false;

  constructor(private readonly deps: SyncFolderDeps) {
    // ⚠ フォルダを選べなくても、保管先を選べるなら止めない
    this.phase = deps.picker === null && this.remoteUnavailable() !== null ? 'unsupported' : 'none';
  }

  /** 保管先を選べない理由(`null` = 選べる)。 */
  private remoteUnavailable(): string | null {
    const r = this.deps.remote;
    if (r === undefined || r === null) return 'このビルドでは使えません';
    return r.unavailable();
  }

  /** 同期する先を選んであるか。 */
  private hasTarget(): boolean {
    return this.dir !== null || this.remote !== null;
  }

  private remoteLabel(c: S3BoxConfig): string {
    return `${c.bucket}${c.prefix === '' ? '' : `/${c.prefix.replace(/\/$/, '')}`}`;
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
      folderName: this.dir?.name ?? (this.remote === null ? null : this.remoteLabel(this.remote.config)),
      kind: this.dir !== null ? 'folder' : this.remote !== null ? 's3' : null,
      folderSupported: this.deps.picker !== null,
      remoteUnavailable: this.remoteUnavailable(),
      remoteConfig: this.remote?.config ?? null,
      minutes: this.minutes,
      lastAt: this.lastAt,
      lastText: this.lastText,
      message: this.phase === 'unsupported' ? SYNC_FOLDER_UNSUPPORTED_NOTE : this.message,
      pending: this.pending.size,
      persist: !this.noPersistFlag,
      e2e: this.e2eView(),
    };
  }

  private e2eView(): SyncE2EView {
    const e2e = this.deps.e2e;
    const st = e2e === undefined || e2e === null ? { open: false, stored: false } : e2e.state(this.deps.cid());
    return {
      available: e2e !== undefined && e2e !== null,
      on: this.hasTarget() && this.wantsEncrypt(),
      open: st.open,
      stored: st.stored,
      ask: this.e2eAsk,
      keyring: this.keyringState,
      refused: [...this.refused],
    };
  }

  /** 状態の欄のボタンの字(止まっていなければ `null`)。 */
  unlockButtonLabel(): string | null {
    if (!this.needsPassphrase()) return null;
    return this.keyringState === 'none' ? '暗号化を設定する' : 'パスフレーズを入れる';
  }

  /** パスフレーズを入れる(決める)まで止まっているか。 */
  needsPassphrase(): boolean {
    return this.e2eLocked && this.phase === 'stopped';
  }

  /** ステータスバーの一言(状態。結果はメッセージへ)。 */
  statusLine(): string {
    if (this.phase === 'running') return '端末間の同期をしています…';
    if (this.needsPassphrase()) return this.keyringState === 'none' ? SYNC_E2E_SETUP_STATUS : SYNC_E2E_LOCKED_STATUS;
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
    if (this.remote !== null) {
      // 🔴 種類だけ(接続情報・認証情報は鍵の保管にある)
      await this.deps.store.save(this.deps.cid(), {
        kind: 's3',
        handle: null,
        minutes: this.minutes,
        record: this.record,
        own: this.own,
        ...(this.e2eAsk ? { e2eAsk: true } : {}),
      });
      return;
    }
    if (this.dir === null) return;
    await this.deps.store.save(this.deps.cid(), {
      handle: this.noPersist() ? null : this.dir,
      minutes: this.minutes,
      record: this.record,
      own: this.own,
      ...(this.folderEncrypt ? { encrypt: true } : {}),
      ...(this.e2eAsk ? { e2eAsk: true } : {}),
    });
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
    if (saved !== null && saved.kind === 's3') return this.bootRemote(saved);
    if (saved !== null && saved.handle === null) {
      // 憶えない端末: 間隔と記録だけ戻す(フォルダは選び直す)
      this.minutes = isSyncFolderMinutes(saved.minutes) ? saved.minutes : SYNC_FOLDER_DEFAULT_MINUTES;
      this.record = normalizeFolderRecord(saved.record);
      this.own = saved.own ?? null;
      this.folderEncrypt = saved.encrypt === true;
      this.e2eAsk = saved.e2eAsk === true;
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
    this.folderEncrypt = saved.encrypt === true;
    this.e2eAsk = saved.e2eAsk === true;
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

  /** 起動時: 保管先の認証情報を開いて回り始める。 */
  private async bootRemote(saved: SyncFolderSaved): Promise<void> {
    const gen = this.generation;
    this.minutes = isSyncFolderMinutes(saved.minutes) ? saved.minutes : SYNC_FOLDER_DEFAULT_MINUTES;
    this.record = normalizeFolderRecord(saved.record);
    this.own = saved.own ?? null;
    this.e2eAsk = saved.e2eAsk === true;
    const why = this.remoteUnavailable();
    const r = this.deps.remote;
    if (why !== null || r === undefined || r === null) {
      // 📌 file:// で開いた等 ── 記録は残す(HTTPS で開き直せば続きから)
      this.phase = 'none';
      this.message = `S3 互換の保管先と同期する設定ですが、${why ?? ''}`;
      this.changed();
      return;
    }
    const opened = await r.open(this.deps.cid()).catch(() => null);
    // ⚠ 開いている間に「接続する」「やめる」が走った ── 古い認証情報で上書きしない(着地前レビュー ⚠2)
    if (gen !== this.generation || this.connecting) return;
    if (opened === null) {
      this.phase = 'none';
      this.message = SYNC_REMOTE_UNREADABLE_NOTE;
      this.changed();
      this.deps.fail(SYNC_REMOTE_UNREADABLE_NOTE);
      return;
    }
    this.dir = null;
    this.remote = { box: r.box(opened.config, opened.secret), config: opened.config };
    this.phase = 'idle';
    this.message = null;
    this.changed();
    void this.syncNow(false);
  }

  /** 画面の欄から接続先を作る(確かめて、通らなければ理由)。 */
  private remoteFrom(form: SyncRemoteForm): { config: S3BoxConfig; secret: S3BoxSecret } | { problem: string } {
    const config = normalizeS3Config(form);
    const problem = s3ConfigProblem(config);
    if (problem !== null) return { problem };
    const accessKeyId = form.accessKeyId.trim();
    const secretAccessKey = form.secretAccessKey.trim();
    if (accessKeyId === '' || secretAccessKey === '') return { problem: 'アクセスキー ID とシークレットアクセスキーを入れてください' };
    return { config: form.encrypt === false ? { ...config, encrypt: false } : config, secret: { accessKeyId, secretAccessKey } };
  }

  /**
   * 🔴 **「接続の確認」** ── 保存せずに、保管先の一覧を 1 度読んでみる。結果は字で返す(メッセージにも残す)。
   * ⚠ 一覧を読めても、書けるか(PUT の CORS・権限)は最初の同期で分かる ── そう言う。
   */
  async testRemote(form: SyncRemoteForm): Promise<{ ok: boolean; text: string }> {
    const why = this.remoteUnavailable();
    const r = this.deps.remote;
    const done = (ok: boolean, text: string): { ok: boolean; text: string } => {
      (ok ? this.deps.say : this.deps.fail)(text);
      return { ok, text };
    };
    if (why !== null || r === undefined || r === null) return done(false, `S3 互換の保管先は ${why ?? ''}`);
    const got = this.remoteFrom(form);
    if ('problem' in got) return done(false, `接続を確認できません: ${got.problem}`);
    try {
      const files = await r.box(got.config, got.secret).list((name) => deviceOfFileName(name) !== null);
      return done(
        true,
        `保管先に接続できました(同期のファイルが ${String(files.length)} 個あります)。書き込めるかは、「接続する」を押したあとの最初の同期で確かめます`,
      );
    } catch (e) {
      return done(false, `保管先に接続できませんでした: ${errorText(e)}`);
    }
  }

  /**
   * 🔴 **「接続する」** ── 確かめて(一覧を読めたら)認証情報を鍵の保管へ置き、保管先と同期し始める。
   * フォルダを選んでいたら、フォルダをやめる(同時には使わない)。
   */
  async connectRemote(form: SyncRemoteForm): Promise<boolean> {
    if (!this.deps.enabled()) {
      this.deps.fail('設定の「端末間の同期」をオンにしてから、保管先に接続してください');
      return false;
    }
    const why = this.remoteUnavailable();
    const r = this.deps.remote;
    if (why !== null || r === undefined || r === null) {
      this.deps.fail(`S3 互換の保管先は ${why ?? ''}`);
      return false;
    }
    const got = this.remoteFrom(form);
    if ('problem' in got) {
      this.deps.fail(`保管先に接続できません: ${got.problem}`);
      return false;
    }
    if (this.connecting) {
      this.deps.fail('いま保管先に接続しています。終わるまで待ってください');
      return false;
    }
    /**
     * 🔴 **接続の間は回を始めない**(着地前レビュー ⚠3・⚠4)── 確かめる・保存する間に定期の回が始まると、差し替えの前後で
     *   古い接続先の記録を新しい接続先の物として残しうる。保存に失敗したら何も変えない(いまの接続と定期の回はそのまま)。
     */
    this.connecting = true;
    try {
      const box = r.box(got.config, got.secret);
      try {
        await box.list((name) => deviceOfFileName(name) !== null);
      } catch (e) {
        this.deps.fail(`保管先に接続できませんでした(何も保存していません): ${errorText(e)}`);
        return false;
      }
      try {
        await r.save(this.deps.cid(), got.config, got.secret);
      } catch (e) {
        this.deps.fail(`保管先の認証情報を保存できませんでした(いまの接続はそのままです): ${errorText(e)}`);
        return false;
      }
      this.generation += 1;
      this.clearTimer();
      await this.waitCurrent();
      this.swapToRemote(box, got.config);
    } finally {
      this.connecting = false;
    }
    try {
      await this.persist();
    } catch (e) {
      this.deps.fail(`保管先を保存できませんでした(この画面を閉じるまでは同期します): ${errorText(e)}`);
    }
    this.changed();
    await this.syncNow(true);
    return true;
  }

  /** 保管先へ差し替える(同じ接続先なら記録を引き継ぐ)。⚠ 待たずに一気に書く(途中で回が割り込まない)。 */
  private swapToRemote(box: RemoteBox, config: S3BoxConfig): void {
    const got = { config };
    const wasFolder = this.dir !== null;
    const same =
      this.remote !== null &&
      (['endpoint', 'bucket', 'region', 'prefix'] as const).every((k) => this.remote?.config[k] === got.config[k]);
    this.dir = null;
    this.remote = { box, config: got.config };
    if (!same) {
      this.record = emptyFolderRecord();
      this.own = null;
    }
    this.phase = 'idle';
    this.message = null;
    this.failures = 0;
    this.pending.clear();
    if (wasFolder) this.deps.say('同期フォルダをやめて、S3 互換の保管先と同期します(フォルダの中のファイルはそのままです)');
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
    if (this.remote !== null) return true; // 保管先は許可を求めない(認証情報で読み書きする)
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
    // 保管先を使っていたら、やめる(同時には使わない。🔴 認証情報も消す ── 使わない秘密を端末に残さない)
    if (this.remote !== null) {
      this.remote = null;
      this.record = emptyFolderRecord();
      this.own = null;
      this.resetE2E();
      await this.deps.e2e?.forget(this.deps.cid()).catch(() => undefined);
      // ⚠ 消せたかで言い分ける(消せなかったのに「消しました」と言わない)── 消せなかった物は「接続を外す」の掃除(上の stop)が拾う
      const removed = await (this.deps.remote?.remove(this.deps.cid()) ?? Promise.resolve()).then(
        () => true,
        (e: unknown) => {
          this.deps.fail(`保管先の認証情報を消せませんでした(同期フォルダに切り替えます。「同期フォルダをやめる」を押すと、もう一度消します): ${errorText(e)}`);
          return false;
        },
      );
      if (removed) this.deps.say('S3 互換の保管先をやめて、同期フォルダと同期します(保管先の認証情報はこの端末から消しました)');
    }
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

  /**
   * 同期フォルダをやめる(handle と記録を消す。フォルダの中のファイルは消さない)。
   * 🔴 保管先なら **「接続を外す」** ── 認証情報も鍵の保管から消す(保管先の中のファイルは消さない)。
   */
  async stop(): Promise<void> {
    this.generation += 1;
    this.clearTimer();
    await this.waitCurrent();
    const wasRemote = this.remote !== null;
    const r = this.deps.remote;
    if (wasRemote && r !== undefined && r !== null) {
      // 🔴 **認証情報を先に消す**(着地前レビュー 🔴1)── 消せなかったら接続したままにして「接続を外す」をもう 1 度押せるようにする
      //   (先に画面を「使っていません」へ戻すと、残った認証情報を消す押し所が無くなる)
      try {
        await r.remove(this.deps.cid());
      } catch (e) {
        this.deps.fail(`保管先の認証情報を消せませんでした(接続したままです。もう一度「接続を外す」を押してください): ${errorText(e)}`);
        this.changed();
        this.schedule();
        return;
      }
    }
    this.remote = null;
    this.dir = null;
    this.record = emptyFolderRecord();
    this.own = null;
    this.pending.clear();
    this.resetE2E();
    this.folderEncrypt = false;
    await this.deps.e2e?.forget(this.deps.cid()).catch(() => undefined);
    this.lastAt = null;
    this.lastText = null;
    this.message = null;
    this.phase = this.phase === 'unsupported' ? 'unsupported' : this.deps.enabled() ? 'none' : 'off';
    try {
      await this.deps.store.remove(this.deps.cid());
    } catch (e) {
      this.deps.fail(`同期フォルダの記録を消せませんでした: ${errorText(e)}`);
    }
    // ⚠ 保管先を使っていなくても消す(起動時に開けなかった等で、置き場に残っている物を残さない)── こちらは黙って試すだけ
    //   (`file://` で開いた端末などでフォルダをやめるたびに失敗を言わない)
    if (!wasRemote && r !== undefined && r !== null && r.unavailable() === null) await r.remove(this.deps.cid()).catch(() => undefined);
    this.changed();
    if (wasRemote) this.deps.say('S3 互換の保管先との接続を外しました(この端末から認証情報を消しました。保管先の中のファイルはそのままです)');
    else this.deps.say('同期フォルダとの同期をやめました(フォルダの中のファイルはそのままです。他の端末が使っていなければ、手で消せます)');
  }

  /**
   * 「同期の記録を消す」の後: 端末 id が変わるので、すぐに 1 回まわして、前の id で置いた自分のファイルを片付ける
   * (片付け自体は回の最初の「端末 id が変わった」の確かめが持つ ── オフの間・別のワークスペースで消したときも、次にオンで回ったときに片付く)。
   * ⚠ 設定がオフ・フォルダを選んでいないときは何もしない(オフの間はフォルダにも IndexedDB にも書かない)。
   */
  async forgetRecords(): Promise<void> {
    if (!this.deps.enabled() || !this.hasTarget()) return;
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

  /** 同期フォルダの暗号化の切り替え(段 4b。S3 互換は接続情報の `encrypt`)。⚠ 切り替えの画面は段 4b-B。 */
  async setFolderEncrypt(on: boolean): Promise<void> {
    if (this.folderEncrypt === on) return;
    this.folderEncrypt = on;
    try {
      await this.persist();
    } catch {
      /* 次に保存できたときに残る */
    }
    this.changed();
  }

  /**
   * 🔴 **この端末を受け入れ直す**(相手が古いバックアップから戻したときの救済 ── 画面は段 4b-B)。その相手の連番の記録を忘れ、
   * 次の回から読み直す。他の相手の記録は動かさない。
   * @returns 記録を変えたか
   */
  async acceptPeerAgain(device: string): Promise<boolean> {
    this.refused.delete(device);
    const changed = forgetPeerSeq(this.record, device);
    if (!changed) {
      this.changed();
      return false;
    }
    try {
      await this.persist();
    } catch (e) {
      this.deps.fail(`受け入れ直す記録を保存できませんでした(この画面を閉じるまでは有効です): ${errorText(e)}`);
    }
    this.deps.say(`端末 ${device.slice(0, 8)} を受け入れ直します(次の同期から、その端末のファイルを再読み込みします)`);
    this.changed();
    await this.syncNow(true);
    return true;
  }

  /** この接続を暗号化したいか(S3 は既定オン / フォルダは入れたとき)。⚠ 口が無くても「したい」── その場合は平文で書かずに止まる(fail-closed)。 */
  private wantsEncrypt(): boolean {
    return this.remote !== null ? this.remote.config.encrypt !== false : this.folderEncrypt;
  }

  private resetE2E(): void {
    this.keyringState = 'unknown';
    this.refused.clear();
    this.e2eLocked = false;
    this.e2eAsk = false;
  }

  /** 開き方の選び方(開くたびに入れる)を保存する。保存できなくても同期は続ける。 */
  private async setAsk(ask: boolean): Promise<void> {
    if (this.e2eAsk === ask) return;
    this.e2eAsk = ask;
    try {
      await this.persist();
    } catch {
      /* 次に保存できたときに残る */
    }
  }

  /** 暗号化の層に包む前の箱(許可・handle の面倒は上が見る)。 */
  private rawBoxNow(): RemoteBox | null {
    return this.remote !== null ? this.remote.box : this.dir !== null ? folderBox(this.dir) : null;
  }

  /** 置き場の暗号化キーの束の有無を調べて、画面の見え方に載せる(調べられなければ `unknown`)。 */
  private async probeKeyring(raw: RemoteBox, e2e: SyncE2EDeps): Promise<void> {
    try {
      const k = await new EncryptedBox({ inner: raw, crypto: e2e.crypto, key: null }).loadKeyring();
      this.keyringState = k === null ? 'none' : 'present';
    } catch (e) {
      this.keyringState = e instanceof KeyringFormatError ? 'broken' : 'unknown';
    }
    await e2e.refresh(this.deps.cid()).catch(() => undefined);
  }

  /** 画面を開いたとき・操作のあと: 置き場の束の有無と、暗号化キーの保管の有無を調べ直す。 */
  async refreshE2E(): Promise<void> {
    const raw = this.rawBoxNow();
    const e2e = this.deps.e2e;
    if (raw === null || e2e === undefined || e2e === null || !this.hasTarget() || !this.wantsEncrypt()) return;
    await this.probeKeyring(raw, e2e);
    this.changed();
  }

  private e2eNeed(): { raw: RemoteBox; e2e: SyncE2EDeps } | E2EResult {
    const raw = this.rawBoxNow();
    const e2e = this.deps.e2e;
    if (e2e === undefined || e2e === null) return { ok: false, text: SYNC_E2E_UNAVAILABLE_NOTE };
    if (raw === null) return { ok: false, text: 'まだ同期先を選んでいません(先に同期フォルダか S3 互換の保管先を選んでください)' };
    return { raw, e2e };
  }

  /** 失敗の字(入れた字は含めない)。 */
  private e2eErrorText(e: unknown): string {
    if (e instanceof E2EError && (e.code === 'wrong-secret' || e.code === 'bad-recovery' || e.code === 'empty-passphrase' || e.code === 'weak-kdf')) return e.message;
    if (e instanceof KeyringConflictError || e instanceof KeyringFormatError) return e.message;
    return errorText(e);
  }

  /**
   * 🔴 **暗号化のオン・オフ**(S3 は接続情報の `encrypt` / フォルダは記録)。
   * オフにすると、この端末の暗号化キーを忘れ、次の回で自分のファイルを平文で書き直して暗号化したファイル(`.enc`)を消す。
   * ⚠ オンにしても、暗号化キーが開かれるまで(平文で書かずに)同期は止まる。
   */
  async setEncrypt(on: boolean): Promise<E2EResult> {
    if (!this.hasTarget()) return { ok: false, text: 'まだ同期先を選んでいません' };
    if (this.wantsEncrypt() === on) return { ok: true, text: on ? '暗号化はすでにオンです' : '暗号化はすでにオフです' };
    this.generation += 1;
    this.clearTimer();
    await this.waitCurrent();
    if (this.remote !== null) {
      const r = this.deps.remote;
      const opened = r === undefined || r === null ? null : await r.open(this.deps.cid()).catch(() => null);
      if (r === undefined || r === null || opened === null) return { ok: false, text: SYNC_REMOTE_UNREADABLE_NOTE };
      const config: S3BoxConfig = { ...opened.config, encrypt: on };
      try {
        await r.save(this.deps.cid(), config, opened.secret);
      } catch (e) {
        this.schedule();
        return { ok: false, text: `暗号化の設定を保存できませんでした: ${errorText(e)}` };
      }
      this.remote = { box: this.remote.box, config };
    } else {
      this.folderEncrypt = on;
    }
    if (!on) {
      await this.deps.e2e?.forget(this.deps.cid()).catch(() => undefined);
      this.resetE2E();
    }
    try {
      await this.persist();
    } catch {
      /* 次に保存できたときに残る */
    }
    this.changed();
    if (this.phase === 'stopped') this.phase = 'idle';
    await this.syncNow(false);
    await this.refreshE2E();
    return { ok: true, text: on ? '暗号化をオンにしました。パスフレーズを入れる(決める)と、暗号化して同期します' : '暗号化をオフにしました。自分のファイルを平文で書き直し、暗号化したファイルを消します' };
  }

  /**
   * 🔴 **初回の設定の前半**(パスフレーズから暗号化キーと回復キーを作る)。⚠ **置き場には何も書かない** ──
   * 回復キーを打ち直してもらってから、`commit` で初めて束(keyring.json)を置く(途中でやめたら何も残らない)。
   * @param remember 開いた暗号化キーをこの端末に置くか(偽 = 開くたびにパスフレーズを入れる)
   */
  async e2eBeginSetup(passphrase: string, remember: boolean): Promise<E2ESetupStart> {
    const need = this.e2eNeed();
    if ('ok' in need) return { kind: 'refused', text: need.text };
    const { raw, e2e } = need;
    try {
      await this.probeKeyring(raw, e2e);
    } catch {
      /* 下で見る */
    }
    this.changed();
    if (this.keyringState === 'present') return { kind: 'refused', text: 'この置き場にはもう暗号化キーがあります。そのパスフレーズか回復キーで開いてください' };
    if (this.keyringState === 'broken') return { kind: 'refused', text: '置き場の暗号化キーの束(keyring.json)を読めません(別のものが置かれているか、内容が正しくありません)' };
    if (this.keyringState === 'unknown') return { kind: 'refused', text: '置き場の暗号化キーの束を確かめられませんでした(接続を確かめてから、もう一度試してください)' };
    let made: Awaited<ReturnType<typeof createKeyMaterial>>;
    try {
      made = await createKeyMaterial(e2e.crypto, passphrase);
    } catch (e) {
      return { kind: 'refused', text: this.e2eErrorText(e) };
    }
    let held: typeof made | null = made;
    return {
      kind: 'ready',
      recoveryKey: made.recoveryKey,
      cancel: () => {
        held = null;
      },
      commit: async () => {
        const m = held;
        held = null;
        if (m === null) return { ok: false, text: '設定をやめたあとです(最初からやり直してください)' };
        try {
          const got = await new EncryptedBox({ inner: raw, crypto: e2e.crypto, key: null }).ensureKeyring(m.keyring);
          if (!got.created) {
            await this.probeKeyring(raw, e2e);
            this.changed();
            return { ok: false, text: '先に別の端末が暗号化キーを作っていました。その端末のパスフレーズか回復キーで開いてください(いま作った分は捨てました)' };
          }
          await e2e.hold(this.deps.cid(), { dataKey: m.dataKey, keyId: m.keyring.keyId }, remember);
          await this.setAsk(!remember);
        } catch (e) {
          return { ok: false, text: `暗号化キーを置けませんでした: ${this.e2eErrorText(e)}` };
        }
        await this.probeKeyring(raw, e2e);
        this.changed();
        if (this.phase === 'stopped') this.phase = 'idle';
        await this.syncNow(true);
        return { ok: true, text: '暗号化キーを作りました。暗号化して同期します' };
      },
    };
  }

  /** 🔴 **開く**(パスフレーズか回復キー。2 台目以降 / 開くたびにパスフレーズを入れる設定のとき)。 */
  async e2eUnlock(via: E2EVia, remember: boolean): Promise<E2EResult> {
    const need = this.e2eNeed();
    if ('ok' in need) return need;
    const { raw, e2e } = need;
    try {
      const have = await new EncryptedBox({ inner: raw, crypto: e2e.crypto, key: null }).loadKeyring();
      if (have === null) {
        await this.probeKeyring(raw, e2e);
        this.changed();
        return { ok: false, text: 'この置き場にはまだ暗号化キーがありません(先にパスフレーズを決めてください)' };
      }
      const key = await openDataKey(e2e.crypto, have.keyring, via);
      await e2e.hold(this.deps.cid(), key, remember);
      await this.setAsk(!remember);
    } catch (e) {
      return { ok: false, text: this.e2eErrorText(e) };
    }
    await this.probeKeyring(raw, e2e);
    this.changed();
    if (this.phase === 'stopped') this.phase = 'idle';
    await this.syncNow(true);
    return { ok: true, text: '暗号化キーを開きました。同期を再開します' };
  }

  /** 🔴 **「開くたびにパスフレーズを入れる」の切り替え**(開いているときだけ。保管を消す / 置く)。 */
  async e2eSetRemember(remember: boolean): Promise<E2EResult> {
    const e2e = this.deps.e2e;
    if (e2e === undefined || e2e === null) return { ok: false, text: SYNC_E2E_UNAVAILABLE_NOTE };
    try {
      const done = await e2e.setRemember(this.deps.cid(), remember);
      if (!done) return { ok: false, text: '暗号化キーがまだ開かれていません(先にパスフレーズを入れてください)' };
      await this.setAsk(!remember);
    } catch (e) {
      return { ok: false, text: this.e2eErrorText(e) };
    }
    await e2e.refresh(this.deps.cid()).catch(() => undefined);
    this.changed();
    return { ok: true, text: remember ? 'この端末に暗号化キーを置きます(開くたびにパスフレーズを入れなくても同期します)' : 'この端末には暗号化キーを置きません(開くたびにパスフレーズを入れてください)' };
  }

  /**
   * 🔴 **パスフレーズの変更**(いまのパスフレーズか回復キーで開き、新しいパスフレーズで包み直す)。差分ファイルは書き直さない。
   * 読んだ版を条件に書く(`If-Match`)── 別の端末が先に変えていたら上書きせずに止まる。
   */
  async e2eChangePassphrase(via: E2EVia, next: string): Promise<E2EResult> {
    const need = this.e2eNeed();
    if ('ok' in need) return need;
    const { raw, e2e } = need;
    try {
      const eb = new EncryptedBox({ inner: raw, crypto: e2e.crypto, key: null });
      const have = await eb.loadKeyring();
      if (have === null) return { ok: false, text: 'この置き場には暗号化キーがありません' };
      const wrapped = await rewrapKeyring(e2e.crypto, have.keyring, via, next);
      await eb.rewrapKeyring(wrapped, have.version ?? have.keyring);
    } catch (e) {
      return { ok: false, text: this.e2eErrorText(e) };
    }
    return { ok: true, text: 'パスフレーズを変えました(ほかの端末で開くときは、新しいパスフレーズを使います。回復キーは変わりません)' };
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
    if (!this.hasTarget() || this.connecting || this.phase === 'unsupported' || this.phase === 'off' || this.phase === 'none') return;
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
    // 🔴 保管先への読み書きは `RemoteBox` の口だけを通す(#2000 段 4a-1)── 許可・handle は上(`permitted`)が持つ
    const rawBox: RemoteBox | null = this.remote !== null ? this.remote.box : this.dir !== null ? folderBox(this.dir) : null;
    if (rawBox === null) return;
    let box: RemoteBox = rawBox;
    const remote = this.remote !== null;
    const where = remote ? 'S3 互換の保管先' : '同期フォルダ';
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
      // ── 🔴 暗号化(段 4b)── 暗号化キーが開かれていなければ**平文で書かずに**止まる(開くまで待つ)
      const encOn = this.wantsEncrypt();
      this.e2eLocked = false;
      if (encOn) {
        const e2e = this.deps.e2e;
        if (e2e === undefined || e2e === null) {
          // 🔴 fail-closed: 暗号化したいのに口が無い ── 平文で書かない
          this.phase = 'stopped';
          this.message = SYNC_E2E_UNAVAILABLE_NOTE;
          this.changed();
          if (manual || this.message !== this.lastFail) this.deps.fail(this.message);
          this.lastFail = this.message;
          return;
        }
        const key = await e2e.key(this.deps.cid()).catch(() => null);
        if (key === null) {
          await this.probeKeyring(rawBox, e2e);
          this.e2eLocked = true;
          this.phase = 'stopped';
          this.message = this.keyringState === 'none' ? SYNC_E2E_SETUP_NOTE : SYNC_E2E_LOCKED_NOTE;
          this.changed();
          if (manual || this.message !== this.lastFail) this.deps.fail(this.message);
          this.lastFail = this.message;
          return;
        }
        const eb = new EncryptedBox({ inner: rawBox, crypto: e2e.crypto, key });
        // 🔴 毎回、置き場の暗号化キーの束の keyId と、この端末で開いているキーを照らす(違えば何も書かずに止まる)
        const ring = await eb.loadKeyring().catch(() => undefined);
        this.keyringState = ring === undefined ? 'unknown' : ring === null ? 'none' : 'present';
        if (ring === undefined || ring === null || ring.keyring.keyId !== key.keyId) {
          this.phase = 'stopped';
          this.message = SYNC_E2E_KEYRING_NOTE;
          this.changed();
          if (manual || this.message !== this.lastFail) this.deps.fail(this.message);
          this.lastFail = this.message;
          return;
        }
        box = eb;
      }
      // ── 🔴 端末 id が変わった(「同期の記録を消す」をした — どのワークスペース・オフの間でも)── 前の id で置いた自分のファイルを片付け、記録を最初からにする
      //   (残すと、他の端末から「もう来ない別の端末」に見え続ける)。⚠ 複製の確認で作り直したときは、前の名前は複製元の物なので `own` を先に空にしてある
      const ownName = this.own?.name;
      if (ownName !== undefined && deviceOfFileName(ownName) !== null && deviceOfFileName(ownName) !== self) {
        await box.remove(ownName).catch(() => undefined);
        this.record = emptyFolderRecord();
        this.own = null;
      }
      // ── フォルダを見る(同期フォルダのファイルだけ。他のファイルには触らない)
      // ⚠ 版の印(S3 の ETag)も運ぶ(落とすと段 4a-3 で「同じファイルか」を大きさ + 日時でしか見られない)
      const listed: FolderFile[] = (await box.list((name) => deviceOfFileName(name) !== null)).map((e) => ({
        name: e.name,
        size: e.size,
        mtime: e.mtime,
        ...(e.version === undefined ? {} : { version: e.version }),
      }));
      if (gen !== this.generation) return;
      // 🔴 平文と暗号化の両方が在る端末は、ここで 1 つに決める(暗号化していれば暗号化を優先)
      const chosen = chooseRoundFiles(listed, self, encOn);
      const files = chosen.files;
      // 🔴 暗号化している間、平文の相手のファイルは取り込まない。⚠ 控え(`seen`)には入れない(暗号化をオフに戻したら、次の無人の回で読む)。
      //   案内は別の記録(`guided`)で「その版を初めて見たとき」だけ出す
      const versionKey = (f: FolderFile): string => f.version ?? [f.size, f.mtime].join('/');
      const newPlain = chosen.skippedPlain.filter((f) => this.record.guided?.[f.name] !== versionKey(f));
      const plan = planFolderRound(self, files, this.record, manual);
      // ── 自分の名前のファイルを、自分以外が書いた(端末のデータの複製)── 取り込みの核が見分けて、手で同期したときに確認する
      const ownFile = plan.ownFile;
      // ⚠ 自分が書いた控えが無い(選び直した・記録が消えた)ときも読んで確かめる ── 自分が書いた物なら核が「取り込む物は無い」と言う
      const foreignOwn = ownFile !== null && (this.own === null || !sameFileVersion(this.own, ownFile));
      const reads = foreignOwn && ownFile !== null ? [...plan.toRead, ownFile] : plan.toRead;
      this.pending.clear();
      let ownUnresolved: string | null = null;
      for (const f of reads) {
        if (gen !== this.generation) return;
        const peer = deviceOfFileName(f.name) as string;
        try {
          const rd = box.readWithMeta !== undefined ? await box.readWithMeta(f.name) : { blob: await box.read(f.name), meta: null };
          if (peer !== self) {
            // 🔴 巻き戻し・差し替えの拒否(段 4b-d)── 取り込まない。同じ中身を無人の回で読み直し続けない(変わったら読む)
            const refuse =
              rd.meta !== null
                ? ((v) => (v === 'ok' ? null : syncE2ERollbackNote(peer, v)))(checkPeerSeq(this.record, peer, rd.meta.seq, f, rd.meta.contentId))
                : null;
            if (refuse !== null) {
              problems.push(refuse);
              this.refused.add(peer);
              this.record.seen[f.name] = {
                size: f.size,
                mtime: f.mtime,
                ...(f.version === undefined ? {} : { version: f.version }),
                want: this.record.seen[f.name]?.want ?? [],
              };
              continue;
            }
          }
          const { outcome, manifest } = await this.deps.apply(rd.blob, f.name, !manual);
          if (outcome.pending !== undefined || outcome.declined === true) {
            // 確認待ち / 確認に「やめる」と答えた ── 取り込んでいない。控え(`seen`)も頼み(`want`)も動かさない(次の回も確認待ちのまま)
            this.pending.add(peer);
            if (peer === self) ownUnresolved = `この端末と同じ ID の端末が${where}に書いています(端末のデータを複製した可能性があります)。「今すぐ同期」を押して確認してください`;
            continue;
          }
          if (!outcome.ok) {
            const why = outcome.reason ?? f.name;
            problems.push(why);
            if (peer === self) ownUnresolved = why;
            // 🔴 同じ中身のファイルを無人の回で読み直し続けない(変わったら読む。手で同期すれば読み直す)── 頼み(`want`)は動かさない
            else
              this.record.seen[f.name] = {
                size: f.size,
                mtime: f.mtime,
                ...(f.version === undefined ? {} : { version: f.version }),
                want: this.record.seen[f.name]?.want ?? [],
              };
            continue;
          }
          if (peer === self) {
            // 自分が書いた物だった / 複製の確認を済ませた(端末 id を作り直した)── 自分のファイルとして憶え直す
            this.own = { size: f.size, mtime: f.mtime, ...(f.version === undefined ? {} : { version: f.version }), name: f.name };
            continue;
          }
          if (rd.meta !== null) notePeerSeq(this.record, peer, rd.meta.seq, f, rd.meta.contentId);
          this.refused.delete(peer);
          imported += outcome.changed;
          conflicts += outcome.conflicts;
          this.record.seen[f.name] = {
            size: f.size,
            mtime: f.mtime,
            ...(f.version === undefined ? {} : { version: f.version }),
            want: manifest.want ?? [],
          };
          this.record.want = updateWant(this.record.want, peer, { needFull: outcome.needFull, complete: manifest.complete });
        } catch (e) {
          problems.push(`${f.name}: ${errorText(e)}`);
        }
      }
      for (const n of plan.vanished) delete this.record.seen[n];
      // 案内した版を控える(平文でなくなった / 暗号化をオフにしたファイルの分は外す ── 次にまた平文になったら案内し直す)
      if (chosen.skippedPlain.length > 0) this.record.guided = Object.fromEntries(chosen.skippedPlain.map((f) => [f.name, versionKey(f)]));
      else delete this.record.guided;
      if (gen !== this.generation) return;
      // 🔴 自分の名前のファイルを、まだ片付けていない誰かが書いている(同じ端末 id の別の端末 / このブラウザの別のワークスペース)──
      //   同じ名前のファイルを書き合わないよう、書かずに待つ
      if (ownUnresolved !== null) {
        await this.persist();
        this.phase = 'stopped';
        this.message = ownUnresolved.includes('別のワークスペース')
          ? `${ownUnresolved}(ワークスペースごとに別の${remote ? '置き場の接頭辞' : '同期フォルダ'}を選んでください)`
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
      // 🔴 自分のファイルが「いまの形」(暗号化 / 平文)でなければ、中身が同じでも全件で書き直す(切り替え = 自分のファイルを書き直す)
      const wantEnc = encOn;
      const ownFormOk = plan.ownFile === null || isEncFileName(plan.ownFile.name) === wantEnc;
      const built = await this.deps.build({
        kind: 'folder',
        others: plan.others.filter((d) => d !== self2),
        wantedBy: wantedByOf(self2, this.record),
        want: this.record.want,
        ownFilePresent: self2 === self && plan.ownFilePresent && ownFormOk,
        lastKey: self2 === self && ownFormOk ? this.record.lastKey : null,
      });
      if (!built.skipped) {
        if (gen !== this.generation) return;
        const name = wantEnc ? encFileName(self2) : folderFileName(self2);
        // 🔑 条件付き書き込みの控え(S3 の If-Match。フォルダは使わない)── 自分が前に書いた版。控えが無ければ条件なし(`null`)
        //   ⚠ 別の名前(切り替え前の形)で書いた控えは、この名前の版ではない ── 条件なし(`If-None-Match: *`)で書く
        const mine = this.own !== null && (this.own.name === undefined || this.own.name === name) ? this.own : null;
        const expect = mine === null ? null : { name, size: mine.size, mtime: mine.mtime, ...(mine.version === undefined ? {} : { version: mine.version }) };
        const after = await box.write(name, built.blob, expect, { device: built.device, seq: built.seq });
        this.own = { size: after.size, mtime: after.mtime, ...(after.version === undefined ? {} : { version: after.version }), name };
        this.record.lastKey = built.key;
        wrote = true;
      }
      // 🔴 切り替えの片付け: 書けた(または既に在る)後で、もう片方の形の自分のファイルを消す(暗号化へ切り替えたら平文を残さない)。消せなくても同期は続ける
      //   ⚠ 「いまの形のファイルが自分の物と確かめられている」ときだけ(いま書けた / 前に自分が書いた控えと同じ)。他人が置いた同名のファイルが在るだけでは消さない
      const ownVerified =
        wrote || (plan.ownFile !== null && this.own !== null && this.own.name === plan.ownFile.name && sameFileVersion(this.own, plan.ownFile));
      if (chosen.ownCounterpart !== null && ownVerified && self2 === self) await box.remove(chosen.ownCounterpart).catch(() => undefined);
      if (gen !== this.generation) return;
      await this.persist();
      this.failures = 0;
      const d = this.deps.now?.() ?? new Date();
      this.lastAt = [pad2(d.getHours()), pad2(d.getMinutes())].join(':');
      this.lastText = `取り込み ${imported} 件${conflicts > 0 ? `(競合 ${conflicts} 件)` : ''}${wrote ? ' / この端末の変更を書き出しました' : ''}`;
      // 🔴 暗号化の案内(段 4b)── 相手が平文 / 暗号化のとき、その端末でも暗号化をオンにしてもらう。同じ案内は回ごとに言い直さない
      const guides = [
        ...(chosen.peersNeedEnc.length > 0 ? [syncE2EPeerPlainNote(chosen.peersNeedEnc)] : []),
        ...(chosen.peersEncOnly.length > 0 ? [syncE2EPeerEncNote(chosen.peersEncOnly)] : []),
      ];
      const guide = guides.length === 0 ? null : guides.join(' / ');
      const pendingText = this.pending.size > 0 ? `確認が要る端末が ${this.pending.size} 台あります。「今すぐ同期」を押すと確認します` : null;
      this.message = [pendingText, guide].filter((x): x is string => x !== null).join(' / ') || null;
      // 平文の相手の案内は、その版を初めて見たときだけ言う(定期の回で言い続けない)/ 暗号化された相手の案内は、変わったときだけ
      const encNote = chosen.peersEncOnly.length > 0 ? syncE2EPeerEncNote(chosen.peersEncOnly) : null;
      const sayParts = [
        ...(chosen.peersNeedEnc.length > 0 && (manual || newPlain.length > 0) ? [syncE2EPeerPlainNote(chosen.peersNeedEnc)] : []),
        ...(encNote !== null && (manual || encNote !== this.lastGuide) ? [encNote] : []),
      ];
      if (sayParts.length > 0) this.deps.say(sayParts.join(' / '));
      this.lastGuide = encNote;
      this.phase = 'idle';
      if (problems.length > 0) {
        const t = `${where}の一部のファイルを取り込めませんでした(${problems.length} 件): ${problems.slice(0, 3).join(' / ')}`;
        if (manual || t !== this.lastFail) this.deps.fail(t);
        this.lastFail = t;
      } else this.lastFail = null;
      if (manual || imported > 0) this.deps.say(`${where}と同期しました(${this.lastText})`);
    } catch (e) {
      this.failures += 1;
      this.phase = 'stopped';
      const lost = errName(e) === 'NotFoundError' || errName(e) === 'NotAllowedError' || errName(e) === 'SecurityError';
      if (e instanceof BoxConflictError)
        // 🔴 412: 上書きしていない。次の回に、書き換えた相手のファイルを読んでから書く(同じ端末 id なら確認を出す)
        this.message = `${errorText(e)}。次の回に、相手のファイルを取り込んでから書きます`;
      else if (remote)
        // 保管先: 許可の出し直しは無い(認証情報・権限・CORS の設定を直す)── 間隔を延ばしながら回り続ける
        this.message = lost
          ? `保管先を読み書きできません(アクセスキー・権限・バケット名を確かめてください。直したら「接続する」で入れ直します): ${errorText(e)}`
          : `同期に失敗しました(次の回にやり直します): ${errorText(e)}`;
      else this.message = lost ? `同期フォルダを読み書きできません(移動・削除されたか、許可が切れました)。選び直してください: ${errorText(e)}` : `同期に失敗しました(次の回にやり直します): ${errorText(e)}`;
      if (lost && !remote) this.phase = 'permission';
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
  const openAt = (version?: number): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = version === undefined ? indexedDB.open(dbName) : indexedDB.open(dbName, version);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        if (!req.result.objectStoreNames.contains(MARKS)) req.result.createObjectStore(MARKS);
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error ?? new Error('IndexedDB を開けません'));
      req.onblocked = () => reject(new Error('IndexedDB を開けません(別のタブが使っています)'));
    });
  /** 🔴 棚が欠けていたら版を上げて足す(鍵の保管と同じ ── 棚の無い同じ名前の DB が先に在ると、版 1 のままでは足せない)。 */
  const open = async (): Promise<IDBDatabase> => {
    const db = await openAt();
    if (db.objectStoreNames.contains(STORE) && db.objectStoreNames.contains(MARKS)) return db;
    const next = db.version + 1;
    db.close();
    return openAt(next);
  };
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
