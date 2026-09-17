/**
 * DuckDB 一式の**設置・削除**をまとめる(#682 段③a)。
 *
 * 🔑 Office(`office-pack-install.ts`)と同じ形を写す ── 取得は
 * `duckdb-pack-acquire.ts`、保管は `duckdb-pack-store.ts`。この module は
 * **その 2 つをどう繋ぐか**と、**失敗したとき user へ何と言うか**だけを持つ。
 *
 * ## 🔴 投げない。**必ず結果を返す**
 *
 * 一式は約 35MB を触る長い操作で、途中の失敗は珍しくない(quota / 通信)。
 * 例外を上へ投げると、呼び側が握り忘れた瞬間に「進捗の字が出たまま固まる」
 * ように見える。だからこの層で全部受けて、**そのまま画面に出せる文**にして返す。
 */
import { DUCKDB_PACK_APPROX } from '@features/query/duckdb-pack';
import { fetchDuckDbPackFromBase, DuckDbPackAcquireError } from './duckdb-pack-acquire';
import { DuckDbPackStoreError, type DuckDbPackMeta, type DuckDbPackStore } from './duckdb-pack-store';
import { requestPersist as requestPersistState } from '@adapter/platform/storage-persist';

/**
 * 一式を取るのに要る量(概算)。⚠ 目録を読む前の書き置き ──
 * 実測(2026-09-15、`tests/features/duckdb-pack.test.ts` の `REAL`)は
 * wasm 35,913,747 + worker 773,223 byte ≒ 35MB。
 * ⚠ **拡張(5.3MB)はここに入らない**(#682 段④b)── 端末へ入れても engine が
 *   使えないので取っていない(`DUCKDB_PACK_FILES` の docstring)。
 *   🔑 だから配る量が 41MB へ増えても、**この数字は 35MB のままで正しい**。
 * 🔑 少なく言って失敗させるより、多めに言うほうが user は損をしない
 * (`@features/office/office-pack-size.ts` と同じ判断)。
 */


export type DuckDbPackInstallResult =
  | { readonly ok: true; readonly meta: DuckDbPackMeta | null; readonly message: string }
  | { readonly ok: false; readonly message: string };

/** 取得と保管の口(test は自前の実装を渡す)。 */
export interface DuckDbPackInstallDeps {
  readonly store: Pick<DuckDbPackStore, 'writeAll' | 'remove' | 'readMeta'>;
  readonly fetchFromBase?: typeof fetchDuckDbPackFromBase;
  /** 保存の永続化を頼む。⚠ test から差し替える(既定は下の `requestPersist`)。 */
  readonly persist?: () => Promise<boolean>;
}

/** `install()` の呼び出し引数。 */
export interface DuckDbPackInstallArgs {
  /** 取得元(同一オリジンの相対 path)。 */
  readonly base: string;
  /** 進捗の 1 行。⚠ **必ず呼ぶ** ── 約 35MB の間、無反応にしない。パーセントにはしない。 */
  readonly onProgress?: (text: string) => void;
}

/**
 * 🔴 **入れた 35MB が、容量逼迫で黙って消えるのを防ぐ**
 * (Office 一式で一度踏んだのと同じ形。#117 / #347)。
 *
 * ⚠ **頼む場所はここ**(設置の直前)。窓の側で呼んでも、既に入っている物にしか
 * 効かない ── **書く前に**永続化しておけば、書いた分が最初から対象になる。
 * ⚠ 拒否されることがある。**拒否は失敗ではない** ── 入れるのは続け、その旨だけ伝える。
 */
async function requestPersist(): Promise<boolean> {
  const store = typeof navigator === 'undefined' ? undefined : navigator.storage;
  return (await requestPersistState(store)) === 'persisted';
}

/**
 * 例外を「そのまま出せる文」へ落とす。
 *
 * ⚠ `DuckDbPackAcquireError` / `DuckDbPackStoreError` は**こちらが書いた文**なので、
 * そのまま出す。それ以外(quota / 通信)は素の文言が英語なので、**前置きを付ける**。
 */
function toMessage(e: unknown, what: string): string {
  if (e instanceof DuckDbPackAcquireError || e instanceof DuckDbPackStoreError) return e.message;
  const raw = e instanceof Error ? e.message : String(e);
  if (/quota/i.test(raw)) {
    return `${what}に失敗しました: この端末の空き容量が足りません(${DUCKDB_PACK_APPROX} 必要です)。`;
  }
  return `${what}に失敗しました: ${raw.slice(0, 160)}`;
}

export class DuckDbPackInstaller {
  private readonly deps: DuckDbPackInstallDeps;
  /** ⚠ **二重起動を作らない** ── 約 35MB を 2 本走らせると quota も帯域も倍食う。 */
  private running = false;

  constructor(deps: DuckDbPackInstallDeps) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** いま入っているもの。⚠ 読めなければ「入っていない」側へ倒す(安全側)。 */
  async readMeta(): Promise<DuckDbPackMeta | null> {
    return this.deps.store.readMeta().catch(() => null);
  }

  /** 同一オリジンの `opts.base` から入れる。 */
  async install(opts: DuckDbPackInstallArgs): Promise<DuckDbPackInstallResult> {
    if (this.running) {
      return { ok: false, message: 'すでに設置中です。終わるまでお待ちください。' };
    }
    this.running = true;
    const progress = (text: string): void => opts.onProgress?.(text);
    try {
      // ⚠ ここは**呼び側が明示的に出す 1 行**(Office の `installFromUrl` と同じ形)。
      //   取得層の内側で出る刻みとは別に、「取り掛かった」ことをまず伝える
      progress('取得元を調べています');
      const { files, version } = await (this.deps.fetchFromBase ?? fetchDuckDbPackFromBase)(
        opts.base,
        (phase, done, total) => progress(`${phase}(${done}/${total})`),
      );
      progress('配備しています');
      // ⚠ **書く前に**永続化を頼む(拒否されても入れるのは続ける)
      const persisted = await (this.deps.persist ?? requestPersist)();
      const meta = await this.deps.store.writeAll(files, {
        version,
        onProgress: (done, total, name) =>
          progress(name === '' ? '書き込んでいます' : `検査中: ${name}(${done}/${total})`),
      });
      return {
        ok: true,
        meta,
        // ⚠ **黙って消えうることを黙っていない。** 拒否されたことを伝えないと、
        //    後日消えたときに user は原因を名指しできない
        message: 'DuckDB 一式を入れました'
          + (persisted
            ? ''
            : '。ただし、このブラウザから「消さずに残す」許可がもらえなかったため、端末の空き容量が減ると自動で消されることがあります'),
      };
    } catch (e) {
      return { ok: false, message: toMessage(e, '設置') };
    } finally {
      // ⚠ **必ず降ろす**(finally)── 落ちたまま立ちっぱなしだと、以後の操作が
      //   全部「すでに設置中です」で断られ、リロードするしか無くなる
      this.running = false;
      progress('');
    }
  }

  /**
   * 入っている一式を消す。
   *
   * ⚠ **消えたことを確かめてから成功と言う** ── 「消しました」と言った直後に
   * まだ読める、が最悪(user は消えたと思って容量を当てにする)。
   */
  async remove(): Promise<DuckDbPackInstallResult> {
    if (this.running) {
      return { ok: false, message: 'いま DuckDB 一式を入れている最中です。終わるまでお待ちください。' };
    }
    try {
      await this.deps.store.remove();
      const left = await this.readMeta();
      if (left !== null) return { ok: false, message: '削除できませんでした(まだ残っています)。' };
      return { ok: true, meta: null, message: 'DuckDB 一式を削除しました' };
    } catch (e) {
      return { ok: false, message: toMessage(e, '削除') };
    }
  }
}
