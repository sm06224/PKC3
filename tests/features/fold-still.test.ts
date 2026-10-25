/**
 * 🔴 **静止している区間を畳む**(#952 A2)。
 *
 * ⚠ fixture は手で組む(`tests/helpers/webm-video-fixture.ts`)+ 実際の libvpx 出力(`tests/fixtures/vp8/*.webm`)。
 *   出力は別の書き方でほどく(`parseWebm`)。
 * 🔑 空振り防止:元の動画に「小さい差分が続く区間」と「大きい差分」の両方があることを test 自身が assert する
 *   (全部小さい / 全部大きいと、畳む・畳まないのどちらかの枝を通らない)。
 * 🔴 **落としてよいのは、次の 1 枚がキーフレームのとき、または動画の終わりまで続くときだけ**(着地前レビュー ⚠2)。
 *   VP8 の差分フレームは参照が積み上がるので、途中で落とすと残した次のフレームが違う絵を土台に復号される。
 *   実物の確認(ffmpeg で復号して比べた): 途中の差分を落とした対照は 255 枚中 32 枚が元と食い違い、
 *   このルールで落とした物は残した全フレームが元と同じ絵だった。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findStillRuns, planFoldStill, STILL_DEFAULTS } from '../../src/features/video/fold-still';
import { scanWebmVideo, webmWithout } from '../../src/features/video/webm-vp8';
import { blobSource, foldStillVideo } from '../../src/adapter/platform/video/video-codec';
import { assembleParts, buildVideoWebm, countingSource, parseWebm } from '../helpers/webm-video-fixture';

/** 40 枚(100ms)。キーフレームは 0 と 30。差分 3〜29 だけが小さい(5 バイト)で、次(30)がキーフレーム。ほかは大きい(300 バイト超)。 */
const STILL_FROM = 3;
const STILL_TO = 29;
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
  it('小さい差分が続き、次がキーフレームの所だけを 1 区間にする(前提も assert)', async () => {
    const { scan } = await scanOf(FIXTURE);
    const video = scan.blocks.filter((b) => b.track === scan.videoTrack);
    const small = video.filter((b) => !b.key && b.dataEnd - b.dataStart <= STILL_DEFAULTS.maxBytes);
    expect(small, '前提: 小さい差分が無い').toHaveLength(STILL_TO - STILL_FROM + 1);
    expect(video.length - small.length, '前提: 大きい / キーフレームが無い').toBeGreaterThan(10);
    expect(video[STILL_TO + 1]!.key, '前提: 区間の次がキーフレーム').toBe(true);

    const runs = findStillRuns(scan);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.blocks).toHaveLength(small.length);
    expect(runs[0]!.fromMs).toBe(200); // 直前に残す 2 枚目
    expect(runs[0]!.toMs).toBe(3000); // 次の映像フレーム(キーフレーム)
  });

  it('🔴 次がキーフレームでない区間(次が大きな差分)は、小さい差分が何枚続いても落とさない', async () => {
    // 小さい差分 3〜20、次の 21 は大きい差分(キーフレームではない)
    const { scan } = await scanOf({ ...FIXTURE, padFor: (i: number) => (i >= 3 && i <= 20 ? 0 : 300) });
    const video = scan.blocks.filter((b) => b.track === scan.videoTrack);
    expect(video[21]!.key, '前提: 次はキーフレームではない').toBe(false);
    expect(video.slice(3, 21).every((b) => b.dataEnd - b.dataStart <= STILL_DEFAULTS.maxBytes), '前提: 18 枚とも小さい').toBe(true);
    expect(findStillRuns(scan)).toHaveLength(0);
    expect(planFoldStill(scan)).toEqual({ ok: false, reason: 'nothing-to-fold' });
  });

  it('動画の終わりまで続く区間は落とせる(後ろに参照する者がいない)', async () => {
    const { scan } = await scanOf({ ...FIXTURE, padFor: (i: number) => (i >= 3 ? 0 : 300), keys: [0] });
    const runs = findStillRuns(scan);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.toMs).toBe(scan.sourceEndMs);
  });

  it('キーフレームは落とさず、区間を区切る(それぞれの次がキーフレームなら 2 区間)', async () => {
    const { scan } = await scanOf({ ...FIXTURE, keys: [0, 15, 30] });
    const runs = findStillRuns(scan);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.blocks.length)).toEqual([12, 14]); // 3〜14 と 16〜29
    for (const r of runs) expect(r.blocks.some((b) => b.key)).toBe(false);
  });

  it('短い区間(minMs 未満)と少ない枚数(minFrames 未満)は落とさない(どちらも次はキーフレーム)', async () => {
    const short = await scanOf({ ...FIXTURE, keys: [0, 7], padFor: (i: number) => (i >= 3 && i <= 6 ? 0 : 300) });
    expect(short.scan.blocks.filter((b) => b.track === short.scan.videoTrack)[7]!.key, '前提: 次はキーフレーム').toBe(true);
    expect(findStillRuns(short.scan), '0.5 秒の区間は落とさない').toHaveLength(0);
    expect(findStillRuns(short.scan, { minMs: 400 }), '前提: 閾値を下げれば落とせる').toHaveLength(1);
    const sparse = await scanOf({ ...FIXTURE, keys: [0, 5], padFor: (i: number) => (i >= 3 && i <= 4 ? 0 : 300), frameMs: 800 });
    expect(findStillRuns(sparse.scan, { minFrames: 3 }), '2 枚だけは落とさない').toHaveLength(0);
    expect(findStillRuns(sparse.scan, { minFrames: 2 }), '前提: 閾値を下げれば落とせる').toHaveLength(1);
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

/**
 * 🔴 **実際の libvpx の出力で確かめる**(合成の fixture は参照の連鎖を持たないので、まとめた結果が壊れないかは実物でしか見えない)。
 *
 * fixture(`tests/fixtures/vp8/screen-still-motion-still.webm`、160x90・30fps・15 秒・キーフレーム 1.5 秒ごと):
 * 0〜11 秒は静止、11〜12 秒は動く(testsrc2)、12〜15 秒は静止。ffmpeg で自作した(`libvpx -deadline realtime -g 45`)。
 * 🔑 libvpx は静止した画面でも 8 枚ほどごとに golden を更新する小さなフレームを出す ── 「更新するフレームは落とさない」とすると
 *   静止区間がまとまらない。区間を次のキーフレームまで丸ごと落とせば、その中の golden の更新は誰にも参照されない。
 */
const FIXTURE_PATH = 'tests/fixtures/vp8/screen-still-motion-still.webm';
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] }).status === 0;

/** ffmpeg で映像を復号し、フレームごとの md5 を pts(1/1000 秒)で返す。 */
function decodedMd5(bytes: Uint8Array): Map<number, string> {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-vp8-'));
  try {
    const file = join(dir, 'in.webm');
    writeFileSync(file, bytes);
    const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-an', '-f', 'framemd5', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).stdout;
    const m = new Map<number, string>();
    for (const line of out.split('\n')) {
      if (line.startsWith('#') || line.trim() === '') continue;
      const cols = line.split(',').map((c) => c.trim());
      m.set(Number(cols[2]), cols[5]!);
    }
    return m;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('実際の libvpx の出力(tests/fixtures/vp8)', () => {
  const original = new Uint8Array(readFileSync(FIXTURE_PATH));

  it('🔴 動かない区間はまとまり、動いている 11〜12 秒は 1 枚も落ちない。落ちた枚の次は、必ずキーフレームか動画の終わり', async () => {
    const before = await scanWebmVideo(blobSource(new Blob([original])), Number.POSITIVE_INFINITY);
    if (!before.ok) throw new Error(before.reason);
    const video = before.scan.blocks.filter((b) => b.track === before.scan.videoTrack);
    expect(video.filter((b) => b.key).length, '前提: キーフレームが複数ある').toBeGreaterThanOrEqual(4);
    expect(video.filter((b) => b.ms >= 11000 && b.ms < 12000 && b.dataEnd - b.dataStart > STILL_DEFAULTS.maxBytes).length, '前提: 動いている区間に大きなフレームがある').toBeGreaterThan(25);

    const r = await foldStillVideo({ blob: new Blob([original]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.runs).toBeGreaterThanOrEqual(8);
    expect(r.droppedFrames).toBeGreaterThan(300);
    const after = await scanWebmVideo(blobSource(r.blob), Number.POSITIVE_INFINITY);
    if (!after.ok) throw new Error(after.reason);
    const kept = new Set(after.scan.blocks.filter((b) => b.track === after.scan.videoTrack).map((b) => b.ms));
    expect(video.filter((b) => b.ms >= 11000 && b.ms < 12000).every((b) => kept.has(b.ms)), '動いている区間のフレームが落ちた').toBe(true);
    // 落ちた枚の次に残っているフレームは、キーフレームか、無い(動画の終わり)
    const keyAt = new Map(video.map((b) => [b.ms, b.key]));
    for (const d of video.filter((b) => !kept.has(b.ms))) {
      const next = video.find((b) => b.ms > d.ms && kept.has(b.ms));
      expect(next === undefined || keyAt.get(next.ms) === true, `${String(d.ms)}ms を落としたのに、次が差分フレーム`).toBe(true);
    }
    expect(r.blob.size).toBeLessThan(original.length);
  });

  it.skipIf(!hasFfmpeg)('🔴 ffmpeg で復号して比べる:残した全フレームが元と同じ絵(1 枚も崩れない)', async () => {
    const r = await foldStillVideo({ blob: new Blob([original]) });
    if (!r.ok) throw new Error(r.reason);
    const orig = decodedMd5(original);
    const folded = decodedMd5(new Uint8Array(await r.blob.arrayBuffer()));
    expect(orig.size, '前提: 元が復号できている').toBeGreaterThan(200);
    expect(folded.size, '前提: 畳んだ物が復号できている').toBeGreaterThan(30);
    expect(folded.size).toBeLessThan(orig.size);
    const mismatched = [...folded].filter(([t, md5]) => orig.get(t) !== md5).map(([t]) => t);
    expect(mismatched, '残したフレームが元と違う絵になっている').toEqual([]);
  });

  it.skipIf(!hasFfmpeg)('⚠ 対照群:動いている区間の途中の差分だけを落とすと、後ろのフレームが元と食い違う(ルールが空振りでない証拠)', async () => {
    const scanned = await scanWebmVideo(blobSource(new Blob([original])), Number.POSITIVE_INFINITY);
    if (!scanned.ok) throw new Error(scanned.reason);
    const drop = new Set(scanned.scan.blocks.filter((b) => b.track === scanned.scan.videoTrack && b.ms >= 11200 && b.ms <= 11400));
    const plan = webmWithout(scanned.scan, drop);
    const naive = assembleParts(plan.parts, original);
    const orig = decodedMd5(original);
    const bad = [...decodedMd5(naive)].filter(([t, md5]) => orig.get(t) !== md5);
    expect(bad.length, '途中を落としても崩れない = このルールの対照になっていない').toBeGreaterThan(10);
  });
});
