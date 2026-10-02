/**
 * 🔴 **音声認識のメインスレッド側の口**(#772 段②)。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください /
 * > ワーカーはしばらくつかわれないなら、キルと解放し、ワーカーへのジョブ発行をバッファして、
 * > ワーカーにディスパッチします」
 *
 * 遅延起動・バッファ・アイドル kill は `WorkerLease` が持つ。ここが足すのは**渡し方**だけ:
 *
 * ⚠ 重みと実行の部品は **`Blob` で渡す** ── 構造化複製で**参照として**渡るので、メインは
 *   bytes を 1 バイトも開かない(254MB が heap に載らない)。
 * ⚠ 音(PCM)は **transfer**(ゼロコピー)。渡した側では空になる ── 呼び側が「もう触らない」。
 * 🔴 **ワーカーが無い環境では動かさない**(`AudioClient` とは違う)── 推論は 1.65〜3.6GB を
 *   食うので、メインスレッドでは回さない。断って、理由を言う。
 * ⚠ 常駐が重い(段②-0 の実測)ので、アイドルは短い(`ASR_WORKER_IDLE_MS`)。
 */
import { ASR_WORKER_IDLE_MS } from '@features/asr/asr-parts';
import { WorkerLease } from '../worker-lease';
import { appJobMonitor, type JobMonitor } from '../job-monitor';
import type { AsrJob, AsrJobResult } from './asr-run';

export interface AsrClientOptions {
  /** worker の作り方(test が差し替える)。 */
  spawn?: () => Worker;
  idleMs?: number;
  monitor?: JobMonitor;
}

export class AsrClient {
  private readonly lease: WorkerLease | null;

  constructor(options: AsrClientOptions = {}) {
    const spawn = options.spawn ?? defaultSpawn();
    this.lease = spawn
      ? new WorkerLease({
          spawn,
          idleMs: options.idleMs ?? ASR_WORKER_IDLE_MS,
          name: 'asr',
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

  /**
   * 字にする。
   * ⚠ **`pcm` は譲る**(transfer)。⚠ 落ちたら例外(呼び側が文にする)。
   */
  transcribe(job: AsrJob): Promise<AsrJobResult> {
    if (this.lease === null) {
      return Promise.reject(new Error('この環境では、重い処理を別に動かす仕組みが使えないため、文字にできません'));
    }
    return this.lease.run<AsrJobResult>(job, [job.pcm.buffer as ArrayBuffer]);
  }

  dispose(): void {
    this.lease?.dispose();
  }
}

/** 既定の作り方。⚠ ワーカーが無い環境では `null`。 */
function defaultSpawn(): (() => Worker) | null {
  if (typeof Worker !== 'function') return null;
  return () => new Worker(new URL('./asr-worker.ts', import.meta.url), { type: 'module' });
}
