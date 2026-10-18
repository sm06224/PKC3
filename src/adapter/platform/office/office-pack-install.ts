/**
 * Office 一式の**設置・削除**をまとめる(#88 / 統合設計 O6-a)。
 *
 * 🔴 user 裁定 2026-08-10:「**実行したい人が手動で設定した際に追加ダウンロードと
 * idb とか opfs に配備して、以降の起動はローカルからにしてください**」/
 * 「**うまくいかない場合は、ローカルとかを介してユーザーができればいいです**」。
 *
 * ## ここが持つのは「判断」だけ
 *
 * 取得は `office-pack-acquire.ts`、保管は `office-pack-store.ts`。この module は
 * **その 2 つをどう繋ぐか**と、**失敗したとき user へ何と言うか**を持つ。
 * ⚠ `main.ts` に書かない ── あそこは原文 pin の test しか無く、判断を置くと
 * 「全 tests 緑のまま取り違える」(CLAUDE.md 2026-08-08)。
 *
 * ## 🔴 投げない。**必ず結果を返す**
 *
 * 設置は 93MB を触る長い操作で、途中の失敗は珍しくない(quota / 通信 / 壊れた zip)。
 * 例外を上へ投げると、呼び側が握り忘れた瞬間に**進捗の字が出たまま固まる**ように見える。
 * だからこの層で全部受けて、**そのまま画面に出せる文**にして返す。
 */
import { OFFICE_PACK_APPROX } from '@features/office/office-pack-size';
import {
  DEFAULT_PACK_BASE,
  OfficePackError,
  type OfficePackMeta,
} from './office-pack';
import {
  fetchPackFromBase,
  fetchPackManifest,
  PackAbortedError,
  packUrlFailureMessage,
  readPackFromZip,
  readPackInfoFromZip,
  type PackFiles,
} from './office-pack-acquire';
import type { PackBuild } from './office-pack';
import type { OfficePackStore } from './office-pack-store';
import { requestPersist as requestPersistState } from '@adapter/platform/storage-persist';
import { humanBytes } from '@features/human-bytes';

export type PackResult =
  | { readonly ok: true; readonly meta: OfficePackMeta | null; readonly message: string }
  /** `cancelled` = user がやめた(失敗ではない ── 画面は「問題」の扱いにしない)。 */
  | { readonly ok: false; readonly message: string; readonly cancelled?: true };

/** やめたときの知らせ。⚠ 「端末には何も書いていない」まで言う(書きかけが残ったと読まれない)。 */
export const PACK_CANCELLED_MESSAGE = 'Office 一式の取り込みをやめました(端末には何も書いていません)';
/** 端末へ書き始めた後にやめようとしたときの知らせ(書き込みは止められない ── 押して無反応にしない)。 */
export const PACK_CANCEL_TOO_LATE_MESSAGE = 'いま端末に書き込んでいる最中なので、やめられません。まもなく終わります';

/** 取得と保管の口(test は自前の実装を渡す)。 */
export interface PackInstallDeps {
  readonly store: Pick<OfficePackStore, 'install' | 'remove' | 'readMeta'>;
  readonly fetchManifest?: typeof fetchPackManifest;
  readonly fetchFiles?: typeof fetchPackFromBase;
  // ⚠ 2 つとも、最後の引数に「やめる」の合図(`AbortSignal`)を受ける(台帳 #1852 束 T1、依頼 156 ②)
  readonly readZip?: typeof readPackFromZip;
  /** zip の中の `pack.json` から版と素性を読む口(O7)。 */
  readonly readZipInfo?: typeof readPackInfoFromZip;
  /** 取得元。⚠ 既定は同一 origin の隣(`office-pack.ts` の定数)。 */
  readonly base?: string;
  /** 進捗の 1 行。⚠ **必ず呼ぶ** ── 93MB の間、無反応にしない。 */
  readonly onProgress?: (text: string) => void;
  /** 保存の永続化を頼む。⚠ test から差し替える(既定は下の `requestPersist`)。 */
  readonly persist?: () => Promise<boolean>;
}

/**
 * 🔴 **入れた 196MB が、容量逼迫で黙って消えるのを防ぐ**(#117、実測 2026-08-12)。
 *
 * ```json
 * {"usageMB": 196, "quotaMB": 10436, "persisted": false}
 * ```
 *
 * `navigator.storage.persist()` を一度も呼んでいなかったので、この一式は
 * **evictable** のまま置かれていた。user から見ると「昨日まで動いてたのに
 * 今日は動かない」になる ── しかも**原因を名指しできない**壊れ方である。
 *
 * ⚠ **頼む場所はここ**(設置の直前)。窓の側で呼んでも、既に入っている物にしか
 * 効かない ── **書く前に**永続化しておけば、書いた分が最初から対象になる。
 * ⚠ 拒否されることがある(engagement が足りない環境)。**拒否は失敗ではない** ──
 * 入れるのは続け、その旨だけ伝える。
 *
 * 🔴 **実体は `adapter/platform/storage-persist.ts` に移した**(#347、2026-08-23)。
 * ⚠ ここにしか無かったせいで、**ノート本体は一度も永続化を頼んでいなかった** ──
 * 同じ問いに答える口を 2 つ持たない(CLAUDE.md §7)。
 */
async function requestPersist(): Promise<boolean> {
  const store = typeof navigator === 'undefined' ? undefined : navigator.storage;
  return (await requestPersistState(store)) === 'persisted';
}

/**
 * 例外を「そのまま出せる文」へ落とす。
 *
 * ⚠ `OfficePackError` は**こちらが書いた文**なので、そのまま出す。
 * それ以外(quota / 通信 / 壊れた zip)は素の文言が英語なので、**前置きを付ける** ──
 * 「QuotaExceededError」だけ出しても user は次に何をすべきか分からない。
 */
function toMessage(e: unknown, what: string): string {
  if (e instanceof OfficePackError) return e.message;
  const raw = e instanceof Error ? e.message : String(e);
  if (/quota/i.test(raw)) {
    return `${what}に失敗しました: この端末の空き容量が足りません(${OFFICE_PACK_APPROX} 必要です)。`;
  }
  return `${what}に失敗しました: ${raw.slice(0, 160)}`;
}

export class OfficePackInstaller {
  private readonly deps: PackInstallDeps;
  /** ⚠ **二重起動を作らない** ── 93MB を 2 本走らせると quota も帯域も倍食う。 */
  private running = false;
  /**
   * 🔴 **取り込みをやめる合図**(依頼 156 ②)。取得の間だけ生きる ── 端末へ書き始めたら外す(書き込みは止められない)。
   * ⚠ 音声認識の部品の取り込み(`asr-pack-install.ts`)の「やめる」と同じ形。
   */
  private abort: AbortController | null = null;

  constructor(deps: PackInstallDeps) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * 取り込みをやめる。@returns やめられたか(`false` = 走っていない、または端末へ書き始めている ── 呼び手が理由を言う)
   */
  cancel(): boolean {
    if (this.abort === null) return false;
    this.abort.abort();
    return true;
  }

  /** いま入っているもの。⚠ 読めなければ「入っていない」側へ倒す(安全側)。 */
  async readMeta(): Promise<OfficePackMeta | null> {
    return this.deps.store.readMeta().catch(() => null);
  }

  /**
   * 🔴 **配布元の版だけを読む**(#134 の配布、user 裁定 2026-08-13「通知のみで OK」)。
   *
   * ⚠ 取るのは**目録(`pack.json`)だけ**で数百バイト ── 一式(77MB)は
   * 押した人にしか取らせない(裁定 2026-08-10「手動で設定した際に追加ダウンロード」)。
   * ⚠ **失敗は黙って `null`** ── オフラインは正常な状態であり、起動のたびに
   * 「届きません」と言うのは害である(押したときの失敗は別で、名指しで理由を出す)。
   */
  async readAvailableVersion(): Promise<string | null> {
    const base = this.deps.base ?? DEFAULT_PACK_BASE;
    return (this.deps.fetchManifest ?? fetchPackManifest)(base)
      .then((m) => m.version)
      .catch(() => null);
  }

  /** 取得元(同一 origin)から入れる。 */
  async installFromUrl(): Promise<PackResult> {
    return this.run('取得', async (progress, signal) => {
      const base = this.deps.base ?? DEFAULT_PACK_BASE;
      progress('取得元を調べています');
      try {
        const manifest = await (this.deps.fetchManifest ?? fetchPackManifest)(base, undefined, signal);
        const files = await (this.deps.fetchFiles ?? fetchPackFromBase)(
          base,
          manifest.fonts,
          (phase, done, total) => progress(`${phase}(${done}/${total})`),
          undefined,
          signal,
        );
        // 🔴 ビルドの素性も持ち帰る(#155)── 版の文字列だけでは新旧を見分けられない
        return { files, version: manifest.version, build: manifest.build, source: 'url' as const };
      } catch (e) {
        // 🔴 user がやめたのは失敗ではない ── 案内を足さずそのまま上へ(`run` が「やめました」を返す)
        if (e instanceof PackAbortedError) throw e;
        // 🔴 取得で落ちたときだけ、日本語の理由 + 「ファイルから取り込む」への案内を付ける
        //    (保管側の失敗 = quota などは、この外なので触らない)
        throw new OfficePackError(packUrlFailureMessage(e));
      }
    });
  }

  /** 手元の zip から入れる。⚠ **CORS の外なので必ず通る**(一級の導線)。 */
  async installFromZip(zip: Blob, name: string): Promise<PackResult> {
    return this.run('取り込み', async (progress) => {
      const files = await (this.deps.readZip ?? readPackFromZip)(
        zip,
        (phase, done, total) => progress(`${phase}(${done}/${total})`),
      );
      // 🔴 版は zip の中の `pack.json` から読む(O7)。⚠ file 名を版にすると、配布元の版
      //    (`lo-wasm-dev` など)と必ず食い違い、起動のたびに「配布元の版と違います」と言い続ける。
      //    目録が無い / 読めない zip だけ、選んだ file 名をそのまま残す(版を推測で作らない)
      const info = await (this.deps.readZipInfo ?? readPackInfoFromZip)(zip).catch(() => null);
      return {
        files,
        version: info?.version ?? (name || 'unknown'),
        build: info?.build ?? null,
        source: 'file' as const,
      };
    });
  }

  /**
   * 入っている一式を消す。
   *
   * ⚠ **消えたことを確かめてから成功と言う** ── 「消しました」と言った直後に
   * まだ開ける、が最悪(user は消えたと思って容量を当てにする)。
   */
  async remove(): Promise<PackResult> {
    if (this.running) return { ok: false, message: 'いま Office 一式を取り込んでいる最中です。終わるまでお待ちください。' };
    try {
      await this.deps.store.remove();
      const left = await this.readMeta();
      if (left !== null) return { ok: false, message: '削除できませんでした(まだ残っています)。' };
      return { ok: true, meta: null, message: 'Office 一式を削除しました' };
    } catch (e) {
      return { ok: false, message: toMessage(e, '削除') };
    }
  }

  private async run(
    what: string,
    acquire: (progress: (text: string) => void, signal: AbortSignal) => Promise<{
      files: PackFiles;
      version: string;
      /** ⚠ どのビルドか(#155)。手元の zip から入れたときは `null`。 */
      build?: PackBuild | null;
      source: 'url' | 'file';
    }>,
  ): Promise<PackResult> {
    if (this.running) {
      return { ok: false, message: 'すでに取り込み中です。終わるまでお待ちください。' };
    }
    this.running = true;
    const abort = new AbortController();
    this.abort = abort;
    const progress = (text: string): void => this.deps.onProgress?.(text);
    try {
      const { files, version, source, build } = await acquire(progress, abort.signal);
      // 🔴 取得が終わる直前にやめた回も、端末には書かない。⚠ ここから先は書き込みなので、やめる合図を外す
      if (abort.signal.aborted) return { ok: false, message: PACK_CANCELLED_MESSAGE, cancelled: true };
      this.abort = null;
      progress('配備しています');
      // ⚠ **書く前に**永続化を頼む(拒否されても入れるのは続ける)
      const persisted = await (this.deps.persist ?? requestPersist)();
      const meta = await this.deps.store.install(files, {
        version,
        // 🔴 **素性をここで落とさない**(#155)── 落ちても画面は成立して見えるので、
        //    変異試験で 2 件生き延びるまで誰も気づかなかった経路である
        build: build ?? null,
        source,
        onProgress: (done, total, name) =>
          progress(name === '' ? '書き込んでいます' : `検査中: ${name}(${done}/${total})`),
      });
      return {
        ok: true,
        meta,
        // ⚠ **黙って消えうることを黙っていない。** 拒否されたことを伝えないと、
        //    後日消えたときに user は原因を名指しできない
        message: `Office 一式を取り込みました(${humanBytes(meta.totalBytes)})`
          + (persisted
            ? ''
            : '。ただし、このブラウザから「消さずに残す」許可がもらえなかったため、端末の空き容量が減ると自動で消されることがあります'),
      };
    } catch (e) {
      if (e instanceof PackAbortedError) return { ok: false, message: PACK_CANCELLED_MESSAGE, cancelled: true };
      return { ok: false, message: toMessage(e, what) };
    } finally {
      this.abort = null;
      // ⚠ **必ず降ろす**(finally)── 落ちたまま立ちっぱなしだと、以後の操作が
      //   全部「すでに取り込み中です」で断られ、リロードするしか無くなる
      this.running = false;
      progress('');
    }
  }
}
