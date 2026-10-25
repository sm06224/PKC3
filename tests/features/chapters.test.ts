/**
 * 🔴 **チャプターを刻む**(#952 A4)。場面の変わり目(動画)・無音の区切れ(音)。
 *
 * 🔑 空振り防止:各 fixture に「刻まれるべき所」と「刻まれてはいけない所(細かすぎる・短い静けさ・小さな動き)」の
 *   両方を入れ、期待値は手で数えた固定値(実装と同じ式で作らない)。
 */
import { describe, expect, it } from 'vitest';
import {
  chaptersHeading,
  chaptersText,
  sceneStartsFromFrames,
  silenceChapterStarts,
  windowRms,
  type FrameInfo,
} from '../../src/features/capture/chapters';
import { scenesVideo } from '../../src/adapter/platform/video/video-codec';
import { readFileSync } from 'node:fs';
import { buildVideoWebm } from '../helpers/webm-video-fixture';

const f = (ms: number, bytes: number, key = false): FrameInfo => ({ ms, bytes, key });

describe('場面の変わり目(sceneStartsFromFrames)', () => {
  it('🔴 長く動いていなかったあとの大きなフレームが場面の頭になる(0 は必ず先頭)', () => {
    const frames = [
      f(0, 9000, true), // 最初の絵
      f(100, 30), f(200, 30), f(300, 30), // 静止
      f(15_000, 5000), // 14.7 秒止まったあとの大きな変化 → 場面 2
      f(15_100, 40),
      f(40_000, 8000), // 25 秒止まったあとの大きな変化 → 場面 3
    ];
    expect(sceneStartsFromFrames(frames)).toEqual([0, 15_000, 40_000]);
  });

  it('動き続けているだけでは刻まない(静止が 2 秒に満たない / 変化が小さい)', () => {
    const busy = [f(0, 9000, true), ...Array.from({ length: 50 }, (_, i) => f((i + 1) * 500, 3000))];
    expect(sceneStartsFromFrames(busy), '動き続けているのに刻んだ').toEqual([0]);
    const small = [f(0, 9000, true), f(30_000, 400)];
    expect(sceneStartsFromFrames(small), '小さな変化で刻んだ').toEqual([0]);
  });

  it('🔴 細かすぎる刻みは間引く(直前から minGapMs 未満の頭は採らない)', () => {
    const frames = [f(0, 9000, true), f(4000, 5000), f(8000, 5000), f(30_000, 5000)];
    // 4 秒・8 秒はどれも 2 秒以上止まったあとの変化だが、0 から 10 秒未満なので採らない。30 秒は採る
    expect(sceneStartsFromFrames(frames)).toEqual([0, 30_000]);
    expect(sceneStartsFromFrames(frames, { minGapMs: 1000 })).toEqual([0, 4000, 8000, 30_000]);
  });

  it('🔴 周期的なキーフレーム(静止していても一定の間隔で出る)は、静止を中断しない ── 大きさが同じなら変わり目にもしない', () => {
    // 1.5 秒ごとにほぼ同じ大きさ(6000 バイト前後)のキーフレーム、差分は小さい。10 秒に大きな差分
    const frames: FrameInfo[] = [];
    for (let t = 0; t < 20_000; t += 100) {
      const key = t % 1500 === 0;
      frames.push(f(t, key ? 6000 + (t % 3) * 50 : t === 10_000 ? 5000 : 30, key));
    }
    expect(sceneStartsFromFrames(frames), '周期的なキーフレームで静止が切れて場面が見つからない / キーフレームを変わり目にした').toEqual([0, 10_000]);
  });

  it('🔴 大きさが 1.5 倍以上変わったキーフレーム(絵の入れ替わり)は変わり目。小さいままのキーフレームは変わり目にしない', () => {
    const frames: FrameInfo[] = [f(0, 800, true)];
    for (let t = 100; t < 20_000; t += 100) frames.push(f(t, t === 4500 ? 5000 : t === 9000 ? 700 : 30, t === 4500 || t === 9000));
    // 4.5 秒: 800 → 5000(6 倍)で変わり目 / 9 秒: 5000 → 700(小さくなった)は changeBytes 未満なので変わり目にしない
    expect(sceneStartsFromFrames(frames, { minGapMs: 1000 })).toEqual([0, 4500]);
  });

  it('🔴 実際の libvpx の出力(静止 11 秒 → 動く 1 秒 → 静止 3 秒。キーフレーム 1.5 秒ごと)で、動き出しが場面の頭になる', async () => {
    const bytes = readFileSync('tests/fixtures/vp8/screen-still-motion-still.webm');
    const r = await scenesVideo({ blob: new Blob([bytes]) });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.startsMs).toEqual([0, 11_000]);
  });

  it('映像が空(フレームが 0 枚)でも先頭の 0 だけを返す', () => {
    expect(sceneStartsFromFrames([])).toEqual([0]);
  });
});

describe('無音の区切れ(silenceChapterStarts)', () => {
  const RATE = 8000;
  /** 秒ごとの [大きさ] を並べた PCM(一定の大きさの正弦の代わりに定数。RMS が大きさそのものになる)。 */
  const pcmOf = (levels: readonly number[]): Float32Array => {
    const out = new Float32Array(levels.length * RATE);
    levels.forEach((v, s) => out.fill(v, s * RATE, (s + 1) * RATE));
    return out;
  };

  it('🔴 2 秒以上の静けさのあとに声が戻る所が頭になる。1 秒の静けさでは刻まない', () => {
    const talk = (n: number): number[] => Array.from({ length: n }, () => 0.3);
    const quiet = (n: number): number[] => Array.from({ length: n }, () => 0.001);
    // 声 20 秒 → 静け 3 秒 → 声 20 秒 → 静け 1 秒 → 声 20 秒 → 静け 4 秒 → 声 5 秒
    const pcm = pcmOf([...talk(20), ...quiet(3), ...talk(20), ...quiet(1), ...talk(20), ...quiet(4), ...talk(5)]);
    expect(silenceChapterStarts(pcm, RATE)).toEqual([0, 23_000, 68_000]);
    // 前提:窓の大きさは声の所と静けさの所で明確に違う(基準が働いている)
    const rms = windowRms(pcm, RATE, 50);
    expect(Math.max(...rms)).toBeGreaterThan(0.25);
    expect(rms[21 * 20]).toBeLessThan(0.01);
  });

  it('全部無音の録音・短い録音は 0 だけ。声の直後の静けさ(終わりの無音)は頭にしない', () => {
    expect(silenceChapterStarts(new Float32Array(RATE * 30), RATE)).toEqual([0]);
    expect(silenceChapterStarts(new Float32Array(0), RATE)).toEqual([0]);
    const tail = pcmOf([...Array.from({ length: 20 }, () => 0.3), ...Array.from({ length: 5 }, () => 0.001)]);
    expect(silenceChapterStarts(tail, RATE)).toEqual([0]);
  });
});

describe('本文に足す字', () => {
  it('行頭は文字起こしと同じ綴りの経過(押すと再生する)、見出しは日時つき', () => {
    expect(chaptersText([0, 23_000, 3_723_000])).toBe('0:00 チャプター 1\n0:23 チャプター 2\n1:02:03 チャプター 3');
    expect(chaptersHeading(new Date(2026, 9, 5, 7, 8))).toBe('## チャプター 2026-10-05 07:08');
  });
});

describe('動画のワーカーの口(scenesVideo)', () => {
  it('Blob の VP8 動画から場面の頭を返す(往復)。壊れた file は理由が値で返る', async () => {
    // 100ms ごと 400 枚。差分は 5 バイト(静止)で、150 枚目・300 枚目だけ大きな変化(1500 バイト超)
    const built = buildVideoWebm({
      frames: 400,
      frameMs: 100,
      keys: [0],
      padFor: (i: number) => (i === 0 ? 300 : i === 150 || i === 300 ? 1500 : 0),
    });
    const r = await scenesVideo({ blob: new Blob([built.bytes]) });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.startsMs).toEqual([0, 15_000, 30_000]);
    expect(await scenesVideo({ blob: new Blob([new Uint8Array(32)]) })).toMatchObject({ ok: false });
  });
});
