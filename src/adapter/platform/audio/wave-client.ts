/**
 * 🔴 **波形の山を畳むメインスレッド側の口**(#1232)。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください / ワーカーはしばらく
 * > つかわれないなら、キルと解放し…」
 *
 * 遅延起動・バッファ・アイドル kill・terminate 時の reject は `WorkerLease` が持つ。
 * ここが足すのは**渡し方**(PCM を transfer)だけ。ワーカーが無い環境では同じ関数をその場で回す。
 */
import { WorkerLease } from '../worker-lease';
import { appJobMonitor, type JobMonitor } from '../job-monitor';
import { wavePeaks } from './wave-codec';

/** アイドルで畳むまで。⚠ 一覧で次の録音を押すたびに作り直さない程度。 */
export const WAVE_WORKER_IDLE_MS = 10_000;

export interface WaveClientOptions {
  /** `null` = ワーカーを使わずその場で回す(test と、ワーカーの無い環境)。省略 = 既定の作り方。 */
  spawn?: (() => Worker) | null;
  idleMs?: number;
  monitor?: JobMonitor;
}

export class WaveClient {
  private readonly lease: WorkerLease | null;

  constructor(options: WaveClientOptions = {}) {
    const spawn = options.spawn === undefined ? defaultSpawn() : options.spawn;
    this.lease = spawn
      ? new WorkerLease({
          spawn,
          idleMs: options.idleMs ?? WAVE_WORKER_IDLE_MS,
          name: 'wave',
          monitor: options.monitor ?? appJobMonitor,
        })
      : null;
  }

  get offloaded(): boolean {
    return this.lease !== null;
  }

  get alive(): boolean {
    return this.lease?.alive ?? false;
  }

  /** ⚠ `channels` の buffer は転送される(呼び側はもう触らない)。 */
  peaks(channels: Float32Array[], points: number): Promise<Float32Array> {
    if (!this.lease) return Promise.resolve(wavePeaks({ channels, points }));
    return this.lease.run<Float32Array>(
      { channels, points },
      channels.map((c) => c.buffer as ArrayBuffer),
    );
  }

  dispose(): void {
    this.lease?.dispose();
  }
}

function defaultSpawn(): (() => Worker) | null {
  if (typeof Worker !== 'function') return null;
  return () => new Worker(new URL('./wave-worker.ts', import.meta.url), { type: 'module' });
}
