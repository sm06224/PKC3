/**
 * 🔴 **コンタクトシート**(#952 A5)── 割り付け(pure)と、復号して描く道(偽の WebCodecs / 偽の canvas)。
 *
 * 🔑 空振り防止:復号の偽物は**本物の意味論**(キーフレームから順に渡さないと絵にならない・出力は 1 枚ずつ `close()` する)を
 *   真似る。「手前のキーフレームから復号した」「全部 close した」「場面ごとに別の枠へ描いた」を数で見る。
 */
import { describe, expect, it } from 'vitest';
import {
  evenStarts,
  layoutSheet,
  SHEET,
  sceneText,
  selectScenes,
  transcriptLinesOf,
  wrapByWidth,
} from '../../src/features/capture/contact-sheet-layout';
import { contactSheetVideo, type DrawApi } from '../../src/adapter/platform/video/contact-sheet';
import type { CodecApi, FrameLike } from '../../src/adapter/platform/video/video-codec';
import { buildVideoWebm } from '../helpers/webm-video-fixture';

describe('割り付け', () => {
  it('3 列で折り返し、枠は重ならず、シートの内側に収まる', () => {
    const l = layoutSheet(7, 16 / 9);
    expect(l.cells).toHaveLength(7);
    expect(l.cells[0]!.x).toBe(SHEET.margin);
    expect(l.cells[3]!.x).toBe(SHEET.margin); // 2 行目の頭
    expect(l.cells[3]!.y).toBeGreaterThan(l.cells[0]!.y + l.cells[0]!.h);
    for (const c of l.cells) {
      expect(c.x + c.w).toBeLessThanOrEqual(l.width);
      expect(c.captionY + SHEET.captionH).toBeLessThanOrEqual(l.height + SHEET.captionH);
    }
    const last = l.cells.at(-1)!;
    expect(last.y + last.h + SHEET.captionH).toBeLessThanOrEqual(l.height);
    // 枠どうしが重ならない(絵 + 欄を 1 つの縦長の箱として)
    for (let i = 0; i < l.cells.length; i += 1)
      for (let j = i + 1; j < l.cells.length; j += 1) {
        const a = l.cells[i]!;
        const b = l.cells[j]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h + SHEET.captionH && b.y < a.y + a.h + SHEET.captionH;
        expect(overlap, `${String(i)} と ${String(j)} が重なる`).toBe(false);
      }
  });

  it('1〜2 場面なら列を減らし(余白だけの幅にしない)、縦横比が絵の高さを決める', () => {
    expect(layoutSheet(1, 2).cells[0]!.h).toBe(160);
    expect(layoutSheet(1, 1).cells[0]!.h).toBe(320);
    expect(layoutSheet(2, 2).width).toBe(SHEET.margin * 2 + 2 * SHEET.thumbW + SHEET.gap);
  });

  it('場面が多すぎるときは先頭と末尾を残して均等に間引く', () => {
    const many = Array.from({ length: 100 }, (_, i) => i * 1000);
    const picked = selectScenes(many);
    expect(picked).toHaveLength(SHEET.maxScenes);
    expect(picked[0]).toBe(0);
    expect(picked.at(-1)).toBe(99_000);
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
    expect(selectScenes([0, 5000])).toEqual([0, 5000]);
  });

  it('均等割りは 0 から始まり昇順', () => {
    expect(evenStarts(60_000, 6)).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000]);
    expect(evenStarts(0, 6)).toEqual([0]);
  });
});

describe('文字起こしの拾い方', () => {
  const body = [
    '---',
    '説明',
    '## 文字起こし 2026-10-02 12:34',
    '0:00 こんにちは',
    '0:15 今日は晴れです',
    '## チャプター',
    '0:00 チャプター 1',
    '0:23 チャプター 2',
    '## 話者',
    '0:00 話者A',
    '本文の途中の 14:00 は時刻ではない',
    '1:75 ありえない',
  ].join('\n');

  it('時刻つきの文字起こしだけを拾い、チャプター・話者の行・不正な綴りは除く', () => {
    expect(transcriptLinesOf(body)).toEqual([
      { ms: 0, text: 'こんにちは' },
      { ms: 15_000, text: '今日は晴れです' },
    ]);
  });

  it('場面の範囲(頭以上・次の頭未満)で文字をつなぐ', () => {
    const lines = transcriptLinesOf(body);
    expect(sceneText([0, 15_000], 0, lines)).toBe('こんにちは');
    expect(sceneText([0, 15_000], 1, lines)).toBe('今日は晴れです');
    expect(sceneText([0, 30_000], 0, lines)).toBe('こんにちは 今日は晴れです');
    expect(sceneText([0, 20_000, 30_000], 2, lines)).toBe('');
  });
});

describe('折り返し', () => {
  const measure = (s: string): number => [...s].length * 10;
  it('幅で折り、行数を超えたら最後の行を「…」で切る', () => {
    expect(wrapByWidth('あいうえおかきくけこ', 50, measure, 5)).toEqual(['あいうえお', 'かきくけこ']);
    const cut = wrapByWidth('あいうえおかきくけこさしすせそ', 50, measure, 2);
    expect(cut).toHaveLength(2);
    expect(cut[1]!.endsWith('…')).toBe(true);
    expect(measure(cut[1]!)).toBeLessThanOrEqual(50);
    expect(wrapByWidth('', 50, measure, 3)).toEqual([]);
  });
});

/** 偽の WebCodecs:キーフレームから順に渡された分だけ出力する。出力は 1 枚ずつ close される。 */
function fakeCodec() {
  const log = { decoded: [] as string[], opened: 0, closed: 0, configured: 0, closedDecoder: 0 };
  const api: CodecApi = {
    createEncoder: () => {
      throw new Error('符号化は使わない');
    },
    createDecoder: (init) => {
      let needKey = true;
      return {
        decodeQueueSize: 0,
        onDequeue: () => {},
        configure: () => {
          log.configured += 1;
        },
        decode: (c) => {
          if (needKey && c.type !== 'key') {
            init.error(new Error('キーフレームから始まっていない'));
            return;
          }
          needKey = false;
          log.decoded.push(`${c.type}@${String(c.timestamp / 1000)}`);
          log.opened += 1;
          const f: FrameLike = {
            timestamp: c.timestamp,
            close: () => {
              log.closed += 1;
            },
          };
          init.output(f);
        },
        flush: async () => {
          needKey = true; // 本物と同じ:flush のあとは次のキーフレームから
        },
        close: () => {
          log.closedDecoder += 1;
        },
      };
    },
    makeProbeFrame: () => {
      throw new Error('使わない');
    },
  };
  return { api, log };
}

function fakeDraw() {
  const log = { frames: [] as { ts: number; x: number; y: number }[], texts: [] as string[], size: [0, 0] };
  const draw: DrawApi = {
    create: (w, h) => {
      log.size = [w, h];
      return {
        fill: () => {},
        frame: (f, x, y) => {
          log.frames.push({ ts: f.timestamp, x, y });
        },
        text: (s) => {
          log.texts.push(s);
        },
        measure: (s) => [...s].length * 7,
        toPng: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
      };
    },
  };
  return { draw, log };
}

describe('復号して描く(contactSheetVideo)', () => {
  // 100ms ごと 400 枚。キーフレーム 0/100/200/300、150 と 300 だけ大きな変化 → 場面の頭は 0 / 15 秒 / 30 秒
  const built = buildVideoWebm({
    frames: 400,
    frameMs: 100,
    keys: [0, 100, 200, 300],
    padFor: (i: number) => (i === 150 || i === 300 ? 1500 : 0),
  });
  const blob = new Blob([built.bytes]);

  it('🔴 場面ごとに「手前のキーフレームから場面の 1 枚まで」だけ復号し、別々の枠へ描き、全フレームを close する', async () => {
    const codec = fakeCodec();
    const d = fakeDraw();
    const r = await contactSheetVideo(
      { blob, lines: [{ ms: 0, text: 'はじめに' }, { ms: 16_000, text: '二つ目の話' }], title: '画面録画.webm' },
      codec.api,
      d.draw,
    );
    expect(r).toMatchObject({ ok: true, scenes: 3, withText: 2 });
    // 復号:場面 0 はキー 1 枚、場面 1(15 秒)はキー(10 秒)から 15 秒まで 51 枚、場面 2(30 秒)はキー 1 枚
    expect(codec.log.decoded).toHaveLength(1 + 51 + 1);
    expect(codec.log.decoded[0]).toBe('key@0');
    expect(codec.log.decoded[1]).toBe('key@10000');
    expect(codec.log.decoded[51]).toBe('delta@15000');
    expect(codec.log.decoded[52]).toBe('key@30000');
    // 描いたのは場面の 1 枚だけ・3 つの別々の枠
    expect(d.log.frames.map((f) => f.ts)).toEqual([0, 15_000_000, 30_000_000]);
    expect(new Set(d.log.frames.map((f) => `${String(f.x)},${String(f.y)}`)).size).toBe(3);
    // 🔑 ゼロコピー・即破棄:開いたフレームは全部閉じ、復号器も閉じた
    expect(codec.log.closed).toBe(codec.log.opened);
    expect(codec.log.closedDecoder).toBe(1);
    // 文字は場面ごと、見出しは元の名前
    expect(d.log.texts).toContain('画面録画.webm');
    expect(d.log.texts).toContain('はじめに');
    expect(d.log.texts).toContain('二つ目の話');
    expect(d.log.texts).toContain('0:15');
    if (r.ok) expect(r.blob.type).toBe('image/png');
  });

  it('場面が刻めない動画は均等に 6 枚取る', async () => {
    const calm = buildVideoWebm({ frames: 400, frameMs: 100, keys: [0, 100, 200, 300], padFor: () => 0 });
    const codec = fakeCodec();
    const d = fakeDraw();
    const r = await contactSheetVideo({ blob: new Blob([calm.bytes]), lines: [], title: 't' }, codec.api, d.draw);
    expect(r).toMatchObject({ ok: true, scenes: 6, withText: 0 });
    expect(d.log.frames).toHaveLength(6);
  });

  it('🔴 WebCodecs / 描く道具が無い環境は作らず理由を返す。復号が落ちたら decode-failed(部分的な絵を出さない)', async () => {
    const d = fakeDraw();
    expect(await contactSheetVideo({ blob, lines: [], title: 't' }, null, d.draw)).toEqual({ ok: false, reason: 'no-codec' });
    expect(await contactSheetVideo({ blob, lines: [], title: 't' }, fakeCodec().api, null)).toEqual({ ok: false, reason: 'no-codec' });
    const broken: CodecApi = {
      ...fakeCodec().api,
      createDecoder: (init) => ({
        decodeQueueSize: 0,
        onDequeue: () => {},
        configure: () => {},
        decode: () => init.error(new Error('壊れた')),
        flush: async () => {},
        close: () => {},
      }),
    };
    expect(await contactSheetVideo({ blob, lines: [], title: 't' }, broken, fakeDraw().draw)).toEqual({ ok: false, reason: 'decode-failed' });
    expect(await contactSheetVideo({ blob: new Blob([new Uint8Array(30)]), lines: [], title: 't' }, fakeCodec().api, fakeDraw().draw)).toMatchObject({ ok: false });
  });
});
