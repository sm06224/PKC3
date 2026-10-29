/**
 * 🔴 **音源分離の信号処理**(#674 / #949。歌声と楽器を分ける NN の前後)── 短時間フーリエ変換(STFT)と逆変換、再標本化。⚠ **pure**。
 *
 * 分離モデル(MDX-Net 系)は、**左右 2 チャンネルの STFT(実部・虚部)** を入力に取り、同じ形の「取り出したい音」の STFT を返す。
 * ここは**モデルの前後**だけを持つ(モデルそのものは `adapter/platform/stems/`)。式は PyTorch の `torch.stft` / `torch.istft`
 * (`center=True`、`pad_mode='reflect'`、ハン窓の周期版、正規化なし)と同じ。
 *
 * ## FFT
 * モデルの窓長は 2 のべきではない(6144 = 2^11・3、7680 = 2^9・3・5)ので、**基数 2・3・5 の混合基数**の FFT を持つ。
 * 左右 2 本の実信号は**1 回の複素 FFT**に詰める(`z = 左 + i・右`)── 変換の回数が半分になる。
 *
 * 🔑 **窓長と frame の数は式で決める**ので、実際の重みが無くても「恒等写像のモデル」で `stft → istft` の往復が元に戻ることを
 *   unit で確かめられる(`tests/features/stem-dsp.test.ts`)。
 */

/** 2・3・5 だけの因数に分ける。それ以外の素因数が残るなら `null`。 */
export function smoothFactors(n: number): number[] | null {
  if (!Number.isInteger(n) || n < 1) return null;
  const out: number[] = [];
  let m = n;
  for (const p of [2, 3, 5]) {
    while (m % p === 0) {
      out.push(p);
      m /= p;
    }
  }
  return m === 1 ? out : null;
}

/** 複素 FFT(基数 2・3・5 の混合基数。再帰の時間間引き)。⚠ 配列は呼び側が持ち、`forward` / `inverse` は**その場で**書き換える。 */
export class Fft {
  readonly n: number;
  private readonly factors: number[];
  private readonly twRe: Float64Array;
  private readonly twIm: Float64Array;
  private readonly sRe: Float64Array;
  private readonly sIm: Float64Array;
  private readonly tRe = new Float64Array(5);
  private readonly tIm = new Float64Array(5);

  constructor(n: number) {
    const f = smoothFactors(n);
    if (f === null) throw new Error(`FFT の長さ ${String(n)} は 2・3・5 の積ではありません`);
    this.n = n;
    this.factors = f;
    this.twRe = new Float64Array(n);
    this.twIm = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const a = (-2 * Math.PI * j) / n;
      this.twRe[j] = Math.cos(a);
      this.twIm[j] = Math.sin(a);
    }
    this.sRe = new Float64Array(n);
    this.sIm = new Float64Array(n);
  }

  /** 順変換(正規化なし)。 */
  forward(re: Float64Array, im: Float64Array): void {
    this.sRe.set(re);
    this.sIm.set(im);
    this.rec(this.sRe, this.sIm, 0, 1, re, im, 0, this.n, 0);
  }

  /** 逆変換(`1/n` をかける)。 */
  inverse(re: Float64Array, im: Float64Array): void {
    // 逆変換 = 共役 → 順変換 → 共役 → 1/n
    for (let i = 0; i < this.n; i++) im[i] = -im[i]!;
    this.forward(re, im);
    const k = 1 / this.n;
    for (let i = 0; i < this.n; i++) {
      re[i] = re[i]! * k;
      im[i] = -im[i]! * k;
    }
  }

  private rec(
    inRe: Float64Array,
    inIm: Float64Array,
    inOff: number,
    stride: number,
    outRe: Float64Array,
    outIm: Float64Array,
    outOff: number,
    n: number,
    level: number,
  ): void {
    if (n === 1) {
      outRe[outOff] = inRe[inOff]!;
      outIm[outOff] = inIm[inOff]!;
      return;
    }
    const p = this.factors[level]!;
    const m = n / p;
    for (let r = 0; r < p; r++) {
      this.rec(inRe, inIm, inOff + r * stride, stride * p, outRe, outIm, outOff + r * m, m, level + 1);
    }
    const N = this.n;
    const step = N / n; // この段の W_n^j = 全体の W_N^(j・step)
    const pStep = N / p; // W_p^j = W_N^(j・N/p)
    const tRe = this.tRe;
    const tIm = this.tIm;
    for (let k = 0; k < m; k++) {
      for (let r = 0; r < p; r++) {
        const idx = outOff + r * m + k;
        const w = (r * k * step) % N;
        const wr = this.twRe[w]!;
        const wi = this.twIm[w]!;
        const xr = outRe[idx]!;
        const xi = outIm[idx]!;
        tRe[r] = xr * wr - xi * wi;
        tIm[r] = xr * wi + xi * wr;
      }
      for (let q = 0; q < p; q++) {
        let sr = 0;
        let si = 0;
        for (let r = 0; r < p; r++) {
          const w = ((r * q) % p) * pStep;
          const wr = this.twRe[w]!;
          const wi = this.twIm[w]!;
          sr += tRe[r]! * wr - tIm[r]! * wi;
          si += tRe[r]! * wi + tIm[r]! * wr;
        }
        outRe[outOff + k + q * m] = sr;
        outIm[outOff + k + q * m] = si;
      }
    }
  }
}

/** 周期版のハン窓(`torch.hann_window(n)` と同じ)。 */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** モデルの STFT の設定。 */
export interface StftSpec {
  /** 窓長(2・3・5 の積)。 */
  readonly nFft: number;
  readonly hop: number;
  /** モデルへ渡す周波数の数(下から)。 */
  readonly dimF: number;
  /** モデルへ渡す frame の数。 */
  readonly dimT: number;
}

/** 1 回にモデルへ渡す音の長さ(標本数)。 */
export function chunkSamples(spec: StftSpec): number {
  return spec.hop * (spec.dimT - 1);
}

/** 反射で範囲外を折り返した標本(`torch.stft` の `pad_mode='reflect'`)。 */
function reflected(x: Float32Array, start: number, len: number, i: number): number {
  let j = i;
  if (j < 0) j = -j;
  if (j >= len) j = 2 * (len - 1) - j;
  if (j < 0 || j >= len) return 0;
  return x[start + j]!;
}

/**
 * 左右 2 本の音(長さは `chunkSamples`)を、モデルの入力へ変える。
 * 並びは `[4, dimF, dimT]`(チャンネルの順 = 左の実部・左の虚部・右の実部・右の虚部)。
 * `zeroBins` で下から数本の周波数を 0 にする(UVR の MDX は低域の 3 本を 0 にして渡す)。
 */
export function toModelInput(
  fft: Fft,
  window: Float64Array,
  spec: StftSpec,
  left: Float32Array,
  leftStart: number,
  right: Float32Array,
  rightStart: number,
  zeroBins: number,
  out: Float32Array,
): void {
  const { nFft, hop, dimF, dimT } = spec;
  const len = chunkSamples(spec);
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  const half = nFft / 2;
  for (let t = 0; t < dimT; t++) {
    const base = t * hop - half;
    for (let i = 0; i < nFft; i++) {
      const w = window[i]!;
      re[i] = w * reflected(left, leftStart, len, base + i);
      im[i] = w * reflected(right, rightStart, len, base + i);
    }
    fft.forward(re, im);
    for (let f = 0; f < dimF; f++) {
      const g = f === 0 ? 0 : nFft - f;
      const a = re[f]!;
      const b = im[f]!;
      const c = re[g]!;
      const d = im[g]!;
      // 左 = (Z[f] + conj Z[N-f]) / 2、右 = (Z[f] − conj Z[N-f]) / 2i
      const zero = f < zeroBins;
      out[(0 * dimF + f) * dimT + t] = zero ? 0 : (a + c) / 2;
      out[(1 * dimF + f) * dimT + t] = zero ? 0 : (b - d) / 2;
      out[(2 * dimF + f) * dimT + t] = zero ? 0 : (b + d) / 2;
      out[(3 * dimF + f) * dimT + t] = zero ? 0 : (c - a) / 2;
    }
  }
}

/**
 * モデルの出力(`[4, dimF, dimT]`)を、左右 2 本の音(長さ `chunkSamples`)へ戻す。
 * `dimF` より上の周波数は 0。重ね合わせは窓の 2 乗の和で割る(`torch.istft` と同じ)。
 */
export function fromModelOutput(
  fft: Fft,
  window: Float64Array,
  spec: StftSpec,
  data: Float32Array,
  outLeft: Float32Array,
  outRight: Float32Array,
): void {
  const { nFft, hop, dimF, dimT } = spec;
  const len = chunkSamples(spec);
  const half = nFft / 2;
  const accL = new Float64Array(len);
  const accR = new Float64Array(len);
  const env = new Float64Array(len);
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  for (let t = 0; t < dimT; t++) {
    re.fill(0);
    im.fill(0);
    for (let f = 0; f < dimF; f++) {
      const a0 = data[(0 * dimF + f) * dimT + t]!;
      const b0 = f === 0 ? 0 : data[(1 * dimF + f) * dimT + t]!;
      const a1 = data[(2 * dimF + f) * dimT + t]!;
      const b1 = f === 0 ? 0 : data[(3 * dimF + f) * dimT + t]!;
      // Z = X0 + i・X1(X0・X1 は実信号のスペクトル = 共役対称)
      re[f] = a0 - b1;
      im[f] = b0 + a1;
      if (f > 0) {
        re[nFft - f] = a0 + b1;
        im[nFft - f] = a1 - b0;
      }
    }
    fft.inverse(re, im);
    const base = t * hop - half;
    for (let i = 0; i < nFft; i++) {
      const pos = base + i;
      if (pos < 0 || pos >= len) continue;
      const w = window[i]!;
      accL[pos] = accL[pos]! + re[i]! * w;
      accR[pos] = accR[pos]! + im[i]! * w;
      env[pos] = env[pos]! + w * w;
    }
  }
  for (let i = 0; i < len; i++) {
    const e = env[i]!;
    outLeft[i] = e > 1e-11 ? accL[i]! / e : 0;
    outRight[i] = e > 1e-11 ? accR[i]! / e : 0;
  }
}

// ── 再標本化 ──────────────────────────────────────────────

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** 片側のゼロ交差の数(大きいほど精度が高く、遅い)。 */
const SINC_ZEROS = 12;

/**
 * 窓つき sinc の再標本化(`from` Hz → `to` Hz)。**縮める向き(`to < from`)は低域通過を併せて行う**。
 * 標本化率の比が小さな分数(44100:48000 = 147:160)なので、位相ごとの係数を表にして使う。
 */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x.slice();
  const g = gcd(from, to);
  const up = to / g;
  const down = from / g;
  const outLen = Math.floor((x.length * up) / down);
  const out = new Float32Array(outLen);
  // 縮める向きは新しいナイキストの手前(95%)に遷移帯を収める。広げる向きは元の帯域をそのまま通す
  const cutoff = from > to ? (to / from) * 0.95 : 1;
  const half = Math.ceil(SINC_ZEROS / cutoff);
  const taps = 2 * half + 1;
  // 位相 p(0..up-1)ごとの係数。出力 i の入力位置 = i・down/up = floor + frac(p/up)
  const table = new Float32Array(up * taps);
  for (let p = 0; p < up; p++) {
    const frac = ((p * down) % up) / up;
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const d = k - half - frac; // 入力標本の位置 − 出力の位置
      const s = d === 0 ? 1 : Math.sin(Math.PI * cutoff * d) / (Math.PI * cutoff * d);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / (half + 1)); // ハン窓
      const v = cutoff * s * (Math.abs(d) <= half ? w : 0);
      table[p * taps + k] = v;
      sum += v;
    }
    for (let k = 0; k < taps; k++) table[p * taps + k] = table[p * taps + k]! / sum; // 直流利得を 1 にそろえる
  }
  for (let i = 0; i < outLen; i++) {
    const p = i % up;
    const center = Math.floor((i * down) / up);
    const row = p * taps;
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      const j = center + k - half;
      if (j >= 0 && j < x.length) acc += x[j]! * table[row + k]!;
    }
    out[i] = acc;
  }
  return out;
}
