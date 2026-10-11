/**
 * 🔴 **動画の切り出しのメインスレッド側の口**(#683 段②b-1。設計 doc §4.7)。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください /
 * > ワーカーはしばらくつかわれないなら、キルと解放し…」
 *
 * 遅延起動・バッファ・アイドル kill・kill 時の reject は `WorkerLease` が持つ。
 *
 * 🔑 **音の `AudioClient` とは別のワーカーにする**(動画の長い仕事で音の切り出しを待たせない)。
 * ⚠ `Blob` は参照で渡る。メインスレッドは bytes を 1 バイトも開かない。
 * 🔴 ワーカーが無い環境では同じ関数(`runVideoJob`)をその場で回す ── 出口を 2 本作らない。
 */
import { WorkerLease } from '../worker-lease';
import { appJobMonitor, type JobMonitor } from '../job-monitor';
import {
  runVideoJob,
  type VideoCutResult,
  type VideoJob,
  type VideoJobResult,
  type VideoScanResult,
} from './video-codec';
import type { VideoScan } from '@features/video/webm-vp8';

/** アイドルで畳むまで。⚠ 走査のあと確認を挟んで切るので、続けて呼ばれる。 */
export const VIDEO_WORKER_IDLE_MS = 15_000;

export interface VideoClientOptions {
  spawn?: () => Worker;
  idleMs?: number;
  monitor?: JobMonitor;
}

export class VideoClient {
  private readonly lease: WorkerLease | null;

  constructor(options: VideoClientOptions = {}) {
    const spawn = options.spawn ?? defaultSpawn();
    this.lease = spawn
      ? new WorkerLease({
          spawn,
          idleMs: options.idleMs ?? VIDEO_WORKER_IDLE_MS,
          name: 'video',
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

  private run(job: VideoJob): Promise<VideoJobResult> {
    if (!this.lease) return runVideoJob(job);
    return this.lease.run<VideoJobResult>(job);
  }

  /** 走査して、始まりがどこへ戻るかを調べる。⚠ 断る理由は**値で返る**。 */
  scan(blob: Blob, startMs: number, endMs: number): Promise<VideoScanResult> {
    return this.run({ op: 'scan', blob, startMs, endMs }) as Promise<VideoScanResult>;
  }

  /** 走査の結果を使って切り出す。 */
  cut(blob: Blob, scan: VideoScan, startMs: number, endMs: number): Promise<VideoCutResult> {
    return this.run({ op: 'cut', blob, scan, startMs, endMs }) as Promise<VideoCutResult>;
  }

  dispose(): void {
    this.lease?.dispose();
  }
}

function defaultSpawn(): (() => Worker) | null {
  if (typeof Worker !== 'function') return null;
  return () => new Worker(new URL('./video-worker.ts', import.meta.url), { type: 'module' });
}
