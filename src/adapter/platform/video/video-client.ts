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
  detectPrecise,
  markPreciseBroken,
  nativeCodecApi,
  reencodeHead,
  blobSource,
  runVideoJob,
  type CodecApi,
  type VideoCutResult,
  type VideoJob,
  type VideoJobResult,
  type VideoScanResult,
} from './video-codec';
import { precisePlanSpec, type VideoScan } from '@features/video/webm-vp8';

/** アイドルで畳むまで。⚠ 走査のあと確認を挟んで切るので、続けて呼ばれる。 */
export const VIDEO_WORKER_IDLE_MS = 15_000;

export interface VideoClientOptions {
  spawn?: () => Worker;
  idleMs?: number;
  monitor?: JobMonitor;
  /** メインスレッドの WebCodecs(ワーカーで使えないときの作り直し先)。省くと本物。test は偽物を渡す。 */
  mainApi?: CodecApi | null;
}

export class VideoClient {
  private readonly lease: WorkerLease | null;
  private readonly mainApi: CodecApi | null | undefined;
  /**
   * 🔑 **ワーカーで押した所ぴったりに切れるか**の覚え(環境ごとに 1 回だけ測る。`null` = まだ測っていない)。
   * 走査のたびにワーカーが測り直さないよう、次の依頼で渡す。落ちたら `false` にする。
   */
  private workerPrecise: boolean | null = null;
  /** 直前の走査が「作り直しはメインスレッドで」と決めたか(走査 → 切り出しは 1 本ずつ進む)。 */
  private viaMain = false;
  /** ワーカーの作り直しが途中で落ちたことがあるか(あれば、メインでの作り直しへ回さない ── 同じエンジンで同じ失敗をする)。 */
  private broken = false;

  constructor(options: VideoClientOptions = {}) {
    this.mainApi = options.mainApi;
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

  /**
   * 走査して、始まりがどこへ戻るか・**押した所ぴったりに切れるか**を調べる。⚠ 断る理由は**値で返る**。
   *
   * 🔴 ワーカーで WebCodecs が使えない(`needs-codec`)ときは、**メインスレッドで使えるか**を測る。
   * 使えるなら作り直しの部分だけメインで回す(重い処理をメインに置く例外 ── 数秒ぶんの復号と符号化で、
   * 符号化器と復号器はブラウザが別スレッドで動かす)。どちらも使えなければ `needs-codec` のまま返す。
   */
  async scan(blob: Blob, startMs: number, endMs: number): Promise<VideoScanResult> {
    const known = this.workerPrecise === null ? undefined : this.workerPrecise;
    const r = (await this.run({ op: 'scan', blob, startMs, endMs, ...(known === undefined ? {} : { known }) })) as VideoScanResult;
    this.viaMain = false;
    if (!r.ok) return r;
    if (r.precise === 'ready') {
      // 作り直しが要るときだけ「ワーカーで通った」と覚える(要らない録画では測っていない)
      const spec = precisePlanSpec(r.scan, startMs, endMs);
      if (spec?.reencode === true) this.workerPrecise = true;
      return r;
    }
    if (r.precise === 'needs-codec' && !this.broken) {
      this.workerPrecise = false;
      const api = this.mainApi === undefined ? nativeCodecApi() : this.mainApi;
      if (api !== null && (await detectPrecise(api))) {
        this.viaMain = true;
        return { ...r, precise: 'ready' };
      }
    }
    return r;
  }

  /**
   * 走査の結果を使って切り出す。
   * - `precise` ── 押した所ぴったり。⚠ 落ちたら**何も作らず** `preciseFailed` で返る(呼び側が手前の区切りへ回す)
   * - `snap` ── 手前のキーフレームから
   */
  async cut(
    blob: Blob,
    scan: VideoScan,
    startMs: number,
    endMs: number,
    mode: 'precise' | 'snap',
  ): Promise<VideoCutResult> {
    if (mode === 'precise' && this.viaMain) {
      const spec = precisePlanSpec(scan, startMs, endMs);
      const api = this.mainApi === undefined ? nativeCodecApi() : this.mainApi;
      if (spec === null || api === null) return { ok: false, preciseFailed: true };
      try {
        const head = (await reencodeHead(blobSource(blob), scan, spec, api)).frames;
        return (await this.run({ op: 'cut', blob, scan, startMs, endMs, mode: 'precise', head })) as VideoCutResult;
      } catch {
        // ⚠ `markPreciseBroken` が環境ごとの覚えを「使えない」に倒す ── 次の走査のメイン側の検出は false になる
        markPreciseBroken(api);
        this.viaMain = false;
        return { ok: false, preciseFailed: true };
      }
    }
    const r = (await this.run({ op: 'cut', blob, scan, startMs, endMs, mode })) as VideoCutResult;
    // 落ちた環境は、次の走査から「使えない」と見る(同じ失敗を繰り返して確認なしで戻らない)
    if (!r.ok && 'preciseFailed' in r) {
      this.workerPrecise = false;
      this.broken = true;
    }
    return r;
  }

  dispose(): void {
    this.lease?.dispose();
  }
}

function defaultSpawn(): (() => Worker) | null {
  if (typeof Worker !== 'function') return null;
  return () => new Worker(new URL('./video-worker.ts', import.meta.url), { type: 'module' });
}
