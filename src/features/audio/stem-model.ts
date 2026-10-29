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
 *
 * ## 🔴 正直に: 設定値は UVR の記録と**照合できていない**
 * `nFft` 7680 / `hop` 1024 / `dimF` 3072 / `dimT` 256 / `zeroBins` 3 / `compensate` 1.009 は、`Kim_Vocal_2` の UVR の
 * 設定(model_data.json)の**記憶**から書いた。開発の箱から配布元にも UVR の記録にも届かず、照合していない
 * (重みも取れていないので、本物の重みで歌声と楽器が分かれることは**未確認**)。
 *  - 守りは 3 つ: ①ORT が読んだ入力の形が `[*, 4, dimF, dimT]` と一致すること ②出力が有限で、歌声の大きさが元の 1.5 倍以下、
 *    残りのエネルギーが元以下であること(`separationProblem`)③画面の結果に「想定の設定で分けました。聞いて確かめてください」を出す。
 *  - `compensate` は歌声(取り出した音)にかける係数で、UVR の記録に確証が無い。外れていても大きさが 1% 動くだけだが、未確認である。
 *  - 窓・reflect・チャンネルの並び(左の実部・虚部・右の実部・虚部)は `tests/features/stem-dsp.test.ts` の既知値の fixture が固定している。
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

/**
 * 🔴 **試験的**であることの印(画面の字・取得の確認・設定の欄・マニュアルが、ここから引く)。
 *
 * 外す手順(再レビュー指摘。issue への記載は別):
 *  1. 本物の重み(`STEM_MODELS[].urls` の先)を取得して、実際に歌声と楽器が分かれて聞こえることを確かめる
 *     (設定値の `nFft` などの照合も、このとき UVR の記録と突き合わせる ── 下の「正直に」の節)。
 *  2. 確かめた重みの sha256 を `STEM_MODELS[].sha256` に埋める(中身を固定する)。
 *  3. `STEM_EXPERIMENTAL` を false にする ── 項目の字・確認・設定の欄・結果の知らせの「試験的」が、この 1 か所で消える
 *     (マニュアルの「試験的」の注記は手で外す)。
 */
export const STEM_EXPERIMENTAL = true;
/** 画面の字に添える語。 */
export const STEM_EXPERIMENTAL_TAG = STEM_EXPERIMENTAL ? '試験的' : '';
/** 括弧つき(`(試験的)`)。試験的でなければ空。 */
export const STEM_EXPERIMENTAL_SUFFIX = STEM_EXPERIMENTAL ? `(${STEM_EXPERIMENTAL_TAG})` : '';

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
  /** 取り出した音にかける係数(UVR の `compensate`。⚠ 記録に確証が無い ── 上の注記)。 */
  readonly compensate: number;
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
    compensate: 1.009,
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

/** モデルの出力が想定と違う(形・有限性)。⚠ 計算資源の失敗(`infer-failed`)とは別 ── 重み・設定の不良として断る。 */
export class StemModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StemModelError';
  }
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
  /** 真ん中の塊で測った、モデルの出力の STFT としての一貫性の誤差(0 = 完全に一貫)。測れなかったら `null`。 */
  readonly consistency: number | null;
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
  let consistency: number | null = null;
  const probeChunk = Math.floor(total / 2);
  const scratch = new Float32Array(4 * spec.dimF * spec.dimT);
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
      throw new StemModelError('モデルの出力の形が想定と違います(別のモデルか、設定が合っていません)');
    }
    // 🔴 出力が有限であること(NaN / Infinity が 1 つでも混ざると、逆変換で全体に広がる)
    for (let k = 0; k < out.length; k++) {
      if (!Number.isFinite(out[k]!)) throw new StemModelError('モデルの出力に数でない値(NaN / 無限大)が含まれています');
    }
    fromModelOutput(fft, window, spec, out, pieceL, pieceR);
    if (i === probeChunk) consistency = inconsistencyOf(fft, window, spec, out, pieceL, pieceR, scratch);
    // 取り出した音のうち、両端の `trim` を除いた `gen` が、混合の `[i・gen, i・gen + gen)` に当たる
    const dst = i * gen;
    const len = Math.min(gen, n - dst);
    if (len > 0) {
      outL.set(pieceL.subarray(trim, trim + len), dst);
      outR.set(pieceR.subarray(trim, trim + len), dst);
    }
    opts.onProgress?.(i + 1, total);
  }
  // 元 − 取り出した音(元の配列を上書きする)。取り出した音には `compensate` をかけてから引く
  const k = opts.model.compensate;
  for (let i = 0; i < n; i++) {
    const pl = outL[i]! * k;
    const pr = outR[i]! * k;
    outL[i] = pl;
    outR[i] = pr;
    left[i] = left[i]! - pl;
    right[i] = right[i]! - pr;
  }
  return { primary: [outL, outR], rest: [left.subarray(0, n), right.subarray(0, n)], consistency };
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

/**
 * 🔴 **モデルの出力が「ひとつの音の STFT」として成り立っているか**(一貫性の誤差)。
 * 出力 X を逆変換して音に戻し、同じ設定でもう一度分析した X' との差 ‖X − X'‖ / ‖X‖。
 *  - 設定(窓長など)が合っていれば小さい。恒等写像のモデルで 0。
 *  - 窓長が違う設定の出力は、ひとつの音の STFT にならないので大きい(実測: 窓長 72 の出力 0.64〜0.66 / 窓長 144 の出力 0.89〜0.91。
 *    `tests/features/stem-model.test.ts`)。
 * ⚠ 本物のモデルの出力が普通どれくらい一貫しているかは**未測定**(重みが無い)。だから `STEM_MAX_INCONSISTENCY` は
 *   「明らかに壊れている」側に置く(0.7)── 窓長の取り違えでも 0.64 台は通る。通るものは、聞いて確かめてもらう。
 */
function inconsistencyOf(
  fft: Fft,
  window: Float64Array,
  spec: StftSpec,
  modelOut: Float32Array,
  pieceL: Float32Array,
  pieceR: Float32Array,
  scratch: Float32Array,
): number | null {
  toModelInput(fft, window, spec, pieceL, 0, pieceR, 0, 0, scratch);
  let diff = 0;
  let energy = 0;
  for (let k = 0; k < modelOut.length; k++) {
    const d = scratch[k]! - modelOut[k]!;
    diff += d * d;
    energy += modelOut[k]! * modelOut[k]!;
  }
  return energy > 1e-9 ? Math.sqrt(diff / energy) : null;
}

/** 一貫性の誤差がこれを超えたら断る(上の注記: 明らかに壊れている側。本物のモデルで測り直して詰める)。 */
export const STEM_MAX_INCONSISTENCY = 0.7;

/** 歌声が元の何倍まで許すか。⚠ 取り出した音は元より大きくならないはず ── 超えるのは設定違い・別のモデルの出力。 */
export const STEM_MAX_GAIN = 1.5;

const rmsOf2 = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]! + b[i]! * b[i]!;
  return Math.sqrt(s / Math.max(1, a.length * 2));
};

/**
 * 🔴 **分けた結果が音として成り立っているか**(理由の文字列。成り立っていれば `null`)。
 *  - 全標本が有限であること
 *  - 取り出した音(歌声)の RMS が元の `STEM_MAX_GAIN` 倍以下
 *  - 残り(楽器 = 元 − 歌声)のエネルギーが元以下(設定違いだと、引いた結果が元より大きくなる)
 *  - 出力の STFT としての一貫性の誤差が `STEM_MAX_INCONSISTENCY` 以下(窓長の取り違えを見る。上の実測)
 * ⚠ これは「設定が合っているか」の**十分条件ではない**(合っていなくても通りうる)── 通らないものだけを止める安全弁。
 */
export function separationProblem(
  inputRms: number,
  primary: readonly [Float32Array, Float32Array],
  rest: readonly [Float32Array, Float32Array],
  consistency: number | null = null,
): string | null {
  for (const arr of [primary[0], primary[1], rest[0], rest[1]]) {
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i]!)) return '分けた結果に数でない値(NaN / 無限大)が含まれています';
    }
  }
  const p = rmsOf2(primary[0], primary[1]);
  if (p > inputRms * STEM_MAX_GAIN) {
    return `取り出した音が元より大きすぎます(元の ${(p / inputRms).toFixed(1)} 倍。別のモデルか、設定が合っていません)`;
  }
  const r = rmsOf2(rest[0], rest[1]);
  if (r > inputRms) return '残りの音が元より大きくなりました(別のモデルか、設定が合っていません)';
  if (consistency !== null && consistency > STEM_MAX_INCONSISTENCY) {
    return `モデルの出力が音として成り立っていません(一貫性の誤差 ${consistency.toFixed(2)}。ウィンドウ長などの設定が合っていません)`;
  }
  return null;
}

/** 左右の RMS(2 本まとめた値)。分ける前に測る(分けると元の配列は上書きされる)。 */
export function stereoRms(left: Float32Array, right: Float32Array): number {
  return rmsOf2(left, right);
}
