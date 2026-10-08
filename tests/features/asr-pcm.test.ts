/**
 * 🔴 **「ほぼ無音」の足切り**(#1446 B)── 閾値 1e-4(−80 dBFS)は、2026-10-08 の実測(合成音声を縮めて
 * 1.6e-4 で字になり 5.1e-5 で崩れた)から「音声を 1 件も切らない側」で決めた値。
 */
import { describe, expect, it } from 'vitest';
import { ASR_SILENCE_RMS, isNearSilent, mixToMono, pcmRms } from '../../src/features/asr/asr-pcm';

describe('ほぼ無音の足切り(#1446 B)', () => {
  it('🔴 閾値は 1e-4(実測の根拠つき ── 変えるなら測り直す)', () => {
    expect(ASR_SILENCE_RMS).toBe(1e-4);
  });

  it('RMS ── 空は 0 / 一定の振幅はその絶対値 / 正負が混じっても同じ', () => {
    expect(pcmRms(new Float32Array(0))).toBe(0);
    expect(pcmRms(new Float32Array(100).fill(0.5))).toBeCloseTo(0.5, 6);
    const alt = new Float32Array(100);
    for (let i = 0; i < alt.length; i++) alt[i] = i % 2 === 0 ? 0.25 : -0.25;
    expect(pcmRms(alt)).toBeCloseTo(0.25, 6);
  });

  it('🔴 デジタル無音と −86 dBFS は切る / −76 dBFS(字になった側)は切らない', () => {
    expect(isNearSilent(new Float32Array(16_000))).toBe(true);
    expect(isNearSilent(new Float32Array(16_000).fill(5.1e-5))).toBe(true);
    expect(isNearSilent(new Float32Array(16_000).fill(1.6e-4))).toBe(false);
    // ⚠ 雑音(−48 dBFS = 3.9e-3)は切らない ── 小さい声と同じ帯なので RMS では切れない(切ると声も切る)
    expect(isNearSilent(new Float32Array(16_000).fill(3.9e-3))).toBe(false);
  });

  it('⚠ 音声を含む長い録音は全体で見る(途中の無音で切らない)', () => {
    const pcm = new Float32Array(48_000);
    for (let i = 0; i < 16_000; i++) pcm[i] = 0.1; // 前 1/3 だけ音
    expect(isNearSilent(pcm)).toBe(false);
  });

  it('mixToMono の結果にそのまま当たる(1 本なら写し)', () => {
    const mono = mixToMono([new Float32Array(10).fill(0.2)]);
    expect(isNearSilent(mono)).toBe(false);
  });
});
