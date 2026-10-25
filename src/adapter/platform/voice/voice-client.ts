/**
 * 🔴 **声の仕上げのメインスレッド側の口**(#952 B1・#674・B4・B5)。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください /
 * > ワーカーはしばらくつかわれないなら、キルと解放し、ワーカーへのジョブ発行をバッファして、ワーカーにディスパッチします」
 *
 * 遅延起動・バッファ・アイドル kill・kill 時の reject は `WorkerLease` が持つ。ここが足すのは**渡し方**だけ:
 * ⚠ PCM は **transfer**(ゼロコピー)。渡した側では空になる ── 呼び側が「もう触らない」。
 * 🔴 **ワーカーが無い環境では動かさない**(`AsrClient` と同じ ── wasm の NN をメインスレッドで回さない)。断って、理由を言う。
 * ⚠ 声の仕上げは続けて押されうる(雑音を減らす → 声を分ける)ので、アイドルは短すぎない(`VOICE_WORKER_IDLE_MS`)。
 */
import { WorkerLease } from '../worker-lease';
import { appJobMonitor, type JobMonitor } from '../job-monitor';
import type { VoiceJob, VoiceResult } from './voice-run';

/** アイドルで畳むまで。 */
export const VOICE_WORKER_IDLE_MS = 20_000;

export interface VoiceClientOptions {
  /** worker の作り方(test が差し替える)。 */
  spawn?: () => Worker;
  idleMs?: number;
  monitor?: JobMonitor;
}

export class VoiceClient {
  private readonly lease: WorkerLease | null;

  constructor(options: VoiceClientOptions = {}) {
    const spawn = options.spawn ?? defaultSpawn();
    this.lease = spawn
      ? new WorkerLease({
          spawn,
          idleMs: options.idleMs ?? VOICE_WORKER_IDLE_MS,
          name: 'voice',
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
   * 依頼を走らせる。⚠ **`pcm` は譲る**(transfer)。⚠ 断る理由は**値で返る**。落ちたら例外(呼び側が文にする)。
   */
  run(job: VoiceJob): Promise<VoiceResult> {
    if (this.lease === null) {
      return Promise.reject(new Error('この環境では、重い処理を別に動かす仕組みが使えないため、実行できません'));
    }
    return this.lease.run<VoiceResult>(job, [job.pcm.buffer as ArrayBuffer]);
  }

  dispose(): void {
    this.lease?.dispose();
  }
}

/** 既定の作り方。⚠ ワーカーが無い環境では `null`。 */
function defaultSpawn(): (() => Worker) | null {
  if (typeof Worker !== 'function') return null;
  return () => new Worker(new URL('./voice-worker.ts', import.meta.url), { type: 'module' });
}
