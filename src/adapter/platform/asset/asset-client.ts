/**
 * 添付の展開・ハッシュの**メインスレッド側の口**(P8 段⑮)。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください /
 * > ワーカーはしばらくつかわれないなら、キルと解放し、ワーカーへのジョブ発行を
 * > バッファして、ワーカーにディスパッチします」
 *
 * 遅延起動・バッファ・アイドル kill は `WorkerLease` が持つ。ここが足すのは
 * **ゼロコピーの受け渡し**だけである:
 *
 * ⚠ `ArrayBuffer` を `transfer` で渡すと、**渡した側の buffer は切り離される**
 * (`byteLength` が 0 になる)。呼び側が同じ bytes を後で使うつもりだと
 * 静かに空になるので、**渡したら手放す**という約束にする(取込は 1 回しか
 * 使わないので都合がよい)。
 *
 * 🔴 **ワーカーが無い環境では同じ関数をその場で回す** ── `file://`・古い環境・
 * test(happy-dom は `Worker` を持たない)。⚠ 出口を 2 本作っているのではなく、
 * 「ワーカーは速さの話であって、正しさの話ではない」という位置づけ:
 * 返る bytes と hash は**同じ関数から出る**(`processAsset`)。
 */
import { WorkerLease } from '../worker-lease';
import { appJobMonitor, type JobMonitor } from '../job-monitor';
import {
  processAsset,
  transferableBuffer,
  type AssetJob,
  type AssetResult,
  hashAsset,
  type AssetHashJob,
  type HashResult,
} from './asset-codec';
import { appFlags } from '../flag-store';
import { FLAG_ASSET_INLINE } from '@features/flags';

/** アイドルで畳むまで。⚠ 取込は連続して来るので、短すぎると作り直しで損をする。 */
export const ASSET_WORKER_IDLE_MS = 15_000;

export interface AssetClientOptions {
  /** worker の作り方(test / bench が差し替える)。 */
  spawn?: () => Worker;
  idleMs?: number;
  monitor?: JobMonitor;
}

export class AssetClient {
  private readonly lease: WorkerLease | null;

  constructor(options: AssetClientOptions = {}) {
    const spawn = options.spawn ?? defaultSpawn();
    this.lease = spawn
      ? new WorkerLease({
          spawn,
          idleMs: options.idleMs ?? ASSET_WORKER_IDLE_MS,
          name: 'asset',
          monitor: options.monitor ?? appJobMonitor,
        })
      : null;
  }

  /** ワーカーを使う環境か(使えないなら同じ処理をその場で回している)。 */
  get offloaded(): boolean {
    return this.lease !== null;
  }

  /** worker が生きているか(計測と test の観測点)。 */
  get alive(): boolean {
    return this.lease?.alive ?? false;
  }

  /**
   * 1 件を展開してハッシュを取る。
   *
   * ⚠ **view を受ける** ── ArrayBuffer を呼び側に作らせない(部分参照を
   * そのまま渡すと、受け手は buffer 全体を展開・ハッシュして**別物になる**)。
   * ⚠ 渡した bytes は transfer で**切り離される**ので、呼び側は後で使わない。
   */
  process(view: Uint8Array<ArrayBuffer>, gzipped: boolean): Promise<AssetResult> {
    const job: AssetJob = { bytes: transferableBuffer(view), gzipped };
    if (!this.lease) return processAsset(job);
    return this.lease.run<AssetResult>(job, [job.bytes]);
  }

  /**
   * **Blob のハッシュだけ**取る(P8 段㉓)。
   *
   * 🔴 添付を貼る経路のための口。ここが無かったので `identifyAsset` をメインで
   * 呼んでいた ── 同じビルドの A/B で、32MB の添付でメインの最大欠測が
   * **10/14ms(ワーカー)対 500/726ms(メイン)**(user 実機報告と一致)。
   * ⚠ どの呼び出しが止めているかは主張しない(単体では両方とも止まらない)。
   * ⚠ **Blob は参照で渡る**(構造化複製で bytes はコピーされない)ので、
   *   transfer は要らない。materialize されるのはワーカーの中だけ。
   */
  hash(blob: Blob, hashMaxBytes?: number): Promise<HashResult> {
    const job: AssetHashJob = {
      blob,
      ...(hashMaxBytes !== undefined ? { hashMaxBytes } : {}),
    };
    if (!this.lease) return hashAsset(job);
    return this.lease.run<HashResult>(job);
  }

  /**
   * 明示的に畳む。
   *
   * ⚠ **常駐を返すのはアイドル kill の仕事**(`WorkerLease` が 15 秒で terminate)。
   * ここは test / 面の破棄用の口であって、アプリの通常経路からは呼ばれない
   * ── かつてコメントが「取込が終わったら畳む」と書いていたが、
   * **呼び出し元は 0 件**だった(P8 段㉔ で実態に合わせた)。
   * 生きているかは設定のジョブ表(`alive`)で見える。
   */
  dispose(): void {
    this.lease?.dispose();
  }
}

/**
 * 既定の作り方。⚠ **ワーカーが無い環境では `null`** を返して同期経路へ落とす。
 * 計測用の逃がし口(`?pkc-asset-inline`)も markdown と同じ形にしておく ──
 * 対照群が「同じビルドの、測りたい違いだけが違うもの」になる。
 */
function defaultSpawn(): (() => Worker) | null {
  if (typeof Worker !== 'function') return null;
  // 🔴 **flag で決める**(P11)。⚠ 直に `location.search` を読まない(抜け穴の禁止)
  if (appFlags.isOn(FLAG_ASSET_INLINE.name)) return null;
  return () => new Worker(new URL('./asset-worker.ts', import.meta.url), { type: 'module' });
}
