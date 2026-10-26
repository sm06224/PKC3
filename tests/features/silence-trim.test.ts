/**
 * 🔴 **前後の無音の見つけ方**(#1232)。期待値は手で数えた固定の ms で守る(実装と同じ式で作らない)。
 */
import { describe, expect, it } from 'vitest';
import {
  SILENCE_MIN_EDGE_MS,
  SILENCE_PAD_MS,
  silenceTrimRange,
} from '../../src/features/audio/silence-trim';

const peaks = (spec: string): Float32Array =>
  Float32Array.from([...spec].map((c) => (c === 'v' ? 0.6 : c === 'q' ? 0.002 : 0)));

describe('前後の無音を見つける', () => {
  it('声の前後に無音があれば、声の範囲 ± 余白を返す', () => {
    // 20 個の山・100 秒 → 1 個 5 秒。声は 4〜15 番(20 秒〜80 秒)
    const r = silenceTrimRange(peaks('qqqqvvvvvvvvvvvvqqqq'), 100_000);
    expect(r).toEqual({ kind: 'range', startMs: 20_000 - SILENCE_PAD_MS, endMs: 80_000 + SILENCE_PAD_MS });
  });
  it('余白は 0 より前・録音の終わりより後へはみ出さない', () => {
    const r = silenceTrimRange(peaks('qqvvvvvvvvvvvvvvvvvv'), 100_000);
    // 前は 10 秒 → 余白を引いて 9.7 秒。後ろは無音が無い → 全長のまま
    expect(r).toEqual({ kind: 'range', startMs: 9_700, endMs: 100_000 });
  });
  it('片側の無音が短い(しきい値以下)ときは、その側は端のまま', () => {
    // 前は 0 番から声。後ろは 10 番以降が無音(= 50 秒から)
    const r = silenceTrimRange(peaks('vvvvvvvvvvqqqqqqqqqq'), 100_000);
    expect(r).toEqual({ kind: 'range', startMs: 0, endMs: 50_300 });
  });
  it('声が全体にあるとき(前後とも除く物が無い)は nothing', () => {
    expect(silenceTrimRange(peaks('vvvvvvvvvvvvvvvvvvvv'), 100_000)).toEqual({ kind: 'nothing' });
    // 対照: 余白の分しか無音が無い短い録音も nothing(除いても 1 秒未満)
    expect(SILENCE_MIN_EDGE_MS).toBeGreaterThanOrEqual(SILENCE_PAD_MS);
    expect(silenceTrimRange(peaks('qvvvvvvvvvvvvvvvvvvq'), 3_000)).toEqual({ kind: 'nothing' });
  });
  it('全体がほぼ無音(声が見つからない)は silent', () => {
    expect(silenceTrimRange(peaks('qqqqqqqqqqqqqqqqqqqq'), 100_000)).toEqual({ kind: 'silent' });
    expect(silenceTrimRange(new Float32Array(20), 100_000)).toEqual({ kind: 'silent' });
  });
  it('山が無い・長さが 0 は silent(落ちない)', () => {
    expect(silenceTrimRange([], 100_000)).toEqual({ kind: 'silent' });
    expect(silenceTrimRange(peaks('vvvv'), 0)).toEqual({ kind: 'silent' });
  });
  it('🔴 小さく録れた録音でも、声を無音と読まない(しきい値は最大の山に対する割合)', () => {
    // 声の山が 0.05(小さい)・無音は 0.002。絶対値 0.01 だけで見ると声が残る一方、最大 0.05 の 5% = 0.0025 より小さい山だけが無音
    const quiet = Float32Array.from({ length: 20 }, (_, i) => (i >= 4 && i <= 15 ? 0.05 : 0.002));
    expect(silenceTrimRange(quiet, 100_000)).toEqual({ kind: 'range', startMs: 19_700, endMs: 80_300 });
  });
  it('🔴 大きい声の間の小さな息継ぎは無音として削らない(両端だけを見る)', () => {
    const r = silenceTrimRange(peaks('qqvvqqqqvvvvvvqqqqqq'), 100_000);
    // 声は 2〜3 番と 8〜13 番 ── 範囲は最初の声の頭〜最後の声の終わり(間の無音は残る)
    expect(r).toEqual({ kind: 'range', startMs: 10_000 - SILENCE_PAD_MS, endMs: 70_000 + SILENCE_PAD_MS });
  });
});
