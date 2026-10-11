/**
 * 🔴 **画面収録(VP8 + opus の webm)の前後を削る**(#683 段②b-1。設計 doc §10.1)。
 *
 * ⚠ fixture は**手で組む**(`tests/helpers/webm-video-fixture.ts`。実装の書き手を使わない)。
 *   出力は**別の書き方**でほどいて(`parseWebm`)、実装の走査器と同じ盲点を共有しない。
 * 🔑 空振り防止:キーフレームが 0 個 / 1 個 / 複数個、の各次元を test 自身が assert する。
 */
import { describe, expect, it } from 'vitest';
import {
  isKeyFrame,
  planVideoTrim,
  scanWebmVideo,
  snapVideoStart,
  VIDEO_TRIM_REFUSAL_TEXT,
  type VideoScan,
} from '../../src/features/video/webm-vp8';
import {
  snapConfirm,
  snapDoneNote,
  snapSecondsText,
  SNAP_CONFIRM_RULED_TEXT,
} from '../../src/features/video/video-trim-text';
import {
  assembleParts,
  buildVideoWebm,
  countingSource,
  parseWebm,
  type VideoFixture,
} from '../helpers/webm-video-fixture';

async function scanOf(f: VideoFixture, endMs = 1e9, windowBytes?: number): Promise<{ scan: VideoScan; src: ReturnType<typeof countingSource>; bytes: Uint8Array }> {
  const built = buildVideoWebm(f);
  const src = countingSource(built.bytes);
  const r = await scanWebmVideo(src, endMs, windowBytes);
  if (!r.ok) throw new Error(`走査できなかった: ${r.reason}`);
  return { scan: r.scan, src, bytes: built.bytes };
}

describe('キーフレームの 3 つの印(isKeyFrame)', () => {
  const base = { tag: null, inGroup: false, flagKey: false, ref: false };
  it('🔴 frame tag が読めれば、容器の印が何を言っても tag が勝つ', () => {
    // 容器は「差分」(ReferenceBlock あり / フラグ無し)と言うが、フレーム本体は「キー」
    expect(isKeyFrame({ tag: true, inGroup: true, flagKey: false, ref: true })).toBe(true);
    expect(isKeyFrame({ tag: true, inGroup: false, flagKey: false, ref: false })).toBe(true);
    // 容器は「キー」(ReferenceBlock 無し / フラグ有り)と言うが、フレーム本体は「差分」
    expect(isKeyFrame({ tag: false, inGroup: true, flagKey: false, ref: false })).toBe(false);
    expect(isKeyFrame({ tag: false, inGroup: false, flagKey: true, ref: false })).toBe(false);
  });
  it('🔴 tag が読めなければ、BlockGroup は ReferenceBlock が無いことで言う', () => {
    expect(isKeyFrame({ ...base, inGroup: true, ref: false })).toBe(true);
    expect(isKeyFrame({ ...base, inGroup: true, ref: true })).toBe(false);
    // ⚠ グループの中の Block には旗が立たない ── 旗は見ない(旗が立っていても差分は差分)
    expect(isKeyFrame({ ...base, inGroup: true, ref: true, flagKey: true })).toBe(false);
  });
  it('🔴 tag が読めなければ、SimpleBlock は旗(0x80)で言う', () => {
    expect(isKeyFrame({ ...base, flagKey: true })).toBe(true);
    expect(isKeyFrame({ ...base, flagKey: false })).toBe(false);
    // ⚠ SimpleBlock に ReferenceBlock は付かない ── ref だけでは変わらない
    expect(isKeyFrame({ ...base, flagKey: true, ref: true })).toBe(true);
  });
});

describe('走査(scanWebmVideo)── 3 つの印を fixture 越しに', () => {
  it('🔴 Chrome の形(BlockGroup。frame tag も在る)でキーフレームが読める', async () => {
    const { scan } = await scanOf({ frames: 40, frameMs: 100, keys: [0, 10, 25] });
    expect(scan.keyMs).toEqual([0, 1000, 2500]);
    // ⚠ 次元:キーは複数あり、全フレームがキーではない
    expect(scan.blocks.filter((b) => b.track === scan.videoTrack)).toHaveLength(40);
  });

  it('🔴 印① SimpleBlock の旗だけ(tag が読めない短さ)でも読める', async () => {
    const { scan } = await scanOf({ frames: 30, keys: [0, 10], style: 'simple', tag: false });
    expect(scan.keyMs).toEqual([0, 1000]);
  });

  it('🔴 印② BlockGroup の ReferenceBlock の有無だけ(tag が読めない短さ)でも読める', async () => {
    const { scan } = await scanOf({ frames: 30, keys: [0, 10, 20], style: 'group', tag: false });
    expect(scan.keyMs).toEqual([0, 1000, 2000]);
  });

  it('🔴 印③ 食い違うとき frame tag が勝つ(容器は 2 件嘘をつく)', async () => {
    // フレーム 10 は本当はキーだが、容器は「差分」と言う / フレーム 5 は差分だが、容器は「キー」と言う
    const group = await scanOf({ frames: 30, keys: [0, 10], style: 'group', lieAbout: [5, 10] });
    expect(group.scan.keyMs).toEqual([0, 1000]);
    const simple = await scanOf({ frames: 30, keys: [0, 10], style: 'simple', lieAbout: [5, 10] });
    expect(simple.scan.keyMs).toEqual([0, 1000]);
  });

  it('⚠ 空振り防止 ── 嘘をつく fixture は、tag を外すと本当に食い違う(tag が効いていることの対照群)', async () => {
    const lying = await scanOf({ frames: 30, keys: [0, 10], style: 'group', tag: false, lieAbout: [5, 10] });
    // tag が無ければ容器の嘘がそのまま出る
    expect(lying.scan.keyMs).toEqual([0, 500]);
  });

  it('時刻は先頭を 0 とする(0 から始まらない webm も)', async () => {
    const { scan } = await scanOf({ frames: 20, originMs: 5000 });
    expect(scan.blocks[0]!.ms).toBe(0);
    expect(scan.keyMs[0]).toBe(0);
    expect(scan.clusters[0]!.tcMs).toBe(0);
  });

  it('寸法・track・フレーム間隔・終わりが読める', async () => {
    const { scan } = await scanOf({ frames: 20, frameMs: 40, audioMs: 40 });
    expect([scan.width, scan.height]).toEqual([640, 360]);
    expect([scan.videoTrack, scan.audioTrack]).toEqual([1, 2]);
    expect(scan.frameGapMs).toBe(40);
    expect(scan.sourceEndMs).toBe(800);
  });

  it('🔴 画面が止まって映像のフレームが出なくなっても、録画の終わりは音まで含めて数える(実機の形)', async () => {
    // 実測(Chrome の画面収録 3.3 秒):映像は最初の 0.4 秒に 9 枚だけ・音は最後まで
    const { scan } = await scanOf({ frames: 5, frameMs: 100, tailMs: 3000, audioMs: 60, keys: [0] });
    expect(scan.blocks.filter((b) => b.track === scan.videoTrack).map((b) => b.ms)).toEqual([0, 100, 200, 300, 400]);
    // 映像だけなら 500。音の最後の packet は 3480(=58*60)+60 → 3540
    expect(scan.sourceEndMs, '映像の最後で録画の終わりを決めている').toBe(3540);
    // 押した所が映像の最後のフレームより後ろでも、断らずに先頭のキーフレームへ戻る
    expect(snapVideoStart(scan, 2000)).toEqual({ ok: true, snappedStartMs: 0, snapBackMs: 2000 });
    expect(snapVideoStart(scan, 3600)).toEqual({ ok: false, reason: 'empty-range' });
  });

  it('大きさが既知の Segment / Cluster も読める(不明だけでない)', async () => {
    const unknown = await scanOf({ frames: 25, unknownSizes: true });
    const known = await scanOf({ frames: 25, unknownSizes: false });
    expect(known.scan.keyMs).toEqual(unknown.scan.keyMs);
    expect(known.scan.clusters).toHaveLength(unknown.scan.clusters.length);
    expect(unknown.scan.clusters.length).toBeGreaterThan(1);
  });

  it('🔴 窓を小さくしても同じ索引になる / 1 度に読むのは窓まで(250MB を丸ごと読まない)', async () => {
    const big = await scanOf({ frames: 60, padBytes: 200 }, 1e9, 1 << 20);
    const small = await scanOf({ frames: 60, padBytes: 200 }, 1e9, 96);
    expect(small.scan.blocks).toEqual(big.scan.blocks);
    expect(small.scan.clusters).toEqual(big.scan.clusters);
    // ⚠ 前提:ファイルは小さい窓より十分大きい(空振りでない)
    expect(small.bytes.length).toBeGreaterThan(96 * 20);
    const longest = Math.max(...small.src.reads.map((r) => r.end - r.start));
    expect(longest, '窓より大きく読んでいる').toBeLessThanOrEqual(96);
    expect(small.src.reads.length).toBeGreaterThan(20);
  });

  it('🔴 終わりの後ろの Cluster は読まない(早く止まる)', async () => {
    const all = await scanOf({ frames: 200, frameMs: 100, padBytes: 50 }, 1e9, 512);
    const early = await scanOf({ frames: 200, frameMs: 100, padBytes: 50 }, 3000, 512);
    // 20 秒の録画の 3 秒目までを頼んだ → 余白(2 秒)を足した 5 秒ぶんあたりで止まる
    expect(early.scan.bytesRead).toBeLessThan(all.scan.bytesRead / 2);
    expect(early.scan.sourceEndMs).toBeGreaterThanOrEqual(3000);
    expect(early.scan.clusters.length).toBeLessThan(all.scan.clusters.length);
  });

  it('断る形(どれも理由が値で返る)', async () => {
    const reason = async (f: VideoFixture): Promise<string> => {
      const r = await scanWebmVideo(countingSource(buildVideoWebm(f).bytes), 1e9);
      return r.ok ? 'ok' : r.reason;
    };
    expect(await reason({ videoCodec: 'V_VP9' })).toBe('not-vp8');
    expect(await reason({ audioCodec: 'A_VORBIS' })).toBe('not-opus');
    expect(await reason({ scaleNs: 500_000 })).toBe('timescale');
    // webm ではない
    const junk = await scanWebmVideo(countingSource(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), 1e9);
    expect(junk).toEqual({ ok: false, reason: 'not-webm' });
    // 途中までしか読めない(最後のブロックの途中で切れている)
    const cut = buildVideoWebm({ frames: 20 }).bytes;
    const truncated = await scanWebmVideo(countingSource(cut.subarray(0, cut.length - 3)), 1e9);
    expect(truncated).toEqual({ ok: false, reason: 'broken' });
    for (const text of Object.values(VIDEO_TRIM_REFUSAL_TEXT)) {
      // ⚠ 動画に「録音」と書かない(種類を言い分ける)
      expect(text).not.toContain('録音');
    }
  });

  it('音だけ / 映像だけの形(音 track 無し)も走査できる', async () => {
    const { scan } = await scanOf({ frames: 20, audioMs: 0 });
    expect(scan.audioTrack).toBeNull();
    expect(scan.blocks.every((b) => b.track === scan.videoTrack)).toBe(true);
  });
});

describe('始まりを戻す(snapVideoStart)', () => {
  const keys = [0, 10, 25];
  const make = async (): Promise<VideoScan> => (await scanOf({ frames: 40, frameMs: 100, keys })).scan;

  it('🔴 押した所以下の最も近いキーフレームへ戻り、戻った長さを返す', async () => {
    const scan = await make();
    expect(snapVideoStart(scan, 1500)).toEqual({ ok: true, snappedStartMs: 1000, snapBackMs: 500 });
    expect(snapVideoStart(scan, 2400)).toEqual({ ok: true, snappedStartMs: 1000, snapBackMs: 1400 });
    expect(snapVideoStart(scan, 2600)).toEqual({ ok: true, snappedStartMs: 2500, snapBackMs: 100 });
  });

  it('🔴 キーフレームのちょうど上 / 1ms 後 / 1ms 前', async () => {
    const scan = await make();
    expect(snapVideoStart(scan, 1000)).toEqual({ ok: true, snappedStartMs: 1000, snapBackMs: 0 });
    expect(snapVideoStart(scan, 1001)).toEqual({ ok: true, snappedStartMs: 1000, snapBackMs: 1 });
    expect(snapVideoStart(scan, 999)).toEqual({ ok: true, snappedStartMs: 0, snapBackMs: 999 });
    // ⚠ 次のキーフレームへは進まない(「手前」へ戻る約束)
    const r = snapVideoStart(scan, 2499);
    expect(r.ok && r.snappedStartMs).toBe(1000);
  });

  it('⚠ currentTime * 1000 の端数(999.6 / 1000.4)は 1ms 刻みに丸めて比べる', async () => {
    const scan = await make();
    expect(snapVideoStart(scan, 999.6)).toEqual({ ok: true, snappedStartMs: 1000, snapBackMs: 0 });
    expect(snapVideoStart(scan, 1000.4)).toEqual({ ok: true, snappedStartMs: 1000, snapBackMs: 0 });
    expect(snapVideoStart(scan, 999.4)).toEqual({ ok: true, snappedStartMs: 0, snapBackMs: 999 });
  });

  it('先頭(0)と負の値は 0 のキーフレーム', async () => {
    const scan = await make();
    expect(snapVideoStart(scan, 0)).toEqual({ ok: true, snappedStartMs: 0, snapBackMs: 0 });
    expect(snapVideoStart(scan, -5)).toEqual({ ok: true, snappedStartMs: 0, snapBackMs: 0 });
  });

  it('録画の外(終わり以降)は断る', async () => {
    const scan = await make();
    expect(snapVideoStart(scan, scan.sourceEndMs)).toEqual({ ok: false, reason: 'empty-range' });
    expect(snapVideoStart(scan, Number.NaN)).toEqual({ ok: false, reason: 'empty-range' });
  });

  it('🔴 キーフレームが 1 つだけの録画は、どこを押しても先頭へ戻る', async () => {
    const { scan } = await scanOf({ frames: 40, keys: [0] });
    expect(scan.keyMs).toEqual([0]);
    expect(snapVideoStart(scan, 3500)).toEqual({ ok: true, snappedStartMs: 0, snapBackMs: 3500 });
  });

  it('🔴 最初のキーフレームより手前を押したら、断らずにそのキーフレームへ進める(戻らないので確認も出ない)', async () => {
    const { scan } = await scanOf({ frames: 40, keys: [10] });
    expect(scan.keyMs).toEqual([1000]);
    expect(snapVideoStart(scan, 500)).toEqual({ ok: true, snappedStartMs: 1000, snapBackMs: 0 });
    // 実機の形:音が先に始まり、映像の最初の絵が 10ms 後ろにある録画で 0:00 を押す
    const lead = await scanOf({ frames: 30, videoOffsetMs: 10, keys: [0, 10] });
    expect(lead.scan.keyMs[0]).toBe(10);
    expect(lead.scan.blocks[0]!.track, '前提:音のほうが先に始まる').toBe(lead.scan.audioTrack);
    expect(snapVideoStart(lead.scan, 0)).toEqual({ ok: true, snappedStartMs: 10, snapBackMs: 0 });
    expect(snapConfirm(0, 0).needed).toBe(false);
  });

  it('キーフレームが 1 つも無い録画だけが断られる', async () => {
    const { scan } = await scanOf({ frames: 40, keys: [] });
    expect(scan.keyMs).toEqual([]);
    expect(snapVideoStart(scan, 500)).toEqual({ ok: false, reason: 'broken' });
  });
});

describe('確認の字(snapConfirm)── 文面は 2 通り・切り替えは 1 か所', () => {
  it('🔴 いまの既定(interim):何秒早くなるか・押した所と実際の始まりを言う。ボタンは [切り出す][やめる]', () => {
    const c = snapConfirm(2500, 12_000);
    expect(c.message).toBe('始まりを一番近い区切りに合わせて切り出します。始まりが約 2.5 秒早くなります(0:12 → 0:09)');
    expect([c.okLabel, c.cancelLabel]).toEqual(['切り出す', 'やめる']);
    expect(c.snapBackSec).toBe(2.5);
    // 裁定の文は、この段では事実と合わない(全部のブラウザが戻る)ので既定では出さない
    expect(c.message).not.toContain('お使いのブラウザでは');
  });
  it('🔴 ruled:裁定の文言そのまま(秒の行は既定で足さない / フラグで足せる)', () => {
    const plain = snapConfirm(2500, 12_000, { variant: 'ruled' });
    expect(plain.message).toBe('お使いのブラウザでは先頭を細かく切れません。一番近い区切りから切り出します');
    expect(plain.message).toBe(SNAP_CONFIRM_RULED_TEXT);
    expect(plain.message).not.toMatch(/\d/);
    const withSec = snapConfirm(2500, 12_000, { variant: 'ruled', secondsInRuled: true });
    expect(withSec.message.startsWith(SNAP_CONFIRM_RULED_TEXT)).toBe(true);
    expect(withSec.message).toContain('約 2.5 秒早くなります(0:12 → 0:09)');
    expect([plain.okLabel, plain.cancelLabel]).toEqual(['切り出す', 'やめる']);
  });
  it('🔴 秒の字:10 秒未満は小数 1 桁・以上は整数・戻るのに 0.0 とは出さない', () => {
    expect(snapSecondsText(1500)).toBe('1.5');
    expect(snapSecondsText(9949)).toBe('9.9');
    expect(snapSecondsText(10_000)).toBe('10');
    expect(snapSecondsText(14_600)).toBe('15');
    expect(snapSecondsText(5)).toBe('0.1');
  });
  it('🔴 戻らない(0)なら確認は要らない / 1ms でも戻れば要る', () => {
    expect(snapConfirm(0, 1000).needed).toBe(false);
    expect(snapConfirm(1, 1000).needed).toBe(true);
    expect(snapConfirm(0, 1000, { variant: 'ruled' }).needed).toBe(false);
  });
  it('🔴 済んだ後の一言:戻ったときだけ「押した所より約 N 秒早く始まります」', () => {
    expect(snapDoneNote(2500)).toBe('。押した所より約 2.5 秒早く始まります');
    expect(snapDoneNote(0)).toBe('');
  });
});

describe('lacing・複数バイトの track 番号・Cues(他の muxer の形)', () => {
  it('🔴 lacing の旗(0x02 / 0x04 / 0x06)× SimpleBlock / BlockGroup は全部断る', async () => {
    for (const style of ['simple', 'group'] as const) {
      for (const lacing of [0x02, 0x04, 0x06]) {
        const r = await scanWebmVideo(countingSource(buildVideoWebm({ style, lacing }).bytes), 1e9);
        expect(r, `${style} / lacing ${lacing}`).toEqual({ ok: false, reason: 'lacing' });
      }
    }
    // 対照群:旗が無ければ読める(断りが lacing 以外の理由で成り立っていない)
    for (const style of ['simple', 'group'] as const) {
      expect((await scanWebmVideo(countingSource(buildVideoWebm({ style }).bytes), 1e9)).ok).toBe(true);
    }
  });

  it('🔴 track 番号が 2 バイト(200)でも、読めて・切れて・相対時刻の位置が合う', async () => {
    const built = buildVideoWebm({ frames: 40, frameMs: 100, videoTrack: 200, padBytes: 20 });
    // 前提:ブロックの先頭は 2 バイトの track 番号(0x40 0xc8)
    expect(parseWebm(built.bytes).blocks.filter((b) => b.track === 200)).toHaveLength(40);
    const src = countingSource(built.bytes);
    const s = await scanWebmVideo(src, 1e9);
    if (!s.ok) throw new Error(s.reason);
    expect(s.scan.videoTrack).toBe(200);
    const p = await planVideoTrim(src, s.scan, 1550, 3050);
    if (!p.ok) throw new Error(p.reason);
    expect(p.plan.rebuiltClusters).toBeGreaterThanOrEqual(1);
    const parsed = parseWebm(assembleParts(p.plan.parts, built.bytes));
    const video = parsed.blocks.filter((b) => b.track === 200);
    expect(video.map((b) => b.ms)).toEqual(Array.from({ length: 21 }, (_, k) => k * 100));
    expect(parsed.blocks.filter((b) => b.track === 2).every((b) => b.ms >= 0)).toBe(true);
  });

  it('🔴 末尾の Cues と先頭の SeekHead / Void は出力に持ち込まない・最後の Cluster は Cues を飲み込まない', async () => {
    const built = buildVideoWebm({ frames: 40, frameMs: 100, cues: true });
    const has = (b: Uint8Array, id: number[]): boolean => {
      for (let i = 0; i + id.length <= b.length; i += 1) if (id.every((x, k) => b[i + k] === x)) return true;
      return false;
    };
    // 前提:元には Cues と SeekHead が在る
    expect(has(built.bytes, [0x1c, 0x53, 0xbb, 0x6b])).toBe(true);
    expect(has(built.bytes, [0x11, 0x4d, 0x9b, 0x74])).toBe(true);
    const src = countingSource(built.bytes);
    const s = await scanWebmVideo(src, 1e9);
    if (!s.ok) throw new Error(s.reason);
    const last = s.scan.clusters[s.scan.clusters.length - 1]!;
    expect(last.end, '最後の Cluster が Cues を飲み込んでいる').toBeLessThan(built.bytes.length);
    // 終わりを録画の外にして、最後の Cluster を丸ごとコピーさせる
    const p = await planVideoTrim(src, s.scan, 1000, 99_000);
    if (!p.ok) throw new Error(p.reason);
    expect(p.plan.copiedClusters).toBeGreaterThanOrEqual(1);
    const out = assembleParts(p.plan.parts, built.bytes);
    expect(has(out, [0x1c, 0x53, 0xbb, 0x6b]), '出力に Cues が残っている(指し先がずれる)').toBe(false);
    expect(has(out, [0x11, 0x4d, 0x9b, 0x74]), '出力に SeekHead が残っている').toBe(false);
    expect(parseWebm(out).blocks.filter((b) => b.track === 1)).toHaveLength(30);
  });

  it('🔴 音が先に始まり映像が 10ms 後ろから始まる録画:0:00 を始まりにしても切れる(音は映像の始まり以降)', async () => {
    const built = buildVideoWebm({ frames: 30, frameMs: 100, videoOffsetMs: 10, keys: [0, 10, 20], audioMs: 60 });
    const src = countingSource(built.bytes);
    const s = await scanWebmVideo(src, 1e9);
    if (!s.ok) throw new Error(s.reason);
    const p = await planVideoTrim(src, s.scan, 0, 2000);
    if (!p.ok) throw new Error(`plan: ${p.reason}`);
    expect(p.plan.snappedStartMs).toBe(10);
    expect(p.plan.snapBackMs).toBe(0);
    const parsed = parseWebm(assembleParts(p.plan.parts, built.bytes));
    expect(parsed.blocks.filter((b) => b.track === 1)[0]!.ms).toBe(0);
    // 10ms より前(0ms)の音は残らない
    expect(parsed.blocks.filter((b) => b.track === 2)[0]!.ms).toBe(60 - 10);
  });
});

describe('切り出しの部品の並び(planVideoTrim)', () => {
  /** 切って、別の書き方でほどく。 */
  async function cut(f: VideoFixture, startMs: number, endMs: number) {
    const built = buildVideoWebm(f);
    const src = countingSource(built.bytes);
    const scanned = await scanWebmVideo(src, endMs);
    if (!scanned.ok) throw new Error(scanned.reason);
    const planned = await planVideoTrim(src, scanned.scan, startMs, endMs);
    if (!planned.ok) throw new Error(`plan: ${planned.reason}`);
    const out = assembleParts(planned.plan.parts, built.bytes);
    return { built, plan: planned.plan, out, parsed: parseWebm(out), src };
  }
  const idxOf = (p: number[]): number => p[3]! + p[4]! * 256;

  it('🔴 手前のキーフレームから終わりまで残る / 時刻は 0 起点 / 映像のバイトは 1 つも変わらない', async () => {
    // 40 フレーム(4 秒)、キーは 0, 10, 20, 30。1550ms を押す → 1000ms のキーへ戻る。終わりは 3050ms
    const r = await cut({ frames: 40, frameMs: 100 }, 1550, 3050);
    expect(r.plan.snappedStartMs).toBe(1000);
    expect(r.plan.snapBackMs).toBe(550);
    const video = r.parsed.blocks.filter((b) => b.track === 1);
    // フレーム 10..30(時刻 1000..3000 < 3050)
    expect(video.map((b) => idxOf(b.payload))).toEqual(Array.from({ length: 21 }, (_, k) => 10 + k));
    // 🔴 時刻は K0 を 0 に直してある
    expect(video.map((b) => b.ms)).toEqual(Array.from({ length: 21 }, (_, k) => k * 100));
    // 🔑 映像の中身(tag を含む)は元のまま。キーは先頭の 1 枚だけ
    const original = buildVideoWebm({ frames: 40, frameMs: 100 });
    const origParsed = parseWebm(original.bytes).blocks.filter((b) => b.track === 1);
    expect(video.map((b) => b.payload)).toEqual(origParsed.slice(10, 31).map((b) => b.payload));
    expect(video.filter((b) => (b.payload[0]! & 1) === 0).map((b) => idxOf(b.payload))).toEqual([10, 20, 30]);
    // 差分にだけ ReferenceBlock が残っている
    expect(video.filter((b) => !b.hasRef).map((b) => idxOf(b.payload))).toEqual([10, 20, 30]);
  });

  it('🔴 音は始まり以降・終わりより前の packet だけ(時刻は同じ物差しで 0 起点)', async () => {
    const r = await cut({ frames: 40, frameMs: 100, audioMs: 60 }, 1550, 3050);
    const audio = r.parsed.blocks.filter((b) => b.track === 2);
    const idx = audio.map((b) => b.payload[1]! + (b.payload[2]! << 8));
    // 元の packet i の時刻は 60*i。1000 以上・3050 未満 → i = 17(1020)〜50(3000)
    expect(idx[0]).toBe(17);
    expect(idx[idx.length - 1]).toBe(50);
    expect(audio[0]!.ms).toBe(60 * 17 - 1000);
    expect(audio.every((b) => b.ms >= 0 && b.ms < 3050 - 1000)).toBe(true);
    // ⚠ 次元:音は複数入っている
    expect(audio.length).toBeGreaterThan(20);
  });

  it('🔴 Duration が書かれ、終わりが有限(Infinity にならない)/ Segment の大きさは出力の実寸と合う', async () => {
    const r = await cut({ frames: 40, frameMs: 100 }, 1550, 3050);
    expect(r.parsed.duration).toBe(3050 - 1000);
    expect(r.plan.durationMs).toBe(2050);
    expect(r.parsed.segmentSizeKnown).toBe(true);
    // EBML 頭 + Segment 頭 を除いた実寸 = Segment の大きさ
    const headLen = r.out.length - r.parsed.segmentSize!;
    expect(headLen).toBeGreaterThan(0);
    expect(headLen).toBeLessThan(80);
    expect(r.out.length).toBe(r.plan.byteLength);
  });

  it('🔴 終わりが録画の外なら、Duration は録画の終わりまで', async () => {
    const r = await cut({ frames: 40, frameMs: 100, audioMs: 100 }, 1000, 99_000);
    expect(r.parsed.duration).toBe(4000 - 1000);
  });

  it('🔴 Cluster の Timecode が 0 起点に直る(丸ごと入る Cluster の中身は 1 バイトも触らない)', async () => {
    // Cluster は 1 秒ごと。K0 = 1000 → 出力の Cluster 時刻は 0, 1000, 2000 …
    const r = await cut({ frames: 40, frameMs: 100 }, 1000, 3700);
    // 期待値は元の Cluster 時刻から K0 を引いたもの(元: 1000, 2000, 3000)
    expect(r.parsed.clusterTimecodes.slice(0, 3)).toEqual([0, 1000, 2000]);
    expect(r.plan.copiedClusters).toBeGreaterThanOrEqual(1);
    // 🔑 コピーした Cluster は slice の部品(元のバイトの範囲)
    const slices = r.plan.parts.filter((p) => p.kind === 'slice');
    expect(slices.length).toBeGreaterThan(1);
    // tracks の写し + 丸ごと入る Cluster の本体
    for (const p of slices) {
      if (p.kind !== 'slice') continue;
      expect(p.end).toBeGreaterThan(p.start);
      expect(p.end).toBeLessThanOrEqual(r.built.bytes.length);
    }
  });

  it('🔴 頭と尻の Cluster だけを組み直す(bytes を読むのはその分だけ)', async () => {
    const r = await cut({ frames: 40, frameMs: 100, padBytes: 100 }, 1550, 3050);
    // K0 = 1000 は Cluster(1000〜2000)の先頭 → その Cluster は丸ごと入る。尻の Cluster(3000〜)だけ組み直す
    expect(r.plan.rebuiltClusters).toBe(1);
    expect(r.plan.copiedClusters).toBeGreaterThanOrEqual(2);
    // 組み直しで読んだ bytes は、元の file よりずっと小さい(250MB を丸ごと読まない)
    const rebuiltRead = r.src.reads.filter((x) => x.end - x.start < r.built.bytes.length / 2);
    expect(rebuiltRead.length).toBeGreaterThan(0);
  });

  it('🔴 K0 が Cluster の途中にあるとき、頭の Cluster も組み直され、相対時刻が書き換わる', async () => {
    // Cluster を 2 秒ごとにして、キーを 1000 に置く(Cluster 0〜2000 の途中)
    const r = await cut({ frames: 40, frameMs: 100, clusterMs: 2000, keys: [0, 10, 20, 30] }, 1100, 3500);
    expect(r.plan.snappedStartMs).toBe(1000);
    expect(r.plan.rebuiltClusters).toBeGreaterThanOrEqual(1);
    const video = r.parsed.blocks.filter((b) => b.track === 1);
    expect(video[0]!.ms).toBe(0);
    expect(idxOf(video[0]!.payload)).toBe(10);
    expect(video.map((b) => b.ms)).toEqual(video.map((_, k) => k * 100));
    // 始まりより前の音は残っていない
    expect(r.parsed.blocks.filter((b) => b.track === 2).every((b) => b.ms >= 0)).toBe(true);
  });

  it('🔴 始まりがちょうどキーフレームなら、戻らない(snapBack 0)', async () => {
    const r = await cut({ frames: 40, frameMs: 100 }, 2000, 3000);
    expect(r.plan.snapBackMs).toBe(0);
    expect(parseWebm(r.out).blocks.filter((b) => b.track === 1)[0]!.ms).toBe(0);
  });

  it('🔴 映像のフレームが出ない後半を切っても作れる(止まった画面の録画)', async () => {
    const r = await cut({ frames: 5, frameMs: 100, tailMs: 3000, keys: [0] }, 2000, 3000);
    const video = r.parsed.blocks.filter((b) => b.track === 1);
    // 手前のキーフレーム(先頭)から、映像は 5 枚すべて残る
    expect(video.map((b) => b.ms)).toEqual([0, 100, 200, 300, 400]);
    expect(r.parsed.duration).toBe(3000);
    expect(r.parsed.blocks.filter((b) => b.track === 2).every((b) => b.ms < 3000)).toBe(true);
  });

  it('🔴 Cluster の時刻が最初のブロックより手前にあっても、始まりが 0 になる(丸ごと入る判定は時刻も見る)', async () => {
    // Cluster 1 の Timecode = 900、最初のブロック(= K0)は 1000。ブロックは全部範囲内でも、Timecode を
    // 1000 だけ引くと負になる ── 負は書けない(0 に丸まる)ので、丸ごとコピーすると全体が 100ms ずれる
    const r = await cut({ frames: 40, frameMs: 100, clusterLeadMs: 100, audioMs: 100 }, 1000, 3050);
    expect(r.plan.snappedStartMs).toBe(1000);
    expect(r.parsed.clusterTimecodes[0]).toBe(0);
    const video = r.parsed.blocks.filter((b) => b.track === 1);
    expect(video.map((b) => b.ms)).toEqual(Array.from({ length: 21 }, (_, k) => k * 100));
    expect(r.parsed.blocks.filter((b) => b.track === 2)[0]!.ms).toBe(0);
    // ⚠ 前提:その Cluster は本当に Timecode が手前にある(次元が潰れていない)
    const original = parseWebm(buildVideoWebm({ frames: 40, frameMs: 100, clusterLeadMs: 100 }).bytes);
    expect(original.clusterTimecodes.slice(0, 3)).toEqual([0, 900, 1900]);
  });

  it('始まりと終わりが同じ Cluster の中', async () => {
    const r = await cut({ frames: 40, frameMs: 100 }, 1200, 1500);
    const video = r.parsed.blocks.filter((b) => b.track === 1);
    expect(video.map((b) => idxOf(b.payload))).toEqual([10, 11, 12, 13, 14]);
    expect(r.parsed.duration).toBe(500);
  });

  it('大きさが既知の Cluster を入力にしても、出力は同じ中身', async () => {
    const a = await cut({ frames: 40, unknownSizes: true }, 1550, 3050);
    const b = await cut({ frames: 40, unknownSizes: false }, 1550, 3050);
    expect(b.parsed.blocks).toEqual(a.parsed.blocks);
  });

  it('範囲が逆 / 空 / 録画の外は断る', async () => {
    const built = buildVideoWebm({ frames: 20 });
    const src = countingSource(built.bytes);
    const s = await scanWebmVideo(src, 1e9);
    if (!s.ok) throw new Error('走査');
    expect(await planVideoTrim(src, s.scan, 1000, 1000)).toEqual({ ok: false, reason: 'empty-range' });
    expect(await planVideoTrim(src, s.scan, 1500, 1000)).toEqual({ ok: false, reason: 'empty-range' });
    expect(await planVideoTrim(src, s.scan, 5000, 6000)).toEqual({ ok: false, reason: 'empty-range' });
  });

  it('🔴 時刻が 0 から始まらない webm でも、押した時刻(先頭 = 0)のとおりに切れる', async () => {
    const r = await cut({ frames: 40, originMs: 7000 }, 1550, 3050);
    expect(r.plan.snappedStartMs).toBe(1000);
    expect(r.parsed.blocks.filter((b) => b.track === 1)[0]!.ms).toBe(0);
  });
});
