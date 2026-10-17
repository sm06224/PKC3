/**
 * 🔴 **動画から音だけ / 絵だけを取り出す**(#952 A1。裁定済み = 元の添付は残す)。
 *
 * ⚠ fixture は**手で組む**(`tests/helpers/webm-video-fixture.ts`。実装の書き手を使わない)。
 *   出力は**別の書き方**でほどく(`parseWebm`)。取り出した音は**実装のほどき(`demuxWebmOpus`)にもう一度かける**
 *   (= 「再び demux できる」が往復の検算)。
 * 🔑 空振り防止:元の動画は**音の packet と映像のフレームの両方を持ち、音が映像の間に挟まっている**ことを
 *   test 自身が assert する(挟まっていないと「隣り合う部分の束ね」を通らない)。
 */
import { describe, expect, it } from 'vitest';
import { demuxWebmOpus, extractWebmOpusAudio, TRIM_REFUSAL_TEXT } from '../../src/features/audio/webm-opus';
import { planPictureOnly, scanWebmVideo } from '../../src/features/video/webm-vp8';
import { canExtractFromVideo } from '../../src/features/capture/capture-trim-gate';
import { captureItemsFrom } from '../../src/features/capture/capture-item';
import { extractedCaptureName } from '../../src/features/audio/trim-text';
import { assembleParts, buildVideoWebm, countingSource, parseWebm } from '../helpers/webm-video-fixture';
import { runAudioJob } from '../../src/adapter/platform/audio/audio-codec';
import { pictureOnlyVideo } from '../../src/adapter/platform/video/video-codec';

const ascii = (s: string): number[] => s.split('').map((c) => c.charCodeAt(0));
const contains = (hay: Uint8Array, needle: string): boolean => {
  const n = ascii(needle);
  outer: for (let i = 0; i + n.length <= hay.length; i += 1) {
    for (let j = 0; j < n.length; j += 1) if (hay[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
};

/** 映像 40 枚(100ms)+ 音 60ms ごと。1 秒ごとに Cluster を切る。 */
const FIXTURE = { frames: 40, frameMs: 100, audioMs: 60 } as const;

describe('音だけ取り出す(extractWebmOpusAudio)', () => {
  it('🔴 取り出した音の webm は、もう一度ほどける ── packet が元の音と同じ数・同じ中身・同じ時刻', () => {
    const built = buildVideoWebm(FIXTURE);
    const original = demuxWebmOpus(built.bytes);
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    // 前提(空振り防止):元は映像も持つ動画で、音の packet が複数ある
    const parsed = parseWebm(built.bytes);
    expect(parsed.blocks.some((b) => b.track === 1), '前提: 映像が無い').toBe(true);
    expect(original.source.packets.length).toBeGreaterThan(10);

    const out = extractWebmOpusAudio(built.bytes);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const again = demuxWebmOpus(out.result.bytes);
    expect(again.ok, '取り出した音をもう一度ほどけない').toBe(true);
    if (!again.ok) return;
    expect(again.source.packets).toHaveLength(original.source.packets.length);
    expect(again.source.packets.map((p) => Array.from(p.data))).toEqual(
      original.source.packets.map((p) => Array.from(p.data)),
    );
    expect(again.source.packets.map((p) => Math.round(p.ms))).toEqual(
      original.source.packets.map((p) => Math.round(p.ms)),
    );
  });

  it('🔴 映像は入らない ── 出力に映像のトラックの宣言も、映像のブロックも無い', () => {
    const built = buildVideoWebm(FIXTURE);
    const out = extractWebmOpusAudio(built.bytes);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 対照群:元には映像の宣言がある(無ければ「入らない」は何も言わない)
    expect(contains(built.bytes, 'V_VP8'), '前提: 元に映像の宣言が無い').toBe(true);
    expect(contains(out.result.bytes, 'V_VP8'), '映像の宣言が残っている').toBe(false);
    const blocks = parseWebm(out.result.bytes).blocks;
    expect(blocks.length).toBeGreaterThan(0);
    // 出力のトラック番号は 1 つだけ(音)
    expect(new Set(blocks.map((b) => b.track)).size).toBe(1);
    // 映像の中身(framePayload の先頭バイト)が混ざっていない:音の中身は 0xc0 で始まる
    expect(blocks.every((b) => b.payload[0] === 0xc0)).toBe(true);
  });

  it('音が入っていない動画は、理由つきで断る(黙って空の file を作らない)', () => {
    const silent = buildVideoWebm({ frames: 20, audioMs: 0 });
    const out = extractWebmOpusAudio(silent.bytes);
    // 音のトラックが無い動画は「opus の音が見つからない」で返る(別の形式の音の動画と同じ理由)
    expect(out).toEqual({ ok: false, reason: 'not-opus' });
    expect(TRIM_REFUSAL_TEXT['not-opus']).toBeTruthy();
  });

  it('WebM でない bytes は断る', () => {
    expect(extractWebmOpusAudio(new Uint8Array([1, 2, 3, 4]))).toEqual({ ok: false, reason: 'not-webm' });
  });

  it('🔴 取り出した音をもう一度取り出しても同じ(CodecDelay を持つ file でも長さがずれない)', () => {
    const first = extractWebmOpusAudio(buildVideoWebm(FIXTURE).bytes);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = extractWebmOpusAudio(first.result.bytes);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.keptPackets).toBe(first.result.keptPackets);
    expect(second.result.durationMs).toBeCloseTo(first.result.durationMs, 3);
  });
});

describe('絵だけ取り出す(planPictureOnly)', () => {
  async function pictureOf(f: Parameters<typeof buildVideoWebm>[0]) {
    const built = buildVideoWebm(f);
    const src = countingSource(built.bytes);
    const scanned = await scanWebmVideo(src, Number.POSITIVE_INFINITY);
    if (!scanned.ok) throw new Error(`走査できなかった: ${scanned.reason}`);
    const planned = await planPictureOnly(src, scanned.scan);
    if (!planned.ok) throw new Error(`組めなかった: ${planned.reason}`);
    const out = assembleParts(planned.plan.parts, built.bytes);
    return { built, scan: scanned.scan, plan: planned.plan, out };
  }

  it('🔴 音のトラックが無い ── 宣言も、ブロックも', async () => {
    const { built, out, plan } = await pictureOf(FIXTURE);
    // 前提(空振り防止):元には音の宣言とブロックがあり、音は映像の間に挟まっている
    expect(contains(built.bytes, 'A_OPUS'), '前提: 元に音の宣言が無い').toBe(true);
    const origBlocks = parseWebm(built.bytes).blocks;
    expect(origBlocks.filter((b) => b.track === 2).length, '前提: 音のブロックが無い').toBeGreaterThan(10);
    expect(plan.droppedAudio).toBe(origBlocks.filter((b) => b.track === 2).length);

    expect(contains(out, 'A_OPUS'), '音の宣言が残っている').toBe(false);
    const blocks = parseWebm(out).blocks;
    expect(blocks.some((b) => b.track === 2), '音のブロックが残っている').toBe(false);
    // 出力を実装の走査にかけても、音のトラックは無い
    const again = await scanWebmVideo(countingSource(out), Number.POSITIVE_INFINITY);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.scan.audioTrack).toBeNull();
  });

  it('🔴 映像は 1 枚も変わらない ── 枚数・時刻・中身・キーフレームの印が元と同じ', async () => {
    const { built, out } = await pictureOf(FIXTURE);
    const before = parseWebm(built.bytes).blocks.filter((b) => b.track === 1);
    const after = parseWebm(out).blocks;
    expect(before).toHaveLength(40); // 前提
    expect(after).toHaveLength(before.length);
    expect(after.map((b) => b.ms)).toEqual(before.map((b) => b.ms));
    expect(after.map((b) => b.payload)).toEqual(before.map((b) => b.payload));
    expect(after.map((b) => b.hasRef)).toEqual(before.map((b) => b.hasRef));
  });

  it('🔴 時刻が 0 から始まらない動画でも、映像の時刻は元の並びのまま(Cluster の時刻を 0 起点に直す)', async () => {
    const { built, out } = await pictureOf({ ...FIXTURE, originMs: 5000 });
    const before = parseWebm(built.bytes).blocks.filter((b) => b.track === 1);
    const after = parseWebm(out).blocks;
    // 先頭を 0 に揃える(元は 5000 から)── 差が一定であることを見る
    const shift = before[0]!.ms - after[0]!.ms;
    expect(shift).toBe(5000);
    expect(after.map((b) => b.ms + shift)).toEqual(before.map((b) => b.ms));
  });

  it('🔴 元の bytes は 1 バイトも変えない(元は残る)', async () => {
    const built = buildVideoWebm(FIXTURE);
    const copy = built.bytes.slice();
    const src = countingSource(built.bytes);
    const scanned = await scanWebmVideo(src, Number.POSITIVE_INFINITY);
    if (!scanned.ok) throw new Error('走査できなかった');
    await planPictureOnly(src, scanned.scan);
    expect(Array.from(built.bytes)).toEqual(Array.from(copy));
  });

  it('映像の宣言が出力の Tracks にある ── 寸法も寸法のまま', async () => {
    const { out } = await pictureOf(FIXTURE);
    const again = await scanWebmVideo(countingSource(out), Number.POSITIVE_INFINITY);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect([again.scan.width, again.scan.height]).toEqual([640, 360]);
  });

  it('音が無い動画の絵だけは、そのまま映像だけの動画になる(落とした音は 0)', async () => {
    const { plan, out } = await pictureOf({ frames: 20, audioMs: 0 });
    expect(plan.droppedAudio).toBe(0);
    expect(parseWebm(out).blocks).toHaveLength(20);
  });
});

describe('ワーカーの中身(その場で回しても同じ結果)', () => {
  it('音だけ: runAudioJob({ whole }) が bytes を返し、範囲を持つ依頼とは別の道を通る', async () => {
    const built = buildVideoWebm(FIXTURE);
    const r = await runAudioJob({ blob: new Blob([built.bytes]), whole: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(demuxWebmOpus(new Uint8Array(r.bytes)).ok).toBe(true);
    // 対照群:範囲つきの依頼は範囲だけ(全部ではない)
    const part = await runAudioJob({ blob: new Blob([built.bytes]), startMs: 600, endMs: 1200 });
    expect(part.ok).toBe(true);
    if (part.ok) expect(part.keptPackets).toBeLessThan(r.keptPackets);
  });

  it('絵だけ: pictureOnlyVideo は元の部品を指す Blob を返し、断る理由は値で返る', async () => {
    const built = buildVideoWebm(FIXTURE);
    const r = await pictureOnlyVideo({ blob: new Blob([built.bytes]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.blob.type).toBe('video/webm');
    expect(r.keptVideo).toBe(40);
    expect(r.droppedAudio).toBeGreaterThan(0);
    const bad = await pictureOnlyVideo({ blob: new Blob([new Uint8Array([1, 2, 3])]) });
    expect(bad.ok).toBe(false);
  });
});

describe('押し所の門(canExtractFromVideo)と名前', () => {
  const item = (mime: string, kindName = '録画.webm', key: string | null = 'k') =>
    captureItemsFrom([
      {
        lid: 'x',
        title: 'x',
        body: [
          '---',
          `attachment.name: ${kindName}`,
          `attachment.mime: ${mime}`,
          'attachment.size: 10',
          ...(key === null ? [] : [`attachment.asset_key: ${key}`]),
          '---',
          '',
        ].join('\n'),
      },
    ])[0]!;

  it('動画(VP8 + opus の webm)には 2 つとも出る', () => {
    const v = item('video/webm;codecs=vp8,opus');
    expect(v.kind).toBe('video'); // 前提
    expect(canExtractFromVideo(v, 'audio')).toBe(true);
    expect(canExtractFromVideo(v, 'picture')).toBe(true);
  });

  it('音の添付には出ない(音だけの物から音だけを取り出しても同じ物ができる)', () => {
    const a = item('audio/webm', '録音.webm');
    expect(a.kind).toBe('audio'); // 前提
    expect(canExtractFromVideo(a, 'audio')).toBe(false);
    expect(canExtractFromVideo(a, 'picture')).toBe(false);
  });

  it('中身の鍵が無い行・webm でない動画には出ない', () => {
    expect(canExtractFromVideo(item('video/webm', '録画.webm', null), 'audio')).toBe(false);
    expect(canExtractFromVideo(item('video/mp4', '録画.mp4'), 'audio')).toBe(false);
    expect(canExtractFromVideo(item('video/mp4', '録画.mp4'), 'picture')).toBe(false);
  });

  it('🔴 codecs が書かれていて、音(opus)が無ければ「音だけ」は出ない / VP8 でなければ「絵だけ」は出ない', () => {
    const silent = item('video/webm;codecs=vp8');
    expect(canExtractFromVideo(silent, 'audio')).toBe(false);
    expect(canExtractFromVideo(silent, 'picture')).toBe(true);
    const vp9 = item('video/webm;codecs=vp9,opus');
    expect(canExtractFromVideo(vp9, 'audio')).toBe(true);
    expect(canExtractFromVideo(vp9, 'picture')).toBe(false);
  });

  it('名前は元の名前 + 「(音だけ)」「(絵だけ)」を拡張子の前に入れる', () => {
    expect(extractedCaptureName('画面収録-2026-09-12-143000.webm', 'audio')).toBe('画面収録-2026-09-12-143000 (音だけ).webm');
    expect(extractedCaptureName('画面収録-2026-09-12-143000.webm', 'picture')).toBe('画面収録-2026-09-12-143000 (絵だけ).webm');
    // 拡張子が無い名前 / 先頭が . の名前
    expect(extractedCaptureName('録画', 'audio')).toBe('録画 (音だけ)');
    expect(extractedCaptureName('.hidden', 'picture')).toBe('.hidden (絵だけ)');
  });
});
