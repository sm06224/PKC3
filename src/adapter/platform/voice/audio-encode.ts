/**
 * 🔴 **PCM を opus の WebM にする**(#952 B1・#674・B5 の出力口)── WebCodecs の `AudioEncoder` + `muxOpusWebm`。ワーカーの中で動く。
 *
 * - 入力は 48kHz mono の PCM(`-1..1`)。1 秒ぶんずつ `AudioData` にして渡し、**渡したらすぐ `close()`**(即破棄)
 * - 出た packet は `EncodedAudioChunk` から bytes へ写し、最後に切り出しと同じ書き手(`muxOpusWebm`)で WebM にする
 * - 🔴 `AudioEncoder` が無い / opus に対応しない環境は**作らず `no-encoder` で返す**(別の形式で黙ってすり替えない)
 *
 * ⚠ 道具(`AudioApi`)は差し替えられる形にして、unit が本物の意味論を真似た偽物で通せる。
 */
import { muxOpusWebm, preSkipOf, type OpusPacket } from '@features/audio/webm-opus';

export interface AudioDataLike {
  close(): void;
}

export interface AudioEncoderLike {
  configure(config: { codec: 'opus'; sampleRate: number; numberOfChannels: number; bitrate: number }): void;
  encode(data: AudioDataLike): void;
  flush(): Promise<void>;
  close(): void;
  readonly encodeQueueSize: number;
}

export interface EncodedAudioOut {
  /** マイクロ秒。 */
  readonly timestamp: number;
  readonly duration: number | null;
  readonly data: Uint8Array;
  /** 最初の出力に付く `OpusHead`(あれば)。 */
  readonly description: Uint8Array | null;
}

export interface AudioApi {
  /** この設定で符号化できるか。 */
  supported(config: { sampleRate: number; numberOfChannels: number; bitrate: number }): Promise<boolean>;
  createEncoder(init: { output: (c: EncodedAudioOut) => void; error: (e: unknown) => void }): AudioEncoderLike;
  /** `samples` は `channels` 本を交互に並べた(インターリーブ)物。省略 = 1 本(mono)。 */
  makeData(samples: Float32Array, sampleRate: number, timestampUs: number, channels?: number): AudioDataLike;
}

/** この場所(ワーカー)で opus を符号化する道具。無ければ `null`。 */
export function nativeAudioApi(): AudioApi | null {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g['AudioEncoder'] !== 'function' || typeof g['AudioData'] !== 'function') return null;
  return {
    supported: async (c) => {
      try {
        const r = await AudioEncoder.isConfigSupported({ codec: 'opus', ...c });
        return r.supported === true;
      } catch {
        return false;
      }
    },
    createEncoder: (init) => {
      const enc = new AudioEncoder({
        output: (chunk, meta) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          const d = meta?.decoderConfig?.description;
          let description: Uint8Array | null = null;
          if (d !== undefined && d !== null) {
            description = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
          }
          init.output({ timestamp: chunk.timestamp, duration: chunk.duration ?? null, data, description });
        },
        error: init.error,
      });
      return {
        get encodeQueueSize(): number {
          return enc.encodeQueueSize;
        },
        configure: (config) => enc.configure(config),
        encode: (data) => enc.encode(data as AudioData),
        flush: () => enc.flush(),
        close: () => {
          if (enc.state !== 'closed') enc.close();
        },
      };
    },
    makeData: (samples, sampleRate, timestampUs, channels = 1) =>
      new AudioData({
        format: 'f32',
        sampleRate,
        numberOfFrames: samples.length / channels,
        numberOfChannels: channels,
        timestamp: timestampUs,
        data: samples as Float32Array<ArrayBuffer>,
      }),
  };
}

export const ENCODE_RATE = 48_000;
export const ENCODE_BITRATE = 64_000;
/** 1 回に `AudioData` にする長さ(1 秒)。 */
const CHUNK_SAMPLES = ENCODE_RATE;
/** 符号化の待ち行列の上限(これを超えたら待つ)。 */
const MAX_QUEUE = 8;

export type EncodeResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly durationMs: number }
  | { readonly ok: false; readonly reason: 'no-encoder' | 'empty' | 'encode-failed' };

/**
 * PCM(48kHz)を opus の WebM にする。⚠ 例外は投げず、理由を値で返す。
 * `channels` を 2 にすると、`pcm` は左右を交互に並べた物(L0 R0 L1 R1 …)として符号化する(音源分離の出力用。ビットレートも倍にする)。
 */
export async function encodeOpusWebm(
  pcm: Float32Array,
  api: AudioApi | null = nativeAudioApi(),
  channels = 1,
): Promise<EncodeResult> {
  if (api === null) return { ok: false, reason: 'no-encoder' };
  if (pcm.length === 0) return { ok: false, reason: 'empty' };
  const config = { sampleRate: ENCODE_RATE, numberOfChannels: channels, bitrate: ENCODE_BITRATE * channels };
  if (!(await api.supported(config))) return { ok: false, reason: 'no-encoder' };
  const packets: OpusPacket[] = [];
  let description: Uint8Array | null = null;
  let packetUs = 20_000;
  let error: unknown = null;
  const enc = api.createEncoder({
    output: (c) => {
      if (description === null && c.description !== null) description = c.description;
      if (c.duration !== null && c.duration > 0) packetUs = c.duration;
      // 🔑 写しを作る(符号化器の内部バッファを指さない)
      packets.push({ ms: c.timestamp * 1e-3, data: c.data.slice() });
    },
    error: (e) => {
      error = e;
    },
  });
  try {
    enc.configure({ codec: 'opus', ...config });
    const step = CHUNK_SAMPLES * channels;
    for (let at = 0; at < pcm.length && error === null; at += step) {
      // 待ち行列があふれないように待つ(背景のタブでも進むよう、短い時計で見張る)
      while (enc.encodeQueueSize > MAX_QUEUE && error === null) await new Promise((r) => setTimeout(r, 5));
      const part = pcm.subarray(at, Math.min(pcm.length, at + step));
      const data = api.makeData(part, ENCODE_RATE, Math.round(((at / channels) * 1e6) / ENCODE_RATE), channels);
      try {
        enc.encode(data);
      } finally {
        data.close(); // 🔑 渡したらすぐ破棄
      }
    }
    if (error === null) await enc.flush();
  } catch (e) {
    error = e;
  } finally {
    try {
      enc.close();
    } catch {
      /* 閉じられないなら諦める */
    }
  }
  if (error !== null || packets.length === 0) return { ok: false, reason: 'encode-failed' };
  const preSkip = (description === null ? null : preSkipOf(description)) ?? 312;
  const muxed = muxOpusWebm({ packets, channels, preSkip, packetMs: packetUs * 1e-3 });
  if (!muxed.ok) return { ok: false, reason: 'encode-failed' };
  return { ok: true, bytes: muxed.result.bytes, durationMs: muxed.result.durationMs };
}
