/**
 * 🔴 **音の切り出しのメインスレッド側の口**(#683 段②a)。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください /
 * > ワーカーはしばらくつかわれないなら、キルと解放し…」
 *
 * 遅延起動・バッファ・アイドル kill は `WorkerLease` が持つ。ここが足すのは
 * **渡し方**だけである:
 *
 * ⚠ **`Blob` で渡す** ── 構造化複製で**参照として**渡るので、メインスレッドは
 *   bytes を 1 バイトも開かない(12 時間の録音でも heap に載らない)。
 * ⚠ 返りは `ArrayBuffer` を **transfer**(ゼロコピー)。
 *
 * 🔴 **ワーカーが無い環境では同じ関数をその場で回す**(`AssetClient` と同じ規律)──
 * 出口を 2 本作っているのではなく、返る bytes は**同じ関数から出る**(`trimAudio`)。
 * ⚠ flag は作らない ── 枠は 15 個で、値を変える動機が user 側に無い。
 */
import { WorkerLease } from '../worker-lease';
import { appJobMonitor, type JobMonitor } from '../job-monitor';
import { trimAudio, type AudioTrimJob, type AudioTrimResult } from './audio-codec';

/**
 * アイドルで畳むまで。⚠ 切り出しは**続けて押されうる**(頭を切って、次に尻を切る)
 * ので、押すたびに作り直すと損をする。
 */
export const AUDIO_WORKER_IDLE_MS = 15_000;

export interface AudioClientOptions {
  /** worker の作り方(test が差し替える)。 */
  spawn?: () => Worker;
  idleMs?: number;
  monitor?: JobMonitor;
}

export class AudioClient {
  private readonly lease: WorkerLease | null;

  constructor(options: AudioClientOptions = {}) {
    const spawn = options.spawn ?? defaultSpawn();
    this.lease = spawn
      ? new WorkerLease({
          spawn,
          idleMs: options.idleMs ?? AUDIO_WORKER_IDLE_MS,
          name: 'audio',
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

  /** 範囲を切り出す。⚠ 断る理由は**値で返る**(例外にしない)。 */
  trim(blob: Blob, startMs: number, endMs: number): Promise<AudioTrimResult> {
    const job: AudioTrimJob = { blob, startMs, endMs };
    if (!this.lease) return trimAudio(job);
    return this.lease.run<AudioTrimResult>(job);
  }

  dispose(): void {
    this.lease?.dispose();
  }
}

/** 既定の作り方。⚠ **ワーカーが無い環境では `null`** を返して同期経路へ落とす。 */
function defaultSpawn(): (() => Worker) | null {
  if (typeof Worker !== 'function') return null;
  return () => new Worker(new URL('./audio-worker.ts', import.meta.url), { type: 'module' });
}
