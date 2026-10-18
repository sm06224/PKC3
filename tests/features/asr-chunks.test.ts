/** @vitest-environment node */
/**
 * 長い録音の区切り方(台帳 #1852 束 O1 / 依頼 149 ③)。
 *
 * 守る主張:
 *  1. 20 分までは 1 本(区切りの境で語が割れる可能性を、必要な録音にだけ持たせる)
 *  2. 区切りは隙間も重なりも無くつながる(全部を足すと元の長さ)
 *  3. 区切りの位置は目標の前後で一番静かな所へ寄る(語の途中で切らない)
 *  4. 残りが短すぎる最後の 1 本は作らない
 *  5. 区切りごとの時刻は、その区切りの先頭の位置を足して録音の頭からの値に直す
 */
import { describe, expect, it } from 'vitest';
import {
  ASR_CHUNK_AFTER_SEC,
  ASR_CHUNK_SEC,
  ASR_SAMPLE_RATE,
  chunkOffsetMs,
  planAsrChunks,
  shiftSegments,
} from '../../src/features/asr/asr-chunks';

const SR = ASR_SAMPLE_RATE;
const loud = (sec: number): Float32Array => new Float32Array(Math.floor(sec * SR)).fill(0.5);

describe('既定の条件', () => {
  it('🔴 20 分(ちょうど)までは 1 本 / それを超えると約 10 分ずつ', () => {
    expect(ASR_CHUNK_AFTER_SEC).toBe(20 * 60);
    expect(ASR_CHUNK_SEC).toBe(10 * 60);
    // ちょうど 20 分は 1 本(大きな配列を確保しない ── 長さだけ見る小さな偽物で足りる)
    const exact = { length: ASR_CHUNK_AFTER_SEC * SR } as unknown as Float32Array;
    expect(planAsrChunks(exact)).toEqual([{ start: 0, end: ASR_CHUNK_AFTER_SEC * SR }]);
  });

  it('空の PCM は区切らない', () => {
    expect(planAsrChunks(new Float32Array(0))).toEqual([]);
  });
});

describe('区切り方(小さい条件で)', () => {
  const opts = { afterSec: 5, chunkSec: 2, minTailSec: 0.5, searchSec: 0.3 };

  it('🔴 隙間も重なりも無くつながり、全部を足すと元の長さになる', () => {
    const pcm = loud(9);
    const chunks = planAsrChunks(pcm, opts);
    expect(chunks.length, '区切れていない').toBeGreaterThan(2);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks[chunks.length - 1]!.end).toBe(pcm.length);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start, '隙間か重なり').toBe(chunks[i - 1]!.end);
    for (const c of chunks) expect(c.end, '長さ 0 の本がある').toBeGreaterThan(c.start);
  });

  it('🔴 目標の位置の前後で、いちばん静かな所に寄る(語の途中で切らない)', () => {
    const pcm = loud(9);
    // 目標 2 秒の少し手前(1.9 秒)に無音の穴を空ける
    const hole = Math.floor(1.9 * SR);
    const holeLen = Math.floor(0.1 * SR);
    pcm.fill(0, hole, hole + holeLen);
    const first = planAsrChunks(pcm, opts)[0]!;
    expect(first.end, '静かな穴に寄っていない').toBeGreaterThanOrEqual(hole);
    expect(first.end).toBeLessThan(hole + holeLen);
  });

  it('🔴 残りが短すぎる最後の 1 本は作らない(前の本に含める)', () => {
    // 6.2 秒を 2 秒目標で切ると最後が 0.2 秒 ── 最後の本が最小の長さ(0.5 秒)を割らない
    const chunks = planAsrChunks(loud(6.2), { ...opts, afterSec: 3 });
    const last = chunks[chunks.length - 1]!;
    expect((last.end - last.start) / SR, '短すぎる最後の本が出来た').toBeGreaterThanOrEqual(0.5);
  });

  it('⚠ 対照群 ── 条件の長さ以下なら 1 本', () => {
    expect(planAsrChunks(loud(5), opts)).toEqual([{ start: 0, end: 5 * SR }]);
  });
});

describe('時刻の直し', () => {
  it('🔴 始まりと(あれば)終わりに、区切りの先頭の位置を足す。終わりが無い(null)区切りはそのまま', () => {
    expect(
      shiftSegments(
        [
          { startMs: 100, endMs: 400, text: 'a' },
          { startMs: 500, endMs: null, text: 'b' },
        ],
        60_000,
      ),
    ).toEqual([
      { startMs: 60_100, endMs: 60_400, text: 'a' },
      { startMs: 60_500, endMs: null, text: 'b' },
    ]);
  });

  it('区切りの先頭の位置(ms)', () => {
    expect(chunkOffsetMs({ start: 10 * SR, end: 20 * SR })).toBe(10_000);
    expect(chunkOffsetMs({ start: 0, end: SR })).toBe(0);
  });
});
