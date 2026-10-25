/**
 * 🔴 **声の仕上げの「中身」**(#952 B1・#674・B4・B5)── ワーカーの中で動く。
 *
 * 🔑 **ワーカーの配線とは別の file に置く**(`audio-codec.ts` と同じ作法 ── 同居させると import しただけで `self.onmessage` が付く)。
 * ⚠ エンジン(RNNoise の wasm)と opus の符号化器は `deps` で注入する ── unit が本物の wasm も偽物も通せる。
 *
 * ## 🔴 使い捨てである
 * RNNoise の wasm は **最初の依頼で初めて読み込む**(動的 import ── 使わない人のワーカーには載らない)。
 * 畳むのは `WorkerLease` のアイドル kill であり、ここは何も解放しない(terminate で wasm のメモリごと消える)。
 * 1 回の依頼ごとに `DenoiseState` を作って、終わったらその場で `destroy()` する(状態を持ち越さない)。
 * ⚠ PCM は **transfer で受ける**(ゼロコピー)。結果の bytes も transfer で返す。
 */
import { runEngine, type FrameEngine } from '@features/audio/voice-lab';
import { encodeOpusWebm, nativeAudioApi, type AudioApi } from './audio-encode';

export type VoiceJob = { readonly op: 'denoise'; readonly pcm: Float32Array };

export interface VoiceFile {
  /** 名前に入れる語(`話し声` など)。 */
  readonly tag: string;
  readonly bytes: ArrayBuffer;
  readonly durationMs: number;
}

export type VoiceRefusal = 'no-encoder' | 'empty' | 'encode-failed' | 'silent' | 'no-voice' | 'no-engine';

export type VoiceResult =
  | { readonly ok: true; readonly kind: 'audio'; readonly files: readonly VoiceFile[] }
  | { readonly ok: false; readonly reason: VoiceRefusal };

/** エンジンの実体。⚠ `destroy` は 1 依頼ごとに呼ぶ。 */
export interface EngineHandle extends FrameEngine {
  destroy(): void;
}

export interface VoiceDeps {
  /** エンジンを 1 つ作る(RNNoise の wasm を読み込み済みにして `createDenoiseState`)。作れなければ投げる。 */
  readonly createEngine: () => Promise<EngineHandle>;
  /** opus の符号化器。省略 = 本物。 */
  readonly audioApi?: AudioApi | null;
}

/** 無音とみなす全体の RMS。 */
const SILENT_RMS = 1e-4;

const peakAndRms = (x: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < x.length; i += 1) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, x.length));
};

export class VoiceRunner {
  private readonly deps: VoiceDeps;

  constructor(deps: VoiceDeps) {
    this.deps = deps;
  }

  async run(job: VoiceJob): Promise<VoiceResult> {
    const { pcm } = job;
    if (pcm.length === 0) return { ok: false, reason: 'empty' };
    if (peakAndRms(pcm) < SILENT_RMS) return { ok: false, reason: 'silent' };
    let engine: EngineHandle;
    try {
      engine = await this.deps.createEngine();
    } catch {
      return { ok: false, reason: 'no-engine' };
    }
    try {
      const { clean } = runEngine(pcm, engine);
      const api = this.deps.audioApi === undefined ? nativeAudioApi() : this.deps.audioApi;
      return await this.encodeFiles(api, [{ tag: '雑音を減らした', pcm: clean }]);
    } finally {
      engine.destroy();
    }
  }

  private async encodeFiles(
    api: AudioApi | null,
    parts: readonly { tag: string; pcm: Float32Array }[],
  ): Promise<VoiceResult> {
    const files: VoiceFile[] = [];
    for (const p of parts) {
      const enc = await encodeOpusWebm(p.pcm, api);
      if (!enc.ok) return { ok: false, reason: enc.reason };
      // ⚠ `bytes` は自前で組んだ `Uint8Array` なので、buffer 全体がそのまま使える(transfer できる)
      files.push({ tag: p.tag, bytes: enc.bytes.buffer as ArrayBuffer, durationMs: enc.durationMs });
    }
    return { ok: true, kind: 'audio', files };
  }
}
