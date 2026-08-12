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
import {
  DEFAULT_PACK_BASE,
  OfficePackError,
  type OfficePackMeta,
} from './office-pack';
import {
  fetchPackFromBase,
  fetchPackManifest,
  readPackFromZip,
  type PackFiles,
} from './office-pack-acquire';
import type { OfficePackStore } from './office-pack-store';

export type PackResult =
  | { readonly ok: true; readonly meta: OfficePackMeta | null; readonly message: string }
  | { readonly ok: false; readonly message: string };

/** 取得と保管の口(test は自前の実装を渡す)。 */
export interface PackInstallDeps {
  readonly store: Pick<OfficePackStore, 'install' | 'remove' | 'readMeta'>;
  readonly fetchManifest?: typeof fetchPackManifest;
  readonly fetchFiles?: typeof fetchPackFromBase;
  readonly readZip?: typeof readPackFromZip;
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
 */
async function requestPersist(): Promise<boolean> {
  const store = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!store || typeof store.persist !== 'function') return false;
  try {
    if (typeof store.persisted === 'function' && (await store.persisted())) return true;
    return await store.persist();
  } catch {
    return false;
  }
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
    return `${what}に失敗しました: この端末の保存容量が足りません(約 77MB 要ります)。`;
  }
  return `${what}に失敗しました: ${raw.slice(0, 160)}`;
}

function sizeText(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`;
}

export class OfficePackInstaller {
  private readonly deps: PackInstallDeps;
  /** ⚠ **二重起動を作らない** ── 93MB を 2 本走らせると quota も帯域も倍食う。 */
  private running = false;

  constructor(deps: PackInstallDeps) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** いま入っているもの。⚠ 読めなければ「入っていない」側へ倒す(安全側)。 */
  async readMeta(): Promise<OfficePackMeta | null> {
    return this.deps.store.readMeta().catch(() => null);
  }

  /** 取得元(同一 origin)から入れる。 */
  async installFromUrl(): Promise<PackResult> {
    return this.run('取得', async (progress) => {
      const base = this.deps.base ?? DEFAULT_PACK_BASE;
      progress('取得元を調べています');
      const manifest = await (this.deps.fetchManifest ?? fetchPackManifest)(base);
      const files = await (this.deps.fetchFiles ?? fetchPackFromBase)(
        base,
        manifest.fonts,
        (phase, done, total) => progress(`${phase}(${done}/${total})`),
      );
      return { files, version: manifest.version, source: 'url' as const };
    });
  }

  /** 手元の zip から入れる。⚠ **CORS の外なので必ず通る**(一級の導線)。 */
  async installFromZip(zip: Blob, name: string): Promise<PackResult> {
    return this.run('取り込み', async (progress) => {
      const files = await (this.deps.readZip ?? readPackFromZip)(
        zip,
        (phase, done, total) => progress(`${phase}(${done}/${total})`),
      );
      // ⚠ 版は file 名から推測しない(嘘の版を記録しない)── 選んだ file 名をそのまま残す
      return { files, version: name || 'unknown', source: 'file' as const };
    });
  }

  /**
   * 入っている一式を消す。
   *
   * ⚠ **消えたことを確かめてから成功と言う** ── 「消しました」と言った直後に
   * まだ開ける、が最悪(user は消えたと思って容量を当てにする)。
   */
  async remove(): Promise<PackResult> {
    if (this.running) return { ok: false, message: 'いま設置中です。終わってから操作してください。' };
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
    acquire: (progress: (text: string) => void) => Promise<{
      files: PackFiles;
      version: string;
      source: 'url' | 'file';
    }>,
  ): Promise<PackResult> {
    if (this.running) {
      return { ok: false, message: 'すでに設置中です。終わるまでお待ちください。' };
    }
    this.running = true;
    const progress = (text: string): void => this.deps.onProgress?.(text);
    try {
      const { files, version, source } = await acquire(progress);
      progress('配備しています');
      // ⚠ **書く前に**永続化を頼む(拒否されても入れるのは続ける)
      const persisted = await (this.deps.persist ?? requestPersist)();
      const meta = await this.deps.store.install(files, {
        version,
        source,
        onProgress: (done, total, name) =>
          progress(name === '' ? '書き込んでいます' : `検査中: ${name}(${done}/${total})`),
      });
      return {
        ok: true,
        meta,
        // ⚠ **黙って消えうることを黙っていない。** 拒否されたことを伝えないと、
        //    後日消えたときに user は原因を名指しできない
        message: `Office 一式を配備しました(${sizeText(meta.totalBytes)})`
          + (persisted
            ? ''
            : '。この端末では保存の永続化が許可されなかったため、容量が足りなくなると消えることがあります'),
      };
    } catch (e) {
      return { ok: false, message: toMessage(e, what) };
    } finally {
      // ⚠ **必ず降ろす**(finally)── 落ちたまま立ちっぱなしだと、以後の操作が
      //   全部「すでに設置中です」で断られ、リロードするしか無くなる
      this.running = false;
      progress('');
    }
  }
}
