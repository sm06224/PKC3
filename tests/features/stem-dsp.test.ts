/** @vitest-environment node */
/**
 * 音源分離の信号処理(#674 / #949)。
 *
 * 守りたい主張:
 *  ① 🔴 混合基数 FFT が**素朴な DFT と一致する**(2・3・5 の各段を通る長さで。実際の窓長 6144 / 7680 も)
 *  ② 🔴 モデルを**恒等写像**にしたとき、`toModelInput → fromModelOutput` が元の音へ戻る
 *     (重みが無くても前後の式の誤りを検出できる ── 窓・中央寄せ・左右の詰め方・重ね合わせの割り算)
 *  ③ 再標本化: 正弦波の周波数が保たれ、長さが比に合う / 縮める向きは折り返しを入れない
 */
import { describe, expect, it } from 'vitest';
import {
  Fft,
  chunkSamples,
  fromModelOutput,
  hannWindow,
  resample,
  smoothFactors,
  toModelInput,
  type StftSpec,
} from '../../src/features/audio/stem-dsp';

/** 決まった乱数(再現できる fixture)。 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000 - 0.5;
  };
}

describe('混合基数 FFT', () => {
  it.each([1, 2, 3, 5, 6, 12, 30, 60, 96, 150])('長さ %i は素朴な DFT と一致する', (n) => {
    const r = rng(n);
    const xr = Float64Array.from({ length: n }, () => r());
    const xi = Float64Array.from({ length: n }, () => r());
    const re = xr.slice();
    const im = xi.slice();
    new Fft(n).forward(re, im);
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      for (let j = 0; j < n; j++) {
        const a = (-2 * Math.PI * ((j * k) % n)) / n;
        sr += xr[j]! * Math.cos(a) - xi[j]! * Math.sin(a);
        si += xr[j]! * Math.sin(a) + xi[j]! * Math.cos(a);
      }
      expect(Math.abs(re[k]! - sr)).toBeLessThan(1e-9);
      expect(Math.abs(im[k]! - si)).toBeLessThan(1e-9);
    }
  });

  it('実際の窓長(6144 = 2^11・3、7680 = 2^9・3・5)でも往復で元に戻る', () => {
    for (const n of [6144, 7680]) {
      const r = rng(n);
      const xr = Float64Array.from({ length: n }, () => r());
      const xi = Float64Array.from({ length: n }, () => r());
      const re = xr.slice();
      const im = xi.slice();
      const f = new Fft(n);
      f.forward(re, im);
      // 空振り防止: 変換後は元と違う
      expect(Math.abs(re[1]! - xr[1]!)).toBeGreaterThan(1e-3);
      f.inverse(re, im);
      for (let i = 0; i < n; i += 97) {
        expect(Math.abs(re[i]! - xr[i]!)).toBeLessThan(1e-9);
        expect(Math.abs(im[i]! - xi[i]!)).toBeLessThan(1e-9);
      }
    }
  });

  it('2・3・5 以外の素因数を持つ長さは断る', () => {
    expect(smoothFactors(7)).toBeNull();
    expect(() => new Fft(14)).toThrow();
    expect(smoothFactors(7680)).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 5]);
  });
});

function roundTrip(spec: StftSpec, zeroBins = 0): { max: number; refMax: number } {
  const len = chunkSamples(spec);
  const r = rng(7);
  const left = Float32Array.from({ length: len }, () => r());
  const right = Float32Array.from({ length: len }, () => r() * 0.5);
  const fft = new Fft(spec.nFft);
  const win = hannWindow(spec.nFft);
  const spectrum = new Float32Array(4 * spec.dimF * spec.dimT);
  toModelInput(fft, win, spec, left, 0, right, 0, zeroBins, spectrum);
  const outL = new Float32Array(len);
  const outR = new Float32Array(len);
  fromModelOutput(fft, win, spec, spectrum, outL, outR);
  let max = 0;
  let refMax = 0;
  for (let i = 0; i < len; i++) {
    max = Math.max(max, Math.abs(outL[i]! - left[i]!), Math.abs(outR[i]! - right[i]!));
    refMax = Math.max(refMax, Math.abs(left[i]!));
  }
  return { max, refMax };
}

describe('STFT → 逆 STFT(恒等写像のモデル)', () => {
  it('小さな設定: 全周波数を渡せば元の音に戻る(端の標本まで)', () => {
    const { max, refMax } = roundTrip({ nFft: 96, hop: 16, dimF: 49, dimT: 33 });
    expect(refMax, '空振り防止(信号が 0 ではない)').toBeGreaterThan(0.4);
    expect(max).toBeLessThan(1e-4);
  });

  it('🔴 実際の MDX の設定(窓 7680 / hop 1024 / dimF 3072 / dimT 256): 上を切った分(3072 以上)だけ違う、乱数ではなく低域は戻る', () => {
    // 白色雑音は高域にも energy があるので dimF で切ると戻らない ── 戻るのは「切った後の成分」。
    // ここでは設定の整合(窓・frame 数・重ね合わせ)の確認として、低域だけの信号で往復する。
    const spec: StftSpec = { nFft: 7680, hop: 1024, dimF: 3072, dimT: 256 };
    const len = chunkSamples(spec);
    expect(len).toBe(261_120);
    const left = new Float32Array(len);
    const right = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      left[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.5;
      right[i] = Math.sin((2 * Math.PI * 1234 * i) / 44100) * 0.25;
    }
    const fft = new Fft(spec.nFft);
    const win = hannWindow(spec.nFft);
    const spectrum = new Float32Array(4 * spec.dimF * spec.dimT);
    toModelInput(fft, win, spec, left, 0, right, 0, 0, spectrum);
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);
    fromModelOutput(fft, win, spec, spectrum, outL, outR);
    // 中ほどは厳密に戻る。両端だけは、周波数を dimF で切った分の小さな差が出る(実測 3e-3)
    let inner = 0;
    let all = 0;
    for (let i = 0; i < len; i += 13) {
      const e = Math.max(Math.abs(outL[i]! - left[i]!), Math.abs(outR[i]! - right[i]!));
      all = Math.max(all, e);
      if (i > 12_000 && i < len - 12_000) inner = Math.max(inner, e);
    }
    expect(inner).toBeLessThan(1e-5);
    expect(all).toBeLessThan(8e-3);
    // 空振り防止: 変換後の中身が 0 ではない
    expect(spectrum.some((v) => Math.abs(v) > 1)).toBe(true);
  });

  it('窓 6144(UVR-MDX-NET-Inst_HQ 系)でも往復する', () => {
    const { max } = roundTrip({ nFft: 6144, hop: 1024, dimF: 3073, dimT: 24 });
    expect(max).toBeLessThan(1e-3);
  });

  it('左右を取り違えない(左だけ鳴る入力は、右の出力が 0)', () => {
    const spec: StftSpec = { nFft: 96, hop: 16, dimF: 49, dimT: 17 };
    const len = chunkSamples(spec);
    const left = Float32Array.from({ length: len }, (_, i) => Math.sin(i / 3));
    const right = new Float32Array(len);
    const fft = new Fft(spec.nFft);
    const win = hannWindow(spec.nFft);
    const s = new Float32Array(4 * spec.dimF * spec.dimT);
    toModelInput(fft, win, spec, left, 0, right, 0, 0, s);
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);
    fromModelOutput(fft, win, spec, s, outL, outR);
    expect(Math.max(...outR.map(Math.abs))).toBeLessThan(1e-5);
    expect(Math.max(...outL.map(Math.abs))).toBeGreaterThan(0.5);
  });

  it('zeroBins: 下から数本の周波数が 0 で渡る(UVR の MDX と同じ)', () => {
    const spec: StftSpec = { nFft: 96, hop: 16, dimF: 49, dimT: 17 };
    const len = chunkSamples(spec);
    const x = Float32Array.from({ length: len }, (_, i) => Math.sin(i / 2));
    const fft = new Fft(spec.nFft);
    const win = hannWindow(spec.nFft);
    const s = new Float32Array(4 * spec.dimF * spec.dimT);
    toModelInput(fft, win, spec, x, 0, x, 0, 3, s);
    for (let c = 0; c < 4; c++) for (let f = 0; f < 3; f++) for (let t = 0; t < spec.dimT; t++) expect(s[(c * spec.dimF + f) * spec.dimT + t]).toBe(0);
    expect(s.some((v) => v !== 0)).toBe(true);
  });
});

describe('再標本化', () => {
  const peakHz = (x: Float32Array, rate: number): number => {
    // 零交差の数から周波数を見積もる
    let z = 0;
    for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 !== x[i]! < 0) z++;
    return (z / 2) * (rate / x.length);
  };

  it('44100 → 48000: 長さが比に合い、周波数が保たれる', () => {
    const n = 44100;
    const x = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / 44100));
    const y = resample(x, 44100, 48000);
    expect(y.length).toBe(48000);
    expect(peakHz(y.subarray(100, y.length - 100), 48000)).toBeGreaterThan(990);
    expect(peakHz(y.subarray(100, y.length - 100), 48000)).toBeLessThan(1010);
    // 振幅も保たれる
    let m = 0;
    for (let i = 200; i < y.length - 200; i++) m = Math.max(m, Math.abs(y[i]!));
    expect(m).toBeGreaterThan(0.98);
    expect(m).toBeLessThan(1.02);
  });

  it('48000 → 44100: 低域通過が効く(新しいナイキスト 22.05kHz を超える 23.5kHz は小さくなる。対照群: 1kHz は残る)', () => {
    const n = 48000;
    const hi = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 23500 * i) / 48000));
    const lo = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / 48000));
    const peak = (a: Float32Array): number => a.subarray(300, a.length - 300).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak(resample(hi, 48000, 44100))).toBeLessThan(0.1);
    expect(peak(resample(lo, 48000, 44100))).toBeGreaterThan(0.95);
  });

  it('同じ率は写しを返す(元の配列を共有しない)', () => {
    const x = new Float32Array([1, 2, 3]);
    const y = resample(x, 48000, 48000);
    expect(y).toEqual(x);
    expect(y).not.toBe(x);
  });
});
