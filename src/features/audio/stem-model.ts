/**
 * 🔴 **歌声と楽器を分けるニューラルの音源分離**(#674 / #949)── 使うモデルの目録と、1 曲を分ける手順。⚠ **pure**。
 *
 * ## 何をするか
 * MDX-Net 系(UVR で広く使われる ONNX のモデル)を、**利用者のブラウザが公開の配布元から取得**して、使い捨てのワーカーで動かす。
 * モデルは「取り出したい音」(ここでは歌声)の STFT を返すので、もう一方(楽器)は **元 − 歌声** にする。
 *
 * ## ⚠ モデルの取得元について(`STEM_MODELS` の `urls`)
 * - 取得元は**ブラウザから CORS で取れる**公開ホスト(Hugging Face の `resolve` は `access-control-allow-origin: *`)。
 *   GitHub の release 資産は CORS を返さない(`asr-parts.ts` に 2026-08-14 の実測)ので使えない。
 * - 目録は**複数の取得元を順に試す**。どれにもつながらない・形が違うときは、**どこがなぜ駄目だったか**を画面に出す。
 * - ⚠ 重みの sha256 は、取得元が重みを差し替えうるので**固定しない**(`sha256: null`)。代わりに ONNX としての形・大きさの下限・
 *   ORT が読んだ入出力の形(`[*, 4, dimF, dimT]`)を検める(取り違え・途中で切れた物を止める)。固定したい日は `sha256` に入れる。
 * - ⚠ STFT の設定(`nFft` など)は**重みごとに決まっている**。モデルを替えるときはここの 1 か所を直す
 *   (設定が違うと出力は音にならない ── 入出力の形が合っても分からないので、実機で聞いて確かめる)。
 */
import {
  Fft,
  chunkSamples,
  fromModelOutput,
  hannWindow,
  resample,
  toModelInput,
  type StftSpec,
} from './stem-dsp';

/** モデルの標本化率。 */
export const STEM_RATE = 44_100;
/** 出力の opus の標本化率(符号化器が受ける率)。 */
export const STEM_OUT_RATE = 48_000;

/**
 * 分けられる録音の上限(ミリ秒)。⚠ 44.1kHz ステレオの float を丸ごと持つ(10 分で約 212MB)。
 * 同時に持つのは 入力(復号した左右)+ 歌声 + 楽器 +(再標本化した 1 本)で約 4 倍 ── 10 分で約 0.9GB になるので、ここで止める。
 */
export const STEM_MAX_MS = 10 * 60_000;

export interface StemModel {
  readonly id: string;
  /** 画面に出す名前。 */
  readonly label: string;
  /** 取得元(順に試す)。 */
  readonly urls: readonly string[];
  /** 画面に出す大きさの目安(byte)。 */
  readonly approxBytes: number;
  /** これ未満なら途中で切れた・別の物として断る(byte)。 */
  readonly minBytes: number;
  readonly sha256: string | null;
  readonly stft: StftSpec;
  /** 入力の下から数本の周波数を 0 にして渡す(UVR の MDX と同じ)。 */
  readonly zeroBins: number;
  /** モデルが返すのはどちらの音か。 */
  readonly primary: 'vocals' | 'instrumental';
}

/**
 * 目録。⚠ 重みと STFT の設定の組は 1 か所(ここ)。
 * `Kim_Vocal_2`(UVR の MDX-Net。歌声を取り出す。約 66MB)── 窓長 7680 / hop 1024 / 周波数 3072 / frame 256。
 */
export const STEM_MODELS: readonly StemModel[] = [
  {
    id: 'mdx-vocal',
    label: '歌声と楽器',
    urls: [
      'https://huggingface.co/seanghay/uvr_models/resolve/main/Kim_Vocal_2.onnx',
      'https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNET/Kim_Vocal_2.onnx',
    ],
    approxBytes: 66_000_000,
    minBytes: 20_000_000,
    sha256: null,
    stft: { nFft: 7680, hop: 1024, dimF: 3072, dimT: 256 },
    zeroBins: 3,
    primary: 'vocals',
  },
];

export function stemModelOf(id: string): StemModel | undefined {
  return STEM_MODELS.find((m) => m.id === id);
}

/** 取得元のホスト名(画面の理由に出す)。 */
export function stemHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 新しい音の名前に入れる語。 */
export function stemTags(model: StemModel): { readonly primary: string; readonly rest: string } {
  return model.primary === 'vocals'
    ? { primary: '歌声', rest: '楽器' }
    : { primary: '楽器', rest: '歌声' };
}

/** 1 回の推論。入力 `[1, 4, dimF, dimT]` を平らにした物 → 出力(同じ並び)。 */
export type StemInfer = (input: Float32Array) => Promise<Float32Array>;

export interface SeparateOptions {
  readonly model: StemModel;
  readonly infer: StemInfer;
  /** 何個目の塊まで終わったか。 */
  readonly onProgress?: (done: number, total: number) => void;
  /** 塊の合間に呼ぶ(中断・譲る用)。投げれば分離が止まる。 */
  readonly checkpoint?: () => Promise<void>;
}

/** 塊の数(進み具合の分母)。 */
export function stemChunkCount(samples: number, spec: StftSpec): number {
  const trim = spec.nFft / 2;
  const gen = chunkSamples(spec) - 2 * trim;
  // 混合の前に `trim`、後ろに `gen + trim − (samples mod gen)` の無音を足した長さを、`gen` ずつ進む
  return Math.floor((2 * trim + samples + gen - (samples % gen)) / gen);
}

/**
 * 1 曲(左右)を分ける。
 *
 * - 戻り値の `primary` はモデルが返した音(歌声)。
 * - ⚠ **`left` / `right` は書き換える**: 分け終えた所から「元 − 取り出した音」(= もう一方)で上書きする
 *   (入力・歌声・楽器の 3 組を同時に持たない ── ゼロコピー・即破棄)。呼び側は戻り値の `rest` を使い、元の配列は触らない。
 */
export async function separateStems(
  left: Float32Array,
  right: Float32Array,
  opts: SeparateOptions,
): Promise<{
  readonly primary: readonly [Float32Array, Float32Array];
  readonly rest: readonly [Float32Array, Float32Array];
}> {
  const spec = opts.model.stft;
  const n = Math.min(left.length, right.length);
  const chunk = chunkSamples(spec);
  const trim = spec.nFft / 2;
  const gen = chunk - 2 * trim;
  const total = stemChunkCount(n, spec);
  const fft = new Fft(spec.nFft);
  const window = hannWindow(spec.nFft);
  const input = new Float32Array(4 * spec.dimF * spec.dimT);
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  // 塊の入力 = 混合の `[i・gen − trim, i・gen − trim + chunk)`(外は 0)
  const sliceL = new Float32Array(chunk);
  const sliceR = new Float32Array(chunk);
  const pieceL = new Float32Array(chunk);
  const pieceR = new Float32Array(chunk);
  for (let i = 0; i < total; i++) {
    if (opts.checkpoint) await opts.checkpoint();
    const from = i * gen - trim;
    sliceL.fill(0);
    sliceR.fill(0);
    const a = Math.max(0, from);
    const b = Math.min(n, from + chunk);
    if (b > a) {
      sliceL.set(left.subarray(a, b), a - from);
      sliceR.set(right.subarray(a, b), a - from);
    }
    toModelInput(fft, window, spec, sliceL, 0, sliceR, 0, opts.model.zeroBins, input);
    const out = await opts.infer(input);
    if (out.length !== input.length) {
      throw new Error('モデルの出力の形が想定と違います(別のモデルか、設定が合っていません)');
    }
    fromModelOutput(fft, window, spec, out, pieceL, pieceR);
    // 取り出した音のうち、両端の `trim` を除いた `gen` が、混合の `[i・gen, i・gen + gen)` に当たる
    const dst = i * gen;
    const len = Math.min(gen, n - dst);
    if (len > 0) {
      outL.set(pieceL.subarray(trim, trim + len), dst);
      outR.set(pieceR.subarray(trim, trim + len), dst);
    }
    opts.onProgress?.(i + 1, total);
  }
  // 元 − 取り出した音(元の配列を上書きする)
  for (let i = 0; i < n; i++) {
    left[i] = left[i]! - outL[i]!;
    right[i] = right[i]! - outR[i]!;
  }
  return { primary: [outL, outR], rest: [left.subarray(0, n), right.subarray(0, n)] };
}

/**
 * 左右 2 本(44.1kHz)を、符号化器へ渡す形(48kHz、左右を交互に並べた 1 本)にする。
 * 🔑 再標本化した左右を作ってすぐ交互に詰める(途中の配列は関数を抜けた時点で手放される)。
 */
export function toEncoderPcm(left: Float32Array, right: Float32Array): Float32Array {
  const l = resample(left, STEM_RATE, STEM_OUT_RATE);
  const r = resample(right, STEM_RATE, STEM_OUT_RATE);
  const out = new Float32Array(l.length * 2);
  for (let i = 0; i < l.length; i++) {
    out[2 * i] = clamp(l[i]!);
    out[2 * i + 1] = clamp(r[i]!);
  }
  return out; // l / r はここで手放される
}

const clamp = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v);
