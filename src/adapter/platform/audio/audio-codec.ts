/**
 * 🔴 **音の切り出しの「中身」**(#683 段②a)。
 *
 * 🔑 **ワーカーの配線とは別の file に置く**(`asset-codec.ts` と同じ作法)──
 * 同じ file に置くと、この関数を import しただけで `self.onmessage` が付き、
 * **メインの `window.onmessage` を奪う**(添付ワーカーが実際に出した欠陥)。
 *
 * ⚠ ここは **bytes を materialize する所**である ── メインスレッドでは
 * `Blob` のまま持ち回り、**ワーカーの中で初めて開く**(不可侵指示 2026-07-27
 * 「ゼロコピー・生成とライフサイクル後の速やかな破棄」)。
 */
import { trimWebmOpus, type TrimRefusal } from '@features/audio/webm-opus';

/** 依頼。⚠ **`Blob` で渡す**(構造化複製で参照として渡り、bytes は写されない)。 */
export interface AudioTrimJob {
  readonly blob: Blob;
  readonly startMs: number;
  readonly endMs: number;
}

export type AudioTrimResult =
  | {
      readonly ok: true;
      /** ⚠ **transfer で返す**(ゼロコピー)。 */
      readonly bytes: ArrayBuffer;
      readonly keptPackets: number;
      readonly codecDelayNs: number;
      readonly discardPaddingNs: number;
      readonly durationMs: number;
      /** 読んだ元のバイト数。⚠ **記憶の門の観測点**(test が数える)。 */
      readonly sourceBytes: number;
    }
  | { readonly ok: false; readonly reason: TrimRefusal };

/**
 * 範囲を切り出して、新しい WebM の bytes を返す。
 *
 * ⚠ **例外を投げない** ── 壊れた file は想定内なので、断る理由を値で返す
 * (呼び側が「この 1 件だけ切り出せない」と user へ言える形)。
 */
export async function trimAudio(job: AudioTrimJob): Promise<AudioTrimResult> {
  const source = new Uint8Array(await job.blob.arrayBuffer());
  const out = trimWebmOpus(source, job.startMs, job.endMs);
  if (!out.ok) return { ok: false, reason: out.reason };
  const r = out.result;
  // ⚠ `bytes` は自前で組んだ `Uint8Array` なので、buffer 全体がそのまま使える
  return {
    ok: true,
    bytes: r.bytes.buffer as ArrayBuffer,
    keptPackets: r.keptPackets,
    codecDelayNs: r.codecDelayNs,
    discardPaddingNs: r.discardPaddingNs,
    durationMs: r.durationMs,
    sourceBytes: source.byteLength,
  };
}
