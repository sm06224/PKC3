// @vitest-environment node
/**
 * 🔴 **声の仕上げの実行**(#952 B1・#674・B5)── opus への書き出し(`audio-encode.ts`)とワーカーの中身(`voice-run.ts`)。
 *
 * 本物の RNNoise(wasm)+ 偽の opus 符号化器(本物の意味論を真似る:1 秒ずつ受け、20ms の packet を返す。受けた `AudioData` は
 * 呼び側が `close()` するまで開いたまま)。出力の WebM は**実装のほどき(`demuxWebmOpus`)にかけ直して**往復を確かめる。
 */
import { describe, expect, it } from 'vitest';
import { encodeOpusWebm, ENCODE_RATE, type AudioApi, type AudioDataLike } from '../../src/adapter/platform/voice/audio-encode';
import { VoiceRunner, type EngineHandle } from '../../src/adapter/platform/voice/voice-run';
import { demuxWebmOpus, muxOpusWebm, opusHead, preSkipOf } from '../../src/features/audio/webm-opus';
import { VOICE_RATE } from '../../src/features/audio/voice-lab';
import { concat, mix, realEngine, synthVoice, whiteNoise } from '../helpers/rnnoise-engine';

/** 偽の AudioEncoder。入力 1 秒 → 50 個の 20ms packet(packet の中身は通し番号)。 */
function fakeAudio(over: { preSkip?: number | null; supported?: boolean; failAt?: number } = {}) {
  const log = { opened: 0, closed: 0, encodedSamples: 0, chunks: [] as number[], closedEncoder: 0, packets: 0 };
  const api: AudioApi = {
    supported: async () => over.supported ?? true,
    makeData: (samples, rate, ts) => {
      log.opened += 1;
      log.chunks.push(samples.length);
      expect(rate).toBe(ENCODE_RATE);
      expect(ts).toBe(Math.round((log.encodedSamples * 1e6) / ENCODE_RATE));
      log.encodedSamples += samples.length;
      const d: AudioDataLike & { n: number } = {
        n: samples.length,
        close: () => {
          log.closed += 1;
        },
      };
      return d;
    },
    createEncoder: (init) => {
      let produced = 0;
      let first = true;
      return {
        encodeQueueSize: 0,
        configure: () => {},
        encode: (data) => {
          const n = (data as unknown as { n: number }).n;
          const packets = Math.ceil(n / 960);
          for (let i = 0; i < packets; i += 1) {
            if (over.failAt !== undefined && produced === over.failAt) {
              init.error(new Error('符号化に失敗'));
              return;
            }
            const description = first && over.preSkip !== null ? opusHead(1, over.preSkip ?? 312) : null;
            first = false;
            log.packets += 1;
            init.output({ timestamp: produced * 20_000, duration: 20_000, data: Uint8Array.of(produced & 0xff, 1, 2), description });
            produced += 1;
          }
        },
        flush: async () => {},
        close: () => {
          log.closedEncoder += 1;
        },
      };
    },
  };
  return { api, log };
}

describe('opus の WebM へ(encodeOpusWebm)', () => {
  it('🔴 1 秒ずつ渡して、渡した AudioData は全部 close し、出力は demux し直せる(packet・pre-skip・長さが往復する)', async () => {
    const f = fakeAudio({ preSkip: 312 });
    const pcm = new Float32Array(ENCODE_RATE * 2 + 4800).fill(0.1); // 2.1 秒
    const r = await encodeOpusWebm(pcm, f.api);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(f.log.chunks).toEqual([48_000, 48_000, 4_800]);
    expect(f.log.closed, '渡した AudioData を閉じていない').toBe(f.log.opened);
    expect(f.log.closedEncoder).toBe(1);
    const d = demuxWebmOpus(r.bytes);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.source.packets).toHaveLength(f.log.packets);
    expect(d.source.packets[3]!.data[0]).toBe(3); // 中身が往復する
    expect(d.source.packets[3]!.ms).toBeCloseTo(60, 0);
    expect(preSkipOf(d.source.codecPrivate)).toBe(312);
    expect(d.source.codecDelayMs).toBeCloseTo(6.5, 1);
    expect(d.source.channels).toBe(1);
    expect(r.durationMs).toBeGreaterThan(2000);
    expect(r.durationMs).toBeLessThan(2200);
  });

  it('pre-skip が description に無ければ 312(opus の既定)を書く', async () => {
    const r = await encodeOpusWebm(new Float32Array(ENCODE_RATE).fill(0.1), fakeAudio({ preSkip: null }).api);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = demuxWebmOpus(r.bytes);
    if (d.ok) expect(preSkipOf(d.source.codecPrivate)).toBe(312);
  });

  it('🔴 符号化できない環境・空・途中で落ちた回は、理由を返して部分的な file を作らない(符号化器は閉じる)', async () => {
    expect(await encodeOpusWebm(new Float32Array(10), null)).toEqual({ ok: false, reason: 'no-encoder' });
    expect(await encodeOpusWebm(new Float32Array(10), fakeAudio({ supported: false }).api)).toEqual({ ok: false, reason: 'no-encoder' });
    expect(await encodeOpusWebm(new Float32Array(0), fakeAudio().api)).toEqual({ ok: false, reason: 'empty' });
    const f = fakeAudio({ failAt: 30 });
    expect(await encodeOpusWebm(new Float32Array(ENCODE_RATE * 2).fill(0.1), f.api)).toEqual({ ok: false, reason: 'encode-failed' });
    expect(f.log.closedEncoder).toBe(1);
    expect(f.log.closed).toBe(f.log.opened);
  });
});

describe('muxOpusWebm', () => {
  it('空の packet 列は断る。OpusHead は 19 バイトで読み戻せる', () => {
    expect(muxOpusWebm({ packets: [], channels: 1, preSkip: 312, packetMs: 20 })).toEqual({ ok: false, reason: 'empty-range' });
    const h = opusHead(2, 400);
    expect(h).toHaveLength(19);
    expect(preSkipOf(h)).toBe(400);
    expect(preSkipOf(new Uint8Array(19))).toBeNull();
  });
});

describe('ワーカーの中身(VoiceRunner。本物の RNNoise)', () => {
  const sec = VOICE_RATE;
  const noisyTalk = (): Float32Array => mix(concat(synthVoice(2), new Float32Array(2 * sec)), whiteNoise(4 * sec, 0.03));

  function runner(audio: ReturnType<typeof fakeAudio>, track?: { created: number; destroyed: number }) {
    return new VoiceRunner({
      createEngine: async () => {
        const e = await realEngine();
        if (track) track.created += 1;
        const h: EngineHandle = {
          process: (f) => e.process(f),
          destroy: () => {
            e.destroy();
            if (track) track.destroyed += 1;
          },
        };
        return h;
      },
      audioApi: audio.api,
    });
  }

  it('🔴 雑音を減らした音を 1 件返す(長さは元と同じ)。エンジンは 1 依頼ごとに作って壊す', async () => {
    const audio = fakeAudio();
    const track = { created: 0, destroyed: 0 };
    const r = await runner(audio, track).run({ op: 'denoise', pcm: noisyTalk() });
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'audio') return;
    expect(r.files.map((f) => f.tag)).toEqual(['雑音を減らした']);
    expect(r.files[0]!.bytes.byteLength).toBeGreaterThan(100);
    expect(r.files[0]!.durationMs).toBeGreaterThan(3900);
    expect(r.files[0]!.durationMs).toBeLessThan(4100);
    expect(track).toEqual({ created: 1, destroyed: 1 });
    // 符号化器に渡った PCM が「雑音を減らした物」であること:渡した総量は入力と同じ長さ
    expect(audio.log.encodedSamples).toBe(4 * sec);
  });

  it('🔴 断る:無音・空・エンジンが作れない・符号化できない。どの回もエンジンは壊す(作れた回)', async () => {
    const track = { created: 0, destroyed: 0 };
    const r1 = await runner(fakeAudio(), track).run({ op: 'denoise', pcm: new Float32Array(sec) });
    expect(r1).toEqual({ ok: false, reason: 'silent' });
    expect(await runner(fakeAudio(), track).run({ op: 'denoise', pcm: new Float32Array(0) })).toEqual({ ok: false, reason: 'empty' });
    expect(track).toEqual({ created: 0, destroyed: 0 }); // 前段で断ったので、重い部品は起こしていない
    const broken = new VoiceRunner({
      createEngine: async () => {
        throw new Error('wasm が読めない');
      },
      audioApi: fakeAudio().api,
    });
    expect(await broken.run({ op: 'denoise', pcm: noisyTalk() })).toEqual({ ok: false, reason: 'no-engine' });
    const t2 = { created: 0, destroyed: 0 };
    const r4 = await runner(fakeAudio({ supported: false }), t2).run({ op: 'denoise', pcm: noisyTalk() });
    expect(r4).toEqual({ ok: false, reason: 'no-encoder' });
    expect(t2).toEqual({ created: 1, destroyed: 1 });
  });
});
