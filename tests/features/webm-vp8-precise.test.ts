/**
 * 🔴 **画面収録を押した所ぴったりに切る ── 純粋な部分**(#683 段②b-2。設計 doc §3.1・§4.3・§4.5)。
 *
 * 見るのは 3 つ:
 *   ①**どこからどこまでを作り直すか**(`precisePlanSpec`)── K0 から復号し、押した所に表示されているフレームから
 *     K1 の手前までを作り直す。K1 から先は元のバイト
 *   ②**頭と元のバイトの継ぎ目**(`planVideoTrim` の `head`)── 時刻が連続・フレームが重ならず欠けない・
 *     1 枚目はキーフレーム(`SimpleBlock` の旗が立つ)・音が継ぎ目で重ならない
 *   ③符号化の設定が元に合う(`preciseEncodeParams`)
 *
 * ⚠ fixture は手で組む(`tests/helpers/webm-video-fixture.ts`)。出力は**別の書き方**でほどく(`parseWebm`)。
 * 🔑 映像フレームの添字は中身(先頭 3 バイトの後ろ)から復元できる ── 「重なる / 欠ける」を添字の列で見る。
 */
import { describe, expect, it } from 'vitest';
import {
  planVideoTrim,
  preciseEncodeParams,
  precisePlanSpec,
  scanWebmVideo,
  type HeadFrame,
  type PreciseSpec,
  type VideoScan,
} from '../../src/features/video/webm-vp8';
import {
  assembleParts,
  buildVideoWebm,
  countingSource,
  parseWebm,
  type VideoFixture,
} from '../helpers/webm-video-fixture';

async function scanOf(f: VideoFixture): Promise<{ scan: VideoScan; src: ReturnType<typeof countingSource>; bytes: Uint8Array }> {
  const built = buildVideoWebm(f);
  const src = countingSource(built.bytes);
  const r = await scanWebmVideo(src, 1e9);
  if (!r.ok) throw new Error(`走査できなかった: ${r.reason}`);
  return { scan: r.scan, src, bytes: built.bytes };
}

/** 作り直した物の代わり(中身に添字と印 0xEE)。1 枚目だけキー。 */
function fakeHead(spec: PreciseSpec, scan: VideoScan, idxOf: (ms: number) => number): HeadFrame[] {
  void scan;
  return spec.emit.map((b, i) => ({
    ms: b.ms,
    key: i === 0,
    bytes: Uint8Array.of(i === 0 ? 0x10 : 0x11, 0, 0, idxOf(b.ms) & 0xff, 0, 0xee),
  }));
}

const msList = (spec: readonly { ms: number }[]): number[] => spec.map((b) => b.ms);

describe('作り直す範囲(precisePlanSpec)', () => {
  it('🔴 K0 から復号し、押した所に表示されているフレームから K1 の手前までを作り直す。K1 から先は元のバイト', async () => {
    const { scan } = await scanOf({ frames: 40, frameMs: 100 });
    // 空振り防止:キーフレームが複数ある録画で、押した所は K0(1000)と K1(2000)の間
    expect(scan.keyMs).toEqual([0, 1000, 2000, 3000]);
    const spec = precisePlanSpec(scan, 1550, 3050);
    expect(spec).not.toBeNull();
    expect(spec!.reencode).toBe(true);
    expect(spec!.startMs).toBe(1550);
    expect(msList(spec!.decode), 'K0(1000)から K1 の手前まで順に').toEqual([1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900]);
    expect(msList(spec!.emit), '押した所(1550)に表示されているフレームは 1500').toEqual([1500, 1600, 1700, 1800, 1900]);
    expect(spec!.tailFromMs).toBe(2000);
  });

  it('🔴 押した所に表示されているのは「時刻が押した所以下の最後のフレーム」(1ms 前 / ちょうど / 1ms 後)', async () => {
    const { scan } = await scanOf({ frames: 40, frameMs: 100 });
    // 1500 のフレームの 1ms 前 → 1400 が表示されている
    expect(precisePlanSpec(scan, 1499, 3050)!.emit[0]!.ms).toBe(1400);
    expect(precisePlanSpec(scan, 1500, 3050)!.emit[0]!.ms).toBe(1500);
    expect(precisePlanSpec(scan, 1501, 3050)!.emit[0]!.ms).toBe(1500);
  });

  it('🔴 currentTime * 1000 の端数(1549.6)は 1ms 刻みに丸めてから探す', async () => {
    const { scan } = await scanOf({ frames: 40, frameMs: 100 });
    expect(precisePlanSpec(scan, 1599.6, 3050)!.startMs).toBe(1600);
    expect(precisePlanSpec(scan, 1599.6, 3050)!.emit[0]!.ms).toBe(1600);
    expect(precisePlanSpec(scan, 1599.4, 3050)!.emit[0]!.ms).toBe(1500);
  });

  it('🔴 押した所に表示されているのがもうキーフレームなら、作り直しは要らない(その 1 枚を頭に写す)', async () => {
    const { scan } = await scanOf({ frames: 40, frameMs: 100 });
    for (const at of [2000, 2040]) {
      const spec = precisePlanSpec(scan, at, 3050)!;
      expect(spec.reencode, `${at}`).toBe(false);
      expect(spec.decode).toHaveLength(0);
      expect(msList(spec.emit)).toEqual([2000]);
      expect(spec.tailFromMs, '次のフレームから先は元のバイト').toBe(2100);
    }
  });

  it('🔴 キーフレームの 1ms 手前は、前の塊の最後の差分が表示されている(前の K0 から作り直す)', async () => {
    const { scan } = await scanOf({ frames: 40, frameMs: 100 });
    const spec = precisePlanSpec(scan, 1999, 3050)!;
    expect(spec.reencode).toBe(true);
    expect(msList(spec.emit)).toEqual([1900]);
    expect(spec.decode[0]!.ms, 'K0 は 1000').toBe(1000);
    expect(spec.tailFromMs).toBe(2000);
  });

  it('🔴 終わりが K1 より前なら、作り直しは終わりの手前まで・元のバイトは繋がない', async () => {
    const { scan } = await scanOf({ frames: 40, frameMs: 100 });
    const spec = precisePlanSpec(scan, 1550, 1850)!;
    expect(msList(spec.emit)).toEqual([1500, 1600, 1700, 1800]);
    expect(spec.tailFromMs).toBeNull();
    expect(msList(spec.decode)).toEqual([1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800]);
  });

  it('最後の塊(後ろに K1 が無い)でも作れる ── 録画の終わりまで作り直す', async () => {
    const { scan } = await scanOf({ frames: 40, frameMs: 100 });
    const spec = precisePlanSpec(scan, 3550, 1e9)!;
    expect(spec.reencode).toBe(true);
    expect(spec.tailFromMs).toBeNull();
    expect(msList(spec.emit)).toEqual([3500, 3600, 3700, 3800, 3900]);
  });

  it('🔴 使えない形は null ── 手前の区切りで切る道へ回す(録画の外 / 最初の映像フレームより手前 / 区切りが無い)', async () => {
    const { scan } = await scanOf({ frames: 40, frameMs: 100 });
    expect(precisePlanSpec(scan, 99_999, 1e9), '録画の外').toBeNull();
    expect(precisePlanSpec(scan, 2000, 2000), '範囲が空').toBeNull();
    expect(precisePlanSpec(scan, Number.NaN, 3000), 'NaN').toBeNull();
    // 音が先に始まり、映像の最初の絵が 500ms 後ろ → 0:00 を押しても表示されている絵が無い
    const late = await scanOf({ frames: 20, frameMs: 100, videoOffsetMs: 500 });
    expect(precisePlanSpec(late.scan, 100, 1500), '最初の映像フレームより手前').toBeNull();
    expect(precisePlanSpec(late.scan, 500, 1500), '最初のフレームちょうど').not.toBeNull();
    // 区切りが先頭のものしか無く、その手前を押す形は作れない ── キーが 5 番目の録画の 2 番目を押す
    const noKey = await scanOf({ frames: 20, frameMs: 100, keys: [5] });
    expect(precisePlanSpec(noKey.scan, 250, 1500), '手前に区切りが無い').toBeNull();
  });
});

describe('頭と元のバイトの継ぎ目(planVideoTrim の head)', () => {
  async function planWith(f: VideoFixture, start: number, end: number) {
    const { scan, src, bytes } = await scanOf(f);
    const spec = precisePlanSpec(scan, start, end)!;
    const frameMs = f.frameMs ?? 100;
    const head = spec.reencode
      ? fakeHead(spec, scan, (ms) => Math.round(ms / frameMs))
      : [
          {
            ms: spec.emit[0]!.ms,
            key: true,
            bytes: bytes.slice(spec.emit[0]!.dataStart, spec.emit[0]!.dataEnd),
          },
        ];
    const planned = await planVideoTrim(src, scan, start, end, { frames: head, tailFromMs: spec.tailFromMs });
    if (!planned.ok) throw new Error(`組めなかった: ${planned.reason}`);
    const out = assembleParts(planned.plan.parts, bytes);
    return { plan: planned.plan, parsed: parseWebm(out), out, scan, src, bytes, spec, head };
  }

  const video = (p: ReturnType<typeof parseWebm>) => p.blocks.filter((b) => b.track === 1);
  const audio = (p: ReturnType<typeof parseWebm>) => p.blocks.filter((b) => b.track === 2);
  /** 映像フレームの添字(中身の 4 番目)── 元のバイトも作り直した物も同じ置き方 */
  const idx = (b: { payload: number[] }): number => b.payload[3]!;

  it('🔴 時刻が連続する ── 継ぎ目(19 → 20)で欠けも重なりも無く、押した所に表示されていたフレームが 0', async () => {
    const r = await planWith({ frames: 40, frameMs: 100 }, 1550, 3050);
    const v = video(r.parsed);
    // 添字は 15 〜 30 を 1 回ずつ(重なり・欠けが無い)
    expect(v.map(idx)).toEqual(Array.from({ length: 16 }, (_, i) => 15 + i));
    // 時刻:押した所の 50ms 前に出たフレームは 0 へ(負にならない)、その後は元の間隔のまま
    expect(v.map((b) => b.ms)).toEqual([0, 50, 150, 250, 350, 450, 550, 650, 750, 850, 950, 1050, 1150, 1250, 1350, 1450]);
    expect(r.plan.headFrames).toBe(5);
    expect(r.plan.keptVideo).toBe(16);
    expect(r.plan.precise).toBe(true);
    expect(r.plan.snapBackMs, '押した所ぴったりなので戻らない').toBe(0);
    expect(r.plan.snappedStartMs).toBe(1550);
  });

  it('🔴 頭の 1 枚目はキーフレーム ── SimpleBlock の旗(0x80)が立ち、frame tag もキー。続きは差分', async () => {
    const r = await planWith({ frames: 40, frameMs: 100 }, 1550, 3050);
    const v = video(r.parsed);
    expect(v[0]!.kind, '作り直した物は SimpleBlock').toBe('a3');
    expect(v[0]!.flags & 0x80, '1 枚目に旗が立っていない').toBe(0x80);
    expect(v[0]!.payload[0], '1 枚目の frame tag がキーでない').toBe(0x10);
    for (const b of v.slice(1, 5)) {
      expect(b.flags & 0x80, '2 枚目以降の旗が立っている').toBe(0);
      expect(b.payload[0]).toBe(0x11);
      expect(b.payload[b.payload.length - 1], '作り直した物の印').toBe(0xee);
    }
    // K1(2000)以降は元のバイト(印が無い)で、元の流儀(BlockGroup)のまま
    expect(v[5]!.payload.includes(0xee), 'K1 を作り直している').toBe(false);
    expect(v[5]!.kind).toBe('a1');
    // 出力を走査し直しても、キーフレームは「頭の 1 枚目」と「K1」と「3000」
    const again = await scanWebmVideo(countingSource(r.out), 1e9);
    expect(again.ok && again.scan.keyMs).toEqual([0, 450, 1450]);
  });

  it('🔴 K1 以降は元のバイトのまま繋がる ── 作り直しは頭の数枚だけ', async () => {
    const r = await planWith({ frames: 40, frameMs: 100, padBytes: 40 }, 1550, 3050);
    const orig = parseWebm(r.bytes);
    const origByIdx = new Map(video(orig).map((b) => [idx(b), b.payload]));
    for (const b of video(r.parsed)) {
      if (idx(b) >= 20) expect(b.payload, `フレーム ${idx(b)} の中身が変わっている`).toEqual(origByIdx.get(idx(b)));
    }
    expect(r.plan.copiedClusters, '丸ごと入る Cluster は元のバイトを写す').toBeGreaterThan(0);
  });

  it('🔴 音:頭と元のバイトの間で重ならず欠けない(押した所以降の packet が 1 回ずつ)', async () => {
    const r = await planWith({ frames: 40, frameMs: 100, audioMs: 60 }, 1550, 3050);
    const a = audio(r.parsed);
    // 音の添字は payload[1]。1550 以降で最初の packet は 1560(添字 26)、3050 より前の最後は 3000(添字 50)
    const ids = a.map((b) => b.payload[1]!);
    expect(ids).toEqual(Array.from({ length: 50 - 26 + 1 }, (_, i) => 26 + i));
    expect(a[0]!.ms, '音は押した所(0)以降の最初の packet').toBe(1560 - 1550);
    // 継ぎ目(2000)をまたぐ音も 1 回ずつ
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.plan.keptAudio).toBe(ids.length);
  });

  it('🔴 Cluster の Timecode は戻らない(頭の Cluster より前の時刻を付けない)', async () => {
    const r = await planWith({ frames: 40, frameMs: 100 }, 1550, 3050);
    const tcs = r.parsed.clusterTimecodes;
    expect(tcs.length).toBeGreaterThan(2);
    for (let i = 1; i < tcs.length; i += 1) expect(tcs[i]!, `${tcs.join(',')}`).toBeGreaterThanOrEqual(tcs[i - 1]!);
    expect(tcs[0]).toBe(0);
    // 全ブロックの時刻も単調(映像と音を混ぜて並べても戻らない)
    const all = r.parsed.blocks.map((b) => b.ms);
    for (let i = 1; i < all.length; i += 1) expect(all[i]!).toBeGreaterThanOrEqual(all[i - 1]! - 1);
  });

  it('🔴 K1 が Cluster の途中にあっても、Cluster の Timecode は戻らない(頭の最後の Cluster より前の時刻を付けない)', async () => {
    // 区切りが 3.5 秒(Cluster は 3.0 秒から)── 押した所 150ms から頭が 3 秒以上続き、頭の最後の Cluster は 3 秒台
    const r = await planWith({ frames: 60, frameMs: 100, keys: [0, 35] }, 150, 5000);
    const tcs = r.parsed.clusterTimecodes;
    // 空振り防止:頭が複数の Cluster に分かれ、頭の最後の Cluster の時刻が、K1 を含む元の Cluster(3000 − 150)より後ろにある
    const headLast = Math.max(...tcs.filter((t) => t < 3500 - 150));
    expect(headLast, `頭の最後の Cluster が 2850 より後ろにない(${tcs.join(',')})`).toBeGreaterThan(2850);
    for (let i = 1; i < tcs.length; i += 1) expect(tcs[i]!, `${tcs.join(',')}`).toBeGreaterThanOrEqual(tcs[i - 1]!);
    // K1 を含む Cluster の中のブロックは、相対時刻が負でも時刻は元どおり(K1 = 3500 − 150)
    const v = video(r.parsed);
    expect(v.find((b) => idx(b) === 35)!.ms).toBe(3350);
  });

  it('🔴 Duration = 終わり − 押した所(出力は有限の長さ)・Segment の大きさは実寸と合う', async () => {
    const r = await planWith({ frames: 40, frameMs: 100 }, 1550, 3050);
    expect(r.parsed.duration).toBe(1500);
    expect(r.plan.durationMs).toBe(1500);
    expect(r.parsed.segmentSizeKnown).toBe(true);
    expect(r.plan.byteLength).toBe(r.out.length);
  });

  it('🔴 押した所がキーフレームの上なら、その 1 枚を頭に写して、次のフレームから元のバイト(作り直し 0)', async () => {
    const r = await planWith({ frames: 40, frameMs: 100 }, 2040, 3050);
    const v = video(r.parsed);
    expect(v.map(idx)).toEqual(Array.from({ length: 11 }, (_, i) => 20 + i));
    expect(v[0]!.ms, '2000 のキーフレームが押した所(2040)で 0').toBe(0);
    expect(v[0]!.flags & 0x80, '頭の 1 枚は旗が立つ').toBe(0x80);
    expect(v[1]!.ms, '次のフレームは元の間隔(2100 − 2040)').toBe(60);
    expect(v.some((b) => b.payload.includes(0xee)), 'キーフレームが上なのに作り直している').toBe(false);
    expect(r.plan.headFrames).toBe(1);
  });

  it('🔴 終わりが K1 より前なら、頭だけで終わる(元のバイトは繋がない)・音も終わりまで頭に入る', async () => {
    const r = await planWith({ frames: 40, frameMs: 100 }, 1550, 1850);
    const v = video(r.parsed);
    expect(v.map(idx)).toEqual([15, 16, 17, 18]);
    expect(r.plan.copiedClusters).toBe(0);
    expect(r.parsed.duration).toBe(300);
    const a = audio(r.parsed);
    expect(a.length).toBeGreaterThan(0);
    expect(Math.max(...a.map((b) => b.ms)), '終わり(300)より後ろの音が入っている').toBeLessThan(300);
  });

  it('🔴 長い塊(頭が 1 秒を超える)は頭の Cluster が 1 秒ごとに分かれる(相対時刻は 16 ビットに収まる)', async () => {
    // 区切りが 100 フレーム(10 秒)ごとの録画で、塊の途中(2.55 秒)から押す
    const r = await planWith({ frames: 150, frameMs: 100, keys: [0, 100] }, 2550, 14000);
    const heads = r.parsed.clusterTimecodes.filter((t) => t < 10_000 - 2550);
    expect(heads.length, '頭が 1 本の Cluster に詰め込まれている').toBeGreaterThan(3);
    const v = video(r.parsed);
    expect(v.map(idx).slice(0, 3)).toEqual([25, 26, 27]);
    for (let i = 1; i < v.length; i += 1) expect(v[i]!.ms).toBeGreaterThan(v[i - 1]!.ms - 1);
  });
});

describe('符号化の設定(preciseEncodeParams)', () => {
  it('🔴 寸法・フレームレートは元から。ビットレートは元の実測より少し高め(1.2 倍)', async () => {
    // 250ms 間隔(4fps)・1 枚 20,005 バイト・40 枚 → 映像の実測 = 800,200 バイト × 8 ÷ 10 秒 = 640,160 bps
    const big = await scanOf({ frames: 40, frameMs: 250, padBytes: 20_000, clusterMs: 1000 });
    const p = preciseEncodeParams(big.scan);
    expect(p.width).toBe(640);
    expect(p.height).toBe(360);
    expect(p.framerate, '250ms 間隔 → 4fps').toBe(4);
    expect(p.bitrate, '実測の 1.2 倍').toBe(768_192);
    // 実測が小さい形は下限(300,000)に支えられる ── 実測が大きければビットレートも大きい(式が実測を見ている)
    const small = await scanOf({ frames: 40, frameMs: 250, padBytes: 0 });
    const q = preciseEncodeParams(small.scan);
    expect(q.bitrate).toBe(300_000);
    expect(p.bitrate).toBeGreaterThan(q.bitrate);
  });

  it('🔴 画面が止まる録画(実測が極端に低い)でも、画素数に比例した下限を下回らない', async () => {
    const tiny = await scanOf({ frames: 40, frameMs: 100, padBytes: 0 });
    const p = preciseEncodeParams(tiny.scan);
    expect(p.bitrate).toBeGreaterThanOrEqual(300_000);
  });
});
