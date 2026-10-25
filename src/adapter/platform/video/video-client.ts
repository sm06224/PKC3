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
  recheckAfterFailure,
  nativeCodecApi,
  reencodeHead,
  blobSource,
  runVideoJob,
  type CodecApi,
  type VideoCutResult,
  type VideoJob,
  type VideoJobResult,
  type VideoFoldResult,
  type VideoPictureResult,
  type VideoScenesResult,
  type VideoScanResult,
} from './video-codec';
import { precisePlanSpec, type VideoScan } from '@features/video/webm-vp8';
import type { ContactSheetResult } from './contact-sheet';
import type { TimedLine } from '@features/capture/contact-sheet-layout';

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
  /** 直前の走査が「作り直しはメインスレッドで」と決めたか(走査 → 切り出しは 1 本ずつ進む)。 */
  private viaMain = false;
  /**
   * ワーカーの環境そのものが壊れていると分かったか(落ちた後の再検出も通らなかった)。立っていれば、
   * メインでの作り直しへ回さない ── 同じエンジンで同じ失敗をする。
   * 🔑 **ワーカーの覚えと同じ寿命にする**:ワーカーが畳まれて作り直されたら、こちらも忘れて測り直す
   *   (ワーカー側の「使える / 使えない」の覚えはワーカーと一緒に消えるので、片方だけ残さない)。
   */
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
    // ワーカーが居ない(まだ / 畳まれた)なら、次の依頼で新しく起きて測り直す ── 覚えも一緒に忘れる
    if (!this.alive) this.broken = false;
    const r = (await this.run({ op: 'scan', blob, startMs, endMs })) as VideoScanResult;
    this.viaMain = false;
    if (!r.ok) return r;
    if (r.precise === 'needs-codec' && !this.broken) {
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
      if (spec === null || api === null) return { ok: false, preciseFailed: true, environmentBroken: api === null };
      try {
        const head = (await reencodeHead(blobSource(blob), scan, spec, api)).frames;
        return (await this.run({ op: 'cut', blob, scan, startMs, endMs, mode: 'precise', head })) as VideoCutResult;
      } catch {
        // 🔴 この録画だけの失敗かもしれない ── 小さい 1 枚を通し直して、環境が壊れたときだけ以後を閉じる
        this.viaMain = false;
        return { ok: false, preciseFailed: true, environmentBroken: await recheckAfterFailure(api) };
      }
    }
    const r = (await this.run({ op: 'cut', blob, scan, startMs, endMs, mode })) as VideoCutResult;
    if (!r.ok && 'preciseFailed' in r && r.environmentBroken) this.broken = true;
    return r;
  }

  /** 🔴 音のトラックを落として映像だけにする(#952 A1)。⚠ 断る理由は**値で返る**。 */
  async pictureOnly(blob: Blob): Promise<VideoPictureResult> {
    return (await this.run({ op: 'picture-only', blob })) as VideoPictureResult;
  }

  /** 🔴 静止している区間を畳む(#952 A2)。⚠ 断る理由は**値で返る**。 */
  async foldStill(blob: Blob): Promise<VideoFoldResult> {
    return (await this.run({ op: 'fold-still', blob })) as VideoFoldResult;
  }

  /** 🔴 場面が変わる所を見つける(#952 A4)。⚠ 断る理由は**値で返る**。 */
  async scenes(blob: Blob): Promise<VideoScenesResult> {
    return (await this.run({ op: 'scenes', blob })) as VideoScenesResult;
  }

  /** 🔴 コンタクトシート(場面ごとの静止画 + 文字起こしの PNG。#952 A5)。⚠ 断る理由は**値で返る**。 */
  async contactSheet(blob: Blob, lines: readonly TimedLine[], title: string): Promise<ContactSheetResult> {
    return (await this.run({ op: 'contact-sheet', blob, lines, title })) as ContactSheetResult;
  }

  dispose(): void {
    this.lease?.dispose();
  }
}

function defaultSpawn(): (() => Worker) | null {
  if (typeof Worker !== 'function') return null;
  return () => new Worker(new URL('./video-worker.ts', import.meta.url), { type: 'module' });
}
