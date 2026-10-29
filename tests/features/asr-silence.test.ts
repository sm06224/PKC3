import { describe, expect, it } from 'vitest';
import {
  ASR_CUT_KEEP_MS,
  ASR_CUT_MIN_MS,
  applySilenceCut,
  planSilenceCut,
  remapEndMs,
  remapMs,
} from '../../src/features/asr/asr-silence';
import {
  ASR_LOOP_CHAR_KEEP,
  ASR_LOOP_SEGMENT_RUN,
  collapseRunaway,
  dropLoopedSegments,
  transcriptLines,
  transcriptText,
} from '../../src/features/asr/asr-text';

const RATE = 16_000;
/** 秒数ぶんの一定の振幅(音らしい物の代わり)。 */
const tone = (sec: number, amp: number): Float32Array => {
  const a = new Float32Array(Math.round(sec * RATE));
  for (let i = 0; i < a.length; i++) a[i] = i % 2 === 0 ? amp : -amp;
  return a;
};
const cat = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe('途中の長い無音を切る(#1446 ①)', () => {
  it('声 3 秒 + 無音 20 秒 + 声 3 秒 → 無音の真ん中だけ切り、両側に ASR_CUT_KEEP_MS ずつ残す', () => {
    const pcm = cat(tone(3, 0.2), tone(20, 0), tone(3, 0.2));
    const cut = planSilenceCut(pcm, RATE);
    expect(cut, '切る物があるのに null').not.toBeNull();
    expect(cut!.cuts).toBe(1);
    const keptSilenceMs = 20_000 - (cut!.cutSamples * 1000) / RATE;
    expect(keptSilenceMs).toBeCloseTo(ASR_CUT_KEEP_MS * 2, -1);
    const out = applySilenceCut(pcm, cut!);
    expect(out.length).toBe(pcm.length - cut!.cutSamples);
    // 声の部分は 1 標本も欠けない
    expect(out.slice(0, 3 * RATE)).toEqual(pcm.slice(0, 3 * RATE));
    expect(out.slice(out.length - 3 * RATE)).toEqual(pcm.slice(pcm.length - 3 * RATE));
  });

  it('対照群:語間の短い無音(ASR_CUT_MIN_MS 未満)は切らない', () => {
    const gap = (ASR_CUT_MIN_MS - 500) / 1000;
    expect(planSilenceCut(cat(tone(3, 0.2), tone(gap, 0), tone(3, 0.2)), RATE)).toBeNull();
  });

  it('対照群:無音が無い録音・全体が無音の録音は切らない(後者は isNearSilent の仕事)', () => {
    expect(planSilenceCut(tone(10, 0.2), RATE)).toBeNull();
    expect(planSilenceCut(tone(30, 0), RATE)).toBeNull();
  });

  it('小さく録れた録音でも、相対のしきい値で声を無音と読まない', () => {
    const pcm = cat(tone(3, 0.004), tone(20, 0), tone(3, 0.004));
    const cut = planSilenceCut(pcm, RATE)!;
    expect(cut.cuts).toBe(1);
    expect(applySilenceCut(pcm, cut).slice(0, 3 * RATE)).toEqual(pcm.slice(0, 3 * RATE));
  });

  it('時刻は元の録音へ戻る(切った後ろの声の時刻が、無音ぶん後ろへずれる)', () => {
    const pcm = cat(tone(3, 0.2), tone(20, 0), tone(3, 0.2));
    const cut = planSilenceCut(pcm, RATE)!;
    expect(remapMs(1000, cut, RATE)).toBeCloseTo(1000, 0);
    const cutMs = (cut.cutSamples * 1000) / RATE;
    // 切ったあとの録音で、後ろの声の頭 = 3 秒 + 残した無音 2 つぶん
    const afterCutStart = 3000 + ASR_CUT_KEEP_MS * 2;
    expect(remapMs(afterCutStart, cut, RATE)).toBeCloseTo(afterCutStart + cutMs, 0);
    expect(remapMs(afterCutStart, cut, RATE)).toBeCloseTo(23_000, -1);
  });
});

describe('🔴 基準は最大の枠ではない(レビュー指摘 1)', () => {
  it('大きな音が 1 回あっても、小さな声 40 秒は切らない(最大枠基準だと声が無音に読まれる)', () => {
    const pcm = cat(tone(1, 0.9), tone(40, 0.02));
    expect(planSilenceCut(pcm, RATE), '小さな声を無音と読んで切った').toBeNull();
  });

  it('対照群: 同じ録音でも、声のあいだの本当の無音は切れて、声は 1 標本も欠けない', () => {
    const pcm = cat(tone(1, 0.9), tone(20, 0.02), tone(10, 0), tone(20, 0.02));
    const cut = planSilenceCut(pcm, RATE);
    expect(cut, '本当の無音が切れていない').not.toBeNull();
    expect(cut!.cuts).toBe(1);
    const out = applySilenceCut(pcm, cut!);
    // 先頭の大きな音と 20 秒の声は丸ごと残る
    expect(out.slice(0, 21 * RATE)).toEqual(pcm.slice(0, 21 * RATE));
    expect(out.slice(out.length - 20 * RATE)).toEqual(pcm.slice(pcm.length - 20 * RATE));
  });

  it('絶対の門: 基準が高くても、−50 dBFS 以上の区間(小さな声)は切らない', () => {
    // 基準 ≈ 0.5(相対しきい値 0.025)。長い 0.01(−40 dBFS)は相対では無音だが、絶対では声の側
    const pcm = cat(tone(20, 0.5), tone(10, 0.01), tone(20, 0.5));
    expect(planSilenceCut(pcm, RATE)).toBeNull();
    // 対照群: 同じ並びで 0.001(−60 dBFS)なら切れる
    expect(planSilenceCut(cat(tone(20, 0.5), tone(10, 0.001), tone(20, 0.5)), RATE)).not.toBeNull();
  });
});

describe('終わりの時刻の変換(レビュー指摘 9)', () => {
  it('切った所の境目の終わりは、前の範囲の末尾へ寄る(remapMs だと次の範囲の頭へ飛ぶ)', () => {
    const pcm = cat(tone(3, 0.2), tone(20, 0), tone(3, 0.2));
    const cut = planSilenceCut(pcm, RATE)!;
    const boundaryMs = 3000 + ASR_CUT_KEEP_MS; // 切ったあとの録音で、前の範囲の末尾 = 切り目
    const end = remapEndMs(boundaryMs, cut, RATE);
    expect(end).toBeCloseTo(boundaryMs, 0);
    expect(remapMs(boundaryMs, cut, RATE), '前提: 開始側の変換は次の範囲の頭へ進む').toBeGreaterThan(end + 10_000);
    // 範囲の中なら remapMs と同じ
    expect(remapEndMs(1000, cut, RATE)).toBeCloseTo(remapMs(1000, cut, RATE), 3);
  });
});

describe('暴走したくり返しの除去(#1446 ①)', () => {
  it('同じ 1 字の暴走は ASR_LOOP_CHAR_KEEP 字に畳み、普通の伸ばしは触らない', () => {
    expect(collapseRunaway('あ'.repeat(40))).toBe('あ'.repeat(ASR_LOOP_CHAR_KEEP));
    expect(collapseRunaway('うわああああ')).toBe('うわああああ');
  });
  it('同じ語の暴走は 1 回に畳み、普通の相槌は触らない', () => {
    expect(collapseRunaway(`${'you '.repeat(30)}end`)).toBe('you end');
    expect(collapseRunaway('はいはいはい、そうです')).toBe('はいはいはい、そうです');
  });
  it('transcriptText / transcriptLines を通る(暴走だけ消え、前後の字は残る)', () => {
    expect(transcriptText(`こんにちは。${'ああ'.repeat(30)}さようなら`)).toBe('こんにちは。あああさようなら');
    const lines = transcriptLines([
      { startMs: 0, text: 'はい' },
      ...Array.from({ length: 20 }, (_, i) => ({ startMs: 1000 * (i + 1), text: ' you ' })),
    ]);
    expect(lines!.split('\n').filter((l) => l.includes('you'))).toHaveLength(1);
  });
  it('同じ区切りが ASR_LOOP_SEGMENT_RUN 未満なら残す(境目)', () => {
    const seg = (n: number) => Array.from({ length: n }, () => ({ text: 'はい' }));
    expect(dropLoopedSegments(seg(ASR_LOOP_SEGMENT_RUN - 1))).toHaveLength(ASR_LOOP_SEGMENT_RUN - 1);
    expect(dropLoopedSegments(seg(ASR_LOOP_SEGMENT_RUN))).toHaveLength(1);
  });
});
