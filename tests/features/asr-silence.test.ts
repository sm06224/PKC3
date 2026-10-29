import { describe, expect, it } from 'vitest';
import {
  ASR_CUT_KEEP_MS,
  ASR_CUT_MIN_MS,
  applySilenceCut,
  planSilenceCut,
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
