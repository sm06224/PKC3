/**
 * 🔴 **録音 1 件の波形の山を出す**(#1232)。
 *
 * ## 分担
 *
 * - 復号 = **メインスレッド**の `OfflineAudioContext.decodeAudioData`(音の出口を持たない版。どちらもワーカーに無い。
 *   復号そのものはブラウザの内部で非同期に走る ── `asr-decode.ts` と同じ)。
 *   ⚠ **8kHz で作る**と再標本化されて PCM が小さくなる(16kHz 比 1/2)。波形は粗くてよい。
 * - 山の計算 = **ワーカー**(`WaveClient`)。PCM は転送で渡し、メインには残さない。
 * - 残るのは**山の配列だけ**(最大 1000 個 × 4 バイト)。⚠ メモリ上のみ・上限 `WAVE_CACHE_MAX` 件。
 *
 * ⚠ 読めない音は `null`(帯を出さない)。例外にしない ── 波形は添え物で、聞く・切り出すを止めない。
 */
import { WaveClient } from './wave-client';

export const WAVE_SAMPLE_RATE = 8000;
export const WAVE_CACHE_MAX = 24;
/**
 * 復号する添付の大きさの上限(手違いの検出であって、守らせる規律ではない ── 通常の増加なら上げてよい)。
 * 🔴 **1 本の録音の上限(`CAPTURE_PART_BYTES` = 250MB)に合わせた**(台帳 #1852 O1 / 依頼 356 A。Gemini 回答 = 推薦どおり)。
 *   直す前は 48MB(約 80 分)で、1〜2 時間の会議の録音で波形が出なかった。PKC3 の録音は約 10KB/秒なので 250MB で約 7 時間。
 * ⚠ **復号後のメモリは未測定**(8kHz の Float32 でチャンネルごとに約 32KB/秒 ── 7 時間のステレオなら約 1.6GB と見積もるだけ)。
 *   端末で問題が出たら、ここを下げる(復号に失敗したときは `null` = 帯を出さないだけで、聞く・切り出すは止まらない)。
 */
export const WAVE_MAX_BLOB_BYTES = 250 * 1024 * 1024;

export interface WavePeaks {
  readonly peaks: Float32Array;
  readonly durationMs: number;
}

export interface WaveProvider {
  load(assetKey: string, blob: Blob, points: number): Promise<WavePeaks | null>;
}

interface DecodeContext {
  decodeAudioData(buf: ArrayBuffer): Promise<{
    readonly numberOfChannels: number;
    readonly duration: number;
    getChannelData(i: number): Float32Array;
  }>;
  close(): Promise<void>;
}

function defaultCreate(): DecodeContext | null {
  /**
   * 🔴 **`OfflineAudioContext` で復号する**(`AudioContext` ではない)── 音の出口を持たないので、
   *   再生の経路(聞きやすくする = `AudioContext` の鎖)と数も資源も混ざらず、`close()` も要らない。
   *   長さ 1 は「復号の器」としての最小(`decodeAudioData` は長さに依らず元の長さで返す)。
   */
  const g = globalThis as unknown as {
    OfflineAudioContext?: new (channels: number, length: number, sampleRate: number) => {
      decodeAudioData: DecodeContext['decodeAudioData'];
    };
  };
  const Ctor = g.OfflineAudioContext;
  if (Ctor === undefined) return null;
  const ctx = new Ctor(1, 1, WAVE_SAMPLE_RATE);
  return { decodeAudioData: (buf) => ctx.decodeAudioData(buf), close: async () => undefined };
}

export interface WaveSourceOptions {
  readonly client?: WaveClient;
  readonly create?: () => DecodeContext | null;
}

export class WaveSource implements WaveProvider {
  private readonly client: WaveClient;
  private readonly create: () => DecodeContext | null;
  /** 挿入順 = 古い順(Map)。⚠ 引いたら入れ直して新しい側へ。 */
  private readonly cache = new Map<string, WavePeaks>();
  /** 同じ録音の二重復号を避ける(押し直し・面が 2 つ)。 */
  private readonly inflight = new Map<string, Promise<WavePeaks | null>>();

  constructor(options: WaveSourceOptions = {}) {
    this.client = options.client ?? new WaveClient();
    this.create = options.create ?? defaultCreate;
  }

  get cached(): number {
    return this.cache.size;
  }

  load(assetKey: string, blob: Blob, points: number): Promise<WavePeaks | null> {
    const key = `${assetKey}|${String(points)}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve(hit);
    }
    const running = this.inflight.get(key);
    if (running !== undefined) return running;
    const p = this.compute(blob, points).then((r) => {
      this.inflight.delete(key);
      if (r !== null) {
        this.cache.set(key, r);
        while (this.cache.size > WAVE_CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
      }
      return r;
    });
    this.inflight.set(key, p);
    return p;
  }

  private async compute(blob: Blob, points: number): Promise<WavePeaks | null> {
    // 🔴 大きすぎる物は復号しない(手違いの検出。PKC3 の録音は約 10KB/秒なので 48MB で約 80 分。上げてよい)
    if (blob.size > WAVE_MAX_BLOB_BYTES) return null;
    const ctx = this.create();
    if (ctx === null) return null;
    try {
      let decoded: Awaited<ReturnType<DecodeContext['decodeAudioData']>> | null = await ctx.decodeAudioData(
        await blob.arrayBuffer(),
      );
      const durationMs = Math.round(decoded.duration * 1000);
      /**
       * 🔑 **1 本に畳んでから転送する**(山はチャンネルの最大ではなく平均で足りる)。
       * ⚠ AudioBuffer の配列は譲らない(`getChannelData` は AudioBuffer の持ち物)── 写した 1 本だけを転送する。
       *   写し終えたら `decoded` を手放す(復号の結果と写しを同時に持ち続けない)。
       */
      const mono = downmix(decoded);
      decoded = null;
      const peaks = await this.client.peaks([mono], points);
      return { peaks, durationMs };
    } catch {
      return null;
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
}

/** チャンネルを平均して 1 本の新しい配列にする(チャンネルは 1 本ずつ読み、写しを溜めない)。 */
function downmix(d: { readonly numberOfChannels: number; getChannelData(i: number): Float32Array }): Float32Array {
  const k = d.numberOfChannels;
  if (k <= 0) return new Float32Array(0);
  if (k === 1) return d.getChannelData(0).slice();
  const first = d.getChannelData(0);
  const out = new Float32Array(first.length);
  for (let c = 0; c < k; c++) {
    const data = d.getChannelData(c);
    const n = Math.min(out.length, data.length);
    for (let j = 0; j < n; j++) out[j]! += data[j]! / k;
  }
  return out;
}

/** アプリ共有の 1 個(遅延 ── 使うまでワーカーは作られない)。 */
export const appWaveSource = new WaveSource();
