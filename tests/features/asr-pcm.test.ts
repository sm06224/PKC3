/**
 * 🔴 **「ほぼ無音」の足切り**(#1446 B)── 閾値 1e-4(−80 dBFS)は、2026-10-08 の実測(合成音声を縮めて
 * 1.6e-4 で字になり 5.1e-5 で崩れた)から「音声を 1 件も切らない側」で決めた値。
 */
import { describe, expect, it } from 'vitest';
import { ASR_SILENCE_PEAK, ASR_SILENCE_RMS, isNearSilent, mixToMono, pcmRms, pcmStats } from '../../src/features/asr/asr-pcm';

describe('ほぼ無音の足切り(#1446 B)', () => {
  it('🔴 閾値は RMS 1e-4 / ピーク 5e-4(実測の根拠つき ── 変えるなら測り直す)', () => {
    expect(ASR_SILENCE_RMS).toBe(1e-4);
    expect(ASR_SILENCE_PEAK).toBe(5e-4);
  });

  it('RMS ── 空は 0 / 一定の振幅はその絶対値 / 正負が混じっても同じ', () => {
    expect(pcmRms(new Float32Array(0))).toBe(0);
    expect(pcmRms(new Float32Array(100).fill(0.5))).toBeCloseTo(0.5, 6);
    const alt = new Float32Array(100);
    for (let i = 0; i < alt.length; i++) alt[i] = i % 2 === 0 ? 0.25 : -0.25;
    expect(pcmRms(alt)).toBeCloseTo(0.25, 6);
  });

  /**
   * 🔴 **RMS は「二乗平均の平方根」である**(着地前レビュー 2026-10-08 M1)── 一定の振幅だけで見ると、
   *   平均絶対値やピークに書き換えても同じ値になって緑のまま。振幅が揃わない信号で値を縛る。
   */
  it('🔴 振幅が揃わない信号で RMS の値そのもの(平均絶対値・ピークと違う値)を縛る', () => {
    expect(pcmRms(new Float32Array([3, 4]))).toBeCloseTo(Math.sqrt(12.5), 6); // 平均絶対値なら 3.5、ピークなら 4
    const third = new Float32Array(48_000);
    for (let i = 0; i < 16_000; i++) third[i] = 0.1;
    expect(pcmRms(third)).toBeCloseTo(0.1 / Math.sqrt(3), 6); // 平均絶対値なら 0.1/3、ピークなら 0.1
    expect(pcmStats(third).peak).toBeCloseTo(0.1, 6);
    expect(pcmStats(new Float32Array([0.2, -0.7, 0.1])).peak).toBeCloseTo(0.7, 6); // 負のほうが大きい
  });

  /**
   * 🔴 **長いデジタル無音の中の短い小さい発話は切らない**(着地前レビュー #6)── 全体 RMS は閾値を割るが、
   *   ピークの門が通す。対照群 = 同じ長さで発話のピークが崩れた側(2.4e-4)なら切る。
   */
  it('🔴 1 時間の無音の中の 2 秒の小さい発話(振幅 0.003)は切らない / 崩れる大きさ(2.4e-4)なら切る', () => {
    const hour = new Float32Array(16_000 * 60 * 60);
    for (let i = 0; i < 16_000 * 2; i++) hour[i] = i % 2 === 0 ? 0.003 : -0.003; // 全体 RMS ≈ 7e-5
    expect(pcmStats(hour).rms, '前提が崩れている(全体 RMS が閾値を割っていない)').toBeLessThan(ASR_SILENCE_RMS);
    expect(isNearSilent(hour), '短い発話を切った').toBe(false);
    const faint = new Float32Array(16_000 * 60 * 60);
    for (let i = 0; i < 16_000 * 2; i++) faint[i] = i % 2 === 0 ? 2.4e-4 : -2.4e-4;
    expect(isNearSilent(faint), '崩れる大きさの発話しか無いのに渡した').toBe(true);
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
