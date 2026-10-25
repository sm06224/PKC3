/**
 * 🔴 **静止している区間を畳む**(#952 A2)。
 *
 * ⚠ fixture は手で組む(`tests/helpers/webm-video-fixture.ts`)。出力は別の書き方でほどく(`parseWebm`)。
 * 🔑 空振り防止:元の動画に「小さい差分が続く区間」と「大きい差分」の両方があることを test 自身が assert する
 *   (全部小さい / 全部大きいと、畳む・畳まないのどちらかの枝を通らない)。
 */
import { describe, expect, it } from 'vitest';
import { findStillRuns, planFoldStill, STILL_DEFAULTS } from '../../src/features/video/fold-still';
import { scanWebmVideo } from '../../src/features/video/webm-vp8';
import { foldStillVideo } from '../../src/adapter/platform/video/video-codec';
import { assembleParts, buildVideoWebm, countingSource, parseWebm } from '../helpers/webm-video-fixture';

/** 40 枚(100ms)。キーフレームは 0 と 30。差分 3〜20 だけが小さい(5 バイト)、ほかは大きい(300 バイト超)。 */
const STILL_FROM = 3;
const STILL_TO = 20;
const FIXTURE = {
  frames: 40,
  frameMs: 100,
  keys: [0, 30],
  padFor: (i: number): number => (i >= STILL_FROM && i <= STILL_TO ? 0 : 300),
} as const;

async function scanOf(f: Parameters<typeof buildVideoWebm>[0]) {
  const built = buildVideoWebm(f);
  const scanned = await scanWebmVideo(countingSource(built.bytes), Number.POSITIVE_INFINITY);
  if (!scanned.ok) throw new Error(`走査できなかった: ${scanned.reason}`);
  return { built, scan: scanned.scan };
}

describe('静止区間の見つけ方(findStillRuns)', () => {
  it('小さい差分が続く所だけを 1 区間にする(前提も assert)', async () => {
    const { scan } = await scanOf(FIXTURE);
    const video = scan.blocks.filter((b) => b.track === scan.videoTrack);
    const small = video.filter((b) => !b.key && b.dataEnd - b.dataStart <= STILL_DEFAULTS.maxBytes);
    expect(small, '前提: 小さい差分が無い').toHaveLength(STILL_TO - STILL_FROM + 1);
    expect(video.length - small.length, '前提: 大きい / キーフレームが無い').toBeGreaterThan(10);

    const runs = findStillRuns(scan);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.blocks).toHaveLength(small.length);
    expect(runs[0]!.fromMs).toBe(200); // 直前に残す 2 枚目
    expect(runs[0]!.toMs).toBe(2100); // 次の映像フレーム
  });

  it('キーフレームは落とさず、区間を区切る', async () => {
    // 小さい差分の途中にキーフレーム(10)を挟む → 2 区間に割れ、キーフレームはどちらにも入らない
    const { scan } = await scanOf({ ...FIXTURE, keys: [0, 15, 30], padFor: (i: number) => (i >= 3 && i <= 28 ? 0 : 300) });
    const runs = findStillRuns(scan);
    expect(runs).toHaveLength(2);
    for (const r of runs) expect(r.blocks.some((b) => b.key)).toBe(false);
  });

  it('短い区間(minMs 未満)と少ない枚数(minFrames 未満)は畳まない', async () => {
    const { scan } = await scanOf({ ...FIXTURE, padFor: (i: number) => (i >= 3 && i <= 6 ? 0 : 300) });
    expect(findStillRuns(scan), '0.4 秒の区間は畳まない').toHaveLength(0);
    const sparse = await scanOf({ ...FIXTURE, padFor: (i: number) => (i >= 3 && i <= 4 ? 0 : 300), frameMs: 800 });
    expect(findStillRuns(sparse.scan, { minFrames: 3 }), '2 枚だけは畳まない').toHaveLength(0);
    expect(findStillRuns(sparse.scan, { minFrames: 2 }), '前提: 閾値を下げれば畳める').toHaveLength(1);
  });

  it('全部大きい(動き続ける)なら区間は 0 件', async () => {
    const { scan } = await scanOf({ ...FIXTURE, padFor: () => 300 });
    expect(findStillRuns(scan)).toHaveLength(0);
    expect(planFoldStill(scan)).toEqual({ ok: false, reason: 'nothing-to-fold' });
  });
});

describe('畳んだ動画(planFoldStill)', () => {
  it('🔴 区間の差分フレームだけが消え、ほかの映像・音は 1 つも変わらない', async () => {
    const { built, scan } = await scanOf(FIXTURE);
    const plan = planFoldStill(scan);
    if (!plan.ok) throw new Error(plan.reason);
    const out = assembleParts(plan.plan.parts, built.bytes);

    const before = parseWebm(built.bytes).blocks;
    const after = parseWebm(out).blocks;
    const v = (bs: typeof before) => bs.filter((b) => b.track === 1);
    const a = (bs: typeof before) => bs.filter((b) => b.track === 2);
    expect(v(before)).toHaveLength(40); // 前提
    expect(a(before).length).toBeGreaterThan(10); // 前提

    expect(plan.plan.droppedFrames).toBe(STILL_TO - STILL_FROM + 1);
    expect(v(after)).toHaveLength(40 - plan.plan.droppedFrames);
    // 残った映像は元と同じ時刻・同じ中身
    const keptBefore = v(before).filter((_, i) => i < STILL_FROM || i > STILL_TO);
    expect(v(after).map((b) => b.ms)).toEqual(keptBefore.map((b) => b.ms));
    expect(v(after).map((b) => b.payload)).toEqual(keptBefore.map((b) => b.payload));
    // 音は全部残る(時刻も中身も同じ)
    expect(a(after).map((b) => [b.ms, b.payload])).toEqual(a(before).map((b) => [b.ms, b.payload]));
    // 長さは変えない
    expect(plan.plan.durationMs).toBe(scan.sourceEndMs);
    expect(parseWebm(out).duration).toBe(scan.sourceEndMs);
    expect(out.length).toBeLessThan(built.bytes.length);
  });

  it('出力をもう一度走査できる(往復)── 音の宣言も残り、畳める所はもう無い', async () => {
    const { built, scan } = await scanOf(FIXTURE);
    const plan = planFoldStill(scan);
    if (!plan.ok) throw new Error(plan.reason);
    const out = assembleParts(plan.plan.parts, built.bytes);
    const again = await scanWebmVideo(countingSource(out), Number.POSITIVE_INFINITY);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.scan.audioTrack).not.toBeNull();
    expect(planFoldStill(again.scan)).toEqual({ ok: false, reason: 'nothing-to-fold' });
  });

  it('終わりまで静止が続く録画(後ろに映像が出ない)も畳める', async () => {
    const f = { ...FIXTURE, padFor: (i: number) => (i >= 3 ? 0 : 300), keys: [0] };
    const { scan } = await scanOf(f);
    const runs = findStillRuns(scan);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.toMs).toBe(scan.sourceEndMs);
  });
});

describe('ワーカーの口(foldStillVideo)', () => {
  it('Blob を渡すと畳んだ Blob と数が返り、畳めない動画は理由が値で返る', async () => {
    const built = buildVideoWebm(FIXTURE);
    const r = await foldStillVideo({ blob: new Blob([built.bytes]) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.runs).toBe(1);
      expect(r.droppedFrames).toBe(STILL_TO - STILL_FROM + 1);
      expect(r.blob.size).toBeLessThan(built.bytes.length);
      expect(r.blob.type).toBe('video/webm');
    }
    const moving = buildVideoWebm({ ...FIXTURE, padFor: () => 300 });
    expect(await foldStillVideo({ blob: new Blob([moving.bytes]) })).toEqual({ ok: false, reason: 'nothing-to-fold' });
    expect(await foldStillVideo({ blob: new Blob([new Uint8Array(64)]) })).toMatchObject({ ok: false });
  });
});
