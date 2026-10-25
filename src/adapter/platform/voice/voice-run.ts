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
import {
  hasVoice,
  levelSegments,
  residualOf,
  runEngine,
  VOICE_FRAME,
  VOICE_RATE,
  type FrameEngine,
  type Span,
} from '@features/audio/voice-lab';
import { diarize, splitLong, voicedRuns, type SpeakerTurn } from '@features/audio/diarize';
import { encodeOpusWebm, nativeAudioApi, type AudioApi } from './audio-encode';

/**
 * 依頼。⚠ `pcm` は **読み取り専用にしない** ── `VoiceRunner.run` は受け取った瞬間にこの参照を空へ差し替えて所有を取り、
 * 使い終わった PCM を**依頼の終わりを待たずに手放す**(30 分の PCM は約 330MB。元・雑音を引いた物・声以外の 3 本を同時に持たない)。
 */
export type VoiceJob =
  | { op: 'denoise'; pcm: Float32Array }
  | { op: 'separate'; pcm: Float32Array }
  | { op: 'diarize'; pcm: Float32Array }
  | { op: 'level'; pcm: Float32Array };

export interface VoiceFile {
  /** 名前に入れる語(`話し声` など)。 */
  readonly tag: string;
  readonly bytes: ArrayBuffer;
  readonly durationMs: number;
}

export type VoiceRefusal = 'no-encoder' | 'empty' | 'encode-failed' | 'silent' | 'no-voice' | 'no-engine';

export type VoiceResult =
  | { readonly ok: true; readonly kind: 'audio'; readonly files: readonly VoiceFile[] }
  | {
      readonly ok: true;
      readonly kind: 'turns';
      readonly turns: readonly SpeakerTurn[];
      readonly speakers: number;
      readonly durationMs: number;
    }
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

const EMPTY = new Float32Array(0);

export class VoiceRunner {
  private readonly deps: VoiceDeps;

  constructor(deps: VoiceDeps) {
    this.deps = deps;
  }

  async run(job: VoiceJob): Promise<VoiceResult> {
    // 🔴 所有を取る:依頼(`job`)が PCM を持ち続けると、使い終わったあとも解放されない
    let pcm: Float32Array | null = job.pcm;
    job.pcm = EMPTY;
    if (pcm.length === 0) return { ok: false, reason: 'empty' };
    if (peakAndRms(pcm) < SILENT_RMS) return { ok: false, reason: 'silent' };
    const lengthSamples = pcm.length;
    let engine: EngineHandle;
    try {
      engine = await this.deps.createEngine();
    } catch {
      return { ok: false, reason: 'no-engine' };
    }
    try {
      const run = runEngine(pcm, engine);
      let clean: Float32Array | null = run.clean;
      const vad = run.vad;
      const api = this.deps.audioApi === undefined ? nativeAudioApi() : this.deps.audioApi;
      if (job.op === 'denoise') {
        pcm = null; // 元の PCM はもう要らない(雑音を引いた物だけを符号化する)
        const parts = [{ tag: '雑音を減らした', pcm: clean as Float32Array | null }];
        clean = null;
        return await this.encodeFiles(api, parts);
      }
      if (job.op === 'diarize') {
        pcm = null;
        const d = diarize(clean, vad);
        if (d.turns.length === 0) return { ok: false, reason: 'no-voice' };
        return {
          ok: true,
          kind: 'turns',
          turns: d.turns,
          speakers: d.speakers,
          durationMs: Math.round((lengthSamples * 1e3) / VOICE_RATE),
        };
      }
      if (job.op === 'level') {
        pcm = null;
        /**
         * 雑音を引いた声を、声の塊(6 秒以内)ごとに目標の大きさへ寄せる。遠い人は持ち上がり、近い人は下がる。
         * 🔴 **塊の切り出しだけを使う**(`voicedRuns` + `splitLong`)── 話者のクラスタリングは走らせない(特徴量の計算も
         *   距離の計算も要らない。大きさを寄せるのに「誰か」は要らない)。
         */
        const runs = splitLong(voicedRuns(vad));
        if (runs.length === 0) return { ok: false, reason: 'no-voice' };
        const source = clean;
        const spans: Span[] = runs.map((r) => ({ start: r.start * VOICE_FRAME, end: Math.min(source.length, r.end * VOICE_FRAME) }));
        const leveled = levelSegments(source, spans, VOICE_RATE);
        clean = null; // 倍率をかけた物ができたので、雑音を引いた物は手放す
        return await this.encodeFiles(api, [{ tag: '声の大きさをそろえた', pcm: leveled as Float32Array | null }]);
      }
      // separate:声 = 雑音(声以外)を引いたもの / 声以外 = 元から声を引いた残り(伴奏・環境音)
      if (!hasVoice(vad)) return { ok: false, reason: 'no-voice' };
      const rest = residualOf(pcm, clean);
      pcm = null; // 残りができたので、元の PCM は手放す(声・声以外の 2 本だけが残る)
      const parts = [
        { tag: '話し声', pcm: clean as Float32Array | null },
        { tag: '声以外', pcm: rest as Float32Array | null },
      ];
      clean = null;
      return await this.encodeFiles(api, parts);
    } finally {
      engine.destroy();
    }
  }

  /** 符号化して返す。⚠ 1 本符号化し終えるたびに、その PCM を手放す(`parts` の参照を空にする)。 */
  private async encodeFiles(
    api: AudioApi | null,
    parts: Array<{ tag: string; pcm: Float32Array | null }>,
  ): Promise<VoiceResult> {
    const files: VoiceFile[] = [];
    for (const p of parts) {
      const source = p.pcm;
      if (source === null) return { ok: false, reason: 'encode-failed' };
      const enc = await encodeOpusWebm(source, api);
      p.pcm = null;
      if (!enc.ok) return { ok: false, reason: enc.reason };
      // ⚠ `bytes` は自前で組んだ `Uint8Array` なので、buffer 全体がそのまま使える(transfer できる)
      files.push({ tag: p.tag, bytes: enc.bytes.buffer as ArrayBuffer, durationMs: enc.durationMs });
    }
    return { ok: true, kind: 'audio', files };
  }
}
