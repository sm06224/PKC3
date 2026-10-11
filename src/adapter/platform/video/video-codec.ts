/**
 * 🔴 **動画の切り出しの「中身」**(#683 段②b-1。設計 doc §4.6・§4.7)。
 *
 * 🔑 **ワーカーの配線とは別の file に置く**(`audio-codec.ts` / `asset-codec.ts` と同じ作法)。
 *
 * ⚠ **音の `trimAudio` と違い、元を `arrayBuffer()` で丸ごと読まない** ── 動画は 1 本 250MB まで
 *   ありうるので、**窓(8MB)で順に読み、索引だけを持つ**。出力も `Blob.slice` の部品を
 *   並べた `Blob` で返す(コピーしない。不可侵指示 2026-07-27「ゼロコピー」)。
 *
 * 2 つの口:
 * - `scanVideo` ── 走査して、始まりをどこへ戻すかを返す(確認の前に呼ぶ)
 * - `cutVideo`  ── 走査の結果を使って、新しい動画の `Blob` を組む
 */
import {
  planVideoTrim,
  scanWebmVideo,
  snapVideoStart,
  type ByteSource,
  type VideoScan,
  type VideoTrimRefusal,
} from '@features/video/webm-vp8';

/** 依頼。⚠ `Blob` で渡す(構造化複製で参照として渡り、bytes は写されない)。 */
export type VideoJob =
  | { readonly op: 'scan'; readonly blob: Blob; readonly startMs: number; readonly endMs: number }
  | {
      readonly op: 'cut';
      readonly blob: Blob;
      readonly scan: VideoScan;
      readonly startMs: number;
      readonly endMs: number;
    };

export type VideoScanResult =
  | {
      readonly ok: true;
      readonly scan: VideoScan;
      readonly snappedStartMs: number;
      /** 始まりが手前へ戻る長さ(ミリ秒)。0 = 押した所がちょうどキーフレーム。 */
      readonly snapBackMs: number;
    }
  | { readonly ok: false; readonly reason: VideoTrimRefusal };

export type VideoCutResult =
  | {
      readonly ok: true;
      /** ⚠ **元の `Blob` の部品を指す**(コピーしていない)。 */
      readonly blob: Blob;
      readonly durationMs: number;
      readonly snappedStartMs: number;
      readonly keptVideo: number;
      readonly keptAudio: number;
    }
  | { readonly ok: false; readonly reason: VideoTrimRefusal };

export type VideoJobResult = VideoScanResult | VideoCutResult;

/** `Blob` を窓で読む口。 */
export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
  };
}

export async function scanVideo(job: { blob: Blob; startMs: number; endMs: number }): Promise<VideoScanResult> {
  const scanned = await scanWebmVideo(blobSource(job.blob), job.endMs);
  if (!scanned.ok) return scanned;
  const snap = snapVideoStart(scanned.scan, job.startMs);
  if (!snap.ok) return snap;
  return { ok: true, scan: scanned.scan, snappedStartMs: snap.snappedStartMs, snapBackMs: snap.snapBackMs };
}

export async function cutVideo(job: {
  blob: Blob;
  scan: VideoScan;
  startMs: number;
  endMs: number;
}): Promise<VideoCutResult> {
  const planned = await planVideoTrim(blobSource(job.blob), job.scan, job.startMs, job.endMs);
  if (!planned.ok) return planned;
  const p = planned.plan;
  const blob = new Blob(
    p.parts.map((part) =>
      part.kind === 'bytes' ? (part.bytes as Uint8Array<ArrayBuffer>) : job.blob.slice(part.start, part.end),
    ),
    { type: 'video/webm' },
  );
  return {
    ok: true,
    blob,
    durationMs: p.durationMs,
    snappedStartMs: p.snappedStartMs,
    keptVideo: p.keptVideo,
    keptAudio: p.keptAudio,
  };
}

/** ワーカー / その場の両方が通る 1 本の入口。 */
export function runVideoJob(job: VideoJob): Promise<VideoJobResult> {
  return job.op === 'scan' ? scanVideo(job) : cutVideo(job);
}
