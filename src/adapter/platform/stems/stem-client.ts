/**
 * 🔴 **歌声と楽器を分けるメインスレッド側の口**(#674 / #949)。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください /
 * > ワーカーはしばらくつかわれないなら、キルと解放し、ワーカーへのジョブ発行をバッファして、ワーカーにディスパッチします」
 *
 * 遅延起動・バッファ・アイドル kill・kill 時の reject は `WorkerLease` が持つ。ここが足すのは**渡し方**だけ:
 * ⚠ PCM は **transfer**(ゼロコピー)。渡した側では空になる ── 呼び側が「もう触らない」。重みの `Blob` は**参照**で渡る。
 * ⚠ 進み具合は `MessageChannel` の片方を依頼に載せて受ける(`WorkerLease` の応答は 1 件 1 返答のため)。終わったら必ず閉じる。
 * 🔴 **ワーカーが無い環境では動かさない** ── ONNX の推論をメインスレッドでは回さない。断って、理由を言う。
 * ⚠ 分離は数十秒〜数分かかる。続けて押されうるので、アイドルは短すぎない(`STEM_WORKER_IDLE_MS`)。
 */
import { WorkerLease } from '../worker-lease';
import { appJobMonitor, type JobMonitor } from '../job-monitor';
import type { StemJob, StemProbeResult, StemResult } from './stem-run';

/** アイドルで畳むまで。 */
export const STEM_WORKER_IDLE_MS = 20_000;

export interface StemClientOptions {
  /** worker の作り方(test が差し替える)。 */
  spawn?: () => Worker;
  idleMs?: number;
  monitor?: JobMonitor;
}

/** メイン側が渡す依頼(進み具合は口の代わりに関数で受ける)。 */
export type StemRequest = Omit<StemJob, 'progress'>;

export class StemClient {
  private readonly lease: WorkerLease | null;

  constructor(options: StemClientOptions = {}) {
    const spawn = options.spawn ?? defaultSpawn();
    this.lease = spawn
      ? new WorkerLease({
          spawn,
          idleMs: options.idleMs ?? STEM_WORKER_IDLE_MS,
          name: 'stems',
          monitor: options.monitor ?? appJobMonitor,
        })
      : null;
  }

  /** ワーカーを使える環境か。 */
  get available(): boolean {
    return this.lease !== null;
  }

  /** worker が生きているか(計測と test の観測点)。 */
  get alive(): boolean {
    return this.lease?.alive ?? false;
  }

  /** 分ける。⚠ `left` / `right` は譲る(transfer)。落ちたら例外(呼び側が文にする)。 */
  run(
    req: StemRequest,
    onProgress: (text: string) => void = () => {},
    /** 「やめる」の合図を繋ぐ口。渡した関数を、やめるときに呼ぶ(ワーカーへ合図を送る)。 */
    registerCancel?: (fn: () => void) => void,
  ): Promise<StemResult> {
    if (this.lease === null) {
      return Promise.reject(new Error('この環境では、重い処理を別に動かす仕組みが使えないため、実行できません'));
    }
    const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
    if (channel !== null) channel.port1.onmessage = (ev: MessageEvent<unknown>): void => {
      if (typeof ev.data === 'string') onProgress(ev.data);
    };
    if (channel !== null) registerCancel?.(() => channel.port1.postMessage('cancel'));
    const job: StemJob = { ...req, ...(channel === null ? {} : { progress: channel.port2 }) };
    // 🔴 モノラルは左右が同じ配列(複製しない)── 同じ buffer を 2 度 transfer すると DataCloneError になるので 1 本にする
    const transfer: Transferable[] = [req.left.buffer as ArrayBuffer];
    if (req.right.buffer !== req.left.buffer) transfer.push(req.right.buffer as ArrayBuffer);
    if (channel !== null) transfer.push(channel.port2);
    return this.lease.run<StemResult>(job, transfer).finally(() => {
      channel?.port1.close();
    });
  }

  /**
   * 🔴 実行器が起動できるかを確かめる(モデルを取る前)。⚠ ワーカーが無い環境は「使えない」を値で返す。
   */
  probe(): Promise<StemProbeResult> {
    if (this.lease === null) {
      return Promise.resolve({
        ok: false,
        reason: 'no-runtime',
        detail: 'この環境では、重い処理を別に動かす仕組みが使えません',
      });
    }
    return this.lease.run<StemProbeResult>({ op: 'probe' });
  }

  dispose(): void {
    this.lease?.dispose();
  }
}

/** 既定の作り方。⚠ ワーカーが無い環境では `null`。 */
function defaultSpawn(): (() => Worker) | null {
  if (typeof Worker !== 'function') return null;
  return () => new Worker(new URL('./stem-worker.ts', import.meta.url), { type: 'module' });
}
