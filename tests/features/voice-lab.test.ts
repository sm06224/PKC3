// @vitest-environment node
/**
 * 🔴 **声の仕上げの計算**(#952 B1 / #674 / B5)── 本物の RNNoise(wasm)で回す。
 *
 * 🔑 空振り防止:
 *  - 遅れの補正は「出力を入力と相互相関して、ずれが 0 に立つ」で見る(補正を外すと 960 に立つ ── 変異試験で確かめる)
 *  - 雑音の低減は「声が無い区間の RMS」で見る(対照:声の区間は残る)
 */
import { describe, expect, it } from 'vitest';
import {
  boxSmooth,
  hasVoice,
  VAD_MIN_FRAMES,
  VAD_WARMUP_FRAMES,
  ENGINE_DELAY,
  levelSegments,
  peakOf,
  residualOf,
  rmsOf,
  runEngine,
  softLimit,
  VOICE_FRAME,
  VOICE_RATE,
} from '../../src/features/audio/voice-lab';
import { concat, mix, realEngine, synthVoice, whiteNoise } from '../helpers/rnnoise-engine';

/** `x[i]` と `y[i + lag]` の相互相関が最大になるずれ(標本)。 */
function bestLag(x: Float32Array, y: Float32Array, from: number, to: number, maxLag: number): number {
  let best = 0;
  let bestC = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    let c = 0;
    for (let i = from; i < to; i += 1) c += x[i]! * (y[i + lag] ?? 0);
    if (c > bestC) {
      bestC = c;
      best = lag;
    }
  }
  return best;
}

describe('エンジンに通す(runEngine。本物の RNNoise)', () => {
  const voice = synthVoice(3);
  it('🔴 出力は入力と同じ長さ・同じ時刻(20ms の遅れを取り除いてある)', async () => {
    const engine = await realEngine();
    try {
      const { clean, vad } = runEngine(voice, engine);
      expect(clean.length).toBe(voice.length);
      expect(vad.length).toBe(Math.ceil(voice.length / VOICE_FRAME));
      // 前提(空振り防止):生の出力を素直に並べると 960 標本遅れている ── 同じ入力を遅れ補正なしで通して確かめる
      const raw = new Float32Array(voice.length + ENGINE_DELAY);
      const e2 = await realEngine();
      const frame = new Float32Array(VOICE_FRAME);
      for (let o = 0; o + VOICE_FRAME <= raw.length; o += VOICE_FRAME) {
        for (let i = 0; i < VOICE_FRAME; i += 1) frame[i] = (voice[o + i] ?? 0) * 32768;
        e2.process(frame);
        for (let i = 0; i < VOICE_FRAME; i += 1) raw[o + i] = frame[i]! / 32768;
      }
      e2.destroy();
      expect(bestLag(voice, raw, 24_000, 120_000, 1500), '前提: 生の出力が遅れていない').toBe(ENGINE_DELAY);
      expect(bestLag(voice, clean, 24_000, 120_000, 1500), '遅れが残っている').toBe(0);
    } finally {
      engine.destroy();
    }
  });

  it('🔴 声の無い区間の雑音を 20dB 以上減らし、声の区間は残す。声らしさ(vad)は声の区間でだけ高い', async () => {
    const engine = await realEngine();
    try {
      const sec = VOICE_RATE;
      const noisy = mix(concat(synthVoice(2), new Float32Array(2 * sec)), whiteNoise(4 * sec, 0.03));
      const { clean, vad } = runEngine(noisy, engine);
      const before = rmsOf(noisy, 3 * sec, 4 * sec);
      const after = rmsOf(clean, 3 * sec, 4 * sec);
      expect(before, '前提: 入力に雑音が入っている').toBeGreaterThan(0.015);
      expect(20 * Math.log10(before / after), '雑音が減っていない(dB)').toBeGreaterThan(20);
      // 声の区間:エネルギーの 7 割以上が残る
      const kept = (rmsOf(clean, sec * 0.5, 2 * sec) / rmsOf(noisy, sec * 0.5, 2 * sec)) ** 2;
      expect(kept, '声まで消している').toBeGreaterThan(0.7);
      const avg = (a: number, b: number): number => {
        let s = 0;
        for (let k = a; k < b; k += 1) s += vad[k]!;
        return s / (b - a);
      };
      expect(avg(60, 190), '声の区間の vad が低い').toBeGreaterThan(0.6);
      expect(avg(320, 390), '無音の区間の vad が高い').toBeLessThan(0.2);
    } finally {
      engine.destroy();
    }
  });

  it('入力が 1 枠に満たなくても、末尾が枠に割り切れなくても、長さを保つ', async () => {
    const engine = await realEngine();
    try {
      for (const n of [1, 479, 480, 481, 1000]) {
        const r = runEngine(whiteNoise(n, 0.1), engine);
        expect(r.clean.length).toBe(n);
        expect(r.vad.length).toBe(Math.ceil(n / VOICE_FRAME));
      }
      expect(runEngine(new Float32Array(0), engine).clean.length).toBe(0);
    } finally {
      engine.destroy();
    }
  });
});

describe('声以外(residualOf)', () => {
  it('元 = 声 + 声以外(足せば元に戻る)', () => {
    const pcm = Float32Array.from([0.1, -0.2, 0.3, 0.5]);
    const clean = Float32Array.from([0.05, -0.2, 0.1, 0.5]);
    const rest = residualOf(pcm, clean);
    expect(Array.from(rest).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0.05, 0, 0.2, 0]);
    for (let i = 0; i < pcm.length; i += 1) expect(clean[i]! + rest[i]!).toBeCloseTo(pcm[i]!, 6);
  });
});

describe('声の大きさをそろえる(levelSegments)', () => {
  const RATE = 8000;
  /** [大きさ, 秒] を並べた PCM と区間。 */
  const build = (parts: ReadonlyArray<readonly [number, number]>, gapSec = 0.5) => {
    const chunks: Float32Array[] = [];
    const spans: { start: number; end: number }[] = [];
    let at = 0;
    for (const [level, sec] of parts) {
      const n = Math.round(sec * RATE);
      const v = new Float32Array(n);
      for (let i = 0; i < n; i += 1) v[i] = level * Math.sqrt(2) * Math.sin((2 * Math.PI * 200 * i) / RATE); // RMS = level
      spans.push({ start: at, end: at + n });
      chunks.push(v);
      at += n;
      const g = new Float32Array(Math.round(gapSec * RATE));
      chunks.push(g);
      at += g.length;
    }
    return { pcm: concat(...chunks), spans };
  };

  it('🔴 遠い人(小さい)も近い人(大きい)も、目標の大きさへ寄る', () => {
    const { pcm, spans } = build([
      [0.02, 3], // 遠い人
      [0.25, 3], // 近い人
    ]);
    const out = levelSegments(pcm, spans, RATE);
    const far = rmsOf(out, spans[0]!.start + 800, spans[0]!.end - 800);
    const near = rmsOf(out, spans[1]!.start + 800, spans[1]!.end - 800);
    const farIn = rmsOf(pcm, spans[0]!.start + 800, spans[0]!.end - 800);
    // 前提:入力は 10 倍以上離れている
    expect(rmsOf(pcm, spans[1]!.start, spans[1]!.end) / farIn).toBeGreaterThan(10);
    expect(far).toBeGreaterThan(0.05);
    expect(far).toBeLessThan(0.09);
    expect(near).toBeGreaterThan(0.05);
    expect(near).toBeLessThan(0.09);
    expect(out.length).toBe(pcm.length);
  });

  it('倍率には上限がある(小さすぎる区間を無限に持ち上げない)。ほぼ無音の区間は触らない', () => {
    const { pcm, spans } = build([[0.001, 2]]);
    const out = levelSegments(pcm, spans, RATE);
    expect(rmsOf(out, 800, 15_000) / rmsOf(pcm, 800, 15_000)).toBeLessThanOrEqual(10.01);
    const silent = build([[0.00005, 2]]);
    const out2 = levelSegments(silent.pcm, silent.spans, RATE);
    expect(rmsOf(out2) / rmsOf(silent.pcm)).toBeCloseTo(1, 2);
  });

  it('🔴 区間の境で倍率が飛ばない(一定の値を通して、倍率そのものの変わり方を見る)', () => {
    // 区間 1 は 0.02、区間 2 は 0.2 の一定値(RMS = 値)。倍率 = 出力 / 入力
    const n = RATE * 2;
    const pcm = new Float32Array(n * 2);
    pcm.fill(0.02, 0, n);
    pcm.fill(0.2, n);
    const out = levelSegments(pcm, [{ start: 0, end: n }, { start: n, end: n * 2 }], RATE);
    const gain = (i: number): number => out[i]! / pcm[i]!;
    expect(gain(n / 2), '前提: 区間 1 は持ち上げる').toBeGreaterThan(3);
    expect(gain(n + n / 2), '前提: 区間 2 は下げる').toBeLessThan(0.5);
    let maxStep = 0;
    for (let i = 1; i < n * 2; i += 1) maxStep = Math.max(maxStep, Math.abs(gain(i) - gain(i - 1)));
    // 段差のままなら 1 標本で 3 以上飛ぶ。80ms(640 標本)でならしてあれば 1 標本の変わり方は 0.01 より小さい
    expect(maxStep).toBeLessThan(0.01);
  });

  it('割れない(出力は ±1 の内側)・区間が無ければ倍率 1', () => {
    const { pcm, spans } = build([[0.5, 1]]);
    const loud = levelSegments(Float32Array.from(pcm, (v) => v * 3), spans, RATE, { targetRms: 0.9 });
    expect(peakOf(loud)).toBeLessThanOrEqual(1);
    const none = levelSegments(pcm, [], RATE);
    expect(Array.from(none.slice(100, 110))).toEqual(Array.from(pcm.slice(100, 110)));
    expect(softLimit(0.5)).toBe(0.5);
    expect(Math.abs(softLimit(5))).toBeLessThanOrEqual(1);
    expect(softLimit(-5)).toBeLessThan(0);
  });

  it('移動平均:窓 1 は恒等・端は縮めて平均する', () => {
    const x = Float32Array.from([1, 1, 1, 4, 4, 4]);
    expect(Array.from(boxSmooth(x, 1))).toEqual(Array.from(x));
    const s = boxSmooth(x, 3);
    expect(s[0]).toBeCloseTo(1, 6);
    expect(s[3]).toBeCloseTo(3, 6);
    expect(s[5]).toBeCloseTo(4, 6);
  });
});

describe('声が入っているか(hasVoice)', () => {
  it('立ち上がりの高い値は数えず、声らしい枠が 200ms 以上あるときだけ真', () => {
    const early = new Float32Array(300).fill(0.1);
    early.fill(0.9, 0, VAD_WARMUP_FRAMES); // 立ち上がりだけ高い(雑音だけでも実測で出る)
    expect(hasVoice(early)).toBe(false);
    const few = new Float32Array(300).fill(0.1);
    few.fill(0.9, 100, 100 + VAD_MIN_FRAMES - 1);
    expect(hasVoice(few), '19 枠は足りない').toBe(false);
    few[200] = 0.9;
    expect(hasVoice(few), '20 枠で足りる').toBe(true);
    expect(hasVoice(new Float32Array(0))).toBe(false);
  });
});
