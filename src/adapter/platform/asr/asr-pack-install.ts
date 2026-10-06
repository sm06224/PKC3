/**
 * 音声認識の部品の**設置・削除**をまとめる(#772 段②)。
 *
 * 🔑 `duckdb-pack-install.ts` / `office-pack-install.ts` と同じ形 ── 取得は
 * `asr-pack-acquire.ts`、保管は `asr-pack-store.ts`。この module は
 * **その 2 つをどう繋ぐか**と、**失敗したとき user へ何と言うか**だけを持つ。
 *
 * ## 🔴 投げない。**必ず結果を返す**
 *
 * 100〜270MB を触る長い操作で、途中の失敗は珍しくない(通信 / quota)。例外を上へ投げると、
 * 呼び側が握り忘れた瞬間に「進捗の字が出たまま固まる」ように見える。
 * だから全部この層で受けて、**そのまま画面に出せる文**にして返す。
 *
 * ## 🔴 順番(「失敗したら部分を捨てる」)
 *
 * ① 目録 ② **要る file を全部取る**(ここで落ちたら端末の保管は 1 バイトも触っていない)
 * ③ 永続化を頼む ④ 実行の部品を書く ⑤ 重みを書く。
 * ⑤が落ちて、**この回に実行の部品を新しく入れていた**なら、④も巻き戻す
 * (重みの無い実行の部品を「入っている」状態で残さない)。
 *
 * ## 🔑 2 回目からは取らない
 *
 * 実行の部品は 2 択に共通なので、**同じ版が既に入っていれば取り直さない**
 * (片方を入れた後でもう片方を入れるとき、16MB を二重に取らない)。
 * 同じ重みを入れ直すのは user の明示操作(「消す」→「取り込む」)だけである。
 */
import {
  asrPartOf,
  type AsrPack,
  type AsrPartId,
} from '@features/asr/asr-parts';
import { requestPersist as requestPersistState } from '@adapter/platform/storage-persist';
import {
  AsrPackAborted,
  AsrPackError,
  fetchAsrFiles,
  fetchAsrManifest,
  type FetchLike,
} from './asr-pack-acquire';
import type { AsrInstalled, AsrPackStore } from './asr-pack-store';

export type AsrInstallResult =
  | { readonly ok: true; readonly installed: AsrInstalled; readonly message: string }
  | { readonly ok: false; readonly message: string };

export interface AsrPackInstallDeps {
  readonly store: Pick<
    AsrPackStore,
    'readInstalled' | 'writeRuntime' | 'writePart' | 'removePart' | 'removeRuntimeIfAlone'
  >;
  /** 取り先(同一オリジンの絶対 path)。 */
  readonly base: string;
  /** ⚠ 既定は素の `fetch`。test が差し替える。 */
  readonly fetchFn?: FetchLike;
  /** 保存の永続化を頼む。⚠ test から差し替える(既定は下の `requestPersist`)。 */
  readonly persist?: () => Promise<boolean>;
}

/**
 * 🔴 **入れた 100〜270MB が、容量逼迫で黙って消えるのを防ぐ**(Office / DuckDB と同じ形)。
 * ⚠ **頼む場所は書く直前**。⚠ 拒否は失敗ではない ── 入れるのは続け、その旨だけ伝える。
 */
async function requestPersist(): Promise<boolean> {
  const store = typeof navigator === 'undefined' ? undefined : navigator.storage;
  return (await requestPersistState(store)) === 'persisted';
}

/** 例外を「そのまま出せる文」へ落とす。⚠ こちらが書いた文はそのまま、素の例外は前置きを付ける。 */
function toMessage(e: unknown, what: string): string {
  if (e instanceof AsrPackError) return e.message;
  const raw = e instanceof Error ? e.message : String(e);
  if (/quota/i.test(raw)) {
    return `${what}に失敗しました: この端末の空き容量が足りません。`;
  }
  return `${what}に失敗しました: ${raw.slice(0, 160)}`;
}

export class AsrPackInstaller {
  private readonly deps: AsrPackInstallDeps;
  /** ⚠ **二重起動を作らない** ── 270MB を 2 本走らせると quota も帯域も倍食う。 */
  private running = false;
  private abort: AbortController | null = null;

  constructor(deps: AsrPackInstallDeps) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 取り込みを途中で止める。⚠ 走っていなければ何もしない。 */
  cancel(): void {
    this.abort?.abort();
  }

  /** いま入っているもの。⚠ 読めなければ「入っていない」側へ倒す(安全側)。 */
  async readInstalled(): Promise<AsrInstalled> {
    return this.deps.store.readInstalled().catch(() => ({ runtime: null, parts: {} }));
  }

  /**
   * 2 択の 1 つを入れる。
   * @param onProgress 進みの 1 行。⚠ **必ず呼ぶ** ── 数分の間、無反応にしない。
   */
  async install(id: AsrPartId, onProgress: (text: string) => void = () => {}): Promise<AsrInstallResult> {
    if (this.running) {
      return { ok: false, message: 'すでに取り込み中です。終わるまでお待ちください。' };
    }
    const part = asrPartOf(id);
    if (part === undefined) return { ok: false, message: '知らない一式です。' };
    this.running = true;
    const abort = new AbortController();
    this.abort = abort;
    const fetchFn: FetchLike = this.deps.fetchFn ?? ((url, init) => fetch(url, init));
    let wroteRuntime = false;
    try {
      onProgress('取り先を調べています');
      const pack: AsrPack = await fetchAsrManifest(this.deps.base, fetchFn, abort.signal);
      const modelFiles = pack.models[id];
      if (modelFiles === undefined) {
        return { ok: false, message: `「${part.label}」は、このサイトの配布元がまだ配布していません。` };
      }
      const before = await this.readInstalled();
      // 🔑 **同じ版が既に入っているなら、何も取らない**(2 回目からは取らない)
      if (before.parts[id]?.version === pack.version) {
        return { ok: true, installed: before, message: `「${part.label}」は取り込み済みです` };
      }
      // 🔑 実行の部品は 2 択に共通 ── 同じ版が既に在れば取り直さない
      const needRuntime = before.runtime?.version !== pack.version;

      const total = (needRuntime ? pack.runtime : []).concat(modelFiles).reduce((s, f) => s + f.bytes, 0);
      const doneOf = (done: number, base: number): string => {
        const pct = total === 0 ? 0 : Math.min(100, Math.floor(((base + done) / total) * 100));
        return `取り込み中 ${pct}%`;
      };
      let baseBytes = 0;
      const runtimeBlobs = needRuntime
        ? await fetchAsrFiles(this.deps.base, pack.runtime, fetchFn, {
            signal: abort.signal,
            onProgress: (done) => onProgress(doneOf(done, 0)),
          })
        : null;
      if (needRuntime) baseBytes = pack.runtime.reduce((s, f) => s + f.bytes, 0);
      const modelBlobs = await fetchAsrFiles(this.deps.base, modelFiles, fetchFn, {
        signal: abort.signal,
        onProgress: (done) => onProgress(doneOf(done, baseBytes)),
      });

      // ここから先は端末の保管へ書く。⚠ もう止められない(書きかけを作らない)
      onProgress('端末へ書き込んでいます');
      const persisted = await (this.deps.persist ?? requestPersist)();
      const expect = (files: readonly { path: string; bytes: number; sha256: string }[]) =>
        new Map(files.map((f) => [f.path, { bytes: f.bytes, sha256: f.sha256 }] as const));
      if (runtimeBlobs !== null) {
        await this.deps.store.writeRuntime(runtimeBlobs, expect(pack.runtime), pack.version);
        wroteRuntime = true;
      }
      try {
        await this.deps.store.writePart(id, modelBlobs, expect(modelFiles), pack.version);
      } catch (e) {
        // 🔴 重みが書けなかったのに、実行の部品だけが「入っている」状態で残らないようにする
        if (wroteRuntime) await this.deps.store.removeRuntimeIfAlone().catch(() => undefined);
        throw e;
      }
      return {
        ok: true,
        installed: await this.readInstalled(),
        // ⚠ **黙って消えうることを黙っていない**(拒否されたことを伝えないと、
        //    後日消えたときに user は原因を名指しできない)
        message: `「${part.label}」を取り込みました`
          + (persisted
            ? ''
            : '。ただし、このブラウザから「消さずに残す」許可がもらえなかったため、端末の空き容量が減ると自動で消されることがあります'),
      };
    } catch (e) {
      if (e instanceof AsrPackAborted) {
        return { ok: false, message: '取り込みをやめました(端末には何も書いていません)。' };
      }
      return { ok: false, message: toMessage(e, '取り込み') };
    } finally {
      // ⚠ **必ず降ろす**(finally)── 立ちっぱなしだと以後が全部「取り込み中」で断られる
      this.running = false;
      this.abort = null;
      onProgress('');
    }
  }

  /**
   * 2 択の 1 つを消す。
   * ⚠ **消えたことを確かめてから成功と言う**(「消しました」と言った直後にまだ読める、が最悪)。
   */
  async remove(id: AsrPartId): Promise<AsrInstallResult> {
    if (this.running) {
      return { ok: false, message: 'いま取り込んでいる最中です。終わるまでお待ちください。' };
    }
    const part = asrPartOf(id);
    if (part === undefined) return { ok: false, message: '知らない一式です。' };
    try {
      await this.deps.store.removePart(id);
      const left = await this.readInstalled();
      if (left.parts[id] !== undefined) {
        return { ok: false, message: '消せませんでした(まだ残っています)。' };
      }
      return { ok: true, installed: left, message: `「${part.label}」を消しました` };
    } catch (e) {
      return { ok: false, message: toMessage(e, '削除') };
    }
  }
}
